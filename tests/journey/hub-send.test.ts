// T2 — Hub de envio (link único): precedência de canal, snapshot, roteamento,
// jobId determinístico sem ':', dryRun, e resolução do T3-2 (voxuy_flow_id).
import { beforeEach, describe, expect, it, vi } from "vitest"

// ---------------------------------------------------------------------------
// Fake Supabase próprio (o hub usa .or()/.upsert()/.range(), que o fake padrão
// não cobre). Só o subconjunto que evaluateHubEligibility/runHubSend exercitam.
// ---------------------------------------------------------------------------
type Row = Record<string, any>
interface DB { [t: string]: Row[] }
let db: DB

interface F { op: string; col: string; val?: any; expr?: string }
class QB {
  filters: F[] = []
  orExpr: string | null = null
  limitN: number | null = null
  rangeFrom: number | null = null
  rangeTo: number | null = null
  pInsert: Row[] | null = null
  pUpdate: Row | null = null
  pUpsert: Row[] | null = null
  onConflict: string | null = null
  constructor(private t: string) {}
  select() { return this }
  eq(col: string, val: any) { this.filters.push({ op: "eq", col, val }); return this }
  in(col: string, val: any[]) { this.filters.push({ op: "in", col, val }); return this }
  gte(col: string, val: any) { this.filters.push({ op: "gte", col, val }); return this }
  not(col: string) { this.filters.push({ op: "notNull", col }); return this }
  is(col: string, val: any) { this.filters.push(val === null ? { op: "isNull", col } : { op: "eq", col, val }); return this }
  or(expr: string) { this.orExpr = expr; return this }
  order() { return this }
  limit(n: number) { this.limitN = n; return this }
  range(a: number, b: number) { this.rangeFrom = a; this.rangeTo = b; return this }
  insert(rows: Row | Row[]) { this.pInsert = Array.isArray(rows) ? rows : [rows]; return this }
  update(patch: Row) { this.pUpdate = patch; return this }
  upsert(rows: Row | Row[], opts?: { onConflict?: string }) {
    this.pUpsert = Array.isArray(rows) ? rows : [rows]
    this.onConflict = opts?.onConflict ?? null
    return this
  }
  private match(r: Row, f: F): boolean {
    const v = r[f.col]
    switch (f.op) {
      case "eq": return v === f.val
      case "in": return Array.isArray(f.val) && f.val.includes(v)
      case "gte": return v != null && v >= f.val
      case "notNull": return v != null
      case "isNull": return v == null
      default: return true
    }
  }
  private matchOr(r: Row): boolean {
    if (!this.orExpr) return true
    // formato "colA.eq.valA,colB.eq.valB" — verdadeiro se QUALQUER par casar
    return this.orExpr.split(",").some((clause) => {
      const [col, , val] = clause.split(".")
      return String(r[col]) === val
    })
  }
  private filtered(): Row[] {
    let out = (db[this.t] ??= []).filter((r) => this.filters.every((f) => this.match(r, f)) && this.matchOr(r))
    if (this.limitN != null) out = out.slice(0, this.limitN)
    return out
  }
  private run(): { data: Row[]; error: null } {
    const table = (db[this.t] ??= [])
    if (this.pInsert) {
      const ins = this.pInsert.map((r) => ({ id: r.id ?? `id_${Math.random().toString(36).slice(2, 10)}`, ...r }))
      table.push(...ins)
      return { data: ins, error: null }
    }
    if (this.pUpsert) {
      for (const r of this.pUpsert) {
        const keys = (this.onConflict ?? "id").split(",")
        const idx = table.findIndex((x) => keys.every((k) => x[k] === r[k]))
        if (idx >= 0) Object.assign(table[idx], r)
        else table.push({ id: r.id ?? `id_${Math.random().toString(36).slice(2, 10)}`, ...r })
      }
      return { data: this.pUpsert, error: null }
    }
    if (this.pUpdate) {
      const target = this.filtered()
      for (const row of target) Object.assign(row, this.pUpdate)
      return { data: target, error: null }
    }
    return { data: this.filtered(), error: null }
  }
  async maybeSingle() { const { data } = this.run(); return { data: data[0] ?? null, error: null } }
  async single() { const { data } = this.run(); return { data: data[0] ?? null, error: data[0] ? null : { message: "no rows" } } }
  then(res: (r: { data: Row[]; error: null }) => void) { res(this.run()) }
}
const fakeClient = { from: (t: string) => new QB(t) }

