import { describe, expect, it } from "vitest"
import {
  EVENT_STAGE_MAP,
  STAGE_RANK,
  applyEventToState,
  initialState,
  reduceEvents,
  stageRank,
  type JourneyEventLike,
  type NegotiationStateProjection,
} from "@/lib/journey/negotiation-state"

let clock = 0
function ev(type: string, at?: string, extra: Partial<JourneyEventLike> = {}): JourneyEventLike {
  const occurred_at = at ?? new Date(Date.UTC(2026, 8, 21, 0, 0, clock++)).toISOString()
  return { event_type: type, occurred_at, ...extra }
}

/** Projeção incremental "de verdade": aplica evento a evento como em produção. */
function incremental(events: JourneyEventLike[]): NegotiationStateProjection {
  let s = initialState()
  for (const e of events) s = applyEventToState(s, e)
  return s
}

describe("STAGE_RANK / Apêndice A", () => {
  it("tem os ranks canônicos do prompt", () => {
    expect(STAGE_RANK.not_started).toBe(0)
    expect(STAGE_RANK.queued).toBe(10)
    expect(STAGE_RANK.dispatched).toBe(20)
    expect(STAGE_RANK.delivered).toBe(30)
    expect(STAGE_RANK.read).toBe(35)
    expect(STAGE_RANK.link_opened).toBe(40)
    expect(STAGE_RANK.authenticated).toBe(50)
    expect(STAGE_RANK.chat_idle).toBe(55)
    expect(STAGE_RANK.in_chat).toBe(60)
    expect(STAGE_RANK.not_recognized).toBe(64)
    expect(STAGE_RANK.acknowledged).toBe(65)
    expect(STAGE_RANK.offer_presented).toBe(70)
    expect(STAGE_RANK.charge_cancelled).toBe(75)
    expect(STAGE_RANK.charge_generated).toBe(80)
    expect(STAGE_RANK.overdue).toBe(85)
    expect(STAGE_RANK.paid).toBe(100)
    expect(STAGE_RANK.dispute).toBe(45)
    expect(STAGE_RANK.human_handoff).toBe(45)
    expect(STAGE_RANK.opted_out).toBe(5)
    expect(STAGE_RANK.blocked).toBe(5)
    expect(STAGE_RANK.no_contact).toBe(1)
  })
})

describe("EVENT_STAGE_MAP — eventos reais → estágio", () => {
  const expectations: Array<[string, string]> = [
    ["message.queued", "queued"],
    ["message.accepted", "dispatched"],
    ["message.delivered", "delivered"],
    ["message.read", "read"],
    ["link.clicked", "link_opened"],
    ["auth.success", "authenticated"],
    ["session.started", "authenticated"],
    ["chat.turn.customer", "in_chat"],
    ["debt.viewed", "in_chat"],
    ["debt.acknowledged", "acknowledged"],
    ["debt.not_recognized", "not_recognized"],
    ["offer.presented", "offer_presented"],
    ["payment.generated", "charge_generated"],
    ["payment.overdue", "overdue"],
    ["payment.paid", "paid"],
    ["payment.cancelled", "charge_cancelled"],
    ["dispute", "dispute"],
    ["dispute.registered", "dispute"],
    ["human.transfer", "human_handoff"],
    ["optout.received", "opted_out"],
    ["block.received", "blocked"],
  ]
  for (const [type, stage] of expectations) {
    it(`${type} → ${stage}`, () => {
      expect(EVENT_STAGE_MAP[type]?.stage).toBe(stage)
      const s = applyEventToState(initialState(), ev(type))
      expect(s.stage).toBe(stage)
      expect(s.stage_rank).toBe(stageRank(stage))
    })
  }

  it("evento desconhecido não muda o estágio", () => {
    const s0 = applyEventToState(initialState(), ev("message.queued"))
    const s1 = applyEventToState(s0, ev("cpf"))
    expect(s1.stage).toBe("queued")
  })
})

describe("monotonicidade — estágio nunca regride por evento de canal", () => {
  it("mensagem reenviada NÃO faz paid regredir para dispatched", () => {
    const events = [
      ev("message.queued"),
      ev("payment.generated"),
      ev("payment.paid"),
      ev("message.delivered"), // canal atrasado/reenviado
      ev("message.read"),
    ]
    const s = incremental(events)
    expect(s.stage).toBe("paid")
    expect(s.stage_rank).toBe(100)
  })

  it("read chegando depois de authenticated não regride", () => {
    const s = incremental([ev("auth.success"), ev("message.read")])
    expect(s.stage).toBe("authenticated")
  })

  it("stage_rank é monotônico ao longo do funil feliz", () => {
    const seq = [
      "message.queued",
      "message.delivered",
      "message.read",
      "link.clicked",
      "auth.success",
      "chat.turn.customer",
      "debt.acknowledged",
      "offer.presented",
      "payment.generated",
      "payment.paid",
    ]
    let s = initialState()
    let prev = -1
    for (const t of seq) {
      s = applyEventToState(s, ev(t))
      expect(s.stage_rank).toBeGreaterThanOrEqual(prev)
      prev = s.stage_rank
    }
    expect(s.stage).toBe("paid")
  })
})

