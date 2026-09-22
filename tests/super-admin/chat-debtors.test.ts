// Testes da agregação POR DEVEDOR (A1.2) e dos KPIs coerentes (A1.3) do painel
// /super-admin/negociacoes-chat. Lógica PURA — sem banco.

import { afterEach, describe, expect, it, vi } from "vitest"
import {
  activeWindowMinutes,
  computeKpis,
  groupByDebtor,
  isActiveSession,
  sessionStage,
  type ChatSessionInput,
} from "@/lib/negotiation/chat-debtors"

function session(over: Partial<ChatSessionInput> & { id: string }): ChatSessionInput {
  return {
    company_id: "co-1",
    customer_id: "cust-1",
    company_name: "Empresa X",
    customer_name_masked: "Maria S.",
    document_masked: "***.456.789-**",
    channel: "web_campaign",
    channel_origin: "direct",
    engine: null,
    fulfillment_mode: "A",
    outcome: "in_progress",
    identity_verified: false,
    consent_given: false,
    debt_acknowledged: false,
    agreement_id: null,
    message_count: 0,
    created_at: "2026-09-20T10:00:00.000Z",
    last_message_at: null,
    last_activity_at: null,
    ...over,
  }
}

describe("groupByDebtor — uma linha por (company_id, customer_id)", () => {
  it("agrupa 6 sessões do mesmo devedor em 1 linha e soma as mensagens", () => {
    const sessions = Array.from({ length: 6 }, (_, i) =>
      session({
        id: `s${i}`,
        created_at: `2026-09-2${i}T10:00:00.000Z`,
        message_count: i, // 0+1+2+3+4+5 = 15
        identity_verified: i > 0,
      }),
    )
    const rows = groupByDebtor(sessions)
    expect(rows).toHaveLength(1)
    expect(rows[0].session_count).toBe(6)
    expect(rows[0].message_count).toBe(15)
    // Início = sessão mais antiga; sessões individuais preservadas
    expect(rows[0].started_at).toBe("2026-09-20T10:00:00.000Z")
    expect(rows[0].sessions).toHaveLength(6)
  })

  it("devedores distintos viram linhas distintas; sessão sem customer_id não agrupa", () => {
    const rows = groupByDebtor([
      session({ id: "a", customer_id: "cust-1" }),
      session({ id: "b", customer_id: "cust-2", customer_name_masked: "João P." }),
      session({ id: "c", customer_id: null }),
      session({ id: "d", customer_id: null }),
    ])
    // cust-1, cust-2, e duas sessões anônimas isoladas = 4 linhas
    expect(rows).toHaveLength(4)
  })

  it("canal e engine vêm da sessão MAIS RECENTE", () => {
    const rows = groupByDebtor([
      session({ id: "old", created_at: "2026-09-10T00:00:00Z", channel: "web_generic", engine: "disabled" }),
      session({ id: "new", created_at: "2026-09-19T00:00:00Z", channel: "whatsapp", engine: "n8n" }),
    ])
    expect(rows[0].channel).toBe("whatsapp")
    expect(rows[0].engine).toBe("n8n")
  })

  it("estágio é o MAIS AVANÇADO e resultado é da sessão canônica", () => {
    const rows = groupByDebtor([
      session({ id: "chat", message_count: 2, identity_verified: true, outcome: "in_progress" }),
      session({
        id: "closed",
        created_at: "2026-09-21T00:00:00Z",
        outcome: "agreement_closed",
        agreement_id: "agr-1",
      }),
    ])
    expect(rows[0].stage).toBe("charge_generated") // agreement_closed é o mais avançado
    expect(rows[0].outcome).toBe("agreement_closed")
    expect(rows[0].agreement_id).toBe("agr-1")
  })

  it("acknowledged=true se qualquer sessão reconheceu", () => {
    const rows = groupByDebtor([
      session({ id: "a" }),
      session({ id: "b", debt_acknowledged: true }),
    ])
    expect(rows[0].acknowledged).toBe(true)
  })

  it("ordena por atividade mais recente desc", () => {
    const rows = groupByDebtor([
      session({ id: "a", customer_id: "cust-1", last_message_at: "2026-09-10T00:00:00Z" }),
      session({ id: "b", customer_id: "cust-2", last_message_at: "2026-09-20T00:00:00Z" }),
    ])
    expect(rows[0].customer_id).toBe("cust-2")
    expect(rows[1].customer_id).toBe("cust-1")
  })
})

