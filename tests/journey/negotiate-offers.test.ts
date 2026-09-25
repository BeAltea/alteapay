// R1 (onda "3 opções", modo ASSISTIDO sem n8n) — "Quero negociar" apresenta as
// PARCELAS DA MATRIZ do servidor como botões (fallback determinístico) e a escolha
// de uma gera o link ASAAS pelo caminho canônico (closeAgreement → charge-inline),
// com guard de idempotência (D7): NUNCA 2ª cobrança, NUNCA declara pago (D6).
//
// Exercita as bibliotecas REAIS (offers/matrix/listOffers/presentMatrixOffers +
// payment-actions) com fake supabase em memória; só a fronteira de cobrança
// (closing/confirmAccept, que representa closeAgreement → charge-inline) e o
// lib/asaas são mockados. Servidor dono da matriz (D8): as ofertas saem de
// listOffers, o client nunca decide desconto/parcela.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"

process.env.CHAT_JOURNEY_ENABLED = "true"

const CO = "eeeeeeee-0000-0000-0000-00000000r1of"
const SID = "sess-r1"
const CUST = "cust-r1"
const DEBT = "debt-r1"
const ctx = { sessionId: SID, companyId: CO, customerId: CUST, debtId: DEBT }

let db: FakeDb
let confirmCalls = 0

vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => makeFakeSupabase(db) }))
vi.mock("@/lib/asaas", () => ({ getAsaasPaymentsForCustomer: async () => [] }))
vi.mock("@/lib/journey/events", () => ({
  recordEvent: async () => ({ ok: true, duplicate: false }),
  getTimeline: async () => [],
}))
// closing mock: confirmAccept = caminho canônico (closeAgreement → charge-inline).
// Registra acordo + acceptance como o real faria (para a idempotência (session,
// offer) de paymentCreate reusar o MESMO acordo no clique duplo).
vi.mock("@/lib/journey/closing", () => ({
  buildAcceptSummary: async () => ({ ok: true, summary: { termsHash: "h", terms: {}, validUntil: null } }),
  confirmAccept: async ({ offerId }: { offerId: string }) => {
    confirmCalls += 1
    const agId = "agR1"
    ;(db.agreements ??= []).push({
      id: agId, company_id: CO, customer_id: CUST, asaas_payment_id: "pay_r1",
      asaas_billing_type: "BOLETO", agreed_amount: 235, installments: 3, due_date: "2026-09-27",
      asaas_pix_qrcode_url: null, asaas_boleto_url: "https://asaas/boleto/pay_r1",
      asaas_invoice_url: "https://asaas/checkout/pay_r1",
      payment_status: "pending", asaas_status: "PENDING",
    })
    ;(db.negotiation_acceptances ??= []).push({ company_id: CO, session_id: SID, offer_id: offerId, agreement_id: agId })
    return { ok: true, agreementId: agId }
  },
}))
// negotiation.start: não dispara rede nos testes do NEGOCIAR (fallback assistido).
vi.mock("@/lib/negotiation/engine", () => ({
  engineName: () => "disabled",
  emitNegotiationStart: async () => ({ ok: true, delivered: false, reason: "engine_unavailable" }),
}))

const MATRIX = {
  id: "mx-1", company_id: CO, name: "default", priority: 1, active: true,
  valid_from: null, valid_to: null, aging_min_days: 0, aging_max_days: null,
  aging_basis: "oldest_due", max_discount_pct: 30, installment_discount_pct: 10,
  min_entry_pct: 20, max_installments: 3, min_installment_value: 10,
  allowed_billing_types: ["PIX", "BOLETO"], proposal_validity_days: 7,
  retry_after_days: 3, max_retries: 2, min_debt_value: 0,
}

function refreshView() {
  const rows = db.debt_acknowledgements ?? []
  const latest = new Map<string, any>()
  for (const r of rows) {
    const key = `${r.session_id}|${r.debt_id}`
    const cur = latest.get(key)
    if (!cur || r.created_at >= cur.created_at) latest.set(key, r)
  }
  db.debt_acknowledgement_latest = [...latest.values()]
}

