// Achado 7.2 — OPT-OUT do fluxo Voxuy ("Sair da lista"/"Cancelar Recebimento").
//
// Quando o devedor clica o botão de saída no funil Voxuy, o nó Webhook (modo
// personalizado) avisa a AlteaPay. Aqui provamos:
//  (a) o mapeador reconhece o opt-out nos formatos aceitos (campo `evento`/
//      `event` com valor de saída; flag booleano; aninhado em contact) e emite
//      um evento `contactOptout` com telefone (E.164) e contactRef;
//  (b) applyNormalizedEvent registra a supressão do NÚMERO (scope=phone,
//      channel=whatsapp, reason=optout), correlacionando por mensagem;
//  (c) idempotência — reprocessar não duplica (addSuppression dedupe);
//  (d) payload SEM opt-out => nenhum contactOptout, nenhuma supressão;
//  (e) a supressão por reason=optout torna o contato INELEGÍVEL no hub.

import { beforeEach, describe, expect, it, vi } from "vitest"
import { mapVoxuyInbound } from "@/lib/whatsapp/voxuy/inbound"

// ---------------------------------------------------------------------------
// fake supabase mínimo: whatsapp_messages.select(...).or(...).order().limit()
// .maybeSingle() (correlação do opt-out) + contact_suppressions para provar a
// idempotência real de addSuppression e a inelegibilidade do hub.
// ---------------------------------------------------------------------------
type Row = Record<string, any>
let db: Record<string, Row[]>

class QB {
  filters: Array<{ op: string; col: string; val?: any; vals?: any[] }> = []
  orExpr: string | null = null
  isNull: string[] = []
  pUpdate: Row | null = null
  pInsert: Row | null = null
  constructor(private t: string) {}
  select() { return this }
  insert(row: Row) { this.pInsert = row; return this }
  update(patch: Row) { this.pUpdate = patch; return this }
  eq(col: string, val: any) { this.filters.push({ op: "eq", col, val }); return this }
  in(col: string, vals: any[]) { this.filters.push({ op: "in", col, vals }); return this }
  is(col: string, val: any) { if (val === null) this.isNull.push(col); return this }
  or(expr: string) { this.orExpr = expr; return this }
  order() { return this }
  limit() { return this }
  private match(r: Row, f: { op: string; col: string; val?: any; vals?: any[] }): boolean {
    if (f.op === "eq") return r[f.col] === f.val
    if (f.op === "in") return (f.vals ?? []).includes(r[f.col])
    return true
  }
  private matchOr(r: Row): boolean {
    if (!this.orExpr) return true
    return this.orExpr.split(",").some((clause) => {
      const [col, , ...rest] = clause.split(".")
      return String(r[col]) === rest.join(".")
    })
  }
  private matchNull(r: Row): boolean {
    return this.isNull.every((c) => r[c] === null || r[c] === undefined)
  }
  private filtered(): Row[] {
    return (db[this.t] ??= []).filter(
      (r) => this.filters.every((f) => this.match(r, f)) && this.matchOr(r) && this.matchNull(r),
    )
  }
  private run(): { data: Row[]; error: null } {
    if (this.pInsert) {
      const row = { id: `id_${(db[this.t] ??= []).length + 1}`, active: true, ...this.pInsert }
      ;(db[this.t] ??= []).push(row)
      return { data: [row], error: null }
    }
    if (this.pUpdate) {
      const target = this.filtered()
      for (const row of target) Object.assign(row, this.pUpdate)
      return { data: target, error: null }
    }
    return { data: this.filtered(), error: null }
  }
  async maybeSingle() { const { data } = this.run(); return { data: data[0] ?? null, error: null } }
  async single() { const { data } = this.run(); return { data: data[0] ?? null, error: null } }
  then(res: (r: { data: Row[]; error: null }) => void) { res(this.run()) }
}

vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => ({ from: (t: string) => new QB(t) }) }))
vi.mock("@/lib/journey/events", () => ({ recordEvent: async () => ({ ok: true, duplicate: false }) }))
// stop-signal é disparado por addSuppression(optout); no-op no teste.
vi.mock("@/lib/journey/stop-signal", () => ({ fireStopSignal: async () => ({ ok: true }) }))

