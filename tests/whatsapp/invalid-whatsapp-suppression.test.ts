// W4 — invalidWhatsApp → SUPRESSÃO do número.
//
// O inbound Enterprise mapeia contact.invalidWhatsApp=true → failed(error=
// "invalid_whatsapp") (lib/whatsapp/voxuy/inbound.ts). Aqui provamos que
// applyNormalizedEvent LIGA esse desfecho à supressão do TELEFONE (scope=phone,
// channel=whatsapp): o número entra em contact_suppressions e não é mais
// selecionado. Um failed comum (outro error) NÃO suprime.

import { beforeEach, describe, expect, it, vi } from "vitest"
import { mapVoxuyInbound } from "@/lib/whatsapp/voxuy/inbound"

// ---------------------------------------------------------------------------
// fake supabase: só o que applyNormalizedEvent (branch de status) usa —
// whatsapp_messages.select(...).or(...).maybeSingle() + update().
// ---------------------------------------------------------------------------
type Row = Record<string, any>
let db: Record<string, Row[]>

class QB {
  filters: Array<{ op: string; col: string; val?: any }> = []
  orExpr: string | null = null
  pUpdate: Row | null = null
  constructor(private t: string) {}
  select() { return this }
  eq(col: string, val: any) { this.filters.push({ op: "eq", col, val }); return this }
  or(expr: string) { this.orExpr = expr; return this }
  update(patch: Row) { this.pUpdate = patch; return this }
  private match(r: Row, f: { op: string; col: string; val?: any }): boolean {
    return f.op === "eq" ? r[f.col] === f.val : true
  }
  private matchOr(r: Row): boolean {
    if (!this.orExpr) return true
    return this.orExpr.split(",").some((clause) => {
      const [col, , ...rest] = clause.split(".")
      return String(r[col]) === rest.join(".")
    })
  }
  private filtered(): Row[] {
    return (db[this.t] ??= []).filter((r) => this.filters.every((f) => this.match(r, f)) && this.matchOr(r))
  }
  private run(): { data: Row[]; error: null } {
    if (this.pUpdate) {
      const target = this.filtered()
      for (const row of target) Object.assign(row, this.pUpdate)
      return { data: target, error: null }
    }
    return { data: this.filtered(), error: null }
  }
  async maybeSingle() { const { data } = this.run(); return { data: data[0] ?? null, error: null } }
  then(res: (r: { data: Row[]; error: null }) => void) { res(this.run()) }
}
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => ({ from: (t: string) => new QB(t) }) }))
vi.mock("@/lib/journey/events", () => ({ recordEvent: async () => ({ ok: true, duplicate: false }) }))

// addSuppression: spy (a mecânica de escrita é coberta pelos testes de suppressions).
const suppressCalls: any[] = []
vi.mock("@/lib/journey/suppressions", () => ({
  addSuppression: async (input: any) => { suppressCalls.push(input); return { ok: true, id: "sup1" } },
}))

const CO = "eeeeeeee-0000-0000-0000-000000000012"

function seedMessage(over: Partial<Row> = {}) {
  db.whatsapp_messages.push({
    id: "22222222-2222-2222-2222-222222222222", company_id: CO, campaign_id: "camp1",
    customer_id: "cust1", status: "sent", status_history: [], phone_e164: "+5511912341234", ...over,
  })
}

beforeEach(() => {
  db = { whatsapp_messages: [] }
  suppressCalls.length = 0
})

describe("applyNormalizedEvent — invalidWhatsApp suprime o número", () => {
  it("failed(invalid_whatsapp) → addSuppression(scope=phone, channel=whatsapp) do telefone da mensagem", async () => {
    seedMessage({ provider_message_id: "h_abc" })
    const { applyNormalizedEvent } = await import("@/lib/whatsapp/inbound-apply")
    // evento vindo do mapeador Enterprise (correlacionado por provider_message_id).
    const ev = mapVoxuyInbound(JSON.stringify({ contact: { hash: "h_abc", invalidWhatsApp: true } }))[0]
    await applyNormalizedEvent(ev, "voxuy")

    // suprimiu o NÚMERO da mensagem correlacionada.
    expect(suppressCalls.length).toBe(1)
    expect(suppressCalls[0]).toMatchObject({
      companyId: CO,
      scope: "phone",
      phoneE164: "+5511912341234",
      customerId: "cust1",
      channel: "whatsapp",
    })
    expect(suppressCalls[0].metadata).toMatchObject({ cause: "invalid_whatsapp" })
    // a mensagem foi marcada failed com o error.
    const msg = db.whatsapp_messages[0]
    expect(msg.status).toBe("failed")
    expect(msg.error).toBe("invalid_whatsapp")
  })

  it("failed COMUM (outro error) NÃO suprime o número", async () => {
    seedMessage({ provider_message_id: "h_xyz" })
    const { applyNormalizedEvent } = await import("@/lib/whatsapp/inbound-apply")
    await applyNormalizedEvent(
      { type: "failed", providerMessageId: "h_xyz", at: new Date().toISOString(), error: "provider_failed" },
      "voxuy",
    )
    expect(suppressCalls.length).toBe(0)
    expect(db.whatsapp_messages[0].status).toBe("failed")
  })

  it("sem mensagem correlacionada: não suprime (nada a fazer)", async () => {
    // db vazio: o provider_message_id não casa nenhuma linha.
    const { applyNormalizedEvent } = await import("@/lib/whatsapp/inbound-apply")
    await applyNormalizedEvent(
      { type: "failed", providerMessageId: "desconhecido", at: new Date().toISOString(), error: "invalid_whatsapp" },
      "voxuy",
    )
    expect(suppressCalls.length).toBe(0)
  })
})