describe("sessionStage — mapeia funil + reconhecimento", () => {
  it("acordo fechado > oferta > reconheceu > em conversa > autenticado", () => {
    expect(sessionStage({ outcome: "agreement_closed", identity_verified: true, debt_acknowledged: true, message_count: 5 })).toBe("charge_generated")
    expect(sessionStage({ outcome: "redirected_official", identity_verified: true, debt_acknowledged: false, message_count: 5 })).toBe("offer_presented")
    expect(sessionStage({ outcome: "in_progress", identity_verified: true, debt_acknowledged: true, message_count: 1 })).toBe("acknowledged")
    expect(sessionStage({ outcome: "in_progress", identity_verified: true, debt_acknowledged: false, message_count: 3 })).toBe("in_chat")
    expect(sessionStage({ outcome: "in_progress", identity_verified: true, debt_acknowledged: false, message_count: 0 })).toBe("authenticated")
    expect(sessionStage({ outcome: "identity_failed", identity_verified: false, debt_acknowledged: false, message_count: 0 })).toBe("no_contact")
  })
})

describe("isActiveSession — janela de conversa ativa", () => {
  const now = new Date("2026-09-21T12:00:00.000Z").getTime()
  it("mensagem dentro da janela conta; fora não; sem mensagem não conta", () => {
    expect(isActiveSession({ last_message_at: "2026-09-21T11:45:00.000Z" }, now, 30)).toBe(true)
    expect(isActiveSession({ last_message_at: "2026-09-21T11:00:00.000Z" }, now, 30)).toBe(false)
    expect(isActiveSession({ last_message_at: null }, now, 30)).toBe(false)
  })
})

describe("activeWindowMinutes — default 30, sobrescrito por env", () => {
  const prev = process.env.CHAT_ACTIVE_WINDOW_MIN
  afterEach(() => {
    if (prev === undefined) delete process.env.CHAT_ACTIVE_WINDOW_MIN
    else process.env.CHAT_ACTIVE_WINDOW_MIN = prev
  })
  it("default 30", () => {
    delete process.env.CHAT_ACTIVE_WINDOW_MIN
    expect(activeWindowMinutes()).toBe(30)
  })
  it("respeita valor válido", () => {
    process.env.CHAT_ACTIVE_WINDOW_MIN = "60"
    expect(activeWindowMinutes()).toBe(60)
  })
  it("valor inválido cai no default", () => {
    process.env.CHAT_ACTIVE_WINDOW_MIN = "abc"
    expect(activeWindowMinutes()).toBe(30)
  })
})

describe("computeKpis — coerentes (A1.3)", () => {
  const now = new Date("2026-09-21T12:00:00.000Z").getTime()

  it("devedores distintos + sessões como número secundário; % de autenticação", () => {
    const sessions = [
      session({ id: "a", customer_id: "c1", identity_verified: true, last_message_at: "2026-09-21T11:50:00Z", message_count: 2 }),
      session({ id: "b", customer_id: "c1", identity_verified: true }),
      session({ id: "c", customer_id: "c2", identity_verified: false }),
    ]
    const debtors = groupByDebtor(sessions)
    const kpis = computeKpis({
      debtors,
      sessions,
      agreementsClosedAmount: 1500,
      redirectCount: 3,
      redirectAmount: 900,
      ackYes: 2,
      ackNo: 1,
      now,
      windowMin: 30,
    })
    expect(kpis.debtors).toBe(2)
    expect(kpis.sessions).toBe(3)
    expect(kpis.authenticatedDebtors).toBe(1) // só c1 tem sessão autenticada
    expect(kpis.authRatePct).toBe(50)
    expect(kpis.activeConversations).toBe(1) // só a sessão "a" tem msg recente
    expect(kpis.activeWindowMin).toBe(30)
    expect(kpis.redirects).toBe(3)
    expect(kpis.redirectsAmount).toBe(900)
    expect(kpis.ackYes).toBe(2)
    expect(kpis.ackNo).toBe(1)
  })

  it("acordos fechados contam devedores com agreement ou outcome fechado, com R$", () => {
    const sessions = [
      session({ id: "a", customer_id: "c1", outcome: "agreement_closed", agreement_id: "agr-1" }),
      session({ id: "b", customer_id: "c2", agreement_id: "agr-2" }),
      session({ id: "c", customer_id: "c3", outcome: "in_progress" }),
    ]
    const debtors = groupByDebtor(sessions)
    const kpis = computeKpis({
      debtors,
      sessions,
      agreementsClosedAmount: 3200.5,
      redirectCount: 0,
      redirectAmount: 0,
      ackYes: 0,
      ackNo: 0,
      now,
      windowMin: 30,
    })
    expect(kpis.agreementsClosed).toBe(2)
    expect(kpis.agreementsClosedAmount).toBeCloseTo(3200.5)
  })

  it("zero devedores → authRatePct 0 (sem divisão por zero)", () => {
    const kpis = computeKpis({
      debtors: [],
      sessions: [],
      agreementsClosedAmount: 0,
      redirectCount: 0,
      redirectAmount: 0,
      ackYes: 0,
      ackNo: 0,
      now,
      windowMin: 30,
    })
    expect(kpis.authRatePct).toBe(0)
  })
})
