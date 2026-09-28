// F-5: a fatura do ASAAS não dizia de quem era a dívida — é onde o devedor
// desconfiado desiste. A descrição da cobrança (a MESMA string alimenta a fila e
// o inline) passa a nomear o credor: branding.brand_name › companies.name (mesma
// precedência da jornada), lido uma vez no Promise.all do fechamento e sempre
// filtrado por company_id. Formato curto, sem "plano"/"assinatura" (o webhook
// usa essas palavras para reconhecer assinatura da plataforma).
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "../journey/_fake-supabase"

let db: FakeDb = {}
const inlineJobs: any[] = []
const queuedJobs: any[] = []

vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => makeFakeSupabase(db) }))
vi.mock("@/lib/journey/charge-inline", () => ({
  createAsaasChargeInline: async (job: any) => { inlineJobs.push(job); return { ok: true, row: null } },
}))
vi.mock("@/lib/queue/queues", () => ({ chargeQueue: { add: async (_n: string, job: any) => { queuedJobs.push(job) } } }))
vi.mock("@/lib/asaas", () => ({ updateAsaasCustomer: async () => ({}) }))

const CO = "eeeeeeee-0000-0000-0000-0000000000f5"
const OTHER = "eeeeeeee-0000-0000-0000-0000000000f6"
const DEBT = "d5000000-0000-4000-8000-0000000000f5"
const CUST = "c5000000-0000-0000-0000-0000000000f5"

function seed(opts: { brand?: string | null; companyName?: string | null } = {}) {
  db = {
    companies: [
      { id: CO, name: opts.companyName === undefined ? "VMAX Telecom" : opts.companyName },
      { id: OTHER, name: "Outra Empresa" },
    ],
    tenant_chat_config: [
      ...(opts.brand === undefined ? [] : [{ company_id: CO, branding: opts.brand === null ? {} : { brand_name: opts.brand } }]),
      { company_id: OTHER, branding: { brand_name: "Marca de Outro Tenant" } },
    ],
    debts: [{ id: DEBT, company_id: CO, customer_id: CUST, amount: 250, status: "pending", due_date: "2026-08-15" }],
    customers: [{ id: CUST, company_id: CO, name: "Devedor", document: "11144477735", email: null, phone: null }],
    agreements: [],
  }
  inlineJobs.length = 0
  queuedJobs.length = 0
}

const journey = (installments: number) => ({
  session_id: "5e550000-0000-4000-8000-0000000000f5",
  offer_row_id: "0ffe0000-0000-4000-8000-0000000000f5",
  terms: {
    total_value: 243.75, installments, installment_value: Math.round((243.75 / installments) * 100) / 100,
    billing_type: "BOLETO" as const, first_due_date: "2026-10-04",
  },
  valid_until: null,
})

async function close(installments: number) {
  const { closeAgreement } = await import("@/lib/negotiation/close-agreement")
  const r = await closeAgreement({
    company_id: CO, debt_id: DEBT, offer_id: "journey", origin: "test", customer_id_hint: CUST, journey: journey(installments),
  })
  expect(r.ok).toBe(true)
  return r as { ok: true; agreement_id: string }
}

describe("chargeDescription (formato)", () => {
  it("à vista e parcelado nomeiam o credor e trazem o id curto do acordo", async () => {
    const { chargeDescription } = await import("@/lib/negotiation/close-agreement")
    const id = "2f516142-66b5-4b18-a819-17c37c527b4c"
    expect(chargeDescription({ creditorName: "VMAX", agreementId: id, installments: 1 })).toBe("VMAX — acordo 2f516142, pagamento à vista")
    expect(chargeDescription({ creditorName: "VMAX", agreementId: id, installments: 3 })).toBe("VMAX — acordo 2f516142")
    // o ASAAS prefixa "Parcela N de M." — nada de "parcela 1/N" contraditório (F8-03)
    expect(`Parcela 2 de 3. ${chargeDescription({ creditorName: "VMAX", agreementId: id, installments: 3 })}`)
      .toBe("Parcela 2 de 3. VMAX — acordo 2f516142")
  })

  it("sem nome: descrição neutra (nunca 'null'/'undefined')", async () => {
    const { chargeDescription } = await import("@/lib/negotiation/close-agreement")
    expect(chargeDescription({ creditorName: null, agreementId: "abcdef12-0000", installments: 1 })).toBe("Acordo abcdef12, pagamento à vista")
    expect(chargeDescription({ creditorName: "   ", agreementId: "abcdef12-0000", installments: 2 })).toBe("Acordo abcdef12")
  })

  it("nunca contém 'plano'/'assinatura' (o webhook trataria como assinatura da plataforma)", async () => {
    const { chargeDescription } = await import("@/lib/negotiation/close-agreement")
    for (const name of ["Plano de Saúde Ideal", "ASSINATURA Digital", "Planó X"]) {
      for (const n of [1, 3]) {
        const d = chargeDescription({ creditorName: name, agreementId: "abcdef12-0000", installments: n }).toLowerCase()
        expect(d.includes("plano")).toBe(false)
        expect(d.includes("assinatura")).toBe(false)
      }
    }
  })

  it("curta: espaços colapsados e nome limitado a 60 caracteres", async () => {
    const { chargeDescription } = await import("@/lib/negotiation/close-agreement")
    const d = chargeDescription({ creditorName: `  Credor   ${"x".repeat(200)}  `, agreementId: "abcdef12-0000", installments: 1 })
    expect(d.startsWith("Credor x")).toBe(true)
    expect(d.length).toBeLessThanOrEqual(60 + " — acordo abcdef12, pagamento à vista".length)
  })
})

describe("closeAgreement usa a descrição com o credor (inline e fila)", () => {
  beforeEach(() => seed({ brand: "VMAX" }))

  it("inline à vista: brand_name do tenant", async () => {
    process.env.CHARGE_MODE = "inline"
    const r = await close(1)
    expect(inlineJobs).toHaveLength(1)
    expect(inlineJobs[0].payment.description).toBe(`VMAX — acordo ${r.agreement_id.slice(0, 8)}, pagamento à vista`)
  })

  it("fila parcelado: a mesma string, sem sufixo de parcela", async () => {
    process.env.CHARGE_MODE = "queue"
    const r = await close(3)
    expect(queuedJobs).toHaveLength(1)
    expect(queuedJobs[0].payment.description).toBe(`VMAX — acordo ${r.agreement_id.slice(0, 8)}`)
    expect(queuedJobs[0].payment.installmentCount).toBe(3)
  })

  it("sem branding: cai em companies.name da MESMA empresa (nunca a marca de outro tenant)", async () => {
    seed({ brand: null })
    process.env.CHARGE_MODE = "inline"
    const r = await close(1)
    expect(inlineJobs[0].payment.description).toBe(`VMAX Telecom — acordo ${r.agreement_id.slice(0, 8)}, pagamento à vista`)
    expect(inlineJobs[0].payment.description).not.toContain("Outro")
  })

  it("sem nome algum: descrição neutra e a cobrança sai normalmente", async () => {
    seed({ brand: null, companyName: null })
    process.env.CHARGE_MODE = "inline"
    const r = await close(2)
    expect(inlineJobs[0].payment.description).toBe(`Acordo ${r.agreement_id.slice(0, 8)}`)
  })
})
