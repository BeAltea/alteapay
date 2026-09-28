// N8N-2 — contrato de botões do n8n (lado plataforma), parte PURA:
// adaptLegacyPrompt / relabelOfferButtons / matchOfferByLabel /
// normalizeLegacyN8nEnvelope. Cada variante legada vem de um nó real do n8n
// (lido via API em 2026-09-27; ver ops/n8n-sync-fix/14-n8n2-botoes.md §2).
import { afterEach, describe, expect, it } from "vitest"
import { offerButtonLabel } from "@/lib/journey/acknowledgement"
import {
  adaptLegacyPrompt,
  isCanonicalButtons,
  matchOfferByLabel,
  normalizeLegacyN8nEnvelope,
  parseBrlAmount,
  paymentFromLabel,
  relabelOfferButtons,
  type ServerOffer,
} from "@/lib/negotiation/n8n-buttons"
import type { OfferTerms } from "@/lib/negotiation/offers"

const terms = (t: Partial<OfferTerms>): OfferTerms => ({
  original_value: 180, discount_pct: 0, discount_value: 0, entry_value: 0, installments: 1,
  installment_value: 180, total_value: 180, billing_type: "PIX", first_due_date: "2026-10-04", ...t,
})
const OA = "a7ae147d-0b12-42e1-9c69-cb234417c6a3"
const OB = "b272e8b9-7adc-45a7-a033-3eb68b4f9806"
const OC = "8bb2046f-dd21-4a03-a6f9-383b4623c64d"
const OFFERS: ServerOffer[] = [
  { id: OA, terms: terms({ discount_pct: 5, discount_value: 9, installment_value: 171, total_value: 171 }) },
  { id: OB, terms: terms({ discount_pct: 2.5, discount_value: 4.5, installments: 2, installment_value: 87.75, total_value: 175.5, entry_value: 87.75, billing_type: "BOLETO" }) },
  { id: OC, terms: terms({ discount_pct: 2.5, discount_value: 4.5, installments: 3, installment_value: 58.5, total_value: 175.5, entry_value: 58.5, billing_type: "BOLETO" }) },
]
const L = (id: string) => offerButtonLabel(OFFERS.find((o) => o.id === id)!.terms)
const adapt = (raw: Parameters<typeof adaptLegacyPrompt>[0]) => adaptLegacyPrompt(raw, OFFERS, offerButtonLabel)

describe("forma canônica", () => {
  it("é aceita como veio (ids, value=offer_id, kind) e não é marcada como adaptada", () => {
    const buttons = [
      { id: 2, label: L(OA), value: OA },
      { id: 3, label: L(OB), value: OB },
      { id: 98, label: "Voltar" },
    ]
    expect(isCanonicalButtons(buttons)).toBe(true)
    const { prompt, report } = adapt({ kind: "offer_choice", question: "Escolha:", buttons })
    expect(prompt).toEqual({ kind: "offer_choice", question: "Escolha:", buttons })
    expect(report.adapted).toBe(false)
    expect(report.dropped_buttons).toEqual([])
    expect(report.relabeled).toBe(0)
  })

  it("booleano canônico (o que o '4. Send Msg & Update' atual já emite) passa inalterado", () => {
    const buttons = [{ id: 1, label: "Sim, quero regularizar" }, { id: 0, label: "Não" }]
    const { prompt, report } = adapt({ kind: "generic_yes_no", question: "Vamos?", buttons })
    expect(prompt).toEqual({ kind: "generic_yes_no", question: "Vamos?", buttons })
    expect(report.adapted).toBe(false)
  })
})

