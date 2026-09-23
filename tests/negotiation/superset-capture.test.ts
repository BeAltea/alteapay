// Superset-compat CONTRA A CAPTURA REAL do que o fluxo n8n consome hoje.
//
// O fluxo n8n LÊ certas chaves do corpo (type, thread_id, debtor.name, debt.id,
// tenant.fulfillment_mode, …). Quando ligarmos NEGOTIATION_ENGINE=n8n, o nosso
// envelope canônico (payload.ts) PRECISA carregar TODAS elas com o mesmo TIPO —
// senão o bot quebra (ex.: sem nome do devedor não há saudação por nome).
//
// Este teste é um contrato: um fixture com o SHAPE EXATO da captura (valores fake,
// SEM webhookUrl/assinatura) e uma asserção que, para CADA chave do body, o nosso
// envelope tem a chave presente com o tipo certo. É superset: o nosso envelope
// pode ter campos aditivos (contract_version, amount_cents, …); a captura, não.
//
// Decisões travadas do dono verificadas aqui:
//   - debtor.name = PRIMEIRO nome (privacidade).
//   - debtor.document = null (só máscara + hash viajam).
//   - debt.amount em REAIS (este envelope NÃO usa centavos; cents é aditivo).
import { describe, expect, it } from "vitest"
import { buildEnvelope, type BuildEnvelopeInput, type CanonicalEnvelope } from "@/lib/negotiation/payload"

const SID = "5e551011-0000-0000-0000-000000000001"
const CO = "cccccccc-0000-0000-0000-000000000003"
const CUST = "dddddddd-0000-0000-0000-000000000004"
const DEBT = "eeeeeeee-0000-0000-0000-000000000005"
const CPF = "12345678909" // 11 dígitos plausíveis

// -----------------------------------------------------------------------------
// A CAPTURA REAL (shape do body que o fluxo n8n consome hoje). Valores FAKE de
// ilustração; SEM webhookUrl nem assinatura — só o corpo. NÃO alterar sem alinhar
// com a captura do fluxo: mudar aqui é mudar o contrato.
const CAPTURE = {
  type: "chat.turn",
  thread_id: "th_fake",
  session_id: SID,
  company_id: CO,
  channel: "webchat",
  message: "Pix (à vista)",
  button: { id: "PIX", text: "Pix (à vista)" },
  session_state: {
    identity_verified: false,
    debt_acknowledged: false,
    fulfillment_mode: "A",
    outcome: null as string | null,
  },
  debtor: {
    id: CUST,
    name: "Fulano de Tal",
    document_masked: "***.456.789-**",
    document_hash: "deadbeef",
    document: null as string | null,
  },
  debt: {
    id: DEBT,
    amount: 1500,
    due_date: "2026-06-15",
    description: "Contrato 00456 - Serviço",
    aging_days: 95,
  },
  tenant: {
    fulfillment_mode: "A",
    official_channel_label: "Canal Oficial VMAX",
  },
} as const

// O nosso envelope montado com os MESMOS valores de identidade da captura.
function ourEnvelope(): CanonicalEnvelope {
  const input: BuildEnvelopeInput = {
    kind: "chat_turn",
    sessionId: SID,
    companyId: CO,
    reopenCount: 0,
    channel: "web_public_link", // colapsa para "webchat"
    seq: 0,
    message: CAPTURE.message,
    button: { id: "PIX", numericId: 3, text: "Pix (à vista)" },
    sessionState: {
      identityVerified: false,
      debtAcknowledged: false,
      fulfillmentMode: "A",
      outcome: null,
    },
    debtor: { customerId: CUST, name: "Fulano de Tal", document: CPF },
    debt: {
      debtId: DEBT,
      amount: 1500, // REAIS (o envelope também emite amount_cents aditivo)
      dueDate: "2026-06-15",
      description: "Contrato 00456 - Serviço",
      invoiceCount: 1,
      hasLiveCharge: false,
    },
    tenant: {
      fulfillmentMode: "A",
      officialChannelLabel: "Canal Oficial VMAX",
      brandName: "VMAX",
      publicLinkCode: null,
    },
    occurredAt: "2026-09-23T12:00:00.000Z",
  }
  return buildEnvelope(input)
}

