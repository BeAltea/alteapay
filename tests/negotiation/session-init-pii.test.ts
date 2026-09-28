// session.init legado (só com N8N_SESSION_FLOW_URL): mesma minimização de PII
// dos demais eventos ao n8n — 1º nome + documento mascarado + hash. Nome
// completo e documento em claro nunca saem.
import { createHash } from "node:crypto"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { buildSessionInitPayload, engineSessionInit } from "@/lib/negotiation/engine"
import type { AgentSessionInit } from "@/lib/negotiation/agent-client"

const CPF = "11144477735"
const INIT: AgentSessionInit = {
  thread_id: "thr-1",
  company_id: "co-1",
  customer_name: "Maria da Silva Sousa",
  document: CPF,
  debt_id: "debt-1",
  amount: 250,
  aging_days: 30,
  due_date: "2026-08-01",
  channel: "n8n",
  identity_preverified: false,
  fulfillment_mode: "A",
}

const KEYS = ["N8N_SESSION_FLOW_URL", "NEGOTIATION_ENGINE", "N8N_WEBHOOK_SECRET"] as const
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k]
  for (const k of KEYS) delete process.env[k]
})

afterEach(() => {
  vi.unstubAllGlobals()
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

function assertNoPlainPii(serialized: string) {
  expect(serialized).not.toContain(CPF)
  expect(serialized).not.toContain("111.444.777-35")
  expect(serialized).not.toContain("Maria da Silva Sousa")
  expect(serialized).not.toContain("Silva")
  expect(serialized).not.toContain("Sousa")
}

describe("buildSessionInitPayload", () => {
  it("1º nome, doc mascarado + hash dos dígitos; sem customer_name/document", () => {
    const p = buildSessionInitPayload(INIT)
    expect(p.type).toBe("session.init")
    expect(p.first_name).toBe("Maria")
    expect(p.document_masked).toBe("***.444.777-**")
    expect(p.document_hash).toBe(createHash("sha256").update(CPF).digest("hex"))
    expect(p).not.toHaveProperty("customer_name")
    expect(p).not.toHaveProperty("document")
    expect(p.debt_id).toBe("debt-1")
    expect(p.thread_id).toBe("thr-1")
    assertNoPlainPii(JSON.stringify(p))
  })

  it("documento formatado gera o mesmo hash dos dígitos", () => {
    const p = buildSessionInitPayload({ ...INIT, document: "111.444.777-35" })
    expect(p.document_hash).toBe(createHash("sha256").update(CPF).digest("hex"))
  })
})

describe("engineSessionInit → n8n", () => {
  it("sem N8N_SESSION_FLOW_URL: não chama nada", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    process.env.NEGOTIATION_ENGINE = "n8n"
    await engineSessionInit(INIT)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("com N8N_SESSION_FLOW_URL: o corpo POSTado não tem nome completo nem CPF em claro", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    process.env.NEGOTIATION_ENGINE = "n8n"
    process.env.N8N_WEBHOOK_SECRET = "test-n8n-secret"
    process.env.N8N_SESSION_FLOW_URL = "https://n8n.example.test/webhook/session"
    await engineSessionInit(INIT)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)
    assertNoPlainPii(body)
    const parsed = JSON.parse(body)
    expect(parsed.type).toBe("session.init")
    expect(parsed.first_name).toBe("Maria")
    expect(parsed.document_masked).toBe("***.444.777-**")
  })
})