describe("variantes legadas encontradas nos fluxos", () => {
  it("LV2 Sim/Não com ids string e `text` (1.1 'Send Msg & Update [4]', 1.2 [2], 1.3 [1], 1.6)", () => {
    const { prompt, report } = adapt({
      question: "Você reconhece?",
      buttons: [{ id: "1", text: "Sim" }, { id: "0", text: "Não" }],
    })
    expect(prompt!.kind).toBe("generic_yes_no")
    expect(prompt!.buttons).toEqual([
      { id: 1, label: "Sim", order: 0 },
      { id: 0, label: "Não", order: 1 },
    ])
    expect(report.adapted).toBe(true)
    expect(report.dropped_buttons).toEqual([])
  })

  it("LV3 métodos com id PIX/BOLETO/CARTAO (1.3/1.4 'Format Buttons' ← 2. 'Prepare Message Body [1]')", () => {
    const { prompt } = adapt({
      kind: "offer_choice", // o '4.' atual chuta offer_choice para tudo que não é 0/1/99
      question: "Escolha o método",
      buttons: [
        { id: "PIX", text: "Pix (à vista)" },
        { id: "BOLETO", text: "Boleto (à vista)" },
        { id: "CARTAO", text: "Cartão (em até 6x)" },
      ],
    })
    expect(prompt!.kind).toBe("payment_method_choice")
    expect(prompt!.buttons).toEqual([
      { id: 2, label: "Pix", value: "PIX", order: 0 },
      { id: 3, label: "Boleto", value: "BOLETO", order: 1 },
      { id: 4, label: "Cartão de crédito", value: "CREDIT_CARD", order: 2 },
    ])
  })

  it("LV3 depois do '4.' atual (Number('PIX') → null no JSON): o método sai do início do rótulo", () => {
    const { prompt } = adapt({
      kind: "offer_choice",
      question: "Escolha o método",
      buttons: [{ id: null, label: "Pix (à vista)" }, { id: null, label: "Cartão (em até 6x)" }],
    })
    expect(prompt!.kind).toBe("payment_method_choice")
    expect(prompt!.buttons.map((b) => b.value)).toEqual(["PIX", "CREDIT_CARD"])
  })

  it("LV4 parcelas 'Nx de R$ X' (1.5 'Code in JavaScript' ← 2. 'Prepare Message Body [2]'): casa só com a oferta exata do servidor", () => {
    const { prompt, report } = adapt({
      question: "Escolha o número de parcelas",
      buttons: [
        { id: "1", text: "1x de R$ 171,00" }, // == à vista do servidor
        { id: "2", text: "2x de R$ 87,75" }, //  == 2x do servidor
        { id: "3", text: "3x de R$ 10,00" }, //  valor do n8n ≠ servidor → descarta
      ],
    })
    expect(prompt!.kind).toBe("offer_choice")
    expect(prompt!.buttons).toEqual([
      { id: 2, label: L(OA), value: OA, order: 0 },
      { id: 3, label: L(OB), value: OB, order: 1 },
    ])
    expect(report.dropped_buttons).toEqual([{ index: 2, reason: "offer_amount_mismatch" }])
  })

  it("LV4 com o valor da base paralela do n8n (R$ 1.470,00) → tudo descartado → fallback", () => {
    const { prompt, report } = adapt({
      kind: "offer_choice",
      question: "Escolha",
      buttons: [{ id: 1, label: "1x de R$ 1.470,00" }, { id: 2, label: "2x de R$ 735,00" }],
    })
    expect(prompt).toBeNull()
    expect(report.fallback).toBe("assisted_menu")
    expect(report.dropped_buttons.map((d) => d.reason)).toEqual(["offer_amount_mismatch", "offer_amount_mismatch"])
  })
})

describe("ofertas: o valor é sempre do servidor", () => {
  it("offer_id errado/antigo é descartado; os válidos seguem", () => {
    const { prompt, report } = adapt({
      kind: "offer_choice",
      question: "Escolha",
      buttons: [
        { id: 2, label: "À vista", value: "d9d8a61d-1620-4337-b6c4-b77a4e612eaf" },
        { id: 3, label: "2x", offer_id: OB },
      ],
    })
    expect(report.dropped_buttons).toEqual([{ index: 0, reason: "offer_stale" }])
    expect(prompt!.buttons).toEqual([{ id: 3, label: L(OB), value: OB, order: 0 }])
  })

  it("rótulo do n8n com valor falso é trocado pelo rótulo da oferta do servidor", () => {
    const { prompt, report } = adapt({
      kind: "offer_choice",
      question: "Escolha",
      buttons: [{ id: 2, label: "À vista R$ 18,00 (90% de desconto)", value: OA }],
    })
    expect(prompt!.buttons[0].label).toBe(L(OA))
    expect(prompt!.buttons[0].label).not.toContain("18,00")
    expect(report.relabeled).toBe(1)
  })

  it("item de lista sem oferta num offer_choice (ex.: {id:2,label:'À vista'}) → offer_unresolved", () => {
    const { prompt, report } = adapt({
      kind: "offer_choice",
      question: "x",
      buttons: [{ id: 2, label: "À vista" }, { id: 3, label: "Parcelar" }],
    })
    expect(prompt).toBeNull()
    expect(report.dropped_buttons.every((d) => d.reason === "offer_unresolved")).toBe(true)
  })

  it("numa lista de ofertas só entram ofertas + Voltar/Atendimento", () => {
    const { prompt, report } = adapt({
      kind: "offer_choice",
      question: "x",
      buttons: [{ id: 2, label: "a", value: OA }, { id: 1, label: "Sim" }, { id: 98, label: "Voltar" }],
    })
    expect(prompt!.buttons.map((b) => b.id)).toEqual([2, 98])
    expect(report.dropped_buttons).toEqual([{ index: 1, reason: "not_allowed_in_kind" }])
  })

  it("matchOfferByLabel: sem valor ou ambíguo não casa", () => {
    expect(matchOfferByLabel("3x", OFFERS)).toEqual({ ok: false, reason: "offer_unresolved" })
    expect(matchOfferByLabel("3x de R$ 58,50", OFFERS)).toMatchObject({ ok: true, offer: { id: OC } })
    expect(matchOfferByLabel("À vista R$ 171,00", OFFERS)).toMatchObject({ ok: true, offer: { id: OA } })
    expect(parseBrlAmount("R$ 1.470,00")).toBe(1470)
  })

  it("relabelOfferButtons (camada sempre ligada) não remove nem reordena nada", () => {
    const input = {
      kind: "offer_choice", question: "q",
      buttons: [{ id: 2, label: "falso R$ 1,00", value: OA }, { id: 9, label: "x", value: "nao-oferta" }],
    }
    const { prompt, relabeled } = relabelOfferButtons(input, OFFERS, offerButtonLabel)
    expect(relabeled).toBe(1)
    expect(prompt.buttons).toEqual([{ id: 2, label: L(OA), value: OA }, { id: 9, label: "x", value: "nao-oferta" }])
  })
})

