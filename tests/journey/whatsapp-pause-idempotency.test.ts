// W2 — processCampaignMessage: idempotência NOSSA + consumidor de pauseCampaign
// + zero PII no payload que sai para o provider.
//
//   - reenvio do MESMO (campaign,customer): a 2ª chamada NÃO bate no provider
//     (guard `msg.status !== 'queued'` releu o status já aceito).
//   - pauseCampaign (401/403/404 → errorClass 'config' / raw.pauseCampaign):
//     marca a campanha `paused` (com counts.pause_reason) e devolve "paused".
//   - inline NÃO chama o provider de novo depois de pausar (via runHubSend).
//   - o input enviado ao provider carrega SÓ link/primeiro_nome/credor/marca —
//     NUNCA valor, vencimento nem documento.

import { beforeEach, describe, expect, it, vi } from "vitest"

// ---------------------------------------------------------------------------
// fake supabase em memória (subconjunto que processCampaignMessage/runHubSend usam)
// ---------------------------------------------------------------------------
type Row = Record<string, any>
let db: Record<string, Row[]>

class QB {
  filters: Array<{ op: string; col: string; val?: any }> = []
  orExpr: string | null = null
  pInsert: Row[] | null = null
  pUpdate: Row | null = null
  constructor(private t: string) {}
  select() { return this }
  eq(col: string, val: any) { this.filters.push({ op: "eq", col, val }); return this }
  neq(col: string, val: any) { this.filters.push({ op: "neq", col, val }); return this }
  in(col: string, val: any[]) { this.filters.push({ op: "in", col, val }); return this }
  gte(col: string, val: any) { this.filters.push({ op: "gte", col, val }); return this }
  not(col: string) { this.filters.push({ op: "notNull", col }); return this }
  is(col: string, val: any) { this.filters.push(val === null ? { op: "isNull", col } : { op: "eq", col, val }); return this }
  or(expr: string) { this.orExpr = expr; return this }
  order() { return this }
  limit() { return this }
  range() { return this }
  insert(rows: Row | Row[]) { this.pInsert = Array.isArray(rows) ? rows : [rows]; return this }
  update(patch: Row) { this.pUpdate = patch; return this }
  private match(r: Row, f: { op: string; col: string; val?: any }): boolean {
    const v = r[f.col]
    switch (f.op) {
      case "eq": return v === f.val
      case "neq": return v !== f.val
      case "in": return Array.isArray(f.val) && f.val.includes(v)
      case "gte": return v != null && v >= f.val
      case "notNull": return v != null
      case "isNull": return v == null
      default: return true
    }
  }
  private matchOr(r: Row): boolean {
    if (!this.orExpr) return true
    return this.orExpr.split(",").some((clause) => {
      const [col, , val] = clause.split(".")
      return String(r[col]) === val
    })
  }
  private filtered(): Row[] {
    return (db[this.t] ??= []).filter((r) => this.filters.every((f) => this.match(r, f)) && this.matchOr(r))
  }
  private run(): { data: Row[]; error: null } {
    const table = (db[this.t] ??= [])
    if (this.pInsert) {
      const ins = this.pInsert.map((r) => ({ id: r.id ?? `id_${Math.random().toString(36).slice(2, 10)}`, ...r }))
      table.push(...ins)
      return { data: ins, error: null }
    }
    if (this.pUpdate) {
      const target = this.filtered()
      for (const row of target) Object.assign(row, this.pUpdate)
      return { data: target, error: null }
    }
    // join fake: whatsapp_messages.select("*, whatsapp_campaigns!inner(...)")
    let out = this.filtered()
    if (this.t === "whatsapp_messages") {
      out = out.map((m) => ({
        ...m,
        whatsapp_campaigns: (db.whatsapp_campaigns ?? []).find((c) => c.id === m.campaign_id) ?? null,
      })).filter((m) => m.whatsapp_campaigns) // !inner
    }
    return { data: out, error: null }
  }
  async maybeSingle() { const { data } = this.run(); return { data: data[0] ?? null, error: null } }
  async single() { const { data } = this.run(); return { data: data[0] ?? null, error: data[0] ? null : { message: "no rows" } } }
  then(res: (r: { data: Row[]; error: null }) => void) { res(this.run()) }
}
const fakeClient = { from: (t: string) => new QB(t) }
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => fakeClient }))

// events / suppressions / agreements: neutros (o foco é o envio).
vi.mock("@/lib/journey/events", () => ({ recordEvent: async () => ({ ok: true, duplicate: false }) }))
vi.mock("@/lib/journey/suppressions", () => ({ isSuppressed: async () => false }))
vi.mock("@/lib/asaas-idempotency", () => ({ findBlockingAgreement: () => null }))
// tokens: emite ids fixos sem tocar no banco.
vi.mock("@/lib/journey/tokens", () => ({
  issueActionTokens: async () => ({
    consult: { id: "tok_consult", token: "CONSULT", expiresAt: "2030-01-01" },
    optout: { id: "tok_optout", token: "OPTOUT", expiresAt: "2030-01-01" },
    block: { id: "tok_block", token: "BLOCK", expiresAt: "2030-01-01" },
  }),
}))
// email-dispatch: usado só pelo runHubSend (canal e-mail); neutro aqui.
vi.mock("@/lib/journey/email-dispatch", () => ({
  dispatchEmailInvite: async () => ({ ok: true, jobId: "e" }),
  dispatchRenderedEmail: async () => ({ ok: true, jobId: "e" }),
}))
vi.mock("@/lib/queue/queues", () => ({ whatsappQueue: { add: async () => ({ id: "job" }) } }))

