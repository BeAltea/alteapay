import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  isCanonicalVoxuyWebhookUrl,
  loadVoxuyApiConfig,
  loadVoxuyConfig,
  VOXUY_WEBHOOK_URL_RE,
  VoxuyConfigError,
  voxuyRateLimitPerSec,
} from "@/lib/whatsapp/voxuy/config"
import { mapVoxuyInbound } from "@/lib/whatsapp/voxuy/inbound"
import { classifyVoxuyResponse } from "@/lib/whatsapp/voxuy/provider"

// URL-credencial canônica (host webhooks.voxuy.com + /voxuyapi/<uuid>). O uuid é
// o SEGREDO — nunca deve aparecer em mensagem de erro.
const CANONICAL_URL = "https://webhooks.voxuy.com/voxuyapi/deadbeef-cafe-babe-f00d-9f3a1b2c3d4e"

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../fixtures/voxuy/${name}`, import.meta.url)), "utf8")

describe("loadVoxuyConfig (V1 — zod, sem logar valor)", () => {
  it("valida config completa", () => {
    const cfg = loadVoxuyConfig({
      VOXUY_WEBHOOK_URL: "https://sistema.voxuy.com/api/abc/webhooks/voxuy/transaction",
      VOXUY_API_TOKEN: "tok",
    } as unknown as NodeJS.ProcessEnv)
    expect(cfg.webhookUrl).toContain("voxuy.com")
    expect(cfg.timeoutMs).toBe(10_000)
  })

  it("lança VoxuyConfigError com os NOMES faltantes (nunca valores)", () => {
    try {
      // valor de token presente porém URL faltando: a msg cita só o NOME da
      // variável faltante, nunca o valor do token fornecido.
      loadVoxuyConfig({ VOXUY_API_TOKEN: "SECRET_TOKEN_VALUE_123" } as unknown as NodeJS.ProcessEnv)
      throw new Error("deveria ter lançado")
    } catch (err) {
      expect(err).toBeInstanceOf(VoxuyConfigError)
      const e = err as VoxuyConfigError
      expect(e.missing).toContain("VOXUY_WEBHOOK_URL")
      // a mensagem cita nomes de variáveis, jamais o VALOR de um segredo
      expect(e.message).not.toContain("SECRET_TOKEN_VALUE_123")
    }
  })

  it("rejeita URL não-https / não montada corretamente", () => {
    expect(() =>
      loadVoxuyConfig({ VOXUY_WEBHOOK_URL: "ftp://x", VOXUY_API_TOKEN: "t" } as unknown as NodeJS.ProcessEnv),
    ).toThrow(VoxuyConfigError)
  })

  it("rate limit default 5, respeita override positivo", () => {
    expect(voxuyRateLimitPerSec({} as unknown as NodeJS.ProcessEnv)).toBe(5)
    expect(voxuyRateLimitPerSec({ WHATSAPP_RATE_LIMIT_PER_SEC: "8" } as unknown as NodeJS.ProcessEnv)).toBe(8)
    expect(voxuyRateLimitPerSec({ WHATSAPP_RATE_LIMIT_PER_SEC: "-1" } as unknown as NodeJS.ProcessEnv)).toBe(5)
  })
})

describe("W1.1 — URL canônica enterprise_v1 (regex, sem ecoar a URL)", () => {
  it("aceita SÓ o formato canônico webhooks.voxuy.com/voxuyapi/<uuid>", () => {
    expect(isCanonicalVoxuyWebhookUrl(CANONICAL_URL)).toBe(true)
    expect(VOXUY_WEBHOOK_URL_RE.test(CANONICAL_URL)).toBe(true)
  })

  it("RECUSA host errado / path errado / http / uuid curto / nulo", () => {
    // host diferente (mesmo que https e 'voxuy' no nome)
    expect(isCanonicalVoxuyWebhookUrl("https://sistema.voxuy.com/voxuyapi/deadbeef-cafe-babe-f00d-9f3a1b2c3d4e")).toBe(false)
    // path errado
    expect(isCanonicalVoxuyWebhookUrl("https://webhooks.voxuy.com/api/deadbeef-cafe-babe-f00d-9f3a1b2c3d4e")).toBe(false)
    // http (não https)
    expect(isCanonicalVoxuyWebhookUrl("http://webhooks.voxuy.com/voxuyapi/deadbeef-cafe-babe-f00d-9f3a1b2c3d4e")).toBe(false)
    // uuid curto (menos de 36 chars)
    expect(isCanonicalVoxuyWebhookUrl("https://webhooks.voxuy.com/voxuyapi/deadbeef")).toBe(false)
    // char fora de [0-9a-f-]
    expect(isCanonicalVoxuyWebhookUrl("https://webhooks.voxuy.com/voxuyapi/ZZZZZZZZ-cafe-babe-f00d-9f3a1b2c3d4e")).toBe(false)
    // sufixo extra depois do uuid
    expect(isCanonicalVoxuyWebhookUrl("https://webhooks.voxuy.com/voxuyapi/deadbeef-cafe-babe-f00d-9f3a1b2c3d4e/extra")).toBe(false)
    expect(isCanonicalVoxuyWebhookUrl(null)).toBe(false)
    expect(isCanonicalVoxuyWebhookUrl(undefined)).toBe(false)
    expect(isCanonicalVoxuyWebhookUrl("")).toBe(false)
  })

  it("loadVoxuyApiConfig (enterprise_v1) aceita a URL canônica", () => {
    const cfg = loadVoxuyApiConfig({
      VOXUY_WEBHOOK_URL: CANONICAL_URL,
      VOXUY_FLOW_ID: "42",
    } as unknown as NodeJS.ProcessEnv)
    expect(cfg.dialect).toBe("enterprise_v1")
    expect(cfg.webhookUrl).toBe(CANONICAL_URL)
    expect(cfg.flowId).toBe(42)
  })

  it("loadVoxuyApiConfig (enterprise_v1) RECUSA host errado — msg cita só o NOME, nunca a URL", () => {
    const WRONG = "https://evil.example.com/voxuyapi/deadbeef-cafe-babe-f00d-9f3a1b2c3d4e"
    try {
      loadVoxuyApiConfig({
        VOXUY_WEBHOOK_URL: WRONG,
        VOXUY_FLOW_ID: "42",
      } as unknown as NodeJS.ProcessEnv)
      throw new Error("deveria ter lançado")
    } catch (err) {
      expect(err).toBeInstanceOf(VoxuyConfigError)
      const e = err as VoxuyConfigError
      expect(e.missing).toContain("VOXUY_WEBHOOK_URL")
      // a mensagem NUNCA contém a URL (só o NOME da variável)
      expect(e.message).not.toContain(WRONG)
      expect(e.message).not.toContain("evil.example.com")
      expect(e.message).not.toContain("deadbeef")
    }
  })
})

describe("fixtures reais (Apêndice A.3) casam com o classificador", () => {
  it("success_200.json => aceito", () => {
    const body = JSON.parse(fixture("success_200.json"))
    expect(classifyVoxuyResponse(200, body, true).accepted).toBe(true)
  })

  it("error_400_phone.json (exemplo da doc) => validação com traceId", () => {
    const body = JSON.parse(fixture("error_400_phone.json"))
    const r = classifyVoxuyResponse(400, body, true)
    expect(r.errorClass).toBe("validation")
    expect(r.traceId).toBe("0HM8U2U27H831:00000001")
    expect(r.errorFields).toEqual(["clientPhoneNumber"])
  })

  it("error_401.json => config", () => {
    const body = JSON.parse(fixture("error_401.json"))
    expect(classifyVoxuyResponse(401, body, true).errorClass).toBe("config")
  })

  it("error_500.html (corpo não-JSON) => retryable", () => {
    // corpo não é JSON => bodyIsJson=false
    expect(classifyVoxuyResponse(500, { nonJson: true }, false).errorClass).toBe("retryable")
  })

  it("success_unexpected_body.json => aceito com note", () => {
    const body = JSON.parse(fixture("success_unexpected_body.json"))
    const r = classifyVoxuyResponse(200, body, true)
    expect(r.accepted).toBe(true)
    expect(r.note).toBe("unexpected_body")
  })
})

describe("mapVoxuyInbound (V5 — só o contrato A.5)", () => {
  it("mapeia clicked com botão", () => {
    const evs = mapVoxuyInbound(JSON.stringify({ event: "clicked", message_ref: "m1", button: "optout" }))
    expect(evs).toEqual([{ type: "clicked", providerMessageId: "m1", button: "optout", at: expect.any(String) }])
  })

  it("mapeia optout por telefone", () => {
    const evs = mapVoxuyInbound(JSON.stringify({ event: "optout", phone: "+5511912341234" }))
    expect(evs[0]).toMatchObject({ type: "optout", phone: "+5511912341234" })
  })

  it("corpo não-JSON => [] (captura bruta fica com a rota)", () => {
    expect(mapVoxuyInbound("<html>500</html>")).toEqual([])
  })

  it("formato desconhecido => [] (fica processed=false)", () => {
    expect(mapVoxuyInbound(JSON.stringify({ foo: "bar" }))).toEqual([])
    expect(mapVoxuyInbound(JSON.stringify({ event: "purchase" }))).toEqual([])
  })
})
