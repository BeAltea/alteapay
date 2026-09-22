// N7: resolver por documento. Fonte primária = customers; consolidado; nunca
// cruza company_id; só-VMAX-sem-customers → null; sem dívida aberta → null.
//
// BUG CRÍTICO corrigido aqui: a busca do customer NÃO pode "carregar todos +
// find()" (limite de 1000 linhas do PostgREST deixava ~68% da VMAX invisível).
// Agora: query DIRETA por `.in("document", candidates)` + fallback paginado
// (.range) para formatos atípicos. Este arquivo usa um fake próprio que suporta
// .in/.filter/.range/.order/.limit — o fake compartilhado não tem .range.
import { beforeEach, describe, expect, it, vi } from "vitest"

type Row = Record<string, any>
interface Db {
  customers: Row[]
  debts: Row[]
  vmax_invoices: Row[]
  agreements: Row[]
}

const CO_A = "aaaaaaaa-0000-0000-0000-000000000001"
const CO_B = "bbbbbbbb-0000-0000-0000-000000000002"

// aging é relativo a hoje; usamos uma data bem antiga para garantir aging > 0.
const OLD_DUE = "2020-01-01"

// Contadores de observabilidade: provam qual caminho a busca do customer tomou.
let calls: { customerIn: number; customerRange: number }

let db: Db

// Fake Supabase mínimo p/ o resolver: suporta a query direta (.in) e o fallback
// paginado (.range). Cada builder resolve como thenable no final da cadeia.
function makeFake(database: Db) {
  return {
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = []
      let orderCol: string | null = null
      let orderAsc = true
      let limitN: number | null = null
      let rangeFrom: number | null = null
      let rangeTo: number | null = null

      const builder: any = {
        select() {
          return builder
        },
        eq(col: string, val: any) {
          filters.push((r) => r[col] === val)
          return builder
        },
        in(col: string, vals: any[]) {
          if (table === "customers" && col === "document") calls.customerIn++
          filters.push((r) => vals.includes(r[col]))
          return builder
        },
        filter(col: string, op: string, _val: any) {
          if (op === "not.is") filters.push((r) => r[col] != null)
          return builder
        },
        order(col: string, opts?: { ascending?: boolean }) {
          orderCol = col
          orderAsc = opts?.ascending !== false
          return builder
        },
        limit(n: number) {
          limitN = n
          return builder
        },
        range(from: number, to: number) {
          if (table === "customers") calls.customerRange++
          rangeFrom = from
          rangeTo = to
          return builder
        },
        run() {
          let out = (database[table as keyof Db] ?? []).filter((r) =>
            filters.every((f) => f(r)),
          )
          if (orderCol) {
            const col = orderCol
            out = [...out].sort((a, b) => {
              const av = a[col]
              const bv = b[col]
              if (av === bv) return 0
              const cmp = av < bv ? -1 : 1
              return orderAsc ? cmp : -cmp
            })
          }
          if (rangeFrom != null && rangeTo != null) out = out.slice(rangeFrom, rangeTo + 1)
          if (limitN != null) out = out.slice(0, limitN)
          return { data: out, error: null }
        },
        then(resolve: (r: { data: Row[]; error: null }) => void) {
          resolve(builder.run())
        },
      }
      return builder
    },
  }
}

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => makeFake(db),
}))

async function importResolver() {
  return await import("@/lib/journey/resolver")
}

