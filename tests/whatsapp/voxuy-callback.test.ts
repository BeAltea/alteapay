// Callback POST /api/webhooks/whatsapp/voxuy — captura PURA e resiliente.
// A Voxuy NÃO faz HMAC: a proteção é URL com segredo (?s=) ou header
// configurável. O contrato de saída REAL traz `contact` (hash/id/
// invalidWhatsApp/tags/customVariables) e não tem delivered/read. Aqui provamos:
// (a) sem segredo => 401; (b) segredo errado => 401; (c) segredo via ?s= => 200;
// (d) fuzz de payload (JSON lixo, não-JSON, binário, callback enterprise) =>
// nunca 500; (e) mapeador nunca derruba a rota; (f) capture falhando => 200;
// (g) dedupe idempotente; (h) invalidWhatsApp:true vira evento failed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mapVoxuyInbound } from "@/lib/whatsapp/voxuy/inbound"

// --- controles do teste ---------------------------------------------------
let captureBehavior: "ok" | "duplicate" | "throw" = "ok"
const captureSpy = vi.fn()

vi.mock("@/lib/whatsapp/inbound-apply", () => ({
  captureRawInbound: async (input: unknown) => {
    captureSpy(input)
    if (captureBehavior === "throw") throw new Error("db down")
    if (captureBehavior === "duplicate") return { duplicate: true, applied: 0 }
    return { duplicate: false, applied: 0 }
  },
}))

// Segredo fixo para o teste (a rota lê voxuyInboundSecret()).
vi.mock("@/lib/whatsapp/voxuy/config", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>
  return {
    ...actual,
    voxuyInboundSecret: () => "test-secret",
    voxuyInboundSecretHeader: () => "x-alteapay-webhook-secret",
  }
})

async function loadRoute() {
  const mod = await import("@/app/api/webhooks/whatsapp/voxuy/route")
  return mod.POST
}

function makeReq(body: string, opts?: { secret?: string; query?: string }) {
  const url = `https://alteapay.com/api/webhooks/whatsapp/voxuy${opts?.query ?? ""}`
  const headers = new Headers({ "content-type": "application/json" })
  if (opts?.secret) headers.set("x-alteapay-webhook-secret", opts.secret)
  return {
    url,
    headers,
    text: async () => body,
  } as unknown as import("next/server").NextRequest
}

beforeEach(() => {
  captureBehavior = "ok"
  captureSpy.mockClear()
})
afterEach(() => vi.clearAllMocks())

describe("mapVoxuyInbound — callback Enterprise REAL", () => {
  it("invalidWhatsApp:true => evento failed correlacionado por contact.hash", () => {
    const evs = mapVoxuyInbound(
      JSON.stringify({ contact: { hash: "h_abc", id: 10, phoneNumber: "+5511912341234", invalidWhatsApp: true } }),
    )
    expect(evs).toHaveLength(1)
    expect(evs[0]).toMatchObject({ type: "failed", providerMessageId: "h_abc", error: "invalid_whatsapp" })
  })

  it("usa contact.id quando não há hash", () => {
    const evs = mapVoxuyInbound(JSON.stringify({ contact: { id: 77, invalidWhatsApp: true } }))
    expect(evs[0]).toMatchObject({ type: "failed", providerMessageId: "77" })
  })

  it("contato válido sem sinal acionável => [] (bruto fica com a rota)", () => {
    const evs = mapVoxuyInbound(
      JSON.stringify({ contact: { hash: "h", invalidWhatsApp: false, tags: ["a"], customVariables: { x: 1 } } }),
    )
    expect(evs).toEqual([])
  })

  it("callback com transaction (venda) sem invalidWhatsApp => [] (não inventa evento)", () => {
    const evs = mapVoxuyInbound(
      JSON.stringify({ contact: { hash: "h" }, transaction: { id: 1, value: 6990 } }),
    )
    expect(evs).toEqual([])
  })

  it("corpo não-JSON => []", () => {
    expect(mapVoxuyInbound("<html>500</html>")).toEqual([])
  })
})

