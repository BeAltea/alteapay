import { describe, it, expect } from "vitest"
import { createHash } from "node:crypto"
import { buildTurnPayload } from "@/lib/negotiation/engine"
import type { NegotiationSession, TenantChatConfig } from "@/lib/negotiation/types"
import type { SessionDebtContext } from "@/lib/negotiation/sessions"

// D-N3-1: o payload REAL enviado ao fluxo n8n (buildTurnPayload) NÃO pode vazar
// o documento em claro por padrão. Claro só com send_document_to_engine=true E
// payment_origin='n8n'. Este teste bate no payload real (o e2e-lab usa stub e
// nunca exercita este caminho).

const DOC = "39053344705" // CPF válido sintético (11 dígitos)

const session = {
  id: "sess-1",
  thread_id: "thread-1",
  company_id: "co-1",
  identity_verified_at: new Date().toISOString(),
  debt_acknowledged_at: null,
  fulfillment_mode: "A",
  outcome: null,
} as unknown as NegotiationSession

const debtor: SessionDebtContext = {
  customer_name: "Cliente Teste",
  document: DOC,
  debt_id: "debt-1",
  amount: 100,
  due_date: "2025-03-10",
  description: null,
  aging_days: 100,
}

function tenant(over: Partial<TenantChatConfig>): TenantChatConfig {
  return {
    payment_origin: "platform",
    send_document_to_engine: false,
    fulfillment_mode: "A",
    ...over,
  } as unknown as TenantChatConfig
}

const base = { session, message: "oi", channel: "n8n" as const, debtor }

describe("buildTurnPayload — masking do documento (D-N3-1)", () => {
  it("mascara por padrão: document=null, mas envia masked+hash", () => {
    const p = buildTurnPayload({ ...base, tenant: tenant({}) }) as any
    expect(p.debtor.document).toBeNull()
    expect(p.debtor.document_masked).toBeTruthy()
    expect(p.debtor.document_masked).not.toContain(DOC)
    expect(p.debtor.document_hash).toBe(createHash("sha256").update(DOC).digest("hex"))
  })

  it("D1: envia só o primeiro nome, nunca o nome completo", () => {
    const p = buildTurnPayload({
      ...base,
      debtor: { ...debtor, customer_name: "Fabio Sobrenome Da Silva" },
      tenant: tenant({}),
    }) as any
    expect(p.debtor.first_name).toBe("Fabio")
    expect(p.debtor.name).toBeUndefined()
  })

  it("NÃO envia claro com só uma flag (send_document_to_engine sem n8n)", () => {
    const p = buildTurnPayload({
      ...base,
      tenant: tenant({ send_document_to_engine: true, payment_origin: "platform" }),
    }) as any
    expect(p.debtor.document).toBeNull()
  })

  it("NÃO envia claro com só payment_origin='n8n' (sem a flag de envio)", () => {
    const p = buildTurnPayload({
      ...base,
      tenant: tenant({ send_document_to_engine: false, payment_origin: "n8n" }),
    }) as any
    expect(p.debtor.document).toBeNull()
  })

  it("envia claro SOMENTE com as 2 flags (send_document_to_engine=true E payment_origin='n8n')", () => {
    const p = buildTurnPayload({
      ...base,
      tenant: tenant({ send_document_to_engine: true, payment_origin: "n8n" }),
    }) as any
    expect(p.debtor.document).toBe(DOC)
  })

  it("tenant null → nunca claro", () => {
    const p = buildTurnPayload({ ...base, tenant: null }) as any
    expect(p.debtor.document).toBeNull()
    expect(p.debtor.document_masked).toBeTruthy()
  })
})