function seed(opts: { matrix?: any[]; amount?: number } = {}) {
  confirmCalls = 0
  db = {
    tenant_chat_config: [{
      company_id: CO, payment_origin: "platform",
      // reconhecimento implícito é gravado no clique NEGOCIAR real; nos testes que
      // chamam acceptMatrixCondition diretamente, liberamos o guard.
      allow_payment_without_acknowledgement: true,
      acknowledgement_enabled: true, show_handoff_button: false,
      on_debt_not_recognized: "continue",
      official_channel_label: null, official_channel_url: null,
      branding: { brand_name: "VMAX" },
    }],
    companies: [{ id: CO, name: "VMAX LTDA" }],
    customers: [{ id: CUST, company_id: CO, name: "Fabio Mendes", document: "11144477735" }],
    debts: [{ id: DEBT, company_id: CO, customer_id: CUST, status: "pending", amount: opts.amount ?? 250, due_date: "2020-01-01" }],
    vmax_invoices: [{ id_company: CO, doc: "11144477735", fatura: "F1", vencimento: "2020-01-10", saldo: opts.amount ?? 250 }],
    negotiation_sessions: [{ id: SID, company_id: CO, customer_id: CUST, debt_id: DEBT, agreement_id: null, debt_acknowledged_at: null }],
    negotiation_offers: [],
    negotiation_condition_matrix: opts.matrix ?? [MATRIX],
    negotiation_acceptances: [],
    chat_prompts: [],
    chat_messages: [],
    debt_acknowledgements: [],
    debt_acknowledgement_latest: [],
    agreements: [],
  }
  delete process.env.PAYMENT_ORIGIN
  delete process.env.PAY_LINK_DUE_DAYS
}

// ============================================================================
// (1) AC1 — clicar Negociar apresenta as PARCELAS DA MATRIZ como botões.
// ============================================================================
describe("R1 — apresentação das parcelas da matriz (fallback assistido)", () => {
  beforeEach(() => seed())

  it("presentMatrixOffers cria um prompt 'offer_choice' com as ofertas da matriz + volta[98]", async () => {
    const { presentMatrixOffers } = await import("@/lib/journey/acknowledgement")
    const r = await presentMatrixOffers({ companyId: CO, sessionId: SID, customerId: CUST, debtId: DEBT })
    expect(r.ok && r.presented).toBe(true)
    if (!(r.ok && r.presented)) throw new Error("esperava apresentar")

    const prompt = db.chat_prompts.find((p) => p.kind === "offer_choice" && p.status === "active")
    expect(prompt).toBeTruthy()
    // ids: itens de lista 2..N + volta 98 (nunca beco sem saída, M7)
    const ids = prompt!.buttons.map((b: any) => b.id)
    expect(ids).toContain(98)
    // pelo menos a oferta à vista (com desconto) — id 2 é a 1ª (à vista)
    expect(ids).toContain(2)
    // o value do 1º item carrega o offer_id (uuid persistido, não confia no client)
    const firstOffer = prompt!.buttons.find((b: any) => b.id === 2)
    expect(typeof firstOffer.value).toBe("string")
    expect(r.offers.map((o) => o.id)).toContain(firstOffer.value)
    // context registra os offer_ids apresentados (defesa: o aceite valida contra ele)
    expect(prompt!.context.offer_ids).toEqual(r.offers.map((o) => o.id))
  })

  it("os rótulos das parcelas (T6/R-45): à vista com âncora de economia + '(recomendado)'; parcelado com total", async () => {
    const { presentMatrixOffers, offerButtonLabel } = await import("@/lib/journey/acknowledgement")
    const r = await presentMatrixOffers({ companyId: CO, sessionId: SID, customerId: CUST, debtId: DEBT })
    if (!(r.ok && r.presented)) throw new Error("esperava apresentar")
    // à vista (T6): "À vista R$ … — você economiza R$ … (recomendado)" (com desconto);
    // âncora de economia em REAIS + destaque "(recomendado)". Sem a palavra "desconto".
    const cash = r.offers.find((o) => o.terms.installments === 1)!
    const cashLabel = offerButtonLabel(cash.terms)
    expect(cashLabel).toMatch(/À vista R\$/)
    expect(cashLabel).toContain("(recomendado)")
    if (cash.terms.discount_value > 0) {
      expect(cashLabel).toMatch(/economia de R\$/) // A4/S9: sem travessão
      expect(cashLabel).not.toContain("—")
    }
    // parcelado: "Nx de R$ … (total R$ …)"
    const inst = r.offers.find((o) => o.terms.installments > 1)
    if (inst) {
      const label = offerButtonLabel(inst.terms)
      expect(label).toMatch(/\dx de R\$/)
      expect(label).toContain("total")
    }
  })

  it("a mensagem-pergunta (T5/R-28) é persistida SEM 'se já pagou desconsidere'", async () => {
    const { presentMatrixOffers } = await import("@/lib/journey/acknowledgement")
    await presentMatrixOffers({ companyId: CO, sessionId: SID, customerId: CUST, debtId: DEBT })
    // T5: "Estas são as condições disponíveis para você. Escolha a que preferir e eu gero o seu pagamento."
    const msg = db.chat_messages.find((m) => m.role === "assistant" && /condições disponíveis para você/i.test(m.text))
    expect(msg).toBeTruthy()
    expect(msg!.text).not.toContain("desconsiderar")
    // A4/S8: a MESMA frase do eco do clique Negociar (S7) — uma bolha só na tela.
    expect(msg!.text).toBe("Certo. Estas são as condições disponíveis para você:")
  })

  it("idempotente: com 'offer_choice' ativo NÃO recria (reload/clique duplo não empilha)", async () => {
    const { presentMatrixOffers } = await import("@/lib/journey/acknowledgement")
    const a = await presentMatrixOffers({ companyId: CO, sessionId: SID, customerId: CUST, debtId: DEBT })
    const b = await presentMatrixOffers({ companyId: CO, sessionId: SID, customerId: CUST, debtId: DEBT })
    expect(a.ok && b.ok).toBe(true)
    const actives = db.chat_prompts.filter((p) => p.kind === "offer_choice" && p.status === "active")
    expect(actives.length).toBe(1)
  })
})