const CO = "eeeeeeee-0000-0000-0000-000000000012"
const PHONE = "+5511912341234"

function seedMessage(over: Partial<Row> = {}) {
  ;(db.whatsapp_messages ??= []).push({
    id: "22222222-2222-2222-2222-222222222222", company_id: CO, campaign_id: "camp1",
    customer_id: "cust1", status: "accepted", status_history: [], phone_e164: PHONE,
    provider_message_id: "h_abc", created_at: "2026-09-23T10:00:00.000Z", ...over,
  })
}

beforeEach(() => {
  db = { whatsapp_messages: [], contact_suppressions: [] }
})

describe("mapVoxuyInbound — opt-out do fluxo Voxuy (achado 7.2)", () => {
  const accepted: Array<[string, unknown]> = [
    ["evento=optout na raiz", { evento: "optout", contact: { hash: "h_abc", phoneNumber: PHONE } }],
    ["event=unsubscribe na raiz", { event: "unsubscribe", contact: { hash: "h_abc", phoneNumber: PHONE } }],
    ["evento=SAIR (case-insensitive)", { evento: "SAIR", contact: { phoneNumber: PHONE } }],
    ["evento=descadastro com acento tolerado", { evento: "descadastro", phoneNumber: PHONE }],
    ["evento aninhado em contact", { contact: { hash: "h_abc", phoneNumber: PHONE, evento: "blacklist" } }],
    ["flag booleano optout=true", { optout: true, contact: { phoneNumber: PHONE } }],
    ['flag "sim" unsubscribe', { unsubscribe: "sim", phoneNumber: PHONE }],
  ]

  for (const [label, payload] of accepted) {
    it(`reconhece opt-out: ${label}`, () => {
      const evs = mapVoxuyInbound(JSON.stringify(payload))
      expect(evs).toHaveLength(1)
      expect(evs[0]).toMatchObject({ type: "contactOptout", phoneE164: PHONE })
    })
  }

  it("deriva contactRef de contact.hash quando presente", () => {
    const evs = mapVoxuyInbound(JSON.stringify({ evento: "optout", contact: { hash: "h_zzz", phoneNumber: PHONE } }))
    expect(evs[0]).toMatchObject({ type: "contactOptout", contactRef: "h_zzz" })
  })

  it("opt-out sem telefone: mapeia com phoneE164=null (correlação por ref no apply)", () => {
    const evs = mapVoxuyInbound(JSON.stringify({ evento: "optout", contact: { hash: "h_abc" } }))
    expect(evs[0]).toMatchObject({ type: "contactOptout", phoneE164: null, contactRef: "h_abc" })
  })

  it("payload SEM opt-out (contato válido) => [] (nada a fazer)", () => {
    expect(mapVoxuyInbound(JSON.stringify({ contact: { hash: "h", phoneNumber: PHONE } }))).toEqual([])
    expect(mapVoxuyInbound(JSON.stringify({ evento: "compra", contact: { phoneNumber: PHONE } }))).toEqual([])
    expect(mapVoxuyInbound(JSON.stringify({ optout: false, contact: { phoneNumber: PHONE } }))).toEqual([])
  })

  it("evento legado A.5 { event:'optout' } continua no caminho legado (não é hijacked)", () => {
    const evs = mapVoxuyInbound(JSON.stringify({ event: "optout", phone: PHONE }))
    expect(evs[0]).toMatchObject({ type: "optout", phone: PHONE })
  })
})

