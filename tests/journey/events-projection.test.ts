// Gancho GLOBAL da projeção: prova que recordEvent (não-duplicata, com company+
// customer) atualiza negotiation_state AO VIVO para QUALQUER evento — não só envio.
// Cobre: auth.success → authenticated; message.* com payload.channel gravando
// `channel`/`provider_status_source`; idempotência (duplicata NÃO reprojeta); e a
// tolerância a mock (a projeção nunca derruba o recordEvent).

import { beforeEach, describe, expect, it, vi } from "vitest"

// Fake Supabase mínimo para o par insert(journey_events) + select/upsert(negotiation_state).
type Row = Record<string, any>
interface Db {
  journey_events: Row[]
  negotiation_state: Row[]
}
const db: Db = { journey_events: [], negotiation_state: [] }

// Controla se a duplicata deve ser simulada (23505) na próxima inserção.
let forceDuplicate = false
// Controla se o upsert da projeção deve estourar (simula mock sem upsert).
let throwOnUpsert = false

function fakeClient() {
  return {
    from(table: string) {
      const filters: Array<{ col: string; val: any }> = []
      let pendingUpsert: Row | null = null
      const builder: any = {
        insert(rows: Row | Row[]) {
          const list = Array.isArray(rows) ? rows : [rows]
          if (table === "journey_events" && forceDuplicate) {
            return { error: { code: "23505", message: "dup" } }
          }
          for (const r of list) db[table as keyof Db].push({ ...r })
          return { error: null }
        },
        select() {
          return builder
        },
        eq(col: string, val: any) {
          filters.push({ col, val })
          return builder
        },
        upsert(row: Row, _opts?: unknown) {
          if (throwOnUpsert) throw new Error("mock sem upsert")
          pendingUpsert = row
          const arr = db[table as keyof Db]
          const idx = arr.findIndex(
            (r) => r.company_id === row.company_id && r.customer_id === row.customer_id,
          )
          if (idx >= 0) arr[idx] = { ...arr[idx], ...row }
          else arr.push({ ...row })
          return Promise.resolve({ error: null })
        },
        async maybeSingle() {
          const arr = db[table as keyof Db]
          const found = arr.find((r) => filters.every((f) => r[f.col] === f.val))
          return { data: found ?? null, error: null }
        },
      }
      return builder
    },
  }
}

vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => fakeClient() }))

import { recordEvent } from "@/lib/journey/events"

const CO = "co-1"
const CU = "cust-1"

function readState() {
  return db.negotiation_state.find((r) => r.company_id === CO && r.customer_id === CU) ?? null
}

beforeEach(() => {
  db.journey_events = []
  db.negotiation_state = []
  forceDuplicate = false
  throwOnUpsert = false
})

describe("gancho global — projeção AO VIVO a partir de recordEvent", () => {
  it("auth.success projeta o estágio 'authenticated'", async () => {
    const r = await recordEvent({
      companyId: CO,
      customerId: CU,
      sessionId: "s1",
      type: "auth.success",
      actor: "customer",
      occurredAt: "2026-09-21T10:00:00.000Z",
    })
    expect(r).toEqual({ ok: true, duplicate: false })
    const s = readState()
    expect(s?.stage).toBe("authenticated")
    expect(s?.stage_rank).toBe(50)
    expect(s?.session_id).toBe("s1")
    // sem canal: fica nulo (evento de auth não traz channel)
    expect(s?.channel).toBeNull()
  })

  it("message.sent com payload.channel grava channel e provider_status_source", async () => {
    await recordEvent({
      companyId: CO,
      customerId: CU,
      campaignId: "camp1",
      type: "message.sent",
      actor: "system",
      payload: { channel: "whatsapp" },
      occurredAt: "2026-09-21T10:05:00.000Z",
    })
    const s = readState()
    expect(s?.stage).toBe("dispatched")
    expect(s?.channel).toBe("whatsapp")
    expect(s?.provider_status_source).toBe("none")
    expect(s?.campaign_id).toBe("camp1")
  })

  it("canal e-mail idem; evento posterior sem canal NÃO regride o canal", async () => {
    await recordEvent({
      companyId: CO, customerId: CU, type: "message.sent", actor: "system",
      payload: { channel: "email" }, occurredAt: "2026-09-21T10:00:00.000Z",
    })
    // evento de auth depois, SEM canal — canal deve permanecer 'email'
    await recordEvent({
      companyId: CO, customerId: CU, type: "auth.success", actor: "customer",
      occurredAt: "2026-09-21T10:10:00.000Z",
    })
    const s = readState()
    expect(s?.stage).toBe("authenticated")
    expect(s?.channel).toBe("email")
  })

  it("avança o funil ao vivo por eventos sucessivos (envio→auth→reconhecimento→pago)", async () => {
    const at = (m: number) => `2026-09-21T10:${String(m).padStart(2, "0")}:00.000Z`
    await recordEvent({ companyId: CO, customerId: CU, type: "message.queued", actor: "system", payload: { channel: "whatsapp" }, occurredAt: at(0) })
    await recordEvent({ companyId: CO, customerId: CU, type: "auth.success", actor: "customer", occurredAt: at(5) })
    await recordEvent({ companyId: CO, customerId: CU, type: "debt.acknowledged", actor: "customer", occurredAt: at(10) })
    await recordEvent({ companyId: CO, customerId: CU, type: "payment.generated", actor: "system", occurredAt: at(15) })
    await recordEvent({ companyId: CO, customerId: CU, type: "payment.paid", actor: "system", occurredAt: at(20) })
    const s = readState()
    expect(s?.stage).toBe("paid")
    expect(s?.stage_rank).toBe(100)
    expect(s?.channel).toBe("whatsapp")
    expect(s?.has_live_charge).toBe(false)
  })

  it("evento DUPLICATA (23505) NÃO reprojeta", async () => {
    forceDuplicate = true
    const r = await recordEvent({
      companyId: CO, customerId: CU, type: "auth.success", actor: "customer",
      occurredAt: "2026-09-21T10:00:00.000Z",
    })
    expect(r).toEqual({ ok: true, duplicate: true })
    expect(readState()).toBeNull() // nada projetado
  })

  it("sem customerId → sem projeção (mas recordEvent ok)", async () => {
    const r = await recordEvent({
      companyId: CO, type: "campaign.created", actor: "admin",
      occurredAt: "2026-09-21T10:00:00.000Z",
    })
    expect(r.ok).toBe(true)
    expect(db.negotiation_state).toHaveLength(0)
  })

  it("falha da projeção é NÃO-FATAL: recordEvent ainda retorna ok", async () => {
    throwOnUpsert = true
    const r = await recordEvent({
      companyId: CO, customerId: CU, type: "auth.success", actor: "customer",
      occurredAt: "2026-09-21T10:00:00.000Z",
    })
    expect(r).toEqual({ ok: true, duplicate: false })
    // o evento foi gravado; a projeção falhou silenciosamente
    expect(db.journey_events).toHaveLength(1)
    expect(readState()).toBeNull()
  })
})