describe("ações não-oferta → ids da plataforma", () => {
  it("reconheço / não reconheço viram debt_acknowledgement 1/0", () => {
    const { prompt } = adapt({
      question: "Reconhece?",
      buttons: [{ action: "acknowledge_debt", label: "Sim, reconheço" }, { action: "nao_reconheco", label: "Não reconheço" }],
    })
    expect(prompt!.kind).toBe("debt_acknowledgement")
    expect(prompt!.buttons.map((b) => [b.id, b.label])).toEqual([[1, "Sim, reconheço"], [0, "Não reconheço"]])
  })

  it("já paguei → 96, atendimento → 99, voltar → 98 (rótulo padrão se ausente)", () => {
    const { prompt } = adapt({
      question: "E agora?",
      buttons: [{ action: "atendimento" }, { action: "ja_paguei", text: "Já paguei" }, { id: "voltar" }],
    })
    expect(prompt!.buttons.map((b) => b.id)).toEqual([96, 99, 98]) // 98/99 ao final, na ordem recebida
    expect(prompt!.buttons.find((b) => b.id === 99)!.label).toBe("Falar com atendimento")
    expect(prompt!.kind).toBe("generic_choice")
  })

  it("ação desconhecida é descartada", () => {
    const { prompt, report } = adapt({
      question: "q",
      buttons: [{ id: "falar_com_gerente", text: "Gerente" }, { action: "teleport", label: "x" }, { id: 99, label: "Atendimento" }],
    })
    expect(report.dropped_buttons).toEqual([
      { index: 0, reason: "action_unknown" },
      { index: 1, reason: "action_unknown" },
    ])
    expect(prompt!.buttons.map((b) => b.id)).toEqual([99])
  })

  it("rótulo de ação com valor monetário é trocado pelo padrão", () => {
    const { prompt } = adapt({ question: "q", buttons: [{ action: "ja_paguei", label: "Já paguei R$ 180,00" }, { id: 99, label: "Atendimento" }] })
    expect(prompt!.buttons.find((b) => b.id === 96)!.label).toBe("Já paguei")
  })

  it("todos inválidos → prompt null + fallback assisted_menu", () => {
    const { prompt, report } = adapt({ question: "q", buttons: [{ id: "x" }, null, { id: -1, label: "a" }] })
    expect(prompt).toBeNull()
    expect(report.fallback).toBe("assisted_menu")
    expect(report.kept).toBe(0)
    expect(report.dropped_buttons.map((d) => d.reason)).toEqual(["action_unknown", "button_shape", "id_invalid"])
  })

  it("ids duplicados: o 2º é descartado", () => {
    const { prompt, report } = adapt({ question: "q", buttons: [{ id: "1", text: "Sim" }, { id: 1, label: "Sim de novo" }, { id: "0", text: "Não" }] })
    expect(prompt!.buttons.map((b) => b.id)).toEqual([1, 0])
    expect(report.dropped_buttons).toEqual([{ index: 1, reason: "duplicate" }])
  })

  it("paymentFromLabel só casa pelo início do rótulo", () => {
    expect(paymentFromLabel("Pix (à vista)")).toBe("PIX")
    expect(paymentFromLabel("Pagar com Pix")).toBeNull()
  })
})

describe("envelope legado {sessionId, output, buttons}", () => {
  const OLD = process.env.N8N_LEGACY_BUTTONS_ADAPTER
  afterEach(() => {
    if (OLD === undefined) delete process.env.N8N_LEGACY_BUTTONS_ADAPTER
    else process.env.N8N_LEGACY_BUTTONS_ADAPTER = OLD
  })
  const legacy = { sessionId: "ae182781-d7c5-4673-bcf0-7d56468aafd5", output: "Você reconhece?", buttons: [{ id: "1", text: "Sim" }, { id: "0", text: "Não" }] }

  it("flag OFF (default): corpo intacto (o schema estrito devolve 422)", () => {
    delete process.env.N8N_LEGACY_BUTTONS_ADAPTER
    expect(normalizeLegacyN8nEnvelope(legacy, "evt-12345678")).toBe(legacy)
  })

  it("flag ON: vira chat.send com event_id do header", () => {
    process.env.N8N_LEGACY_BUTTONS_ADAPTER = "on"
    expect(normalizeLegacyN8nEnvelope(legacy, "evt-12345678")).toEqual({
      action: "chat.send",
      session_id: legacy.sessionId,
      event_id: "evt-12345678",
      args: { text: "Você reconhece?", prompt: { kind: "", question: "Você reconhece?", buttons: legacy.buttons }, legacy_envelope: true },
    })
    // corpo canônico nunca é tocado
    const canon = { action: "ping" }
    expect(normalizeLegacyN8nEnvelope(canon, null)).toBe(canon)
  })
})
