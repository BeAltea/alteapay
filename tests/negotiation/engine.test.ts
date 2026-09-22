// Engine n8n: chamada assinada ao fluxo, parsing leniente da resposta e
// propagação de erros. Usa um servidor HTTP local como stub do fluxo n8n
// (Webhook trigger + Respond to Webhook), que VALIDA a assinatura HMAC.

import { createServer, type Server } from "node:http"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { engineChat, engineHealth, engineName } from "@/lib/negotiation/engine"
import { verifyN8nRequest } from "@/lib/negotiation/n8n"
import type { NegotiationSession } from "@/lib/negotiation/types"

// Captura de eventos gravados pelo engine (§3 chat.engine_invalid_action).
// context.ts devolve null → o engine usa buildTurnPayload (sem tocar Supabase).
const recordedEvents: Array<{ type: string; payload?: unknown }> = []
vi.mock("@/lib/journey/events", () => ({
  recordEvent: async (i: any) => {
    recordedEvents.push({ type: i.type, payload: i.payload })
    return { ok: true, duplicate: false }
  },
}))
vi.mock("@/lib/journey/context", () => ({
  buildSessionContext: async () => null,
}))

const SECRET = "test-engine-secret"

let server: Server
let port: number
let flowResponse: unknown
let flowStatus = 200
let lastPayload: any = null
let lastSignatureValid: boolean | null = null
let lastAuthHeader: string | null = null
let lastEventId: string | null = null

function fakeSession(): NegotiationSession {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    company_id: "22222222-2222-2222-2222-222222222222",
    customer_id: null,
    debt_id: null,
    document_hash: "x",
    channel_origin: "n8n",
    frontend_mode: "alteapay",
    handoff_token_hash: null,
    token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
    token_used_at: null,
    identity_verified_at: new Date().toISOString(),
    debt_acknowledged_at: null,
    consent_lgpd_at: new Date().toISOString(),
    consent_lgpd_version: "v1",
    fulfillment_mode: "A",
    outcome: "in_progress",
    agreement_id: null,
    thread_id: "web_test",
    user_agent: null,
    ip_hash: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      lastPayload = JSON.parse(raw)
      lastAuthHeader = (req.headers["authorization"] as string) ?? null
      lastEventId = (req.headers["x-alteapay-event-id"] as string) ?? null
      const verdict = verifyN8nRequest(
        raw,
        (req.headers["x-alteapay-signature"] as string) ?? null,
        (req.headers["x-alteapay-timestamp"] as string) ?? null,
      )
      lastSignatureValid = verdict.ok
      if (!verdict.ok) {
        res.writeHead(401).end(JSON.stringify({ error: "assinatura" }))
        return
      }
      if (lastPayload.message === "force-timeout") {
        // não responde: força o AbortSignal.timeout do engine
        return
      }
      if (flowStatus === 202) {
        res.writeHead(202, { "content-type": "application/json" })
        res.end(JSON.stringify({ accepted: true }))
        return
      }
      if (flowStatus !== 200) {
        res.writeHead(flowStatus).end("boom")
        return
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify(flowResponse))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  port = typeof address === "object" && address ? address.port : 0
})

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

beforeEach(() => {
  process.env.N8N_WEBHOOK_SECRET = SECRET
  process.env.NEGOTIATION_ENGINE = "n8n"
  process.env.N8N_CHAT_FLOW_URL = `http://127.0.0.1:${port}/webhook/chat`
  // Basic Auth papel A (credenciais de teste — nunca são impressas)
  process.env.N8N_BASIC_AUTH_USER = "flowuser"
  process.env.N8N_BASIC_AUTH_PASSWORD = "flowpass"
  // timeout curto para o teste de timeout não pendurar a suíte
  process.env.N8N_TIMEOUT_MS = "300"
  delete process.env.NEGOTIATION_ENGINE_FALLBACK
  flowStatus = 200
  lastPayload = null
  lastSignatureValid = null
  lastAuthHeader = null
  lastEventId = null
  recordedEvents.length = 0
})