// ---------------------------------------------------------------------------
// provider mockável: controla accepted / errorClass / pauseCampaign e CAPTURA o
// input (para provar zero PII). Trocado por teste via providerRef.
// ---------------------------------------------------------------------------
const sentInputs: any[] = []
const providerRef: { result: any } = { result: { accepted: true, providerMessageId: "pm", raw: {} } }
vi.mock("@/lib/whatsapp", () => ({
  getWhatsAppProvider: () => ({
    name: "voxuy",
    sendCampaignMessage: async (input: any) => {
      sentInputs.push(input)
      return providerRef.result
    },
  }),
  resolveDispatchMode: () => "voxuy_api",
}))
vi.mock("@/lib/whatsapp/voxuy/config", () => ({
  loadVoxuyApiConfig: () => ({ dialect: "enterprise_v1", webhookUrl: "x", flowId: 1, timeoutMs: 1000 }),
  coerceFlowId: (v: any) => (typeof v === "number" ? v : null),
}))
// render-context/resolve-default: usados só no canal e-mail — stubs neutros.
vi.mock("@/lib/email/templates/resolve-default", () => ({
  resolveNegotiationTemplate: async () => null,
  renderTemplate: () => ({ ok: true, subject: "", html: "", text: "" }),
}))
vi.mock("@/lib/email/templates/render-context", () => ({
  resolveDebtEmailContext: async () => new Map(),
  isPublicLinkAvailable: async () => true,
}))

const CO = "eeeeeeee-0000-0000-0000-000000000012"

function seedBase() {
  db = {
    whatsapp_messages: [], whatsapp_campaigns: [], customers: [], companies: [],
    tenant_chat_config: [], chat_access_tokens: [], agreements: [],
  }
  db.companies.push({ id: CO, name: "VMAX" })
  db.customers.push({ id: "cust1", company_id: CO, name: "Maria Aparecida Silva", document: "11144477735" })
  db.tenant_chat_config.push({
    company_id: CO, link_ttl_hours: 168, whatsapp_sender_label: "AlteaPay", branding: { creditor_name: "Cedente XPTO" },
    voxuy_plan_id: null, voxuy_events: {}, voxuy_flow_id: 1,
  })
}

function seedQueuedMessage(id: string, campaignStatus = "running", provider = "voxuy") {
  db.whatsapp_campaigns.push({
    id: `camp_${id}`, company_id: CO, template_key: "hub_link", provider, status: campaignStatus, counts: {},
  })
  db.whatsapp_messages.push({
    id, company_id: CO, campaign_id: `camp_${id}`, customer_id: "cust1", debt_id: "debt1",
    phone_e164: "+5511999998888", provider, status: "queued", status_history: [],
  })
}

beforeEach(() => {
  vi.resetModules()
  seedBase()
  sentInputs.length = 0
  providerRef.result = { accepted: true, providerMessageId: "pm", raw: {} }
  process.env.VOXUY_MODE = "mock"
})

describe("idempotência NOSSA — reenvio do mesmo (campaign,customer)", () => {
  it("2ª chamada com a mensagem já aceita NÃO chama o provider de novo", async () => {
    seedQueuedMessage("m1")
    const { processCampaignMessage } = await import("@/lib/journey/campaign-send")
    // 1º envio: provider aceita ('accepted' porque provider=voxuy).
    const first = await processCampaignMessage("m1")
    expect(first).toBe("sent")
    expect(sentInputs.length).toBe(1)
    const msg = db.whatsapp_messages.find((m) => m.id === "m1")!
    expect(msg.status).toBe("accepted") // voxuy → accepted (não delivered)

    // 2º envio do MESMO id: status não é mais 'queued' → aborta ANTES do provider.
    const second = await processCampaignMessage("m1")
    expect(second).toBe("skipped")
    expect(sentInputs.length).toBe(1) // NÃO houve 2ª chamada ao provider
  })
})