// ============================================================================
// (3) AC3 — servidor VALIDA a oferta contra a matriz (não confia no client).
// ============================================================================
describe("R1 — servidor dono da matriz (validação da oferta)", () => {
  beforeEach(() => seed())

  it("sem faixa de matriz vigente → presented:false (cai na degradação, nunca beco sem saída)", async () => {
    seed({ matrix: [] }) // nenhuma linha de matriz
    const { presentMatrixOffers } = await import("@/lib/journey/acknowledgement")
    const r = await presentMatrixOffers({ companyId: CO, sessionId: SID, customerId: CUST, debtId: DEBT })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.presented).toBe(false)
    // nenhum prompt de escolha criado
    expect(db.chat_prompts.some((p) => p.kind === "offer_choice")).toBe(false)
  })

  it("resolveOfferIdFromButton rejeita value fora do context.offer_ids (client não injeta oferta arbitrária)", async () => {
    const { presentMatrixOffers, resolveOfferIdFromButton } = await import("@/lib/journey/acknowledgement")
    await presentMatrixOffers({ companyId: CO, sessionId: SID, customerId: CUST, debtId: DEBT })
    const prompt = db.chat_prompts.find((p) => p.kind === "offer_choice")!
    // botão forjado com value fora dos offer_ids → null
    const forged = { ...prompt, buttons: [{ id: 2, label: "x", value: "offer-forjada-nao-existe" }] } as any
    expect(resolveOfferIdFromButton(forged, 2)).toBeNull()
    // botão legítimo (value = offer_id do context) → devolve o offer_id
    const legitId = prompt.buttons.find((b: any) => b.id === 2).value
    expect(resolveOfferIdFromButton(prompt as any, 2)).toBe(legitId)
    // botão de volta (sem value) → null (não mapeia oferta)
    expect(resolveOfferIdFromButton(prompt as any, 98)).toBeNull()
  })
})

