// D1/Frente A: envelope canônico (payload.ts). Superset compatível com o
// Apêndice A: todo campo do exemplo está presente com o mesmo tipo; os aditivos
// (amount_cents/amount_formatted/button.numeric_id/tenant.chat_link/contract_version)
// nunca substituem. event_id determinístico não duplica em reload/reabertura da
// MESMA abertura. aging_days bate com o due_date.
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  buildEnvelope,
  deterministicEventId,
  mapChannel,
  resolveEventName,
  stableStringify,
  threadIdOf,
  toCents,
  formatBRL,
  CONTRACT_VERSION,
  type BuildEnvelopeInput,
} from "@/lib/negotiation/payload"
import { agingDays } from "@/lib/negotiation/config"

const SID = "5e551011-0000-0000-0000-000000000001"
const CO = "cccccccc-0000-0000-0000-000000000003"
const CPF = "39044455705" // 11 dígitos plausíveis

function baseInput(over: Partial<BuildEnvelopeInput> = {}): BuildEnvelopeInput {
  return {
    kind: "chat_turn",
    sessionId: SID,
    companyId: CO,
    reopenCount: 0,
    channel: "web_public_link",
    seq: 0,
    message: "oi",
    button: { id: "SIM", numericId: 1, text: "Sim, reconheço" },
    sessionState: {
      identityVerified: true,
      debtAcknowledged: false,
      fulfillmentMode: "A",
      outcome: "in_progress",
    },
    debtor: { customerId: "cust1", name: "Fulano de Tal", document: CPF },
    debt: {
      debtId: "debt1",
      amount: 1234.56,
      dueDate: "2025-07-08",
      description: "Contrato 00456 - Serviço",
      invoiceCount: 3,
      hasLiveCharge: true,
    },
    tenant: {
      fulfillmentMode: "A",
      officialChannelLabel: "Portal VMAX",
      brandName: "VMAX",
      publicLinkCode: "k7Qm3Xb9Rt",
    },
    occurredAt: "2026-09-23T12:00:00.000Z",
    ...over,
  }
}

