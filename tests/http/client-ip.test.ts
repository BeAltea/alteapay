// N8N-12 / F-4 — fonte única e confiável do IP do cliente.
import { afterEach, describe, expect, it } from "vitest"

import {
  clientIpDiagnostics,
  clientIpHash,
  edgeClientIp,
  legacyClientIp,
  resolveClientIp,
  resolveClientIpDetailed,
  signEdgeClientIp,
  xffClientIp,
} from "@/lib/http/client-ip"
import { applyEdgeClientIp } from "@/lib/http/client-ip-edge"
import { parseClientIpConfig } from "@/lib/http/client-ip-shared"
import { clientIpFromHeaders } from "@/lib/journey/client-ip"

const H = (h: Record<string, string>) => new Headers(h)
const CLIENT = "198.51.100.23"
const FORGED = "203.0.113.9"
const HOP = "100.64.7.7" // salto intermediário (ex.: Netlify)
const SECRET = "s".repeat(40)

describe("parseClientIpConfig — flag com default seguro", () => {
  it("ausente/legacy/lixo → legacy (produção inalterada)", () => {
    expect(parseClientIpConfig({}).mode).toBe("legacy")
    expect(parseClientIpConfig({ TRUSTED_CLIENT_IP_SOURCE: "legacy" }).mode).toBe("legacy")
    expect(parseClientIpConfig({ TRUSTED_CLIENT_IP_SOURCE: "netlify,cloudflare" }).mode).toBe("legacy")
    expect(parseClientIpConfig({ TRUSTED_CLIENT_IP_SOURCE: " , " }).mode).toBe("legacy")
  })
  it("none e lista ordenada; hops inválido → 1; segredo curto → sem edge", () => {
    expect(parseClientIpConfig({ TRUSTED_CLIENT_IP_SOURCE: "none" }).mode).toBe("none")
    const c = parseClientIpConfig({
      TRUSTED_CLIENT_IP_SOURCE: "Edge, netlify,xff", TRUSTED_PROXY_HOPS: "0", CLIENT_IP_HEADER_SECRET: "curto",
    })
    expect(c).toEqual({ mode: "trusted", sources: ["edge", "netlify", "xff"], proxyHops: 1, edgeSecret: null })
    expect(parseClientIpConfig({ TRUSTED_CLIENT_IP_SOURCE: "xff", TRUSTED_PROXY_HOPS: "2" })).toMatchObject({ proxyHops: 2 })
  })
})

describe("flag desligada → comportamento de hoje (legacy), byte a byte", () => {
  const cases: Array<[Record<string, string>, string | null]> = [
    [{ "x-nf-client-connection-ip": CLIENT, "x-forwarded-for": `${FORGED}, ${HOP}` }, CLIENT],
    [{ "x-forwarded-for": `${FORGED}, ${HOP}` }, HOP],
    [{ "x-forwarded-for": FORGED }, FORGED], // XFF de 1 elemento: hoje é aceito (legado)
    [{ "x-nf-client-connection-ip": "lixo", "x-forwarded-for": HOP }, HOP],
    [{ "x-real-ip": FORGED }, null],
    [{}, null],
  ]
  it.each(cases)("%j → %s", (headers, want) => {
    expect(resolveClientIp(H(headers), {})).toBe(want)
    expect(legacyClientIp(H(headers))).toBe(want)
  })
  it("fachada clientIpFromHeaders segue a flag do process.env (default legacy)", () => {
    delete process.env.TRUSTED_CLIENT_IP_SOURCE
    expect(clientIpFromHeaders(H({ "x-forwarded-for": `${FORGED}, ${HOP}` }))).toBe(HOP)
  })
  it("cabeçalho de borda forjado é ignorado no legacy", () => {
    expect(resolveClientIp(H({ "x-alteapay-client-ip": FORGED }), {})).toBeNull()
  })
})