describe("resolveByDocument", () => {
  beforeEach(() => {
    calls = { customerIn: 0, customerRange: 0 }
    db = {
      customers: [
        // doc PONTUADO na base (poucos casos reais)
        { id: "cust_a", company_id: CO_A, name: "Fabio Silva", document: "111.444.777-35" },
        // doc CRU na base (a esmagadora maioria da VMAX)
        { id: "cust_b", company_id: CO_B, name: "Outro Cliente", document: "11144477735" },
      ],
      debts: [
        { id: "debt_a1", company_id: CO_A, customer_id: "cust_a", status: "pending", amount: 100, due_date: OLD_DUE, updated_at: "2021-01-01T00:00:00.000Z" },
        { id: "debt_a2", company_id: CO_A, customer_id: "cust_a", status: "in_negotiation", amount: 200, due_date: "2021-06-01", updated_at: "2021-06-02T00:00:00.000Z" },
        { id: "debt_a3", company_id: CO_A, customer_id: "cust_a", status: "paid", amount: 50, due_date: "2022-01-01", updated_at: "2022-02-01T00:00:00.000Z" },
        { id: "debt_b1", company_id: CO_B, customer_id: "cust_b", status: "pending", amount: 999, due_date: OLD_DUE, updated_at: "2021-01-01T00:00:00.000Z" },
      ],
      vmax_invoices: [
        { id_company: CO_A, doc: "11144477735", fatura: "F1", vencimento: OLD_DUE, saldo: 100 },
      ],
      agreements: [],
    }
  })

  it("resolve consolidado (kind='open'): todas as abertas, primária = mais antiga", async () => {
    const { resolveByDocument } = await importResolver()
    const r = await resolveByDocument({ companyId: CO_A, document: "111.444.777-35" })
    expect(r.kind).toBe("open")
    if (r.kind !== "open") throw new Error("esperava kind=open")
    expect(r.debtor.customerId).toBe("cust_a")
    expect(r.debtor.debtIds.sort()).toEqual(["debt_a1", "debt_a2"]) // paid excluída das abertas
    expect(r.debtor.primaryDebtId).toBe("debt_a1") // due_date mais antigo
    expect(r.debtor.totalOpen).toBe(300)
    expect(r.debtor.agingDays).toBeGreaterThan(0)
    expect(r.debtor.invoiceCount).toBe(1)
  })

  it("resolve pela query DIRETA (.in), sem varrer todos os customers", async () => {
    const { resolveByDocument } = await importResolver()
    // doc CRU no input casa com o cust_b (doc CRU na base) — mas em CO_B.
    // Testamos em CO_A com input CRU → candidato pontuado casa o cust_a.
    const r = await resolveByDocument({ companyId: CO_A, document: "11144477735" })
    expect(r.kind === "open" && r.debtor.customerId).toBe("cust_a")
    expect(calls.customerIn).toBe(1) // usou a query direta
    expect(calls.customerRange).toBe(0) // NÃO precisou do fallback paginado
  })

  it("input pontuado + base CRUA resolve (normalização casa)", async () => {
    // cust_b tem doc CRU; buscamos no CO_B com input PONTUADO
    const { resolveByDocument } = await importResolver()
    const r = await resolveByDocument({ companyId: CO_B, document: "111.444.777-35" })
    expect(r.kind === "open" && r.debtor.customerId).toBe("cust_b")
    expect(calls.customerRange).toBe(0)
  })

  it("input CRU + base CRUA resolve (candidato cru casa direto)", async () => {
    const { resolveByDocument } = await importResolver()
    const r = await resolveByDocument({ companyId: CO_B, document: "11144477735" })
    expect(r.kind === "open" && r.debtor.customerId).toBe("cust_b")
  })

  it("NUNCA cruza company_id (mesmo doc em outro tenant não vaza)", async () => {
    const { resolveByDocument } = await importResolver()
    const r = await resolveByDocument({ companyId: CO_A, document: "111.444.777-35" })
    expect(r.kind === "open" && r.debtor.debtIds).not.toContain("debt_b1")
  })

  it("documento inexistente → kind='none'", async () => {
    const { resolveByDocument } = await importResolver()
    const r = await resolveByDocument({ companyId: CO_A, document: "99999999999" })
    expect(r).toEqual({ kind: "none" })
  })

  it("só-VMAX-sem-customers → kind='none' (não cria registro)", async () => {
    db.customers = [] // documento existe só na VMAX
    const { resolveByDocument } = await importResolver()
    const r = await resolveByDocument({ companyId: CO_A, document: "11144477735" })
    expect(r).toEqual({ kind: "none" })
  })

  it("cliente só com dívida PAGA → kind='settled' (quitado, consolida valor/vencimento/data)", async () => {
    // remove as abertas; sobra só a debt_a3 (paid). Sem agreement → paidAt cai no
    // fallback debts.updated_at.
    db.debts = db.debts.filter((d) => d.id === "debt_a3")
    const { resolveByDocument } = await importResolver()
    const r = await resolveByDocument({ companyId: CO_A, document: "111.444.777-35" })
    expect(r.kind).toBe("settled")
    if (r.kind !== "settled") throw new Error("esperava kind=settled")
    expect(r.debtor.customerId).toBe("cust_a")
    expect(r.debtor.paidDebtIds).toEqual(["debt_a3"])
    expect(r.debtor.totalPaid).toBe(50)
    expect(r.debtor.oldestDueDate).toBe("2022-01-01")
    expect(r.debtor.paidAt).toBe("2022-02-01T00:00:00.000Z") // fallback updated_at
  })

  it("dívida paga: data de pagamento vem do agreement (payment_received_at), mais recente vence", async () => {
    db.debts = db.debts.filter((d) => d.id === "debt_a3")
    db.agreements = [
      { id: "agr1", company_id: CO_A, debt_id: "debt_a3", payment_received_at: "2026-05-10T12:00:00.000Z", asaas_payment_date: "2026-05-09" },
    ]
    const { resolveByDocument } = await importResolver()
    const r = await resolveByDocument({ companyId: CO_A, document: "111.444.777-35" })
    expect(r.kind).toBe("settled")
    if (r.kind !== "settled") throw new Error("esperava kind=settled")
    expect(r.debtor.paidAt).toBe("2026-05-10T12:00:00.000Z") // payment_received_at tem prioridade
  })

  it("cliente sem dívida NENHUMA (nem aberta nem paga) → kind='none'", async () => {
    db.debts = db.debts.filter((d) => d.customer_id !== "cust_a")
    const { resolveByDocument } = await importResolver()
    const r = await resolveByDocument({ companyId: CO_A, document: "111.444.777-35" })
    expect(r).toEqual({ kind: "none" })
  })

  it("documento vazio → kind='none'", async () => {
    const { resolveByDocument } = await importResolver()
    expect(await resolveByDocument({ companyId: CO_A, document: "" })).toEqual({ kind: "none" })
  })

  it("fallback paginado (.range) acha o customer em formato atípico", async () => {
    // Documento gravado com espaços/pontuação PARCIAL não coberta pelos
    // candidatos [cru, pontuado] → a query direta (.in) vem vazia e o fallback
    // paginado casa por dígitos normalizados.
    db.customers = [
      { id: "cust_odd", company_id: CO_A, name: "Formato Atípico", document: "330 366 958 93" },
    ]
    db.debts = [
      { id: "debt_odd", company_id: CO_A, customer_id: "cust_odd", status: "pending", amount: 42, due_date: OLD_DUE, updated_at: null },
    ]
    db.vmax_invoices = []
    const { resolveByDocument } = await importResolver()
    const r = await resolveByDocument({ companyId: CO_A, document: "330.366.958-93" })
    expect(r.kind).toBe("open")
    if (r.kind !== "open") throw new Error("esperava kind=open")
    expect(r.debtor.customerId).toBe("cust_odd")
    expect(r.debtor.debtIds).toEqual(["debt_odd"])
    expect(calls.customerIn).toBe(1) // tentou a direta primeiro
    expect(calls.customerRange).toBeGreaterThanOrEqual(1) // e caiu no fallback
  })

  it("status filter: pending + in_negotiation viram 'open'; paid vira 'settled'; cancelled ignorada", async () => {
    // com abertas presentes → open (paid não entra no consolidado de abertas)
    db.debts = [
      { id: "d_pending", company_id: CO_A, customer_id: "cust_a", status: "pending", amount: 10, due_date: OLD_DUE, updated_at: null },
      { id: "d_inneg", company_id: CO_A, customer_id: "cust_a", status: "in_negotiation", amount: 20, due_date: "2021-01-01", updated_at: null },
      { id: "d_paid", company_id: CO_A, customer_id: "cust_a", status: "paid", amount: 30, due_date: "2021-02-01", updated_at: "2021-03-01T00:00:00.000Z" },
      { id: "d_cancelled", company_id: CO_A, customer_id: "cust_a", status: "cancelled", amount: 40, due_date: "2021-03-01", updated_at: null },
    ]
    const { resolveByDocument } = await importResolver()
    const r = await resolveByDocument({ companyId: CO_A, document: "111.444.777-35" })
    expect(r.kind).toBe("open")
    if (r.kind !== "open") throw new Error("esperava kind=open")
    expect(r.debtor.debtIds.sort()).toEqual(["d_inneg", "d_pending"])
    expect(r.debtor.totalOpen).toBe(30)
  })
})

describe("documentCandidates", () => {
  it("CPF (11 díg) → [cru, pontuado XXX.XXX.XXX-XX]", async () => {
    const { documentCandidates } = await importResolver()
    expect(documentCandidates("33036695893")).toEqual(["33036695893", "330.366.958-93"])
  })

  it("CNPJ (14 díg) → [cru, pontuado XX.XXX.XXX/XXXX-XX]", async () => {
    const { documentCandidates } = await importResolver()
    expect(documentCandidates("11222333000181")).toEqual([
      "11222333000181",
      "11.222.333/0001-81",
    ])
  })

  it("comprimento atípico → só o valor cru (fallback cobre o resto)", async () => {
    const { documentCandidates } = await importResolver()
    expect(documentCandidates("123")).toEqual(["123"])
  })
})