describe("buildEnvelope — superset compatível com o Apêndice A", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = "https://alteapay.com"
  })
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_APP_URL
  })

  it("todo campo do exemplo do Apêndice A está presente com o mesmo tipo", () => {
    const env = buildEnvelope(baseInput())
    // type (string) — NÃO `event`
    expect(env.type).toBe("chat.turn")
    expect("event" in env).toBe(false)
    // thread_id (string), session_id/company_id (string), channel = webchat
    expect(env.thread_id).toBe(`web_${SID}`)
    expect(env.session_id).toBe(SID)
    expect(env.company_id).toBe(CO)
    expect(env.channel).toBe("webchat")
    // message (string), session_state (objeto com os 4 campos do exemplo)
    expect(typeof env.message).toBe("string")
    expect(env.session_state).toMatchObject({
      identity_verified: true,
      debt_acknowledged: false,
      fulfillment_mode: "A",
      outcome: "in_progress",
    })
    // debt: amount (number reais, do Apêndice A), due_date (string), aging_days (number)
    expect(env.debt!.amount).toBe(1234.56)
    expect(typeof env.debt!.due_date).toBe("string")
    expect(typeof env.debt!.aging_days).toBe("number")
    // tenant: official_channel_label (string)
    expect(env.tenant.official_channel_label).toBe("Portal VMAX")
    // NOVO (captura n8n): debtor.{id,name}, debt.{id,description}, tenant.fulfillment_mode
    expect(env.debtor!.id).toBe("cust1")
    expect(env.debtor!.name).toBe("Fulano") // 1º nome de "Fulano de Tal"
    expect(env.debt!.id).toBe("debt1")
    expect(env.debt!.description).toBe("Contrato 00456 - Serviço")
    expect(env.tenant.fulfillment_mode).toBe("A")
  })

  it("debtor.name é sempre o PRIMEIRO nome (privacidade)", () => {
    const env = buildEnvelope(baseInput({ debtor: { customerId: "c9", name: "Fabio Sobrenome Da Silva", document: CPF } }))
    expect(env.debtor!.name).toBe("Fabio")
  })

  it("description string|null: null vira null explícito", () => {
    const env = buildEnvelope(
      baseInput({
        debt: { debtId: "d1", amount: 100, dueDate: "2025-01-01", description: null, invoiceCount: 1, hasLiveCharge: false },
      }),
    )
    expect(env.debt!.description).toBeNull()
  })

  it("campos ADITIVOS presentes e nunca substituem (amount permanece reais)", () => {
    const env = buildEnvelope(baseInput())
    expect(env.contract_version).toBe(CONTRACT_VERSION)
    // os 3 valores: reais + centavos + formatado
    expect(env.debt!.amount).toBe(1234.56)
    expect(env.debt!.amount_cents).toBe(123456)
    expect(env.debt!.amount_formatted).toBe("R$ 1.234,56")
    expect(env.debt!.currency).toBe("BRL")
    // button estruturado com numeric_id
    expect(env.button).toEqual({ id: "SIM", numeric_id: 1, text: "Sim, reconheço" })
    // tenant.chat_link = /n/{public_link_code}
    expect(env.tenant.chat_link).toBe("https://alteapay.com/n/k7Qm3Xb9Rt")
    expect(env.tenant.brand_name).toBe("VMAX")
  })

  it("documento nunca em claro: só máscara (mantida) + hash; sem e-mail/telefone", () => {
    const env = buildEnvelope(baseInput())
    expect(env.debtor!.document).toBeNull()
    // máscara MANTIDA (***.456.789-**), não o formato do exemplo
    expect(env.debtor!.document_masked).toBe("***.444.557-**")
    expect(env.debtor!.document_hash).toHaveLength(64)
    const json = JSON.stringify(env)
    expect(json).not.toContain(CPF)
  })

  it("campo ausente = null EXPLÍCITO (debt/debtor/button/message/outcome/chat_link)", () => {
    const env = buildEnvelope(
      baseInput({
        message: null,
        button: null,
        debtor: null,
        debt: null,
        sessionState: { identityVerified: false, debtAcknowledged: false, fulfillmentMode: "A", outcome: null },
        tenant: { fulfillmentMode: "A", officialChannelLabel: null, brandName: "VMAX", publicLinkCode: null },
      }),
    )
    expect(env.message).toBeNull()
    expect(env.button).toBeNull()
    expect(env.debtor).toBeNull()
    expect(env.debt).toBeNull()
    expect(env.session_state.outcome).toBeNull()
    expect(env.tenant.chat_link).toBeNull()
    expect(env.tenant.official_channel_label).toBeNull()
  })

  it("debtor.id/debt.id ausentes = null explícito (customerId/debtId null)", () => {
    const env = buildEnvelope(
      baseInput({
        debtor: { customerId: null, name: null, document: CPF },
        debt: { debtId: null, amount: 100, dueDate: "2025-01-01", description: null, invoiceCount: 1, hasLiveCharge: false },
      }),
    )
    expect(env.debtor!.id).toBeNull()
    expect(env.debtor!.name).toBe("") // sem nome → string vazia (nunca null)
    expect(env.debt!.id).toBeNull()
  })

  it("aging_days bate com o due_date (America/Sao_Paulo)", () => {
    const dueDate = "2025-07-08"
    const env = buildEnvelope(
      baseInput({
        debt: { debtId: "debt1", amount: 100, dueDate, description: null, invoiceCount: 1, hasLiveCharge: false },
      }),
    )
    expect(env.debt!.aging_days).toBe(agingDays(dueDate))
  })

  it("sem due_date → aging_days null (nunca inventado)", () => {
    const env = buildEnvelope(
      baseInput({
        debt: { debtId: "debt1", amount: 100, dueDate: null, description: null, invoiceCount: 1, hasLiveCharge: false },
      }),
    )
    expect(env.debt!.aging_days).toBeNull()
    expect(env.debt!.due_date).toBeNull()
  })
})