// ---------------------------------------------------------------------------
let queued: any[] = []
let emailCalls: any[] = []
let processed: string[] = []

vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => fakeClient }))
vi.mock("@/lib/queue/queues", () => ({
  whatsappQueue: { add: async (_n: string, data: any, opts: any) => { queued.push({ data, opts }); return { id: opts?.jobId } } },
}))
vi.mock("@/lib/journey/events", () => ({ recordEvent: async () => ({ ok: true, duplicate: false }) }))
vi.mock("@/lib/journey/negotiation-state", () => ({ applyJourneyEventToState: async () => ({ ok: true }) }))
vi.mock("@/lib/journey/email-dispatch", () => ({
  dispatchEmailInvite: async (i: any) => { emailCalls.push(i); return { ok: true, jobId: "email_job" } },
}))
vi.mock("@/lib/journey/suppressions", () => ({ isSuppressed: async () => false }))
vi.mock("@/lib/asaas-idempotency", () => ({ findBlockingAgreement: () => null }))

const CO = "eeeeeeee-0000-0000-0000-000000000012"

function seedCustomer(id: string, over: Partial<Row> = {}) {
  ;(db.customers ??= []).push({ id, company_id: CO, phone: null, email: null, ...over })
  ;(db.debts ??= []).push({ id: `debt_${id}`, customer_id: id, company_id: CO, amount: 500, status: "pending" })
}

beforeEach(() => {
  db = { customers: [], debts: [], agreements: [], negotiation_cases: [], whatsapp_messages: [], whatsapp_campaigns: [], tenant_chat_config: [], companies: [], negotiation_condition_matrix: [] }
  queued = []
  emailCalls = []
  processed = []
  db.companies.push({ id: CO, name: "VMAX" })
  db.tenant_chat_config.push({
    company_id: CO, contact_cooldown_days: 7, whatsapp_provider: "mock", whatsapp_dispatch_mode: "mock",
    negotiation_send_mode: "whatsapp_chat", public_link_code: "k7Qm3Xb9Rt", public_link_enabled: true,
    link_ttl_hours: 168, voxuy_flow_id: null, voxuy_plan_id: null, branding: {},
  })
})

describe("dedupeHubByPhone (puro)", () => {
  it("mantém o primeiro WhatsApp e marca duplicados por telefone", async () => {
    const { dedupeHubByPhone } = await import("@/lib/journey/campaigns")
    const out = dedupeHubByPhone([
      { customerId: "a", eligible: true, channel: "whatsapp", phoneE164: "+5511999999999" },
      { customerId: "b", eligible: true, channel: "whatsapp", phoneE164: "+5511999999999" },
      { customerId: "c", eligible: true, channel: "email", email: "c@x.com" },
    ] as any)
    expect(out[0].eligible).toBe(true)
    expect(out[1].eligible).toBe(false)
    expect(out[1].reason).toBe("telefone_duplicado")
    // e-mail não sofre dedupe por telefone
    expect(out[2].eligible).toBe(true)
  })
})

describe("summarizeHubEligibility (puro)", () => {
  it("conta por canal, excluídos e cobrança viva", async () => {
    const { summarizeHubEligibility } = await import("@/lib/journey/campaigns")
    const c = summarizeHubEligibility([
      { customerId: "a", eligible: true, channel: "whatsapp", hasLiveCharge: true },
      { customerId: "b", eligible: true, channel: "email" },
      { customerId: "c", eligible: false, reason: "sem_contato" },
      { customerId: "d", eligible: false, reason: "sem_contato" },
    ] as any)
    expect(c.byChannel.whatsapp).toBe(1)
    expect(c.byChannel.email).toBe(1)
    expect(c.eligibleTotal).toBe(2)
    expect(c.liveChargeCount).toBe(1)
    expect(c.excluded.sem_contato).toBe(2)
  })
})

