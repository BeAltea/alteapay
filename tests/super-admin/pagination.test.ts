// Paginação REAL server-side da lista de negociações (T5 — follow-up de
// performance). Prova, contra um fake in-memory do service client que HONRA
// eq/in/gte/lte/order/range, que:
//
//  1. A página de dados sai do banco JÁ FATIADA (range(offset,+limit)) — a query
//     NÃO materializa mais o universo inteiro por abertura. Verificamos que só a
//     fatia pedida de negotiation_state é lida com colunas completas.
//  2. Os contadores por estágio (byStage) e o total refletem o UNIVERSO FILTRADO
//     inteiro (não só a página) e batem: sum(byStage) === total (countersReconcile).
//  3. Filtro SATÉLITE (busca por documento mascarado) restringe página, contadores
//     e total ao mesmo conjunto → os contadores continuam fechando.
//  4. "selecionar todos os N filtrados" (resolveFilteredCustomerIds) devolve o
//     conjunto COMPLETO do universo filtrado, não só a página.
//
// O fake registra os `range` pedidos em negotiation_state para provar que a
// leitura de dados completos é limitada à página (a agregação lê só `stage`).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { countersReconcile } from "@/components/super-admin/negotiations/stages"
import { parseFilters } from "@/components/super-admin/negotiations/filters"

const CO = "cccccccc-0000-0000-0000-000000000001"

// -------- dataset in-memory --------
// 12 devedores em 3 estágios. documentos: CPFs válidos p/ mascarar de forma
// determinística. updated_at decrescente ↔ ordem "last_activity".
interface StateRow {
  company_id: string
  customer_id: string
  stage: string
  stage_rank: number
  stage_at: string
  channel: string
  campaign_id: string | null
  has_live_charge: boolean
  provider_status_source: string
  updated_at: string
}

// 5 dispatched, 4 in_chat, 3 paid = 12.
const STAGES: Array<[string, number, number]> = [
  ["dispatched", 20, 5],
  ["in_chat", 60, 4],
  ["paid", 100, 3],
]

const STATE: StateRow[] = []
const CUSTOMERS: Record<string, { name: string; document: string; contact_profile: string }> = {}
let seq = 0
for (const [stage, rank, n] of STAGES) {
  for (let i = 0; i < n; i++) {
    const id = `cust-${String(seq).padStart(2, "0")}`
    // documento determinístico: dígitos do meio variam com seq (para busca).
    const doc = `1114447${String(7730 + seq).padStart(4, "0")}` // 11 dígitos
    STATE.push({
      company_id: CO,
      customer_id: id,
      stage,
      stage_rank: rank,
      stage_at: `2026-09-${String(1 + seq).padStart(2, "0")}T00:00:00Z`,
      channel: "whatsapp",
      campaign_id: null,
      has_live_charge: stage === "paid",
      provider_status_source: "none",
      // updated_at estritamente decrescente com seq → ordem estável p/ paginação.
      updated_at: `2026-09-${String(20 - seq).padStart(2, "0")}T00:00:00Z`,
    })
    CUSTOMERS[id] = { name: `Fulano ${seq}`, document: doc, contact_profile: "mobile" }
    seq++
  }
}
const TOTAL = STATE.length // 12

// range de negotiation_state (colunas COMPLETAS) pedidos — para provar que a
// leitura de dados densos é limitada à página.
const dataRanges: Array<[number, number]> = []

// -------- fake query builder --------
function makeBuilder(table: string) {
  const qb: any = {
    _cols: "*",
    _eq: {} as Record<string, any>,
    _in: {} as Record<string, any[]>,
    _gte: {} as Record<string, string>,
    _lte: {} as Record<string, string>,
    _order: [] as Array<{ col: string; asc: boolean }>,
    _range: null as null | [number, number],
    select(cols: string) {
      qb._cols = cols ?? "*"
      return qb
    },
    eq(col: string, val: any) {
      qb._eq[col] = val
      return qb
    },
    in(col: string, vals: any[]) {
      qb._in[col] = vals
      return qb
    },
    gte(col: string, val: string) {
      qb._gte[col] = val
      return qb
    },
    lte(col: string, val: string) {
      qb._lte[col] = val
      return qb
    },
    order(col: string, opts?: { ascending?: boolean }) {
      qb._order.push({ col, asc: opts?.ascending ?? true })
      return qb
    },
    range(a: number, b: number) {
      qb._range = [a, b]
      // registra os ranges de negotiation_state com colunas densas (não a
      // agregação que lê só "stage").
      if (table === "negotiation_state" && qb._cols.includes("stage_at")) {
        dataRanges.push([a, b])
      }
      return qb
    },
    then(resolve: (r: { data: any[]; error: null }) => void) {
      resolve({ data: rowsFor(table, qb), error: null })
    },
  }
  return qb
}

