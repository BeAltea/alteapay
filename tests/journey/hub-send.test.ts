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
  neq(col: string, val: any) { this.filters.push({ op: "neq", col, val }); return this }
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
let renderedCalls: any[] = []
vi.mock("@/lib/journey/email-dispatch", () => ({
  dispatchEmailInvite: async (i: any) => {
    emailCalls.push(i)
    // teste de isolamento (E3): e-mail para "boom@" estoura — não pode afetar WA.
    if (String(i.to).includes("boom")) throw new Error("smtp_explodiu")
    return { ok: true, jobId: "email_job" }
  },
  // F4: envio de template já renderizado (padrão do cedente/global).
  dispatchRenderedEmail: async (i: any) => {
    renderedCalls.push(i)
    if (String(i.to).includes("boom")) throw new Error("smtp_explodiu")
    return { ok: true, jobId: "rendered_job" }
  },
  // usado pelo resolver (resolve-default.builtinTemplate) no fallback embutido.
  buildEmailInviteHtml: (i: any) => `<html><body>convite ${i.link}</body></html>`,
}))
vi.mock("@/lib/journey/suppressions", () => ({ isSuppressed: async () => false }))
vi.mock("@/lib/asaas-idempotency", () => ({ findBlockingAgreement: () => null }))

const CO = "eeeeeeee-0000-0000-0000-000000000012"

function seedCustomer(id: string, over: Partial<Row> = {}) {
  ;(db.customers ??= []).push({ id, company_id: CO, phone: null, email: null, ...over })
  ;(db.debts ??= []).push({ id: `debt_${id}`, customer_id: id, company_id: CO, amount: 500, status: "pending" })
}