// ============================================================================
// (2)+(4) AC2 — escolher uma oferta gera link ASAAS (valor coerente); AC4 —
//         idempotência (clique duplo → 1 acordo/1 link).
// ============================================================================
describe("R1 — aceite de uma parcela gera o link canônico", () => {
  beforeEach(() => seed())

  it("acceptMatrixCondition(offer) devolve link ASAAS e valor coerente com a oferta", async () => {
    const { presentMatrixOffers } = await import("@/lib/journey/acknowledgement")
    const { acceptMatrixCondition } = await import("@/lib/journey/assisted")
    const pres = await presentMatrixOffers({ companyId: CO, sessionId: SID, customerId: CUST, debtId: DEBT })
    if (!(pres.ok && pres.presented)) throw new Error("esperava apresentar")
    refreshView()
    const offerId = pres.offers[0].id
    const r = await acceptMatrixCondition(ctx, offerId)
    expect(r.ok).toBe(true)
    if (r.ok && r.status === "created") {
      expect(r.payment.invoice_url).toBe("https://asaas/checkout/pay_r1")
      // valor da cobrança = total da oferta aceita (confirmAccept registrou 235)
      expect(r.payment.total_value).toBe(235)
    } else {
      throw new Error(`esperava created, veio ${r.ok ? r.status : "erro"}`)
    }
    expect(confirmCalls).toBe(1)
  })

  it("G5/R7: aceite persiste UMA mensagem de assistente com o link (reload restaura; M11)", async () => {
    const { presentMatrixOffers } = await import("@/lib/journey/acknowledgement")
    const { acceptMatrixCondition } = await import("@/lib/journey/assisted")
    const pres = await presentMatrixOffers({ companyId: CO, sessionId: SID, customerId: CUST, debtId: DEBT })
    if (!(pres.ok && pres.presented)) throw new Error("esperava apresentar")
    refreshView()
    const r = await acceptMatrixCondition(ctx, pres.offers[0].id)
    expect(r.ok).toBe(true)
    // a bolha do link foi gravada no histórico (chat_messages), com o link real…
    const withLink = (db.chat_messages ?? []).filter(
      (m: any) => m.role === "assistant" && typeof m.text === "string" && m.text.includes("https://asaas/checkout/pay_r1"),
    )
    expect(withLink.length).toBe(1)
    // …com o valor da oferta aceita e SEM declarar pago (M15).
    expect(withLink[0].text).toMatch(/R\$\s?235,00/)
    expect(withLink[0].text.toLowerCase()).not.toMatch(/pagamento (confirmado|recebido)|quitad/)
  })

  it("G5/R7 (A1): aceite repetido responde 'já tem cobrança' com o MESMO link; não empilha além disso", async () => {
    const { presentMatrixOffers } = await import("@/lib/journey/acknowledgement")
    const { acceptMatrixCondition } = await import("@/lib/journey/assisted")
    const pres = await presentMatrixOffers({ companyId: CO, sessionId: SID, customerId: CUST, debtId: DEBT })
    if (!(pres.ok && pres.presented)) throw new Error("esperava apresentar")
    refreshView()
    const offerId = pres.offers[0].id
    await acceptMatrixCondition(ctx, offerId)
    await acceptMatrixCondition(ctx, offerId)
    await acceptMatrixCondition(ctx, offerId)
    const withLink = (db.chat_messages ?? []).filter(
      (m: any) => m.role === "assistant" && typeof m.text === "string" && m.text.includes("https://asaas/checkout/pay_r1"),
    )
    // A1 (§2.3): o 1º aceite entrega o link; o repetido é idempotente e é
    // respondido como already_charged ("Você já tem uma cobrança ativa…") com o
    // MESMO link — 2 bolhas distintas, e o 3º aceite NÃO empilha (dedup 15min).
    expect(withLink.length).toBe(2)
    expect(withLink[0].text).toMatch(/Aqui está seu link/i)
    expect(withLink[1].text).toMatch(/já tem uma cobrança ativa/i)
    // ambas carregam a ação open_payment_link (fonte única do painel do client)
    expect(withLink.every((m: any) => m.offers_snapshot?.message_action?.type === "open_payment_link")).toBe(true)
  })

  it("idempotência (D7): 2 aceites da MESMA oferta → 1 confirmAccept/1 acordo (nunca 2ª cobrança)", async () => {
    const { presentMatrixOffers } = await import("@/lib/journey/acknowledgement")
    const { acceptMatrixCondition } = await import("@/lib/journey/assisted")
    const pres = await presentMatrixOffers({ companyId: CO, sessionId: SID, customerId: CUST, debtId: DEBT })
    if (!(pres.ok && pres.presented)) throw new Error("esperava apresentar")
    refreshView()
    const offerId = pres.offers[0].id
    const a = await acceptMatrixCondition(ctx, offerId)
    const b = await acceptMatrixCondition(ctx, offerId)
    expect(a.ok && b.ok).toBe(true)
    // paymentCreate deduplica por (session, offer): o 2º NÃO chama confirmAccept.
    expect(confirmCalls).toBe(1)
    // só 1 acordo criado (nunca 2ª cobrança)
    expect((db.agreements ?? []).length).toBe(1)
    // ambos devolvem o MESMO link
    if (a.ok && a.status === "created" && b.ok && b.status === "created") {
      expect(b.payment.invoice_url).toBe(a.payment.invoice_url)
    }
  })

  it("sem reconhecimento (guard ligado) o aceite é BLOQUEADO e NÃO cobra (D18)", async () => {
    // liga o guard (allow_payment_without_acknowledgement=false) e não reconhece.
    db.tenant_chat_config = [{
      company_id: CO, payment_origin: "platform",
      allow_payment_without_acknowledgement: false, acknowledgement_enabled: true,
      on_debt_not_recognized: "continue", branding: { brand_name: "VMAX" },
    }]
    const { presentMatrixOffers } = await import("@/lib/journey/acknowledgement")
    const { acceptMatrixCondition } = await import("@/lib/journey/assisted")
    const pres = await presentMatrixOffers({ companyId: CO, sessionId: SID, customerId: CUST, debtId: DEBT })
    if (!(pres.ok && pres.presented)) throw new Error("esperava apresentar")
    refreshView()
    const r = await acceptMatrixCondition(ctx, pres.offers[0].id)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe("debt_not_acknowledged")
    expect(confirmCalls).toBe(0)
  })
})