describe("evaluateHubEligibility — precedência de canal", () => {
  it("celular válido → whatsapp; só e-mail → email; nenhum → sem_contato", async () => {
    seedCustomer("wa", { phone: "11999998888", email: "wa@x.com" })
    seedCustomer("mail", { phone: null, email: "so@dominio.com" })
    seedCustomer("nada", { phone: "1122", email: "naotem@vmax" })
    const { evaluateHubEligibility } = await import("@/lib/journey/campaigns")
    const r = await evaluateHubEligibility({ companyId: CO, customerIds: ["wa", "mail", "nada"], cooldownDays: 7, minDebtValue: 0 })
    const by = Object.fromEntries(r.map((x) => [x.customerId, x]))
    expect(by.wa.channel).toBe("whatsapp")
    expect(by.mail.channel).toBe("email")
    expect(by.nada.eligible).toBe(false)
    expect(by.nada.reason).toBe("sem_contato")
  })

  it("sem dívida aberta → sem_divida_aberta; abaixo do mínimo → valor_minimo", async () => {
    ;(db.customers ??= []).push({ id: "semdiv", company_id: CO, phone: "11999990000", email: null })
    seedCustomer("baixo", { phone: "11988887777" })
    // ajusta a dívida do "baixo" para abaixo do mínimo
    db.debts.find((d) => d.customer_id === "baixo")!.amount = 10
    const { evaluateHubEligibility } = await import("@/lib/journey/campaigns")
    const r = await evaluateHubEligibility({ companyId: CO, customerIds: ["semdiv", "baixo"], cooldownDays: 7, minDebtValue: 100 })
    const by = Object.fromEntries(r.map((x) => [x.customerId, x]))
    expect(by.semdiv.reason).toBe("sem_divida_aberta")
    expect(by.baixo.reason).toBe("valor_minimo")
  })
})