function applyCommon(rows: any[], qb: any): any[] {
  let out = rows
  for (const [col, val] of Object.entries(qb._eq)) {
    out = out.filter((r) => r[col] === val)
  }
  for (const [col, vals] of Object.entries(qb._in)) {
    const set = new Set(vals as any[])
    out = out.filter((r) => set.has(r[col]))
  }
  for (const [col, val] of Object.entries(qb._gte)) {
    out = out.filter((r) => String(r[col]) >= String(val))
  }
  for (const [col, val] of Object.entries(qb._lte)) {
    out = out.filter((r) => String(r[col]) <= String(val))
  }
  // ordenação (aplica a sequência de .order na ordem informada).
  if (qb._order.length) {
    out = [...out].sort((a, b) => {
      for (const { col, asc } of qb._order) {
        const av = a[col] ?? ""
        const bv = b[col] ?? ""
        if (av < bv) return asc ? -1 : 1
        if (av > bv) return asc ? 1 : -1
      }
      return 0
    })
  }
  // range (paginação server-side).
  if (qb._range) {
    const [a, b] = qb._range
    out = out.slice(a, b + 1)
  }
  return out
}

function rowsFor(table: string, qb: any): any[] {
  if (table === "negotiation_state") {
    const rows = applyCommon(STATE, qb)
    // projeta só as colunas pedidas (agregação lê "stage, customer_id").
    if (!qb._cols.includes("stage_at")) {
      return rows.map((r) => ({ stage: r.stage, customer_id: r.customer_id }))
    }
    return rows
  }
  if (table === "customers") {
    const ids: string[] = qb._in["id"] ?? Object.keys(CUSTOMERS)
    return ids
      .filter((id) => CUSTOMERS[id])
      .map((id) => ({ id, ...CUSTOMERS[id] }))
  }
  if (table === "companies") return [{ id: CO, name: "VMAX" }]
  if (table === "tenant_chat_config")
    return [{ company_id: CO, public_link_code: "k7Qm3Xb9Rt", public_link_enabled: true }]
  // debts / contact_suppressions / whatsapp_campaigns: vazio.
  return []
}

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({ from: (t: string) => makeBuilder(t) }),
}))

// import DEPOIS do mock (query.ts é server-only; stub no vitest.config).
let queryNegotiations: typeof import("@/components/super-admin/negotiations/query")["queryNegotiations"]
let resolveFilteredCustomerIds: typeof import("@/components/super-admin/negotiations/query")["resolveFilteredCustomerIds"]

beforeEach(async () => {
  dataRanges.length = 0
  const mod = await import("@/components/super-admin/negotiations/query")
  queryNegotiations = mod.queryNegotiations
  resolveFilteredCustomerIds = mod.resolveFilteredCustomerIds
})

afterEach(() => {
  vi.clearAllMocks()
})

describe("paginação server-side — a página sai do banco já fatiada", () => {
  it("devolve só os pageSize da página pedida (range aplicado no banco)", async () => {
    const f = parseFilters(new URLSearchParams({ companyId: CO, pageSize: "5", page: "0" }))
    const res = await queryNegotiations(f)

    expect(res.rows.length).toBe(5)
    expect(res.page).toBe(0)
    expect(res.pageSize).toBe(5)
    // a leitura DENSA de negotiation_state foi limitada à página (range 0..4).
    expect(dataRanges).toContainEqual([0, 4])
    // e nenhuma leitura densa pediu além da 1ª página (não materializou tudo).
    expect(dataRanges.every(([a]) => a === 0)).toBe(true)
  })

  it("a 2ª página lê o próximo range (offset = page*pageSize)", async () => {
    const f = parseFilters(new URLSearchParams({ companyId: CO, pageSize: "5", page: "1" }))
    const res = await queryNegotiations(f)

    expect(res.rows.length).toBe(5)
    expect(res.page).toBe(1)
    // range da 2ª página: 5..9.
    expect(dataRanges).toContainEqual([5, 9])
  })

  it("última página parcial (12 itens, pageSize 5 → página 2 = 2 itens)", async () => {
    const f = parseFilters(new URLSearchParams({ companyId: CO, pageSize: "5", page: "2" }))
    const res = await queryNegotiations(f)
    expect(res.rows.length).toBe(2)
    expect(dataRanges).toContainEqual([10, 14])
  })
})