describe("event_id determinístico", () => {
  it("mesma abertura (session+reopen+tipo+seq) → MESMO event_id (reload não duplica)", () => {
    const a = deterministicEventId({ sessionId: SID, reopenCount: 0, kind: "session_start", seq: 0 })
    const b = deterministicEventId({ sessionId: SID, reopenCount: 0, kind: "session_start", seq: 0 })
    expect(a).toBe(b)
    // o envelope também é estável entre montagens idênticas
    const e1 = buildEnvelope(baseInput({ kind: "session_start", seq: 0, eventId: undefined }))
    const e2 = buildEnvelope(baseInput({ kind: "session_start", seq: 0, eventId: undefined }))
    expect(e1.event_id).toBe(e2.event_id)
  })

  it("turnos diferentes (seq) → event_id diferente", () => {
    const t0 = deterministicEventId({ sessionId: SID, reopenCount: 0, kind: "chat_turn", seq: 0 })
    const t1 = deterministicEventId({ sessionId: SID, reopenCount: 0, kind: "chat_turn", seq: 1 })
    expect(t0).not.toBe(t1)
  })

  it("tipos diferentes no mesmo turno → event_id diferente", () => {
    const s = deterministicEventId({ sessionId: SID, reopenCount: 0, kind: "session_start", seq: 0 })
    const n = deterministicEventId({ sessionId: SID, reopenCount: 0, kind: "negotiation_start", seq: 0 })
    expect(s).not.toBe(n)
  })
})

describe("mapa de canal (Apêndice B) e rótulos de evento", () => {
  it("todo canal web colapsa para webchat; n8n/whatsapp preservados", () => {
    expect(mapChannel("web_public_link")).toBe("webchat")
    expect(mapChannel("web_campaign")).toBe("webchat")
    expect(mapChannel("web_generic")).toBe("webchat")
    expect(mapChannel("admin_preview")).toBe("webchat")
    expect(mapChannel("whatsapp")).toBe("whatsapp")
    expect(mapChannel("n8n")).toBe("n8n")
    expect(mapChannel(null)).toBe("webchat")
    expect(mapChannel("desconhecido")).toBe("webchat")
  })

  it("resolveEventName usa o default, override por tenant vence", () => {
    expect(resolveEventName("session_start")).toBe("session.start")
    expect(resolveEventName("chat_turn")).toBe("chat.turn")
    expect(resolveEventName("negotiation_start")).toBe("negotiation.start")
    expect(resolveEventName("session_start", { session_start: "vmax.session.start" })).toBe("vmax.session.start")
    // vazio → default
    expect(resolveEventName("chat_turn", { chat_turn: "  " })).toBe("chat.turn")
  })
})

describe("serialização estável (HMAC cobre o corpo cru)", () => {
  it("ordem de chave determinística em qualquer profundidade", () => {
    const a = stableStringify({ b: 1, a: { z: 2, y: [3, { m: 4, k: 5 }] } })
    const b = stableStringify({ a: { y: [3, { k: 5, m: 4 }], z: 2 }, b: 1 })
    expect(a).toBe(b)
  })

  it("dois envelopes idênticos serializam byte-a-byte igual", () => {
    const e1 = buildEnvelope(baseInput())
    const e2 = buildEnvelope(baseInput())
    expect(stableStringify(e1)).toBe(stableStringify(e2))
  })
})

describe("helpers monetários e thread", () => {
  it("toCents/formatBRL/null", () => {
    expect(toCents(1234.56)).toBe(123456)
    expect(toCents(null)).toBeNull()
    expect(formatBRL(1234.56)).toBe("R$ 1.234,56")
    expect(formatBRL(null)).toBeNull()
  })
  it("thread_id estável derivado do session_id (nunca o uuid cru)", () => {
    expect(threadIdOf(SID)).toBe(`web_${SID}`)
    expect(threadIdOf(SID, "web_existing")).toBe("web_existing")
  })
})
