// Engine n8n: chamada assinada ao fluxo, parsing leniente da resposta e
// propagação de erros. Usa um servidor HTTP local como stub do fluxo n8n
// (Webhook trigger + Respond to Webhook), que VALIDA a assinatura HMAC.

import { createServer, type Server } from "node:http"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { engineChat, engineHealth, engineName } from "@/lib/negotiation/engine"
import { verifyN8nRequest } from "@/lib/negotiation/n8n"
import type { NegotiationSession } from "@/lib/negotiation/types"

const SECRET = "test-engine-secret"

let server: Server
let port: number
let flowResponse: unknown
let lastPayload: any = null
let lastSignatureValid: boolean | null = null

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
      if (lastPayload.message === "force-500") {
        res.writeHead(500).end("boom")
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
  lastPayload = null
  lastSignatureValid = null
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

  it("rejeita resposta sem reply", async () => {
    flowResponse = { action: "handoff" }
    await expect(
      engineChat({ session: fakeSession(), message: "oi", channel: "n8n", debtor: null, tenant: null }),
    ).rejects.toThrow(/inválida/)
  })

  it("propaga erro HTTP do fluxo", async () => {
    flowResponse = { reply: "nunca chega" }
    await expect(
      engineChat({ session: fakeSession(), message: "force-500", channel: "n8n", debtor: null, tenant: null }),
    ).rejects.toThrow(/500/)
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
