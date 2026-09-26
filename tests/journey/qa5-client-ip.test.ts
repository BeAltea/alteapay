// QA rodada 5 (Q1-5, ALTO) — o IP do rate limit/auditoria da jornada NUNCA vem
// do 1º elemento do X-Forwarded-For (forjável). Ordem: x-nf-client-connection-ip
// (borda Netlify) › ÚLTIMO elemento do XFF (anexado pelo proxy confiável) › null.
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { clientIpFromHeaders, normalizeIp } from "@/lib/journey/client-ip"
import { ipHashOf } from "@/lib/journey/public-rate-limit"

const H = (h: Record<string, string>) => new Headers(h)
const REAL = "198.51.100.23"
const FORGED = "203.0.113.9" // TEST-NET-3, o IP "informado" pela sonda do QA

describe("clientIpFromHeaders — XFF forjado não controla o IP (Q1-5)", () => {
  it("prefere x-nf-client-connection-ip mesmo com XFF forjado no 1º elemento", () => {
    const ip = clientIpFromHeaders(H({
      "x-forwarded-for": `${FORGED}, ${REAL}`,
      "x-nf-client-connection-ip": REAL,
    }))
    expect(ip).toBe(REAL)
  })

  it("a sonda do QA (XFF só com o IP forjado + borda Netlify) grava o hash do IP REAL", () => {
    const ip = clientIpFromHeaders(H({ "x-forwarded-for": FORGED, "x-nf-client-connection-ip": REAL }))
    expect(ipHashOf(ip)).toBe(ipHashOf(REAL))
    expect(ipHashOf(ip)).not.toBe(ipHashOf(FORGED))
  })

  it("sem cabeçalho da borda: usa o ÚLTIMO elemento do XFF (o do proxy), nunca o 1º", () => {
    expect(clientIpFromHeaders(H({ "x-forwarded-for": `${FORGED}, 10.0.0.1, ${REAL}` }))).toBe(REAL)
    expect(clientIpFromHeaders(H({ "x-forwarded-for": `${FORGED},${REAL}` }))).toBe(REAL)
  })

  it("variar o 1º elemento do XFF não muda o IP resultante (não contorna o limite por IP)", () => {
    const ips = new Set(
      ["1.1.1.1", "2.2.2.2", "8.8.8.8", "lixo", ""].map((f) =>
        clientIpFromHeaders(H({ "x-forwarded-for": `${f}, ${REAL}`, "x-nf-client-connection-ip": REAL })),
      ),
    )
    expect([...ips]).toEqual([REAL])
    const noEdge = new Set(
      ["1.1.1.1", "2.2.2.2"].map((f) => clientIpFromHeaders(H({ "x-forwarded-for": `${f}, ${REAL}` }))),
    )
    expect([...noEdge]).toEqual([REAL])
  })

  it("cabeçalho da borda inválido cai para o último do XFF; nada válido → null", () => {
    expect(clientIpFromHeaders(H({ "x-nf-client-connection-ip": "not-an-ip", "x-forwarded-for": REAL }))).toBe(REAL)
    expect(clientIpFromHeaders(H({ "x-forwarded-for": `${REAL}, garbage` }))).toBeNull()
    expect(clientIpFromHeaders(H({}))).toBeNull()
  })

  it("x-real-ip (sem garantia de proxy) é ignorado", () => {
    expect(clientIpFromHeaders(H({ "x-real-ip": FORGED }))).toBeNull()
  })

  it("normaliza IPv6, [v6]:porta e v4:porta", () => {
    expect(normalizeIp("2001:DB8::1")).toBe("2001:db8::1")
    expect(normalizeIp("[2001:db8::1]:443")).toBe("2001:db8::1")
    expect(normalizeIp("198.51.100.23:5555")).toBe(REAL)
    expect(normalizeIp("999.1.1.1")).toBeNull()
    expect(normalizeIp("<script>")).toBeNull()
    expect(clientIpFromHeaders(H({ "x-nf-client-connection-ip": "2001:db8::7" }))).toBe("2001:db8::7")
  })
})

describe("nenhuma rota/lib da jornada lê o 1º elemento do X-Forwarded-For", () => {
  const ROOTS = ["app/api/chat", "app/api/negotiation", "app/api/webhooks/n8n", "app/actions/contact-lead.ts", "lib/journey"]
  const files: string[] = []
  const walk = (p: string) => {
    const st = statSync(p)
    if (st.isDirectory()) for (const f of readdirSync(p)) walk(join(p, f))
    else if (/\.(ts|tsx)$/.test(p)) files.push(p)
  }
  for (const r of ROOTS) walk(join(process.cwd(), r))

  it("grep: nenhuma leitura direta de x-forwarded-for fora de lib/journey/client-ip.ts", () => {
    expect(files.length).toBeGreaterThan(10)
    const offenders = files.filter((f) => {
      if (f.endsWith(join("lib", "journey", "client-ip.ts"))) return false
      const src = readFileSync(f, "utf8")
      return /\.get\(\s*["'`]x-forwarded-for["'`]/i.test(src)
    })
    expect(offenders).toEqual([])
  })
})