/** typeof que trata null como "null" (não "object") — o contrato distingue os dois. */
function kindOf(v: unknown): string {
  return v === null ? "null" : typeof v
}

describe("superset-compat: cada chave da CAPTURA n8n existe no envelope com o mesmo tipo", () => {
  const env = ourEnvelope() as unknown as Record<string, unknown>

  // top-level: type, thread_id, session_id, company_id, channel, message
  it.each([
    ["type", "string"],
    ["thread_id", "string"],
    ["session_id", "string"],
    ["company_id", "string"],
    ["channel", "string"],
    ["message", "string"],
  ])("top-level %s presente e do tipo %s", (key, expectedType) => {
    expect(key in env).toBe(true)
    expect(kindOf(env[key])).toBe(expectedType)
  })

  it("button.{id,text} presentes com o tipo da captura", () => {
    const button = env.button as Record<string, unknown>
    expect(button).not.toBeNull()
    expect(kindOf(button.id)).toBe(kindOf(CAPTURE.button.id)) // string
    expect(kindOf(button.text)).toBe(kindOf(CAPTURE.button.text)) // string
  })

  it("session_state.* (identity_verified, debt_acknowledged, fulfillment_mode, outcome)", () => {
    const ss = env.session_state as Record<string, unknown>
    for (const [k, v] of Object.entries(CAPTURE.session_state)) {
      expect(k in ss).toBe(true)
      expect(kindOf(ss[k])).toBe(kindOf(v))
    }
    // outcome pode ser null (a captura tem null): o envelope respeita string|null.
    expect("outcome" in ss).toBe(true)
  })

  it("debtor.{id,name,document_masked,document_hash,document} com os tipos da captura", () => {
    const d = env.debtor as Record<string, unknown>
    expect(d).not.toBeNull()
    for (const [k, v] of Object.entries(CAPTURE.debtor)) {
      expect(k in d).toBe(true)
      expect(kindOf(d[k])).toBe(kindOf(v))
    }
  })

  it("debt.{id,amount,due_date,description,aging_days} com os tipos da captura", () => {
    const d = env.debt as Record<string, unknown>
    expect(d).not.toBeNull()
    for (const [k, v] of Object.entries(CAPTURE.debt)) {
      expect(k in d).toBe(true)
      expect(kindOf(d[k])).toBe(kindOf(v))
    }
  })

  it("tenant.{fulfillment_mode,official_channel_label} com os tipos da captura", () => {
    const t = env.tenant as Record<string, unknown>
    for (const [k, v] of Object.entries(CAPTURE.tenant)) {
      expect(k in t).toBe(true)
      expect(kindOf(t[k])).toBe(kindOf(v))
    }
  })

  // Decisões travadas do dono: valores concretos, não só tipos.
  it("debtor.name = PRIMEIRO nome (privacidade)", () => {
    const d = env.debtor as Record<string, unknown>
    expect(d.name).toBe("Fulano") // 1º token de "Fulano de Tal"
  })

  it("debtor.document = null (só máscara + hash viajam)", () => {
    const d = env.debtor as Record<string, unknown>
    expect(d.document).toBeNull()
    expect(kindOf(d.document_masked)).toBe("string")
    expect(kindOf(d.document_hash)).toBe("string")
    // o CPF em claro nunca aparece no corpo serializado.
    expect(JSON.stringify(env)).not.toContain(CPF)
  })

  it("debt.amount em REAIS (não centavos)", () => {
    const d = env.debt as Record<string, unknown>
    expect(d.amount).toBe(1500) // reais; o centavos vive em amount_cents (aditivo)
    expect(d.amount_cents).toBe(150000)
  })

  it("debtor.id e debt.id = uuids fornecidos", () => {
    const debtor = env.debtor as Record<string, unknown>
    const debt = env.debt as Record<string, unknown>
    expect(debtor.id).toBe(CUST)
    expect(debt.id).toBe(DEBT)
  })

  it("tenant.fulfillment_mode espelha session_state.fulfillment_mode", () => {
    const t = env.tenant as Record<string, unknown>
    const ss = env.session_state as Record<string, unknown>
    expect(t.fulfillment_mode).toBe(ss.fulfillment_mode)
  })
})