describe("runHubSend — roteamento e jobId", () => {
  async function makeCampaign(mode: string, evaluated: any[]) {
    const cid = `camp_${Math.random().toString(36).slice(2, 8)}`
    db.whatsapp_campaigns.push({
      id: cid, company_id: CO, provider: "mock", template_key: "hub_link", status: "draft",
      selection_snapshot: { send_mode: mode, evaluated }, counts: {}, started_at: null,
    })
    return cid
  }

  it("WhatsApp em modo queue: enfileira com jobId determinístico SEM ':'", async () => {
    seedCustomer("wa", { phone: "11999998888" })
    const cid = await makeCampaign("whatsapp_chat", [{ customerId: "wa", eligible: true, channel: "whatsapp", phoneE164: "+5511999998888", debtIds: ["debt_wa"] }])
    const { runHubSend } = await import("@/lib/journey/campaign-send")
    const res = await runHubSend({ campaignId: cid, companyId: CO, dispatchMode: "queue", dryRun: false })
    expect(res.summary.sent).toBe(1)
    expect(queued.length).toBe(1)
    expect(queued[0].opts.jobId).toBe(`hub_${cid}_wa`)
    expect(queued[0].opts.jobId).not.toContain(":")
    // registro com channel
    const msg = db.whatsapp_messages.find((m) => m.customer_id === "wa")!
    expect(msg.channel).toBe("whatsapp")
  })

  it("E-mail: dispara convite com o mesmo link /n/{code}, sem fila WhatsApp", async () => {
    seedCustomer("mail", { phone: null, email: "so@dominio.com" })
    const cid = await makeCampaign("whatsapp_chat", [{ customerId: "mail", eligible: true, channel: "email", email: "so@dominio.com", debtIds: ["debt_mail"] }])
    const { runHubSend } = await import("@/lib/journey/campaign-send")
    const res = await runHubSend({ campaignId: cid, companyId: CO, dispatchMode: "queue", dryRun: false })
    expect(res.summary.sent).toBe(1)
    expect(queued.length).toBe(0)
    expect(emailCalls.length).toBe(1)
    expect(emailCalls[0].link).toBe("http://localhost:3000/n/k7Qm3Xb9Rt")
    const msg = db.whatsapp_messages.find((m) => m.customer_id === "mail")!
    expect(msg.channel).toBe("email")
    expect(msg.status).toBe("sent")
  })

  it("dryRun: resultado completo sem escrever mensagem nem enfileirar", async () => {
    seedCustomer("wa", { phone: "11999998888" })
    const cid = await makeCampaign("whatsapp_chat", [{ customerId: "wa", eligible: true, channel: "whatsapp", phoneE164: "+5511999998888", debtIds: ["debt_wa"] }])
    const { runHubSend } = await import("@/lib/journey/campaign-send")
    const res = await runHubSend({ campaignId: cid, companyId: CO, dispatchMode: "queue", dryRun: true })
    expect(res.dryRun).toBe(true)
    expect(res.summary.sent).toBe(1)
    expect(queued.length).toBe(0)
    expect(db.whatsapp_messages.length).toBe(0)
  })

  it("reverifica no envio: quem virou sem_contato sai como skipped", async () => {
    // no snapshot era elegível, mas o customer não tem mais contato válido
    ;(db.customers ??= []).push({ id: "perdido", company_id: CO, phone: "1122", email: "naotem@vmax" })
    ;(db.debts ??= []).push({ id: "debt_perdido", customer_id: "perdido", company_id: CO, amount: 500, status: "pending" })
    const cid = await makeCampaign("whatsapp_chat", [{ customerId: "perdido", eligible: true, channel: "whatsapp", phoneE164: "+5511000000000", debtIds: ["debt_perdido"] }])
    const { runHubSend } = await import("@/lib/journey/campaign-send")
    const res = await runHubSend({ campaignId: cid, companyId: CO, dispatchMode: "queue", dryRun: false })
    expect(res.summary.sent).toBe(0)
    expect(res.summary.skipped).toBe(1)
    expect(res.items[0].reason).toBe("sem_contato")
  })
})

describe("buildProviderSelector (T3-2)", () => {
  it("mock: devolve a string, sem carregar credencial", async () => {
    const { buildProviderSelector } = await import("@/lib/journey/campaign-send")
    expect(buildProviderSelector("mock", 42)).toBe("mock")
  })

  it("voxuy_api: injeta voxuy_flow_id do tenant no apiConfig", async () => {
    process.env.VOXUY_WEBHOOK_URL = "https://webhook.voxuy.example/abc"
    process.env.VOXUY_FLOW_ID = "7"
    process.env.VOXUY_DIALECT = "enterprise_v1"
    const { buildProviderSelector } = await import("@/lib/journey/campaign-send")
    const sel = buildProviderSelector("voxuy_api", 99)
    expect(typeof sel).toBe("object")
    if (typeof sel === "object") {
      expect(sel.dispatchMode).toBe("voxuy_api")
      // tenant (99) sobrescreve o env (7)
      expect(sel.apiConfig?.flowId).toBe(99)
    }
    delete process.env.VOXUY_WEBHOOK_URL
    delete process.env.VOXUY_FLOW_ID
    delete process.env.VOXUY_DIALECT
  })

  it("voxuy_api sem tenant flowId: cai no env VOXUY_FLOW_ID", async () => {
    process.env.VOXUY_WEBHOOK_URL = "https://webhook.voxuy.example/abc"
    process.env.VOXUY_FLOW_ID = "7"
    process.env.VOXUY_DIALECT = "enterprise_v1"
    const { buildProviderSelector } = await import("@/lib/journey/campaign-send")
    const sel = buildProviderSelector("voxuy_api", null)
    if (typeof sel === "object") expect(sel.apiConfig?.flowId).toBe(7)
    delete process.env.VOXUY_WEBHOOK_URL
    delete process.env.VOXUY_FLOW_ID
    delete process.env.VOXUY_DIALECT
  })
})