describe("consumidor de pauseCampaign", () => {
  it("errorClass=config: marca a campanha paused (counts.pause_reason) e devolve 'paused'", async () => {
    seedQueuedMessage("m2")
    providerRef.result = { accepted: false, error: "HTTP 401", errorClass: "config", raw: { pauseCampaign: true } }
    const { processCampaignMessage } = await import("@/lib/journey/campaign-send")
    const outcome = await processCampaignMessage("m2")
    expect(outcome).toBe("paused")
    const camp = db.whatsapp_campaigns.find((c) => c.id === "camp_m2")!
    expect(camp.status).toBe("paused")
    expect(camp.counts.pause_reason).toMatch(/config/)
    // a mensagem em si fica failed (registro), mas o CONTROLE é a pausa.
    const msg = db.whatsapp_messages.find((m) => m.id === "m2")!
    expect(msg.status).toBe("failed")
  })

  it("raw.pauseCampaign=true sem errorClass também pausa", async () => {
    seedQueuedMessage("m3")
    providerRef.result = { accepted: false, error: "config", errorClass: "validation", raw: { pauseCampaign: true } }
    const { processCampaignMessage } = await import("@/lib/journey/campaign-send")
    const outcome = await processCampaignMessage("m3")
    expect(outcome).toBe("paused")
    expect(db.whatsapp_campaigns.find((c) => c.id === "camp_m3")!.status).toBe("paused")
  })

  it("validation SEM pauseCampaign: falha final, campanha segue running", async () => {
    seedQueuedMessage("m4")
    providerRef.result = { accepted: false, error: "HTTP 400", errorClass: "validation", raw: {} }
    const { processCampaignMessage } = await import("@/lib/journey/campaign-send")
    const outcome = await processCampaignMessage("m4")
    expect(outcome).toBe("failed")
    expect(db.whatsapp_campaigns.find((c) => c.id === "camp_m4")!.status).toBe("running")
  })
})

describe("zero PII no payload que vai ao provider", () => {
  it("input carrega só link/primeiro_nome/credor/marca — nada de valor/venc/documento", async () => {
    seedQueuedMessage("m5")
    const { processCampaignMessage } = await import("@/lib/journey/campaign-send")
    await processCampaignMessage("m5")
    expect(sentInputs.length).toBe(1)
    const input = sentInputs[0]
    // variáveis previstas
    expect(input.variables.consult_url).toContain("/c/CONSULT")
    expect(input.variables.first_name).toBe("Maria") // só o 1º nome
    expect(input.variables.creditor_name).toBe("Cedente XPTO")
    // NENHUM campo de dívida/valor/vencimento nas variáveis (o que VAI para a
    // Voxuy). `input.document` existe no contrato mas é SÓ interno — o adapter V1
    // (assertFinalPayloadSafe) garante que ele NUNCA sai; o que este caminho
    // controla são as `variables`, e elas não podem ter PII/valor.
    const varKeys = Object.keys(input.variables)
    for (const forbidden of ["value", "amount", "valor", "vencimento", "due_date", "document", "cpf", "totalValue"]) {
      expect(varKeys).not.toContain(forbidden)
    }
    // as VARIÁVEIS (payload real p/ Voxuy) não podem conter o documento em claro.
    expect(JSON.stringify(input.variables)).not.toContain("11144477735")
  })
})

describe("inline PARA de iterar após pausar (runHubSend)", () => {
  it("2 devedores, 1º pausa: o provider é chamado 1x só; o 2º fica skipped", async () => {
    // campanha do hub com 2 devedores por WhatsApp.
    const cid = "camp_hub"
    db.whatsapp_campaigns.push({ id: cid, company_id: CO, provider: "voxuy", template_key: "hub_link", status: "draft", counts: {}, started_at: null })
    db.customers.push({ id: "cA", company_id: CO, name: "Ana Souza", document: "52998224725" })
    db.customers.push({ id: "cB", company_id: CO, name: "Bruno Lima", document: "11144477735" })
    db.debts = [
      { id: "dA", customer_id: "cA", company_id: CO, amount: 500, status: "pending" },
      { id: "dB", customer_id: "cB", company_id: CO, amount: 500, status: "pending" },
    ]
    db.whatsapp_campaigns.find((c) => c.id === cid)!.selection_snapshot = {
      send_mode: "whatsapp_chat", channels: ["whatsapp"], dedupe: false,
      channel_decisions: [
        { customerId: "cA", decisions: [], hasBothContacts: false },
        { customerId: "cB", decisions: [], hasBothContacts: false },
      ],
    }

    // provider pausa SEMPRE (credencial inválida).
    providerRef.result = { accepted: false, error: "HTTP 403", errorClass: "config", raw: { pauseCampaign: true } }

    // evaluateHubChannels precisa dos telefones válidos → seta phone.
    db.customers.find((c) => c.id === "cA")!.phone = "11999990001"
    db.customers.find((c) => c.id === "cB")!.phone = "11999990002"

    const { runHubSend } = await import("@/lib/journey/campaign-send")
    const res = await runHubSend({ campaignId: cid, companyId: CO, dispatchMode: "inline", dryRun: false })

    // o provider foi chamado UMA vez só (o 2º devedor não bateu no provider).
    expect(sentInputs.length).toBe(1)
    // a campanha ficou pausada.
    expect(db.whatsapp_campaigns.find((c) => c.id === cid)!.status).toBe("paused")
    // há um item skipped por pausa entre os resultados.
    const skippedByPause = res.items.filter((i) => i.reason === "campanha_pausada_credencial_invalida")
    expect(skippedByPause.length).toBeGreaterThanOrEqual(1)
  })
})
