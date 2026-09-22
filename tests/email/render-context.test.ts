// D1 — contexto de DÉBITO do e-mail de cobrança (render-context.ts).
//   - reusa buildAckContext (C4) para valor/vencimento/qtd (mock);
//   - formata pt-BR (R$ / DD/MM/AAAA) e normaliza nome (CAPS→Title);
//   - falha FECHADA com reason estável (sem_nome/sem_valor/sem_vencimento/
//     documento_invalido/link_indisponivel);
//   - link fora do ar bloqueia a campanha inteira.
import { beforeEach, describe, expect, it, vi } from "vitest"

// ---------------------------------------------------------------------------
// Fake supabase: tabelas customers / tenant_chat_config em memória. Suporta
// eq/in/range/maybeSingle e o then() de leitura em lista.
// ---------------------------------------------------------------------------
type Row = Record<string, any>
interface DB {
  customers: Row[]
  tenant_chat_config: Row[]
}
let db: DB

interface F { op: "eq" | "in"; col: string; val: any }
class QB {
  filters: F[] = []
  constructor(private t: keyof DB) {}
  select() { return this }
  eq(col: string, val: any) { this.filters.push({ op: "eq", col, val }); return this }
  in(col: string, val: any[]) { this.filters.push({ op: "in", col, val }); return this }
  range() { return this }
  private match(r: Row, f: F): boolean {
    const v = r[f.col]
    return f.op === "eq" ? v === f.val : (f.val as any[]).includes(v)
  }
  private filtered(): Row[] {
    return (db[this.t] ?? []).filter((r) => this.filters.every((f) => this.match(r, f)))
  }
  async maybeSingle() { return { data: this.filtered()[0] ?? null, error: null } }
  then(res: (r: { data: Row[]; error: null }) => void) { res({ data: this.filtered(), error: null }) }
}
const fakeClient = { from: (t: keyof DB) => new QB(t) } as any

vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => fakeClient }))

// buildAckContext mockado: devolve o que o "chat" mostraria por customerId.
const ackByCustomer: Record<string, { updatedValue: number; oldestDueDate: string | null; invoiceCount: number; firstName: string }> = {}
vi.mock("@/lib/journey/acknowledgement", () => ({
  buildAckContext: vi.fn(async (input: { customerId: string }) => {
    const a = ackByCustomer[input.customerId] ?? { updatedValue: 0, oldestDueDate: null, invoiceCount: 0, firstName: "" }
    return { creditorName: "VMAX", ...a }
  }),
}))

const CO = "1f7729ee-a537-43fc-a27f-5747c177988d"
// CPF válido (DV correto): 111.444.777-35
const VALID_CPF = "11144477735"

function seedLinkOn() {
  db.tenant_chat_config = [
    { company_id: CO, public_link_code: "k7Qm3Xb9Rt", public_link_enabled: true, public_link_valid_until: null },
  ]
}

beforeEach(() => {
  db = { customers: [], tenant_chat_config: [] }
  for (const k of Object.keys(ackByCustomer)) delete ackByCustomer[k]
})