describe("applyNormalizedEvent — opt-out registra supressão do número", () => {
  it("contactOptout correlacionado por telefone => supressão scope=phone/channel=whatsapp/reason=optout", async () => {
    seedMessage()
    const { applyNormalizedEvent } = await import("@/lib/whatsapp/inbound-apply")
    const ev = mapVoxuyInbound(JSON.stringify({ evento: "optout", contact: { phoneNumber: PHONE } }))[0]
    await applyNormalizedEvent(ev, "voxuy")

    expect(db.contact_suppressions).toHaveLength(1)
    expect(db.contact_suppressions[0]).toMatchObject({
      company_id: CO,
      scope: "phone",
      phone_e164: PHONE,
      customer_id: "cust1",
      channel: "whatsapp",
      reason: "optout",
      source: "voxuy",
    })
    expect(db.contact_suppressions[0].metadata).toMatchObject({ cause: "voxuy_flow_optout" })
  })

  it("correlaciona por contactRef quando o payload não traz telefone", async () => {
    seedMessage({ provider_message_id: "h_ref" })
    const { applyNormalizedEvent } = await import("@/lib/whatsapp/inbound-apply")
    const ev = mapVoxuyInbound(JSON.stringify({ evento: "optout", contact: { hash: "h_ref" } }))[0]
    await applyNormalizedEvent(ev, "voxuy")
    expect(db.contact_suppressions).toHaveLength(1)
    expect(db.contact_suppressions[0]).toMatchObject({ phone_e164: PHONE, company_id: CO, reason: "optout" })
  })

  it("idempotente: reprocessar o MESMO opt-out não duplica a supressão", async () => {
    seedMessage()
    const { applyNormalizedEvent } = await import("@/lib/whatsapp/inbound-apply")
    const ev = mapVoxuyInbound(JSON.stringify({ evento: "optout", contact: { phoneNumber: PHONE } }))[0]
    await applyNormalizedEvent(ev, "voxuy")
    await applyNormalizedEvent(ev, "voxuy")
    expect(db.contact_suppressions).toHaveLength(1)
  })

  it("sem correlação e sem telefone => nada a suprimir (nunca 500)", async () => {
    // db vazio, ref desconhecido, sem phone no payload.
    const { applyNormalizedEvent } = await import("@/lib/whatsapp/inbound-apply")
    await applyNormalizedEvent(
      { type: "contactOptout", phoneE164: null, contactRef: "desconhecido", at: new Date().toISOString() },
      "voxuy",
    )
    expect(db.contact_suppressions).toHaveLength(0)
  })

  it("sem correlação MAS com telefone => supressão global do número (companyId=null)", async () => {
    const { applyNormalizedEvent } = await import("@/lib/whatsapp/inbound-apply")
    await applyNormalizedEvent(
      { type: "contactOptout", phoneE164: PHONE, contactRef: "", at: new Date().toISOString() },
      "voxuy",
    )
    expect(db.contact_suppressions).toHaveLength(1)
    expect(db.contact_suppressions[0]).toMatchObject({
      company_id: null, scope: "phone", phone_e164: PHONE, channel: "whatsapp", reason: "optout",
    })
  })
})

describe("isSuppressed — opt-out torna o número inelegível (canal WhatsApp)", () => {
  it("após o opt-out, isSuppressed(whatsapp, telefone) => true", async () => {
    seedMessage()
    const { applyNormalizedEvent } = await import("@/lib/whatsapp/inbound-apply")
    const ev = mapVoxuyInbound(JSON.stringify({ evento: "optout", contact: { phoneNumber: PHONE } }))[0]
    await applyNormalizedEvent(ev, "voxuy")

    const { isSuppressed } = await import("@/lib/journey/suppressions")
    const suppressed = await isSuppressed({ companyId: CO, channel: "whatsapp", phoneE164: PHONE, customerId: "cust1" })
    expect(suppressed).toBe(true)
  })

  it("e-mail NÃO é suprimido automaticamente pelo opt-out do WhatsApp (decisão de produto)", async () => {
    seedMessage()
    const { applyNormalizedEvent } = await import("@/lib/whatsapp/inbound-apply")
    const ev = mapVoxuyInbound(JSON.stringify({ evento: "optout", contact: { phoneNumber: PHONE } }))[0]
    await applyNormalizedEvent(ev, "voxuy")

    const { isSuppressed } = await import("@/lib/journey/suppressions")
    // canal email não é coberto por uma supressão channel=whatsapp
    const emailSuppressed = await isSuppressed({ companyId: CO, channel: "email", customerId: "cust1" })
    expect(emailSuppressed).toBe(false)
  })
})
