// Testes da página de negociações (T5): lógica PURA — estágios, contadores
// (total = soma), parsing/serialização de filtros e resultado por devedor.
// Sem banco (a camada de query usa service client; validada por outras trilhas).

import { describe, it, expect } from "vitest"
import {
  STAGE_META,
  STAGE_ORDER,
  stageMeta,
  stageLabel,
  buildStageCounts,
  sumStageCounts,
  countersReconcile,
  CONTACT_PROFILES,
  CONTACT_PROFILE_META,
} from "@/components/super-admin/negotiations/stages"
import {
  parseFilters,
  serializeFilters,
  contentFilters,
  type NegotiationFilters,
} from "@/components/super-admin/negotiations/filters"
import {
  emptyOutcomeCounts,
  tallyOutcomes,
  summarizeForDisplay,
  failureRows,
  detailLabel,
  type SendResponse,
  type SendResultRow,
} from "@/components/super-admin/negotiations/send-contract"
import { STAGE_RANK } from "@/lib/journey/negotiation-state"

describe("stages — espelho do Apêndice A (T1)", () => {
  it("os ranks locais batem com STAGE_RANK do contrato de T1", () => {
    for (const meta of STAGE_META) {
      expect(STAGE_RANK[meta.stage]).toBe(meta.rank)
    }
  })

  it("STAGE_ORDER está em ranks não-decrescentes (ordem do funil)", () => {
    const ranks = STAGE_ORDER.map((s) => stageMeta(s).rank)
    for (let i = 1; i < ranks.length; i++) {
      expect(ranks[i]).toBeGreaterThanOrEqual(ranks[i - 1])
    }
  })

  it("stageMeta desconhecido cai em fallback muted/rank 0", () => {
    const m = stageMeta("nope")
    expect(m.rank).toBe(0)
    expect(m.tone).toBe("muted")
  })

  it("stageLabel devolve pt-BR compreensível sem treino", () => {
    expect(stageLabel("paid")).toBe("Pago")
    expect(stageLabel("overdue")).toBe("Em atraso")
    expect(stageLabel("in_chat")).toBe("Em conversa")
  })

  it("todos os perfis de contato têm rótulo + ícone", () => {
    for (const p of CONTACT_PROFILES) {
      expect(CONTACT_PROFILE_META[p].label.length).toBeGreaterThan(0)
      expect(CONTACT_PROFILE_META[p].icon.length).toBeGreaterThan(0)
    }
  })
})

describe("contadores por estágio — total = soma (§5)", () => {
  it("buildStageCounts respeita a ordem do funil e omite zeros", () => {
    const byStage = { paid: 3, dispatched: 5, not_started: 0, in_chat: 2 }
    const counts = buildStageCounts(byStage)
    // não inclui not_started (zero)
    expect(counts.find((c) => c.stage === "not_started")).toBeUndefined()
    // ordenados por rank: dispatched(20) < in_chat(60) < paid(100)
    expect(counts.map((c) => c.stage)).toEqual(["dispatched", "in_chat", "paid"])
  })

  it("sumStageCounts == total filtrado", () => {
    const byStage = { paid: 3, dispatched: 5, in_chat: 2 }
    const counts = buildStageCounts(byStage)
    expect(sumStageCounts(counts)).toBe(10)
  })

  it("countersReconcile true quando a soma fecha e false quando não fecha", () => {
    expect(countersReconcile({ paid: 3, dispatched: 5, in_chat: 2 }, 10)).toBe(true)
    expect(countersReconcile({ paid: 3, dispatched: 5, in_chat: 2 }, 11)).toBe(false)
  })

  it("estágio fora do mapa (defensivo) ainda entra na soma", () => {
    const byStage = { paid: 2, ghost_stage: 4 }
    const counts = buildStageCounts(byStage)
    expect(sumStageCounts(counts)).toBe(6)
    expect(countersReconcile(byStage, 6)).toBe(true)
  })
})