describe("fonte netlify (x-nf-client-connection-ip)", () => {
  const env = { TRUSTED_CLIENT_IP_SOURCE: "netlify" }
  it("usa o cabeçalho da borda e ignora XFF forjado", () => {
    expect(resolveClientIp(H({ "x-nf-client-connection-ip": CLIENT, "x-forwarded-for": FORGED }), env)).toBe(CLIENT)
  })
  it("sem ele → null (NÃO cai no último do XFF, que é o salto)", () => {
    expect(resolveClientIp(H({ "x-forwarded-for": `${FORGED}, ${HOP}` }), env)).toBeNull()
  })
  it("netlify,xff → prefere netlify e cai no XFF por contagem de saltos", () => {
    const e = { TRUSTED_CLIENT_IP_SOURCE: "netlify,xff", TRUSTED_PROXY_HOPS: "2" }
    expect(resolveClientIpDetailed(H({ "x-nf-client-connection-ip": CLIENT }), e)).toMatchObject({ ip: CLIENT, source: "netlify" })
    expect(resolveClientIpDetailed(H({ "x-forwarded-for": `${FORGED}, ${CLIENT}, ${HOP}` }), e))
      .toMatchObject({ ip: CLIENT, source: "xff" })
  })
})

describe("fonte xff — salto mais à direita não confiável", () => {
  it("hops=1: último; hops=2: penúltimo", () => {
    const h = H({ "x-forwarded-for": `${FORGED}, ${CLIENT}, ${HOP}` })
    expect(xffClientIp(h, 1)).toBe(HOP)
    expect(xffClientIp(h, 2)).toBe(CLIENT)
  })
  it("prefixo forjado pelo cliente nunca é escolhido", () => {
    for (const f of ["1.1.1.1", "8.8.8.8", `${FORGED}, 9.9.9.9`, "lixo"]) {
      expect(xffClientIp(H({ "x-forwarded-for": `${f}, ${CLIENT}, ${HOP}` }), 2)).toBe(CLIENT)
    }
  })
  it("lista menor que o nº de proxies confiáveis → null (só haveria valor do cliente)", () => {
    expect(xffClientIp(H({ "x-forwarded-for": FORGED }), 2)).toBeNull()
    expect(resolveClientIp(H({ "x-forwarded-for": FORGED }), { TRUSTED_CLIENT_IP_SOURCE: "xff", TRUSTED_PROXY_HOPS: "2" })).toBeNull()
  })
  it("elemento escolhido inválido → null (não anda para a esquerda)", () => {
    expect(xffClientIp(H({ "x-forwarded-for": `${CLIENT}, lixo, ${HOP}` }), 2)).toBeNull()
  })
})