beforeEach(() => {
  db = { customers: [], debts: [], agreements: [], negotiation_cases: [], whatsapp_messages: [], whatsapp_campaigns: [], tenant_chat_config: [], companies: [], negotiation_condition_matrix: [], email_template_defaults: [], email_templates: [], email_template_versions: [] }
  queued = []
  emailCalls = []
  renderedCalls = []
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

describe("createHubCampaign — idempotência (A1)", () => {
  it("mesma chave (double-click/retry) reusa a MESMA campanha; chave nova cria outra", async () => {
    seedCustomer("ci", { phone: "11999998888", email: "ci@dominio.com" })
    const { createHubCampaign } = await import("@/lib/journey/campaigns")
    // channels omitido → createHubCampaign default-a para ambos (whatsapp+email).
    const base = {
      companyId: CO, name: "Hub teste", templateKey: "hub_link", customerIds: ["ci"],
      sendMode: "whatsapp_chat" as const, provider: "mock",
    }
    const a = await createHubCampaign({ ...base, idempotencyKey: "K1" })
    expect(db.whatsapp_campaigns.length).toBe(1)

    // 2ª chamada com a MESMA chave: não cria nova campanha, devolve a mesma.
    const b = await createHubCampaign({ ...base, idempotencyKey: "K1" })
    expect(b.campaignId).toBe(a.campaignId)
    expect(b.deduped).toBe(true)
    expect(db.whatsapp_campaigns.length).toBe(1)

    // chave NOVA = intenção nova = campanha nova.
    const c = await createHubCampaign({ ...base, idempotencyKey: "K2" })
    expect(c.campaignId).not.toBe(a.campaignId)
    expect(db.whatsapp_campaigns.length).toBe(2)

    // sem chave: comportamento antigo (sempre cria) — não deve deduplicar.
    const d = await createHubCampaign({ ...base })
    expect(d.deduped).toBeFalsy()
    expect(db.whatsapp_campaigns.length).toBe(3)
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

describe("evaluateHubChannels + summarizeHubChannels — seleção de canal (F1)", () => {
  it("3 clientes (só-celular / só-email / ambos): contagens por canal + cruzamento", async () => {
    seedCustomer("soWa", { phone: "11999998888", email: "naotem@vmax" }) // só celular
    seedCustomer("soMail", { phone: "1122", email: "mail@dominio.com" })  // só e-mail
    seedCustomer("ambos", { phone: "11977776666", email: "ambos@dominio.com" }) // os dois
    const { evaluateHubChannels, summarizeHubChannels } = await import("@/lib/journey/campaigns")
    const decisions = await evaluateHubChannels({
      companyId: CO, customerIds: ["soWa", "soMail", "ambos"], cooldownDays: 7, minDebtValue: 0,
      channels: ["whatsapp", "email"], dedupe: false,
    })
    const c = summarizeHubChannels(decisions, ["whatsapp", "email"])
    // WhatsApp: soWa + ambos; e-mail: soMail + ambos.
    expect(c.perChannel.whatsapp.eligible).toBe(2)
    expect(c.perChannel.email.eligible).toBe(2)
    // cruzamento: só "ambos" recebe pelos dois.
    expect(c.bothCount).toBe(1)
    expect(c.hasBothContacts).toBe(1)
    // total de DEVEDORES distintos que recebem por >=1 canal.
    expect(c.total).toBe(3)
    // exclusões por-canal: soMail sem WhatsApp; soWa sem e-mail.
    expect(c.perChannel.whatsapp.excluded.map((d) => d.customerId)).toContain("soMail")
    expect(c.perChannel.whatsapp.excluded.find((d) => d.customerId === "soMail")!.reason).toBe("sem_contato_para_o_canal")
    expect(c.perChannel.email.excluded.map((d) => d.customerId)).toContain("soWa")
  })

  it("desmarcar WhatsApp: só-celular vira exclusão sem_contato_para_o_canal (nunca troca silenciosa)", async () => {
    seedCustomer("soWa", { phone: "11999998888", email: "naotem@vmax" })
    const { evaluateHubChannels } = await import("@/lib/journey/campaigns")
    const decisions = await evaluateHubChannels({
      companyId: CO, customerIds: ["soWa"], cooldownDays: 7, minDebtValue: 0,
      channels: ["email"], dedupe: false, // só e-mail marcado
    })
    const d = decisions[0].decisions.find((x) => x.channel === "email")!
    expect(d.eligible).toBe(false)
    expect(d.reason).toBe("sem_contato_para_o_canal")
    // o WhatsApp NÃO aparece (canal desmarcado) — nunca é usado silenciosamente.
    expect(decisions[0].decisions.some((x) => x.channel === "whatsapp")).toBe(false)
  })

  it("não duplicar: quem tem os dois vai só por WhatsApp (e-mail = priorizado_whatsapp)", async () => {
    seedCustomer("ambos", { phone: "11977776666", email: "ambos@dominio.com" })
    const { evaluateHubChannels, summarizeHubChannels } = await import("@/lib/journey/campaigns")
    const decisions = await evaluateHubChannels({
      companyId: CO, customerIds: ["ambos"], cooldownDays: 7, minDebtValue: 0,
      channels: ["whatsapp", "email"], dedupe: true,
    })
    const wa = decisions[0].decisions.find((x) => x.channel === "whatsapp")!
    const em = decisions[0].decisions.find((x) => x.channel === "email")!
    expect(wa.eligible).toBe(true)
    expect(em.eligible).toBe(false)
    expect(em.reason).toBe("priorizado_whatsapp")
    // com dedupe, bothCount = 0 (ninguém recebe pelos dois).
    const c = summarizeHubChannels(decisions, ["whatsapp", "email"])
    expect(c.bothCount).toBe(0)
    expect(c.hasBothContacts).toBe(1) // ainda TEM os dois contatos
  })
})

describe("runHubSend — roteamento por canal e jobId", () => {
  // O snapshot novo carrega channel_decisions (multi-canal) + channels + dedupe.
  async function makeCampaign(channels: string[], customerIds: string[], dedupe = false) {
    const cid = `camp_${Math.random().toString(36).slice(2, 8)}`
    db.whatsapp_campaigns.push({
      id: cid, company_id: CO, provider: "mock", template_key: "hub_link", status: "draft",
      selection_snapshot: {
        send_mode: "whatsapp_chat",
        channels,
        dedupe,
        // channel_decisions só precisa dos customerIds; runHubSend REVERIFICA tudo.
        channel_decisions: customerIds.map((customerId) => ({ customerId, decisions: [], hasBothContacts: false })),
      },
      counts: {}, started_at: null,
    })
    return cid
  }

  it("WhatsApp em modo queue: enfileira com jobId determinístico SEM ':' (com canal)", async () => {
    seedCustomer("wa", { phone: "11999998888" })
    const cid = await makeCampaign(["whatsapp"], ["wa"])
    const { runHubSend } = await import("@/lib/journey/campaign-send")
    const res = await runHubSend({ campaignId: cid, companyId: CO, dispatchMode: "queue", dryRun: false })
    expect(res.summary.sent).toBe(1)
    expect(queued.length).toBe(1)
    expect(queued[0].opts.jobId).toBe(`hub_whatsapp_${cid}_wa`)
    expect(queued[0].opts.jobId).not.toContain(":")
    const msg = db.whatsapp_messages.find((m) => m.customer_id === "wa")!
    expect(msg.channel).toBe("whatsapp")
  })

  it("E-mail: dispara convite com o mesmo link /n/{code}, sem fila WhatsApp", async () => {
    seedCustomer("mail", { phone: null, email: "so@dominio.com" })
    const cid = await makeCampaign(["email"], ["mail"])
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

  it("ambos os canais: quem tem os dois contatos gera 2 whatsapp_messages (E4)", async () => {
    seedCustomer("both", { phone: "11999997777", email: "both@dominio.com" })
    const cid = await makeCampaign(["whatsapp", "email"], ["both"])
    const { runHubSend } = await import("@/lib/journey/campaign-send")
    const res = await runHubSend({ campaignId: cid, companyId: CO, dispatchMode: "queue", dryRun: false })
    expect(res.summary.sent).toBe(2)
    const msgs = db.whatsapp_messages.filter((m) => m.customer_id === "both")
    expect(msgs.length).toBe(2)
    expect(new Set(msgs.map((m) => m.channel))).toEqual(new Set(["whatsapp", "email"]))
    // WhatsApp enfileirado, e-mail direto.
    expect(queued.length).toBe(1)
    expect(emailCalls.length).toBe(1)
  })

  it("não duplicar: quem tem os dois vai SÓ por WhatsApp (e-mail priorizado)", async () => {
    seedCustomer("both", { phone: "11999997777", email: "both@dominio.com" })
    const cid = await makeCampaign(["whatsapp", "email"], ["both"], true)
    const { runHubSend } = await import("@/lib/journey/campaign-send")
    const res = await runHubSend({ campaignId: cid, companyId: CO, dispatchMode: "queue", dryRun: false })
    expect(res.summary.sent).toBe(1) // só WhatsApp enviado
    expect(emailCalls.length).toBe(0)
    const emailItem = res.items.find((i) => i.channel === "email")!
    expect(emailItem.status).toBe("skipped")
    expect(emailItem.reason).toBe("priorizado_whatsapp")
  })

  it("dryRun: resultado completo sem escrever mensagem nem enfileirar", async () => {
    seedCustomer("wa", { phone: "11999998888" })
    const cid = await makeCampaign(["whatsapp"], ["wa"])
    const { runHubSend } = await import("@/lib/journey/campaign-send")
    const res = await runHubSend({ campaignId: cid, companyId: CO, dispatchMode: "queue", dryRun: true })
    expect(res.dryRun).toBe(true)
    expect(res.summary.sent).toBe(1)
    expect(queued.length).toBe(0)
    expect(db.whatsapp_messages.length).toBe(0)
  })

  it("reverifica no envio: quem virou sem contato do canal sai como skipped", async () => {
    // no snapshot era elegível, mas o customer não tem mais celular válido
    ;(db.customers ??= []).push({ id: "perdido", company_id: CO, phone: "1122", email: "naotem@vmax" })
    ;(db.debts ??= []).push({ id: "debt_perdido", customer_id: "perdido", company_id: CO, amount: 500, status: "pending" })
    const cid = await makeCampaign(["whatsapp"], ["perdido"])
    const { runHubSend } = await import("@/lib/journey/campaign-send")
    const res = await runHubSend({ campaignId: cid, companyId: CO, dispatchMode: "queue", dryRun: false })
    expect(res.summary.sent).toBe(0)
    expect(res.summary.skipped).toBe(1)
    expect(res.items[0].reason).toBe("sem_contato_para_o_canal")
  })

  it("erro forçado no e-mail NÃO afeta o WhatsApp (E3 — sequências independentes)", async () => {
    // devedor com os dois contatos; o e-mail estoura (boom@), o WhatsApp segue.
    seedCustomer("both", { phone: "11999997777", email: "boom@dominio.com" })
    const cid = await makeCampaign(["whatsapp", "email"], ["both"])
    const { runHubSend } = await import("@/lib/journey/campaign-send")
    const res = await runHubSend({ campaignId: cid, companyId: CO, dispatchMode: "queue", dryRun: false })
    // WhatsApp enviado apesar do e-mail ter estourado.
    const wa = res.items.find((i) => i.channel === "whatsapp")!
    const em = res.items.find((i) => i.channel === "email")!
    expect(wa.status).toBe("sent")
    expect(em.status).toBe("failed")
    expect(em.reason).toBe("smtp_explodiu")
    expect(queued.length).toBe(1) // WA enfileirado
  })
})

describe("runHubSend — template padrão por cedente (F4)", () => {
  async function makeCampaign(channels: string[], customerIds: string[], dedupe = false) {
    const cid = `camp_${Math.random().toString(36).slice(2, 8)}`
    db.whatsapp_campaigns.push({
      id: cid, company_id: CO, provider: "mock", template_key: "hub_link", status: "draft",
      selection_snapshot: {
        send_mode: "whatsapp_chat", channels, dedupe,
        channel_decisions: customerIds.map((customerId) => ({ customerId, decisions: [], hasBothContacts: false })),
      },
      counts: {}, started_at: null,
    })
    return cid
  }

  const VALID_HTML =
    "<p>Olá {{primeiro_nome}} da {{credor}}</p>" +
    '<p><a href="{{link_negociacao}}">negociar</a></p>' +
    '<p><a href="{{link_descadastro}}">sair</a></p>'

  function seedCedenteTemplate(companyId: string) {
    db.email_template_versions.push({
      id: "ver_ced", template_id: "tpl_ced", subject: "Olá {{primeiro_nome}}",
      preheader: "", html: VALID_HTML, text_fallback: "Negocie: {{link_negociacao}} sair {{link_descadastro}}",
    })
    db.email_templates.push({
      id: "tpl_ced", company_id: companyId, name: "Convite do Cedente", purpose: "negotiation",
      status: "active", current_version_id: "ver_ced", updated_at: "2026-02-01",
    })
    db.email_template_defaults.push({ company_id: companyId, template_id: "tpl_ced", purpose: "negotiation" })
  }

  it("SEM padrão do cedente: usa o convite embutido e grava template_id/version = NULL", async () => {
    seedCustomer("mail", { phone: null, email: "so@dominio.com", name: "Maria Silva" })
    const cid = await makeCampaign(["email"], ["mail"])
    const { runHubSend } = await import("@/lib/journey/campaign-send")
    const res = await runHubSend({ campaignId: cid, companyId: CO, dispatchMode: "queue", dryRun: false })
    expect(res.summary.sent).toBe(1)
    // caminho builtin: dispatchEmailInvite chamado, dispatchRenderedEmail NÃO.
    expect(emailCalls.length).toBe(1)
    expect(renderedCalls.length).toBe(0)
    const msg = db.whatsapp_messages.find((m) => m.customer_id === "mail")!
    expect(msg.status).toBe("sent")
    expect(msg.email_template_id ?? null).toBeNull()
    expect(msg.email_template_version_id ?? null).toBeNull()
  })

  it("COM padrão do cedente: renderiza o template e grava template_id + version_id", async () => {
    seedCustomer("mail", { phone: null, email: "so@dominio.com", name: "João Souza" })
    seedCedenteTemplate(CO)
    const cid = await makeCampaign(["email"], ["mail"])
    const { runHubSend } = await import("@/lib/journey/campaign-send")
    const res = await runHubSend({ campaignId: cid, companyId: CO, dispatchMode: "queue", dryRun: false })
    expect(res.summary.sent).toBe(1)
    // caminho template: dispatchRenderedEmail chamado, dispatchEmailInvite NÃO.
    expect(renderedCalls.length).toBe(1)
    expect(emailCalls.length).toBe(0)
    // o subject/html renderizados trazem o primeiro nome e o link do hub.
    expect(renderedCalls[0].subject).toBe("Olá João")
    expect(renderedCalls[0].html).toContain("http://localhost:3000/n/k7Qm3Xb9Rt")
    expect(renderedCalls[0].html).not.toContain("{{")
    const msg = db.whatsapp_messages.find((m) => m.customer_id === "mail")!
    expect(msg.email_template_id).toBe("tpl_ced")
    expect(msg.email_template_version_id).toBe("ver_ced")
  })

  it("dryRun não resolve nem renderiza template (nada de rendered/builtin)", async () => {
    seedCustomer("mail", { phone: null, email: "so@dominio.com", name: "Maria" })
    seedCedenteTemplate(CO)
    const cid = await makeCampaign(["email"], ["mail"])
    const { runHubSend } = await import("@/lib/journey/campaign-send")
    const res = await runHubSend({ campaignId: cid, companyId: CO, dispatchMode: "queue", dryRun: true })
    expect(res.summary.sent).toBe(1)
    expect(renderedCalls.length).toBe(0)
    expect(emailCalls.length).toBe(0)
    expect(db.whatsapp_messages.length).toBe(0)
  })
})

describe("runHubSend — allowResend (override do cooldown)", () => {
  // Snapshot idêntico ao dos outros testes de runHubSend: só carrega os
  // customerIds; runHubSend REVERIFICA tudo (inclusive o cooldown) no envio.
  async function makeCampaign(channels: string[], customerIds: string[], dedupe = false) {
    const cid = `camp_${Math.random().toString(36).slice(2, 8)}`
    db.whatsapp_campaigns.push({
      id: cid, company_id: CO, provider: "mock", template_key: "hub_link", status: "draft",
      selection_snapshot: {
        send_mode: "whatsapp_chat", channels, dedupe,
        channel_decisions: customerIds.map((customerId) => ({ customerId, decisions: [], hasBothContacts: false })),
      },
      counts: {}, started_at: null,
    })
    return cid
  }

  /** Marca um contato RECENTE (dentro da janela de cooldown) para o devedor, numa
   * campanha ANTERIOR (não a atual — senão dispararia ja_contatado_campanha, que a
   * flag não ignora). queued_at = agora → dentro de qualquer cooldownDays >= 1. */
  function seedRecentContact(customerId: string, phoneE164: string) {
    ;(db.whatsapp_messages ??= []).push({
      id: `prev_${customerId}`, company_id: CO, campaign_id: "camp_anterior",
      customer_id: customerId, phone_e164: phoneE164, channel: "whatsapp",
      status: "sent", queued_at: new Date().toISOString(),
    })
  }

  it("allowResend=true: devedor com contato recente (dentro do cooldown) fica ELEGÍVEL", async () => {
    seedCustomer("recente", { phone: "11999998888", email: null })
    seedRecentContact("recente", "+5511999998888")
    const cid = await makeCampaign(["whatsapp"], ["recente"])
    const { runHubSend } = await import("@/lib/journey/campaign-send")
    const res = await runHubSend({ campaignId: cid, companyId: CO, dispatchMode: "queue", dryRun: false, allowResend: true })
    // com o override, o cooldown é pulado: o devedor volta a ser elegível e enfileira.
    expect(res.summary.sent).toBe(1)
    const item = res.items.find((i) => i.customerId === "recente" && i.channel === "whatsapp")!
    expect(item.status).toBe("sent")
    expect(res.items.some((i) => i.reason === "cooldown")).toBe(false)
  })

  it("allowResend=false (default): mesmo devedor continua EXCLUÍDO por cooldown", async () => {
    seedCustomer("recente", { phone: "11999998888", email: null })
    seedRecentContact("recente", "+5511999998888")
    const cid = await makeCampaign(["whatsapp"], ["recente"])
    const { runHubSend } = await import("@/lib/journey/campaign-send")
    // allowResend omitido → default false.
    const res = await runHubSend({ campaignId: cid, companyId: CO, dispatchMode: "queue", dryRun: false })
    expect(res.summary.sent).toBe(0)
    expect(res.summary.skipped).toBe(1)
    const item = res.items.find((i) => i.customerId === "recente" && i.channel === "whatsapp")!
    expect(item.status).toBe("skipped")
    expect(item.reason).toBe("cooldown")
    expect(queued.length).toBe(0)
  })

  it("allowResend=true NÃO derruba as outras exclusões (ex.: sem_divida_aberta segue barrando)", async () => {
    // devedor com contato recente E sem dívida aberta: a flag pula o cooldown, mas
    // sem_divida_aberta continua barrando os dois canais.
    ;(db.customers ??= []).push({ id: "semdiv", company_id: CO, phone: "11988887777", email: null })
    seedRecentContact("semdiv", "+5511988887777")
    // (sem seedCustomer → sem linha em db.debts → sem dívida aberta)
    const cid = await makeCampaign(["whatsapp"], ["semdiv"])
    const { runHubSend } = await import("@/lib/journey/campaign-send")
    const res = await runHubSend({ campaignId: cid, companyId: CO, dispatchMode: "queue", dryRun: false, allowResend: true })
    expect(res.summary.sent).toBe(0)
    const item = res.items.find((i) => i.customerId === "semdiv" && i.channel === "whatsapp")!
    expect(item.status).toBe("skipped")
    // a exclusão não é cooldown (foi pulada) — é sem_divida_aberta.
    expect(item.reason).toBe("sem_divida_aberta")
    expect(queued.length).toBe(0)
  })
})

describe("buildProviderSelector (T3-2)", () => {
  it("mock: devolve a string, sem carregar credencial", async () => {
    const { buildProviderSelector } = await import("@/lib/journey/campaign-send")
    expect(buildProviderSelector("mock", 42)).toBe("mock")
  })

  it("voxuy_api: injeta voxuy_flow_id do tenant no apiConfig", async () => {
    // URL-credencial no formato CANÔNICO exigido pelo enterprise_v1 (W1.1):
    // webhooks.voxuy.com/voxuyapi/<uuid>. O uuid é sintético (só hex/hífen).
    process.env.VOXUY_WEBHOOK_URL = "https://webhooks.voxuy.com/voxuyapi/deadbeef-cafe-babe-f00d-9f3a1b2c3d4e"
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
    // URL-credencial no formato CANÔNICO exigido pelo enterprise_v1 (W1.1):
    // webhooks.voxuy.com/voxuyapi/<uuid>. O uuid é sintético (só hex/hífen).
    process.env.VOXUY_WEBHOOK_URL = "https://webhooks.voxuy.com/voxuyapi/deadbeef-cafe-babe-f00d-9f3a1b2c3d4e"
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