describe("filtros — parse/serialize idempotente e combináveis (§4)", () => {
  it("parse de todos os filtros combinados", () => {
    const raw = new URLSearchParams({
      companyId: "co-1",
      stage: "paid,overdue",
      contact_profile: "mobile,both",
      channel: "whatsapp",
      campaign: "camp-1",
      live_charge: "1",
      suppressed: "0",
      aging_min: "30",
      aging_max: "90",
      value_min: "100.5",
      value_max: "5000",
      activity_since: "2026-09-01",
      activity_until: "2026-09-20",
      q: "***.456.789-**",
      sort: "stage",
      dir: "asc",
      page: "2",
      pageSize: "25",
    })
    const f = parseFilters(raw)
    expect(f.companyId).toBe("co-1")
    expect(f.stages).toEqual(["paid", "overdue"])
    expect(f.contactProfiles).toEqual(["mobile", "both"])
    expect(f.channel).toBe("whatsapp")
    expect(f.campaignId).toBe("camp-1")
    expect(f.hasLiveCharge).toBe(true)
    expect(f.suppressed).toBe(false)
    expect(f.agingMin).toBe(30)
    expect(f.agingMax).toBe(90)
    expect(f.valueMin).toBeCloseTo(100.5)
    expect(f.valueMax).toBe(5000)
    expect(f.activitySince).toBe("2026-09-01")
    expect(f.activityUntil).toBe("2026-09-20")
    expect(f.search).toBe("***.456.789-**")
    expect(f.sort).toBe("stage")
    expect(f.dir).toBe("asc")
    expect(f.page).toBe(2)
    expect(f.pageSize).toBe(25)
  })

  it("perfis de contato inválidos são descartados", () => {
    const f = parseFilters(new URLSearchParams({ contact_profile: "mobile,bogus,none" }))
    expect(f.contactProfiles).toEqual(["mobile", "none"])
  })

  it("pageSize é limitado ao teto e mínimo", () => {
    expect(parseFilters(new URLSearchParams({ pageSize: "9999" })).pageSize).toBe(200)
    expect(parseFilters(new URLSearchParams({ pageSize: "0" })).pageSize).toBe(1)
    expect(parseFilters(new URLSearchParams({})).pageSize).toBe(50)
  })

  it("serialize→parse é estável (round-trip)", () => {
    const raw = new URLSearchParams({
      companyId: "co-9",
      stage: "in_chat",
      contact_profile: "email_only",
      live_charge: "0",
      aging_min: "10",
      value_max: "999",
      q: "**.456.789/****-**",
      sort: "last_activity",
      dir: "desc",
      page: "3",
    })
    const f1 = parseFilters(raw)
    const f2 = parseFilters(new URLSearchParams(serializeFilters(f1)))
    expect(f2).toEqual(f1)
  })

  it("contentFilters descarta paginação/ordenação (seleção 'todos os N')", () => {
    const f = parseFilters(
      new URLSearchParams({ companyId: "co-1", stage: "paid", page: "5", pageSize: "10", sort: "stage" }),
    )
    const cf = contentFilters(f)
    expect("page" in cf).toBe(false)
    expect("pageSize" in cf).toBe(false)
    expect("sort" in cf).toBe(false)
    expect("dir" in cf).toBe(false)
    expect(cf.companyId).toBe("co-1")
    expect(cf.stages).toEqual(["paid"])
  })

  it("defaults sensatos quando vazio", () => {
    const f: NegotiationFilters = parseFilters(new URLSearchParams({}))
    expect(f.companyId).toBeNull()
    expect(f.stages).toEqual([])
    expect(f.hasLiveCharge).toBeNull()
    expect(f.sort).toBe("last_activity")
    expect(f.dir).toBe("desc")
    expect(f.page).toBe(0)
  })

  it("aceita objeto simples (searchParams do Next), não só URLSearchParams", () => {
    const f = parseFilters({ companyId: "co-2", stage: "paid,read", page: "1" })
    expect(f.companyId).toBe("co-2")
    expect(f.stages).toEqual(["paid", "read"])
    expect(f.page).toBe(1)
  })
})

