// N7: resolver por documento. Fonte primária = customers; consolidado; nunca
// cruza company_id; só-VMAX-sem-customers → null; sem dívida aberta → null.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"

const CO_A = "aaaaaaaa-0000-0000-0000-000000000001"
const CO_B = "bbbbbbbb-0000-0000-0000-000000000002"

let db: FakeDb
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => makeFakeSupabase(db),
}))

// aging é relativo a hoje; usamos uma data bem antiga para garantir aging > 0.
const OLD_DUE = "2020-01-01"

async function importResolver() {
  return await import("@/lib/journey/resolver")
}

describe("resolveByDocument", () => {
  beforeEach(() => {
    db = {
      customers: [
        { id: "cust_a", company_id: CO_A, name: "Fabio Silva", document: "111.444.777-35" },
        { id: "cust_b", company_id: CO_B, name: "Outro Cliente", document: "11144477735" },
      ],
      debts: [
        { id: "debt_a1", company_id: CO_A, customer_id: "cust_a", status: "pending", amount: 100, current_amount: 100, due_date: OLD_DUE },
        { id: "debt_a2", company_id: CO_A, customer_id: "cust_a", status: "in_negotiation", amount: 200, current_amount: 200, due_date: "2021-06-01" },
        { id: "debt_a3", company_id: CO_A, customer_id: "cust_a", status: "paid", amount: 50, current_amount: 50, due_date: "2022-01-01" },
        { id: "debt_b1", company_id: CO_B, customer_id: "cust_b", status: "pending", amount: 999, current_amount: 999, due_date: OLD_DUE },
      ],
      vmax_invoices: [
        { id_company: CO_A, doc: "11144477735", fatura: "F1", vencimento: OLD_DUE, saldo: 100 },
      ],
    }
  })

  it("resolve consolidado: todas as abertas, primária = mais antiga", async () => {
    const { resolveByDocument } = await importResolver()
    const r = await resolveByDocument({ companyId: CO_A, document: "111.444.777-35" })
    expect(r).not.toBeNull()
    expect(r!.customerId).toBe("cust_a")
    expect(r!.debtIds.sort()).toEqual(["debt_a1", "debt_a2"]) // paid excluída
    expect(r!.primaryDebtId).toBe("debt_a1") // due_date mais antigo
    expect(r!.totalOpen).toBe(300)
    expect(r!.agingDays).toBeGreaterThan(0)
    expect(r!.invoiceCount).toBe(1)
  })

  it("normaliza documento dos dois lados (pontuação irrelevante)", async () => {
    const { resolveByDocument } = await importResolver()
    const r = await resolveByDocument({ companyId: CO_A, document: "11144477735" })
    expect(r?.customerId).toBe("cust_a")
  })

  it("NUNCA cruza company_id (mesmo doc em outro tenant não vaza)", async () => {
    const { resolveByDocument } = await importResolver()
    const r = await resolveByDocument({ companyId: CO_A, document: "111.444.777-35" })
    expect(r?.debtIds).not.toContain("debt_b1")
  })

  it("só-VMAX-sem-customers → null (não cria registro)", async () => {
    db.customers = [] // documento existe só na VMAX
    const { resolveByDocument } = await importResolver()
    const r = await resolveByDocument({ companyId: CO_A, document: "11144477735" })
    expect(r).toBeNull()
  })

  it("cliente sem dívida aberta → null", async () => {
    db.debts = db.debts.filter((d) => d.customer_id !== "cust_a" || d.status === "paid")
    const { resolveByDocument } = await importResolver()
    const r = await resolveByDocument({ companyId: CO_A, document: "111.444.777-35" })
    expect(r).toBeNull()
  })

  it("documento vazio → null", async () => {
    const { resolveByDocument } = await importResolver()
    expect(await resolveByDocument({ companyId: CO_A, document: "" })).toBeNull()
  })
})