describe("eventos de domínio — regridem o estágio deliberadamente", () => {
  it("payment.cancelled baixa de charge_generated para charge_cancelled", () => {
    const s = incremental([ev("payment.generated"), ev("payment.cancelled")])
    expect(s.stage).toBe("charge_cancelled")
    expect(s.stage_rank).toBe(75)
    expect(s.has_live_charge).toBe(false)
  })

  it("optout.received regride mesmo depois de in_chat", () => {
    const s = incremental([ev("auth.success"), ev("chat.turn.customer"), ev("optout.received")])
    expect(s.stage).toBe("opted_out")
    expect(s.stage_rank).toBe(5)
  })

  it("human.transfer estabiliza em human_handoff", () => {
    const s = incremental([ev("offer.presented"), ev("human.transfer")])
    expect(s.stage).toBe("human_handoff")
  })
})

describe("has_live_charge", () => {
  it("verdadeiro em charge_generated e overdue", () => {
    expect(incremental([ev("payment.generated")]).has_live_charge).toBe(true)
    expect(incremental([ev("payment.generated"), ev("payment.overdue")]).has_live_charge).toBe(true)
  })
  it("falso após pagamento e após cancelamento", () => {
    expect(incremental([ev("payment.generated"), ev("payment.paid")]).has_live_charge).toBe(false)
    expect(incremental([ev("payment.generated"), ev("payment.cancelled")]).has_live_charge).toBe(false)
  })
})

describe("marks — carimbo do primeiro evento de cada marco", () => {
  it("registra o timestamp do marco na primeira ocorrência", () => {
    const t1 = "2026-09-21T10:00:00.000Z"
    const t2 = "2026-09-21T11:00:00.000Z"
    const s = incremental([
      ev("payment.generated", t1),
      ev("payment.generated", t2), // repetido: marca não muda
    ])
    expect(s.marks.charge_generated).toBe(t1)
  })

  it("acumula marcos distintos", () => {
    const s = incremental([ev("message.queued"), ev("auth.success"), ev("payment.paid")])
    expect(s.marks.queued).toBeDefined()
    expect(s.marks.authenticated).toBeDefined()
    expect(s.marks.paid).toBeDefined()
  })
})

describe("correlações (campaign/session/agreement)", () => {
  it("guarda o vínculo mais recente sem afetar o estágio", () => {
    const s = incremental([
      ev("message.queued", undefined, { campaign_id: "camp1" }),
      ev("session.started", undefined, { session_id: "sess1" }),
      ev("payment.generated", undefined, { agreement_id: "agr1" }),
    ])
    expect(s.campaign_id).toBe("camp1")
    expect(s.session_id).toBe("sess1")
    expect(s.agreement_id).toBe("agr1")
  })
})

describe("rebuild == incremental (diferença ZERO)", () => {
  // Conjunto sintético com fora de ordem, canal atrasado e domínio regressivo.
  const synthetic: JourneyEventLike[] = [
    ev("message.read", "2026-09-21T09:05:00.000Z"),
    ev("message.queued", "2026-09-21T09:00:00.000Z"),
    ev("auth.success", "2026-09-21T09:10:00.000Z", { session_id: "s1" }),
    ev("chat.turn.customer", "2026-09-21T09:11:00.000Z"),
    ev("offer.presented", "2026-09-21T09:12:00.000Z"),
    ev("payment.generated", "2026-09-21T09:13:00.000Z", { agreement_id: "a1" }),
    ev("message.delivered", "2026-09-21T09:02:00.000Z"), // canal fora de ordem
    ev("payment.paid", "2026-09-21T09:20:00.000Z"),
  ]

  it("reduceEvents (rebuild) iguala a projeção incremental ordenada", () => {
    // rebuild reduz a lista já ordenada internamente
    const rebuilt = reduceEvents(synthetic)
    // incremental precisa aplicar em ordem cronológica (como o banco entrega)
    const ordered = [...synthetic].sort((a, b) => (a.occurred_at < b.occurred_at ? -1 : 1))
    const inc = incremental(ordered)
    expect(rebuilt).toEqual(inc)
  })

  it("resultado final é paid com os marcos e correlações corretos", () => {
    const s = reduceEvents(synthetic)
    expect(s.stage).toBe("paid")
    expect(s.stage_rank).toBe(100)
    expect(s.session_id).toBe("s1")
    expect(s.agreement_id).toBe("a1")
    expect(s.marks.queued).toBe("2026-09-21T09:00:00.000Z")
    expect(s.marks.paid).toBe("2026-09-21T09:20:00.000Z")
    expect(s.has_live_charge).toBe(false)
  })

  it("cenário com cancelamento: rebuild==incremental e estágio regride", () => {
    const evs: JourneyEventLike[] = [
      ev("message.queued", "2026-09-21T08:00:00.000Z"),
      ev("payment.generated", "2026-09-21T08:30:00.000Z"),
      ev("payment.cancelled", "2026-09-21T09:00:00.000Z"),
    ]
    const rebuilt = reduceEvents(evs)
    const inc = incremental(evs)
    expect(rebuilt).toEqual(inc)
    expect(rebuilt.stage).toBe("charge_cancelled")
  })
})