describe("voxuy callback — autenticação", () => {
  it("sem segredo => 401", async () => {
    const POST = await loadRoute()
    const res = await POST(makeReq("{}"))
    expect(res.status).toBe(401)
    expect(captureSpy).not.toHaveBeenCalled()
  })

  it("segredo errado => 401", async () => {
    const POST = await loadRoute()
    const res = await POST(makeReq("{}", { secret: "wrong" }))
    expect(res.status).toBe(401)
  })

  it("aceita segredo via query ?s= (URL com segredo)", async () => {
    const POST = await loadRoute()
    const res = await POST(makeReq("{}", { query: "?s=test-secret" }))
    expect(res.status).toBe(200)
  })

  it("aceita segredo via header configurável", async () => {
    const POST = await loadRoute()
    const res = await POST(makeReq("{}", { secret: "test-secret" }))
    expect(res.status).toBe(200)
  })
})

describe("voxuy callback — captura resiliente (fuzz nunca 500)", () => {
  const fuzz: Array<[string, string]> = [
    ["objeto vazio", "{}"],
    ["JSON lixo", '{"foo":"bar","x":[1,2,3]}'],
    ["não-JSON", "<html>500 internal</html>"],
    ["string vazia", ""],
    ["array", "[1,2,3]"],
    ["número solto", "42"],
    ["JSON quebrado", '{"event": '],
    ["callback enterprise inválido", '{"contact":{"hash":"h","invalidWhatsApp":true}}'],
    ["callback enterprise com transaction", '{"contact":{"hash":"h"},"transaction":{"value":6990}}'],
    ["evento legado válido", '{"event":"clicked","message_ref":"m1","button":"optout"}'],
    ["payload gigante", JSON.stringify({ contact: { hash: "x" }, blob: "A".repeat(50_000) })],
  ]

  for (const [label, body] of fuzz) {
    it(`nunca 500: ${label}`, async () => {
      const POST = await loadRoute()
      const res = await POST(makeReq(body, { secret: "test-secret" }))
      expect(res.status).toBe(200)
      expect(captureSpy).toHaveBeenCalledTimes(1)
      expect(captureSpy.mock.calls[0][0]).toMatchObject({ provider: "voxuy", rawBody: body })
    })
  }

  it("capture lançando (db down) => ainda 200, captured:false", async () => {
    captureBehavior = "throw"
    const POST = await loadRoute()
    const res = await POST(makeReq('{"contact":{"hash":"h2"}}', { secret: "test-secret" }))
    expect(res.status).toBe(200)
    const json = (await res.json()) as { ok: boolean; captured?: boolean }
    expect(json.ok).toBe(true)
    expect(json.captured).toBe(false)
  })

  it("duplicado => 200 ok:true duplicate:true (dedupe idempotente)", async () => {
    captureBehavior = "duplicate"
    const POST = await loadRoute()
    const res = await POST(makeReq('{"contact":{"hash":"h3"}}', { secret: "test-secret" }))
    expect(res.status).toBe(200)
    const json = (await res.json()) as { duplicate?: boolean }
    expect(json.duplicate).toBe(true)
  })

  it("req.text() lançando (stream abortado) => 200 captured:false, sem 500", async () => {
    const POST = await loadRoute()
    const req = {
      url: "https://alteapay.com/api/webhooks/whatsapp/voxuy",
      headers: new Headers({ "x-alteapay-webhook-secret": "test-secret" }),
      text: async () => {
        throw new Error("stream aborted")
      },
    } as unknown as import("next/server").NextRequest
    const res = await POST(req)
    expect(res.status).toBe(200)
    const json = (await res.json()) as { captured?: boolean }
    expect(json.captured).toBe(false)
  })
})