describe("resultado por devedor — contadores de desfecho", () => {
  it("emptyOutcomeCounts zera os quatro desfechos", () => {
    expect(emptyOutcomeCounts()).toEqual({ sent: 0, failed: 0, suppressed: 0, skipped: 0 })
  })

  it("tallyOutcomes agrega por desfecho e a soma == nº de linhas", () => {
    const rows: SendResultRow[] = [
      { customerId: "a", documentMasked: "***-01", channel: "whatsapp", outcome: "sent" },
      { customerId: "b", documentMasked: "***-02", channel: "email", outcome: "sent" },
      { customerId: "c", documentMasked: "***-03", channel: null, outcome: "suppressed" },
      { customerId: "d", documentMasked: "***-04", channel: "whatsapp", outcome: "failed" },
      { customerId: "e", documentMasked: "***-05", channel: null, outcome: "skipped" },
    ]
    const counts = tallyOutcomes(rows)
    expect(counts).toEqual({ sent: 2, failed: 1, suppressed: 1, skipped: 1 })
    const sum = Object.values(counts).reduce((s, c) => s + c, 0)
    expect(sum).toBe(rows.length)
  })
})

// A3.3 — feedback na tela do diálogo de envio: resumo em 5 categorias (separa
// "enviadas" de "simuladas"), lista de falhas com motivo legível, e rótulos.
describe("feedback do envio (A3.3) — resumo/falhas/rótulos", () => {
  const RESULTS: SendResultRow[] = [
    { customerId: "a", documentMasked: "***-01", channel: "whatsapp", outcome: "sent" },
    { customerId: "b", documentMasked: "***-02", channel: "email", outcome: "sent" },
    { customerId: "c", documentMasked: "***-03", channel: null, outcome: "suppressed", detail: "suprimido" },
    { customerId: "d", documentMasked: "***-04", channel: "whatsapp", outcome: "failed", detail: "send_failed" },
    { customerId: "e", documentMasked: "***-05", channel: null, outcome: "skipped", detail: "sem_contato" },
  ]

  it("summarizeForDisplay (real): 'sent' contam como enviadas, simuladas=0", () => {
    const result: SendResponse = { dryRun: false, counts: tallyOutcomes(RESULTS), results: RESULTS }
    expect(summarizeForDisplay(result)).toEqual({
      enviadas: 2,
      simuladas: 0,
      falharam: 1,
      suprimidas: 1,
      ignoradas: 1,
    })
  })

  it("summarizeForDisplay (dry run): 'sent' vira simuladas, enviadas=0", () => {
    const result: SendResponse = { dryRun: true, counts: tallyOutcomes(RESULTS), results: RESULTS }
    const s = summarizeForDisplay(result)
    expect(s.enviadas).toBe(0)
    expect(s.simuladas).toBe(2)
    expect(s.falharam).toBe(1)
  })

  it("failureRows lista só as falhas com motivo legível (nunca o código cru)", () => {
    const result: SendResponse = { dryRun: false, counts: tallyOutcomes(RESULTS), results: RESULTS }
    const failures = failureRows(result)
    expect(failures.length).toBe(1)
    expect(failures[0].customerId).toBe("d")
    expect(failures[0].reason).toBe("Falha no envio") // send_failed → legível
    expect(failures[0].reason).not.toBe("send_failed")
  })

  it("detailLabel: código conhecido vira texto; desconhecido cai no próprio código; nulo → '—'", () => {
    expect(detailLabel("sem_contato")).toBe("Sem contato válido (celular ou e-mail)")
    expect(detailLabel("dry_run")).toBe("Simulado (nada enviado)")
    expect(detailLabel("codigo_novo_desconhecido")).toBe("codigo_novo_desconhecido")
    expect(detailLabel(null)).toBe("—")
    expect(detailLabel(undefined)).toBe("—")
  })
})