describe("resolveDebtEmailContext — sucesso (reusa buildAckContext)", () => {
  it("monta as 5 vars formatadas em pt-BR, reusando valor/venc/qtd do buildAckContext", async () => {
    seedLinkOn()
    db.customers = [{ id: "c1", company_id: CO, name: "JOSE DA SILVA", document: VALID_CPF }]
    ackByCustomer["c1"] = { updatedValue: 199.8, oldestDueDate: "2026-04-15", invoiceCount: 1, firstName: "Jose" }

    const { resolveDebtEmailContext } = await import("@/lib/email/templates/render-context")
    const map = await resolveDebtEmailContext(CO, [{ customerId: "c1", debtIds: ["d1"] }])
    const entry = map.get("c1")!
    expect(entry.ok).toBe(true)
    if (!entry.ok) return
    expect(entry.ctx.nome_cliente).toBe("Jose Da Silva") // CAPS → Title
    expect(entry.ctx.primeiro_nome).toBe("Jose")
    expect(entry.ctx.documento_mascarado).toBe("***.444.777-**")
    expect(entry.ctx.valor_divida.replace(/\u00a0/g, " ")).toBe("R$ 199,80")
    expect(entry.ctx.vencimento_original).toBe("15/04/2026")
    // 1 fatura → frase VAZIA (não o dígito cru "1"): o corpo não mostra contador.
    expect(entry.ctx.qtd_faturas).toBe("")
  })

  it("chama buildAckContext com os debtIds do devedor (paridade com o chat)", async () => {
    seedLinkOn()
    db.customers = [{ id: "c1", company_id: CO, name: "Maria Souza", document: VALID_CPF }]
    ackByCustomer["c1"] = { updatedValue: 50, oldestDueDate: "2025-11-10", invoiceCount: 2, firstName: "Maria" }
    const ack = await import("@/lib/journey/acknowledgement")
    const { resolveDebtEmailContext } = await import("@/lib/email/templates/render-context")
    const map = await resolveDebtEmailContext(CO, [{ customerId: "c1", debtIds: ["dA", "dB"] }])
    expect(ack.buildAckContext).toHaveBeenCalledWith({ companyId: CO, customerId: "c1", debtIds: ["dA", "dB"] })
    // >1 fatura → frase pronta (texto puro, sem tags), não o dígito cru "2".
    const entry = map.get("c1")!
    expect(entry.ok).toBe(true)
    if (entry.ok) {
      expect(entry.ctx.qtd_faturas).toBe("Este valor reúne 2 faturas em aberto.")
      expect(entry.ctx.qtd_faturas).not.toContain("<")
    }
  })
})

describe("resolveDebtEmailContext — falha FECHADA por devedor (reasons estáveis)", () => {
  it("sem_nome quando o nome é vazio/numérico/<2 chars", async () => {
    seedLinkOn()
    db.customers = [
      { id: "c1", company_id: CO, name: "", document: VALID_CPF },
      { id: "c2", company_id: CO, name: "12345", document: VALID_CPF },
      { id: "c3", company_id: CO, name: "A", document: VALID_CPF },
    ]
    ackByCustomer["c1"] = { updatedValue: 100, oldestDueDate: "2026-01-01", invoiceCount: 1, firstName: "" }
    ackByCustomer["c2"] = ackByCustomer["c1"]
    ackByCustomer["c3"] = ackByCustomer["c1"]
    const { resolveDebtEmailContext } = await import("@/lib/email/templates/render-context")
    const map = await resolveDebtEmailContext(CO, [
      { customerId: "c1", debtIds: ["d"] },
      { customerId: "c2", debtIds: ["d"] },
      { customerId: "c3", debtIds: ["d"] },
    ])
    for (const id of ["c1", "c2", "c3"]) {
      const e = map.get(id)!
      expect(e.ok).toBe(false)
      if (!e.ok) expect(e.reason).toBe("sem_nome")
    }
  })

  it("documento_invalido quando o CPF não passa no DV", async () => {
    seedLinkOn()
    db.customers = [{ id: "c1", company_id: CO, name: "Jose Silva", document: "12345678900" }]
    ackByCustomer["c1"] = { updatedValue: 100, oldestDueDate: "2026-01-01", invoiceCount: 1, firstName: "Jose" }
    const { resolveDebtEmailContext } = await import("@/lib/email/templates/render-context")
    const e = (await resolveDebtEmailContext(CO, [{ customerId: "c1", debtIds: ["d"] }])).get("c1")!
    expect(e.ok).toBe(false)
    if (!e.ok) expect(e.reason).toBe("documento_invalido")
  })

  it("sem_valor quando updatedValue <= 0", async () => {
    seedLinkOn()
    db.customers = [{ id: "c1", company_id: CO, name: "Jose Silva", document: VALID_CPF }]
    ackByCustomer["c1"] = { updatedValue: 0, oldestDueDate: "2026-01-01", invoiceCount: 1, firstName: "Jose" }
    const { resolveDebtEmailContext } = await import("@/lib/email/templates/render-context")
    const e = (await resolveDebtEmailContext(CO, [{ customerId: "c1", debtIds: ["d"] }])).get("c1")!
    expect(e.ok).toBe(false)
    if (!e.ok) expect(e.reason).toBe("sem_valor")
  })

  it("sem_vencimento quando oldestDueDate é null/invalid", async () => {
    seedLinkOn()
    db.customers = [{ id: "c1", company_id: CO, name: "Jose Silva", document: VALID_CPF }]
    ackByCustomer["c1"] = { updatedValue: 100, oldestDueDate: null, invoiceCount: 1, firstName: "Jose" }
    const { resolveDebtEmailContext } = await import("@/lib/email/templates/render-context")
    const e = (await resolveDebtEmailContext(CO, [{ customerId: "c1", debtIds: ["d"] }])).get("c1")!
    expect(e.ok).toBe(false)
    if (!e.ok) expect(e.reason).toBe("sem_vencimento")
  })

  it("customer inexistente → sem_nome (falha fechada)", async () => {
    seedLinkOn()
    const { resolveDebtEmailContext } = await import("@/lib/email/templates/render-context")
    const e = (await resolveDebtEmailContext(CO, [{ customerId: "ghost", debtIds: ["d"] }])).get("ghost")!
    expect(e.ok).toBe(false)
    if (!e.ok) expect(e.reason).toBe("sem_nome")
  })
})