describe("fonte edge — cabeçalho assinado pelo middleware", () => {
  const env = { TRUSTED_CLIENT_IP_SOURCE: "edge", CLIENT_IP_HEADER_SECRET: SECRET }

  it("round-trip: middleware (Web Crypto) assina, route handler (node) confere", async () => {
    const req = { ip: CLIENT, headers: new Headers({ "x-forwarded-for": `${FORGED}, ${HOP}` }) }
    expect(await applyEdgeClientIp(req, env)).toBe(true)
    expect(req.headers.get("x-alteapay-client-ip-sig")).toBe(signEdgeClientIp(CLIENT, SECRET))
    expect(resolveClientIp(req.headers, env)).toBe(CLIENT)
  })

  it("cliente que envia o cabeçalho interno: o middleware apaga e reescreve", async () => {
    const req = {
      ip: CLIENT,
      headers: new Headers({ "x-alteapay-client-ip": FORGED, "x-alteapay-client-ip-sig": "a".repeat(64) }),
    }
    await applyEdgeClientIp(req, env)
    expect(resolveClientIp(req.headers, env)).toBe(CLIENT)
  })

  it("sem request.ip no middleware → cabeçalhos removidos → null", async () => {
    const req = { ip: undefined, headers: new Headers({ "x-alteapay-client-ip": FORGED }) }
    expect(await applyEdgeClientIp(req, env)).toBe(true)
    expect(req.headers.get("x-alteapay-client-ip")).toBeNull()
    expect(resolveClientIp(req.headers, env)).toBeNull()
  })

  it("cabeçalho forjado sem passar pelo middleware (assinatura errada/ausente) → null", () => {
    expect(edgeClientIp(H({ "x-alteapay-client-ip": FORGED }), SECRET)).toBeNull()
    expect(edgeClientIp(H({ "x-alteapay-client-ip": FORGED, "x-alteapay-client-ip-sig": signEdgeClientIp(FORGED, "outro".repeat(10)) }), SECRET)).toBeNull()
    // assinatura válida para OUTRO IP não serve
    expect(edgeClientIp(H({ "x-alteapay-client-ip": FORGED, "x-alteapay-client-ip-sig": signEdgeClientIp(CLIENT, SECRET) }), SECRET)).toBeNull()
  })

  it("sem segredo configurado → edge nunca confia (null)", async () => {
    const e = { TRUSTED_CLIENT_IP_SOURCE: "edge" }
    const req = { ip: CLIENT, headers: new Headers() }
    await applyEdgeClientIp(req, e)
    expect(req.headers.get("x-alteapay-client-ip")).toBeNull()
    expect(resolveClientIp(H({ "x-alteapay-client-ip": CLIENT, "x-alteapay-client-ip-sig": signEdgeClientIp(CLIENT, SECRET) }), e)).toBeNull()
  })

  it("middleware inerte sem 'edge' na flag (não toca nos headers)", async () => {
    const req = { ip: CLIENT, headers: new Headers({ "x-alteapay-client-ip": FORGED }) }
    expect(await applyEdgeClientIp(req, {})).toBe(false)
    expect(await applyEdgeClientIp(req, { TRUSTED_CLIENT_IP_SOURCE: "netlify" })).toBe(false)
    expect(req.headers.get("x-alteapay-client-ip")).toBe(FORGED)
  })

  it("edge,netlify: sem cabeçalho assinado cai no x-nf-client-connection-ip", () => {
    const e = { ...env, TRUSTED_CLIENT_IP_SOURCE: "edge,netlify" }
    expect(resolveClientIpDetailed(H({ "x-nf-client-connection-ip": CLIENT }), e)).toMatchObject({ ip: CLIENT, source: "netlify" })
  })
})

describe("none", () => {
  it("sempre null", () => {
    expect(resolveClientIp(H({ "x-nf-client-connection-ip": CLIENT, "x-forwarded-for": CLIENT }), { TRUSTED_CLIENT_IP_SOURCE: "none" })).toBeNull()
  })
})

describe("telemetria — hash salgado, nunca IP em claro", () => {
  const env = { CLIENT_IP_HASH_SALT: "sal-de-teste-123456", TRUSTED_CLIENT_IP_SOURCE: "edge,netlify", CLIENT_IP_HEADER_SECRET: SECRET }
  afterEach(() => { delete process.env.TRUSTED_CLIENT_IP_SOURCE })

  it("sem sal → null; com sal → 16 hex estável e diferente por IP", () => {
    expect(clientIpHash(CLIENT, {})).toBeNull()
    const a = clientIpHash(CLIENT, env)
    expect(a).toMatch(/^[0-9a-f]{16}$/)
    expect(clientIpHash(CLIENT, env)).toBe(a)
    expect(clientIpHash(HOP, env)).not.toBe(a)
  })

  it("diagnóstico mostra qual fonte bate com o IP esperado, sem vazar IP", () => {
    const d = clientIpDiagnostics(
      H({ "x-nf-client-connection-ip": HOP, "x-forwarded-for": `${FORGED}, ${HOP}` }),
      { expected: CLIENT, env },
    )
    expect(d.netlify).toMatchObject({ present: true, valid: true, matches_expected: false })
    expect(d.xff.map((x) => x.matches_expected)).toEqual([false, false])
    expect(d.resolved.source).toBe("netlify")
    const json = JSON.stringify(d)
    for (const ip of [CLIENT, HOP, FORGED]) expect(json).not.toContain(ip)
  })
})
