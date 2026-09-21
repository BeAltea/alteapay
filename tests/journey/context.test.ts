// N7: buildSessionContext. Documento mascarado por padrão; em claro só com
// send_document_to_engine=true E payment_origin='n8n'; valores em centavos;
// sem outra PII (telefone/e-mail nunca entram no payload).
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"

const CO = "cccccccc-0000-0000-0000-000000000003"
const SID = "5e551011-0000-0000-0000-000000000001"

let db: FakeDb
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => makeFakeSupabase(db),
}))
// matriz: evita rede; devolve linha simples
vi.mock("@/lib/negotiation/matrix", () => ({
  resolveMatrixRow: async () => ({
    id: "m1", max_discount_pct: 20, min_entry_pct: 20, max_installments: 3,
    allowed_billing_types: ["PIX", "BOLETO"], proposal_validity_days: 7,
  }),
}))

function seed(cfg: Record<string, any>) {
  db = {
    negotiation_sessions: [
      {
        id: SID, company_id: CO, customer_id: "cust1", debt_id: "debt1",
        primary_debt_id: "debt1", debt_ids: ["debt1", "debt2"], channel: "web_generic",
        engine: "n8n", identity_verified_at: "2026-09-18T10:00:00Z",
        consent_at: "2026-09-18T10:00:00Z", consent_lgpd_at: "2026-09-18T10:00:00Z",
        fulfillment_mode: "A",
      },
    ],
    tenant_chat_config: [{ company_id: CO, branding: { brand_name: "VMAX", slug: "vmax" }, ...cfg }],
    companies: [{ id: CO, name: "VMAX LTDA" }],
    customers: [
      { id: "cust1", company_id: CO, name: "Fabio Silva", document: "111.444.777-35", phone: "11999998888", email: "fabio@x.com" },
    ],
    debts: [
      { id: "debt1", company_id: CO, amount: 100.5, due_date: "2020-01-01" },
      { id: "debt2", company_id: CO, amount: 50, due_date: "2021-01-01" },
    ],
    vmax_invoices: [{ id_company: CO, doc: "11144477735", fatura: "F1", vencimento: "2020-01-01", saldo: 100.5 }],
    negotiation_offers: [],
  }
}

describe("buildSessionContext", () => {
  beforeEach(() => seed({ payment_origin: "platform", send_document_to_engine: false }))

  it("mascara o documento por padrão e nunca envia PII extra", async () => {
    const { buildSessionContext } = await import("@/lib/journey/context")
    const ctx = await buildSessionContext(SID, 2)
    expect(ctx).not.toBeNull()
    expect(ctx!.customer.document).toBeNull()
    expect(ctx!.customer.document_masked).toBe("***.444.777-**")
    expect(ctx!.customer.document_hash).toHaveLength(64)
    // telefone/e-mail não aparecem em lugar nenhum do payload
    const json = JSON.stringify(ctx)
    expect(json).not.toContain("11999998888")
    expect(json).not.toContain("fabio@x.com")
    expect(json).not.toContain("11144477735") // documento em claro nunca
  })

  it("valores monetários em centavos", async () => {
    const { buildSessionContext } = await import("@/lib/journey/context")
    const ctx = await buildSessionContext(SID)
    expect(ctx!.debt.original_value).toBe(15050) // (100.5 + 50) * 100
    expect(ctx!.debt.updated_value).toBe(15050)
    expect(ctx!.debt.ids).toEqual(["debt1", "debt2"]) // consolidado
    expect(ctx!.debt.id).toBe("debt1")
  })

  it("documento em claro SÓ com as duas flags (send=true E origin=n8n)", async () => {
    seed({ payment_origin: "n8n", send_document_to_engine: true })
    const { buildSessionContext } = await import("@/lib/journey/context")
    const ctx = await buildSessionContext(SID)
    expect(ctx!.customer.document).toBe("11144477735")
  })

  it("uma flag só NÃO libera o documento em claro", async () => {
    seed({ payment_origin: "platform", send_document_to_engine: true })
    const { buildSessionContext } = await import("@/lib/journey/context")
    const ctx = await buildSessionContext(SID)
    expect(ctx!.customer.document).toBeNull()
  })

  it("turn_index e verified/consent refletem a sessão", async () => {
    const { buildSessionContext } = await import("@/lib/journey/context")
    const ctx = await buildSessionContext(SID, 5)
    expect(ctx!.session.turn_index).toBe(5)
    expect(ctx!.session.verified).toBe(true)
    expect(ctx!.session.consent).toBe(true)
    expect(ctx!.session.channel).toBe("web_generic")
  })
})