describe("contadores por estágio — universo filtrado inteiro, sem materializar", () => {
  it("byStage cobre TODOS os devedores filtrados (não só a página) e total = universo", async () => {
    const f = parseFilters(new URLSearchParams({ companyId: CO, pageSize: "5", page: "0" }))
    const res = await queryNegotiations(f)

    expect(res.total).toBe(TOTAL) // 12, mesmo com pageSize 5
    expect(res.byStage).toEqual({ dispatched: 5, in_chat: 4, paid: 3 })
  })

  it("sum(byStage) === total → countersReconcile verdadeiro", async () => {
    const f = parseFilters(new URLSearchParams({ companyId: CO, pageSize: "3", page: "1" }))
    const res = await queryNegotiations(f)
    expect(countersReconcile(res.byStage, res.total)).toBe(true)
  })

  it("filtro de ESTADO (stage) restringe total e contadores coerentemente", async () => {
    const f = parseFilters(
      new URLSearchParams({ companyId: CO, stage: "in_chat", pageSize: "10", page: "0" }),
    )
    const res = await queryNegotiations(f)
    expect(res.total).toBe(4)
    expect(res.byStage).toEqual({ in_chat: 4 })
    expect(countersReconcile(res.byStage, res.total)).toBe(true)
  })
})

describe("filtro SATÉLITE (busca por documento mascarado) — contadores ainda fecham", () => {
  it("busca restringe página, total e contadores ao MESMO conjunto", async () => {
    // documento do cust-00: 11144477730 → mascarado ***.447.773-**.
    // buscamos um fragmento presente só em um subconjunto.
    const doc0 = CUSTOMERS["cust-00"].document // 11144477730
    // fragmento mascarado do meio (447) aparece em vários; escolhemos algo único.
    const f = parseFilters(
      new URLSearchParams({ companyId: CO, q: maskFragment(doc0), pageSize: "50", page: "0" }),
    )
    const res = await queryNegotiations(f)

    // todos os que casam o fragmento mascarado.
    const expectedIds = Object.entries(CUSTOMERS)
      .filter(([, c]) => maskDoc(c.document).includes(maskFragment(doc0)))
      .map(([id]) => id)

    expect(res.total).toBe(expectedIds.length)
    // contadores refletem o subconjunto e fecham.
    const sum = Object.values(res.byStage).reduce((s, c) => s + c, 0)
    expect(sum).toBe(res.total)
    expect(countersReconcile(res.byStage, res.total)).toBe(true)
    // a página só traz devedores do subconjunto.
    for (const row of res.rows) expect(expectedIds).toContain(row.customerId)
  })

  it("busca sem correspondência → resposta vazia coerente (total 0, contadores vazios)", async () => {
    const f = parseFilters(
      new URLSearchParams({ companyId: CO, q: "ZZZ-nao-existe", pageSize: "10", page: "0" }),
    )
    const res = await queryNegotiations(f)
    expect(res.rows).toEqual([])
    expect(res.total).toBe(0)
    expect(res.byStage).toEqual({})
    expect(countersReconcile(res.byStage, res.total)).toBe(true)
  })
})

describe("selecionar todos os N filtrados — conjunto COMPLETO, não só a página", () => {
  it("resolveFilteredCustomerIds devolve todos os ids do universo (12), não a página", async () => {
    const f = parseFilters(new URLSearchParams({ companyId: CO, pageSize: "5", page: "0" }))
    const ids = await resolveFilteredCustomerIds(f)
    expect(ids.length).toBe(TOTAL)
    expect(new Set(ids).size).toBe(TOTAL)
  })

  it("com filtro de estado, resolve só o subconjunto filtrado", async () => {
    const f = parseFilters(new URLSearchParams({ companyId: CO, stage: "paid" }))
    const ids = await resolveFilteredCustomerIds(f)
    expect(ids.length).toBe(3)
  })
})

// -------- helpers de mascaramento (espelho do maskDocument p/ montar a busca) --------
function maskDoc(d: string): string {
  return `***.${d.slice(3, 6)}.${d.slice(6, 9)}-**`
}
function maskFragment(d: string): string {
  // fragmento do meio (posições 6..9) — determinístico e presente no mascarado.
  return `.${d.slice(6, 9)}-`
}