describe("resolveDebtEmailContext — link fora do ar bloqueia a campanha inteira", () => {
  it("link desabilitado → TODOS com link_indisponivel", async () => {
    db.customers = [{ id: "c1", company_id: CO, name: "Jose Silva", document: VALID_CPF }]
    db.tenant_chat_config = [
      { company_id: CO, public_link_code: "k7Qm3Xb9Rt", public_link_enabled: false, public_link_valid_until: null },
    ]
    ackByCustomer["c1"] = { updatedValue: 100, oldestDueDate: "2026-01-01", invoiceCount: 1, firstName: "Jose" }
    const { resolveDebtEmailContext } = await import("@/lib/email/templates/render-context")
    const e = (await resolveDebtEmailContext(CO, [{ customerId: "c1", debtIds: ["d"] }])).get("c1")!
    expect(e.ok).toBe(false)
    if (!e.ok) expect(e.reason).toBe("link_indisponivel")
  })

  it("linkAvailable=false passado pelo chamador → link_indisponivel (sem tocar buildAckContext)", async () => {
    const ack = await import("@/lib/journey/acknowledgement")
    ;(ack.buildAckContext as any).mockClear()
    const { resolveDebtEmailContext } = await import("@/lib/email/templates/render-context")
    const e = (
      await resolveDebtEmailContext(CO, [{ customerId: "c1", debtIds: ["d"] }], { linkAvailable: false })
    ).get("c1")!
    expect(e.ok).toBe(false)
    if (!e.ok) expect(e.reason).toBe("link_indisponivel")
    expect(ack.buildAckContext).not.toHaveBeenCalled()
  })
})

describe("helpers de formatação", () => {
  it("normalizeDisplayName: CAPS/lower → Title, colapsa espaços", async () => {
    const { normalizeDisplayName } = await import("@/lib/email/templates/render-context")
    expect(normalizeDisplayName("JOAO   DA  SILVA")).toBe("Joao Da Silva")
    expect(normalizeDisplayName("maria souza")).toBe("Maria Souza")
    expect(normalizeDisplayName("")).toBe("")
  })

  it("formatDatePtBR: DD/MM/AAAA sem timezone-shift para date puro", async () => {
    const { formatDatePtBR } = await import("@/lib/email/templates/render-context")
    expect(formatDatePtBR("2026-04-15")).toBe("15/04/2026")
    expect(formatDatePtBR(null)).toBe("")
    expect(formatDatePtBR("nao-e-data")).toBe("")
  })

  it("formatBRL: R$ pt-BR", async () => {
    const { formatBRL } = await import("@/lib/email/templates/render-context")
    expect(formatBRL(1234.56).replace(/\u00a0/g, " ")).toBe("R$ 1.234,56")
  })
})