describe("engine n8n", () => {
  it("D14: default é disabled; n8n exige URL; agent exige URL+token", () => {
    // beforeEach configura NEGOTIATION_ENGINE=n8n + N8N_CHAT_FLOW_URL → n8n
    expect(engineName()).toBe("n8n")
    // n8n sem URL degrada para disabled
    delete process.env.N8N_CHAT_FLOW_URL
    expect(engineName()).toBe("disabled")
    // agent sem AGENT_URL/AGENT_APP_TOKEN degrada para disabled
    process.env.NEGOTIATION_ENGINE = "agent"
    delete process.env.AGENT_URL
    delete process.env.AGENT_APP_TOKEN
    expect(engineName()).toBe("disabled")
    process.env.AGENT_URL = "http://127.0.0.1:9"
    process.env.AGENT_APP_TOKEN = "t"
    expect(engineName()).toBe("agent")
    delete process.env.AGENT_URL
    delete process.env.AGENT_APP_TOKEN
    // sem env nenhuma → disabled
    delete process.env.NEGOTIATION_ENGINE
    expect(engineName()).toBe("disabled")
  })

  it("POSTa o turno assinado e o stub valida o HMAC", async () => {
    flowResponse = { reply: "Olá, Frederico!" }
    const result = await engineChat({
      session: fakeSession(),
      message: "quero negociar",
      channel: "webchat",
      debtor: {
        customer_name: "Frederico",
        document: "77329842508",
        debt_id: "33333333-3333-3333-3333-333333333333",
        amount: 1000,
        due_date: "2025-07-08",
        description: null,
        aging_days: 90,
      },
      tenant: null,
    })
    expect(lastSignatureValid).toBe(true)
    expect(lastPayload.type).toBe("chat.turn")
    expect(lastPayload.thread_id).toBe("web_test")
    expect(lastPayload.message).toBe("quero negociar")
    // contrato v2 (onda R): valor monetário na borda n8n em CENTAVOS (1000 → 100000)
    expect(lastPayload.debt.amount).toBe(100000)
    expect(lastPayload.session_state.identity_verified).toBe(true)
    // A URL oficial do tenant NUNCA viaja para o fluxo
    expect(JSON.stringify(lastPayload)).not.toContain("official_channel_url")
    expect(result.reply).toBe("Olá, Frederico!")
    expect(result.action).toBeNull()
    expect(result.events).toEqual([])
    expect(result.prompt_version).toBe("n8n-flow")
  })

  it("aceita resposta completa do fluxo (action/events/verified)", async () => {
    flowResponse = {
      reply: "Encaminhando ao canal oficial.",
      action: "redirect_payment",
      events: ["redirected_official_payment"],
      verified: true,
    }
    const result = await engineChat({
      session: fakeSession(),
      message: "ok",
      channel: "n8n",
      debtor: null,
      tenant: null,
    })
    expect(result.action).toBe("redirect_payment")
    expect(result.events).toContain("redirected_official_payment")
    expect(result.verified).toBe(true)
  })

  it("§5: resposta sem reply → fallback neutro (não lança, não trava)", async () => {
    flowResponse = { action: "handoff" } // sem reply obrigatório
    const result = await engineChat({
      session: fakeSession(), message: "oi", channel: "n8n", debtor: null, tenant: null,
    })
    expect(result.n8n_mode).toBe("fallback")
    expect(result.reply).toBe("Só um instante, estou verificando…")
    expect(result.action).toBeNull()
    // reply neutro NUNCA contém erro técnico/URL/segredo
    expect(result.reply).not.toMatch(/error|http|secret|url|senha|password/i)
  })

  it("§5: 5xx do fluxo → fallback neutro (não lança)", async () => {
    flowStatus = 500
    const result = await engineChat({
      session: fakeSession(), message: "oi", channel: "n8n", debtor: null, tenant: null,
    })
    expect(result.n8n_mode).toBe("fallback")
    expect(result.reply).toBe("Só um instante, estou verificando…")
  })

  it("§2/§5: timeout → fallback neutro (uma tentativa, sem retry)", async () => {
    flowResponse = { reply: "nunca chega" }
    const result = await engineChat({
      session: fakeSession(), message: "force-timeout", channel: "n8n", debtor: null, tenant: null,
    })
    expect(result.n8n_mode).toBe("fallback")
    expect(result.reply).toBe("Só um instante, estou verificando…")
    expect(typeof result.latency_ms).toBe("number")
  })

  it("§4: 202 → modo assíncrono (reply neutro, resposta real vem via chat.send)", async () => {
    flowStatus = 202
    const result = await engineChat({
      session: fakeSession(), message: "ok", channel: "n8n", debtor: null, tenant: null,
    })
    expect(result.n8n_mode).toBe("async")
    expect(result.reply).toBe("Só um instante, estou verificando…")
    expect(result.events).toContain("n8n_async_pending")
  })

  it("§1: Basic Auth + Event-Id presentes em TODA chamada papel A (sem imprimir credencial)", async () => {
    flowResponse = { reply: "ok" }
    const spy = vi.spyOn(console, "log")
    const spyWarn = vi.spyOn(console, "warn")
    const spyErr = vi.spyOn(console, "error")
    await engineChat({
      session: fakeSession(), message: "oi", channel: "n8n", debtor: null, tenant: null,
    })
    // Basic Auth calculado com Buffer('user:pass','utf8').toString('base64')
    const expected = "Basic " + Buffer.from("flowuser:flowpass", "utf8").toString("base64")
    expect(lastAuthHeader).toBe(expected)
    // Event-Id (uuid) presente
    expect(lastEventId).toMatch(/^[0-9a-f-]{36}$/i)
    // A credencial (clara ou base64) NUNCA aparece em NENHUM log
    const printed = [...spy.mock.calls, ...spyWarn.mock.calls, ...spyErr.mock.calls]
      .flat()
      .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
      .join(" ")
    expect(printed).not.toContain("flowpass")
    expect(printed).not.toContain(Buffer.from("flowuser:flowpass", "utf8").toString("base64"))
    spy.mockRestore(); spyWarn.mockRestore(); spyErr.mockRestore()
  })

  it("§3: ação de domínio inválida → chat.engine_invalid_action, ignora a ação mas exibe reply", async () => {
    flowResponse = { reply: "seguimos", action: "offer.teleport" }
    const result = await engineChat({
      session: fakeSession(), message: "oi", channel: "n8n", debtor: null, tenant: null,
    })
    expect(result.reply).toBe("seguimos") // reply é exibido
    expect(result.action).toBeNull() // ação ignorada (não vira redirect)
    expect(result.n8n_action).toBeNull() // ação de domínio ignorada
    expect(recordedEvents.some((e) => e.type === "chat.engine_invalid_action")).toBe(true)
  })

  it("§3: ação de domínio permitida (payment.create) → n8n_action, reply exibido", async () => {
    flowResponse = { reply: "vou gerar o pagamento", action: "payment.create" }
    const result = await engineChat({
      session: fakeSession(), message: "quero pagar", channel: "n8n", debtor: null, tenant: null,
    })
    expect(result.reply).toBe("vou gerar o pagamento")
    expect(result.n8n_action).toBe("payment.create")
    expect(result.action).toBeNull() // não é redirect legado
  })

  it("§6: URL por tenant tem precedência sobre a env (tenant → env → disabled)", async () => {
    // env apagada; a URL do tenant aponta ao stub → o turno ainda POSTa ao fluxo.
    delete process.env.N8N_CHAT_FLOW_URL
    flowResponse = { reply: "via tenant" }
    const result = await engineChat({
      session: { ...fakeSession(), engine_owner: "n8n" } as any,
      message: "oi",
      channel: "n8n",
      debtor: null,
      tenant: { n8n_chat_flow_url: `http://127.0.0.1:${port}/webhook/tenant` } as any,
    })
    expect(result.reply).toBe("via tenant")
    expect(lastSignatureValid).toBe(true)
  })

  it("D14: sem N8N_CHAT_FLOW_URL o engine degrada para disabled (nao erra)", async () => {
    delete process.env.N8N_CHAT_FLOW_URL
    expect(engineName()).toBe("disabled")
    const health = await engineHealth()
    expect(health.ok).toBe(true)
    expect(health.engine).toBe("disabled")
  })

  it("engineHealth reflete n8n configurado (URL presente)", async () => {
    const health = await engineHealth()
    expect(health.ok).toBe(true)
    expect(health.engine).toBe("n8n")
  })
})
