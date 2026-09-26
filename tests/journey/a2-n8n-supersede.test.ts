// A2 (N-D2-5 / N-D2-6 / §2.3 / §2.5 D1 híbrido) — o n8n só SUBSTITUI o menu
// assistido da plataforma por um prompt ACIONÁVEL:
//  - texto sem botões (chat.send só com text) NÃO supersede: a bolha entra, o
//    offer_choice/3 opções continua ativo;
//  - prompt com botões inválidos → 422 e nada é gravado; ativo preservado;
//  - prompt válido mas NÃO mapeável (offer_id fora da matriz da sessão, kind
//    desconhecido sem mapeamento, kind reservado à plataforma) → 422
//    prompt_not_actionable; ativo preservado;
//  - prompt acionável (offer_id da matriz / booleano conhecido / método de
//    pagamento) → substitui (ativo vira superseded, novo created_by='n8n');
//  - prompt.close NÃO fecha o menu protegido (422); fecha um prompt do n8n;
//  - sem menu protegido ativo → comportamento legado (supersede livre).
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"

const CO = "eeeeeeee-0000-0000-0000-0000000a2sup"
const SID = "sess-a2-sup"
const ctx = { sessionId: SID, companyId: CO, customerId: "cust-a2-sup", debtId: "debt-a2-sup" }

let db: FakeDb
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => makeFakeSupabase(db) }))
vi.mock("@/lib/journey/events", () => ({ recordEvent: async () => ({ ok: true, duplicate: false }) }))

const OFFER_A = "offer-a2-avista"
const OFFER_B = "offer-a2-2x"

function seedWithPlatformOfferChoice() {
  db = {
    negotiation_sessions: [{ id: SID, company_id: CO, thread_epoch: 0 }],
    negotiation_offers: [
      { id: OFFER_A, session_id: SID, status: "presented", terms: { installments: 1 }, valid_until: null },
      { id: OFFER_B, session_id: SID, status: "presented", terms: { installments: 2 }, valid_until: null },
      { id: "offer-expired", session_id: SID, status: "expired", terms: { installments: 3 }, valid_until: null },
    ],
    chat_prompts: [{
      id: "p-offer", company_id: CO, session_id: SID, kind: "offer_choice", status: "active",
      created_by: "platform", question: "Estas são as condições…",
      buttons: [{ id: 2, label: "À vista", value: OFFER_A }, { id: 3, label: "2x", value: OFFER_B }, { id: 98, label: "Voltar às opções" }],
      // QA round 4 (R-27): parcelas apresentadas AGORA (dentro da janela de tomada
      // do n8n); a janela em si é coberta em qa4-kickoff-window.
      context: { offer_ids: [OFFER_A, OFFER_B] }, created_at: new Date().toISOString(),
    }],
    chat_messages: [],
  }
}
const activePrompt = () => db.chat_prompts.find((p) => p.status === "active")

describe("texto do n8n sem botões NÃO cala o assistido", () => {
  beforeEach(seedWithPlatformOfferChoice)

  it("chat.send só com text → bolha engine=n8n sem prompt; offer_choice continua ativo", async () => {
    const { chatSend } = await import("@/lib/journey/chat-send")
    const r = await chatSend(ctx, { text: "Muito obrigado pela confirmação, **Fabio**!", n8n_execution_id: "7518" }, "evt-text")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.prompt_id).toBeUndefined()
    const msg = db.chat_messages[0]
    expect(msg.engine).toBe("n8n")
    expect(msg.prompt_id).toBeNull()
    expect(activePrompt()!.id).toBe("p-offer")
    expect(activePrompt()!.status).toBe("active")
  })
})

describe("prompt do n8n inválido ou não acionável → 422, ativo preservado", () => {
  beforeEach(seedWithPlatformOfferChoice)

  it("botões inválidos (ids duplicados) → 422 sem gravar nada", async () => {
    const { chatSend } = await import("@/lib/journey/chat-send")
    const r = await chatSend(ctx, {
      text: "x",
      prompt: { kind: "offer_choice", question: "q", buttons: [{ id: 2, label: "A", value: OFFER_A }, { id: 2, label: "B", value: OFFER_B }] },
    }, "evt-bad")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(422)
    expect(db.chat_messages.length).toBe(0)
    expect(db.chat_prompts.length).toBe(1)
    expect(activePrompt()!.id).toBe("p-offer")
  })

  it("shape legado do n8n (ids string / 'text' em vez de 'label') → 422 button_id_invalid", async () => {
    const { chatSend } = await import("@/lib/journey/chat-send")
    const r = await chatSend(ctx, {
      text: "Conseguimos uma condição especial",
      prompt: { kind: "offer_choice", question: "q", buttons: [{ id: "1", text: "Sim" } as any, { id: "0", text: "Não" } as any] },
    }, "evt-legacy")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe("button_id_invalid")
    expect(activePrompt()!.id).toBe("p-offer")
  })

  it("offer_choice com offer_id fora da matriz da sessão → 422 prompt_not_actionable; ativo preservado; texto NÃO gravado", async () => {
    const { chatSend } = await import("@/lib/journey/chat-send")
    const r = await chatSend(ctx, {
      text: "Tenho uma oferta melhor",
      prompt: { kind: "offer_choice", question: "Escolha", buttons: [{ id: 2, label: "50% off", value: "offer-forjada" }, { id: 98, label: "Voltar" }] },
    }, "evt-forged")
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.status).toBe(422)
      expect(r.code).toBe("prompt_not_actionable")
      expect(r.message).toContain("offer_id_unknown")
    }
    expect(db.chat_messages.length).toBe(0)
    expect(db.chat_prompts.length).toBe(1)
    expect(activePrompt()!.id).toBe("p-offer")
  })

  it("offer_choice apontando para oferta EXPIRADA → não mapeável (422)", async () => {
    const { chatSend } = await import("@/lib/journey/chat-send")
    const r = await chatSend(ctx, {
      text: "x",
      prompt: { kind: "offer_choice", question: "q", buttons: [{ id: 2, label: "3x", value: "offer-expired" }] },
    }, "evt-expired")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe("prompt_not_actionable")
    expect(activePrompt()!.id).toBe("p-offer")
  })

  it("kind desconhecido com botões sem mapeamento → 422; kind reservado à plataforma → 422", async () => {
    const { chatSend, promptAsk } = await import("@/lib/journey/chat-send")
    const r1 = await chatSend(ctx, {
      text: "x",
      prompt: { kind: "negotiation_l1", question: "Quer regularizar?", buttons: [{ id: 2, label: "Sim, quero regularizar" }, { id: 3, label: "Agora não" }] },
    }, "evt-l1")
    expect(r1.ok).toBe(false)
    if (!r1.ok) expect(r1.message).toContain("button_action_unmapped")
    const r2 = await promptAsk(ctx, { kind: "debt_three_options", question: "q", buttons: [{ id: 4, label: "Pagar" }, { id: 1, label: "Negociar" }] })
    expect(r2.ok).toBe(false)
    if (!r2.ok) {
      expect(r2.status).toBe(422)
      expect(r2.message).toContain("kind_reserved_platform")
    }
    expect(db.chat_prompts.length).toBe(1)
    expect(activePrompt()!.id).toBe("p-offer")
  })

  it("prompt.close NÃO fecha o menu protegido da plataforma (422 platform_prompt_protected)", async () => {
    const { promptClose } = await import("@/lib/journey/chat-send")
    const r = await promptClose(ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.status).toBe(422)
      expect(r.code).toBe("platform_prompt_protected")
    }
    expect(activePrompt()!.id).toBe("p-offer")
    expect(activePrompt()!.status).toBe("active")
  })
})

describe("prompt do n8n ACIONÁVEL substitui o assistido", () => {
  beforeEach(seedWithPlatformOfferChoice)

  it("chat.send com offer_choice cujos values são offer_ids da matriz da sessão → supersede", async () => {
    const { chatSend } = await import("@/lib/journey/chat-send")
    const r = await chatSend(ctx, {
      text: "Conseguimos uma condição especial",
      prompt: { kind: "offer_choice", question: "Escolha a melhor para você", buttons: [{ id: 2, label: "À vista com desconto", value: OFFER_A }, { id: 98, label: "Voltar" }] },
      n8n_execution_id: "8001",
    }, "evt-ok")
    expect(r.ok).toBe(true)
    const old = db.chat_prompts.find((p) => p.id === "p-offer")!
    expect(old.status).toBe("superseded")
    const now = activePrompt()!
    expect(now.created_by).toBe("n8n")
    expect(now.kind).toBe("offer_choice")
    expect(db.chat_messages[0].prompt_id).toBe(now.id)
  })

  it("prompt.ask booleano conhecido (generic_yes_no) → acionável, substitui", async () => {
    const { promptAsk } = await import("@/lib/journey/chat-send")
    const r = await promptAsk(ctx, { kind: "generic_yes_no", question: "Confirma?", buttons: [{ id: 1, label: "Sim" }, { id: 0, label: "Não" }] })
    expect(r.ok).toBe(true)
    expect(activePrompt()!.created_by).toBe("n8n")
    expect(db.chat_prompts.find((p) => p.id === "p-offer")!.status).toBe("superseded")
  })

  it("payment_method_choice com values PIX/BOLETO → acionável; value inválido → 422", async () => {
    const { promptAsk } = await import("@/lib/journey/chat-send")
    const bad = await promptAsk(ctx, { kind: "payment_method_choice", question: "Como paga?", buttons: [{ id: 2, label: "Cheque", value: "CHEQUE" }] })
    expect(bad.ok).toBe(false)
    expect(activePrompt()!.id).toBe("p-offer")
    const ok = await promptAsk(ctx, { kind: "payment_method_choice", question: "Como paga?", buttons: [{ id: 2, label: "PIX", value: "PIX" }, { id: 3, label: "Boleto", value: "BOLETO" }] })
    expect(ok.ok).toBe(true)
    expect(activePrompt()!.kind).toBe("payment_method_choice")
  })

  it("prompt.close fecha um prompt do n8n (não protegido)", async () => {
    const { promptAsk, promptClose } = await import("@/lib/journey/chat-send")
    await promptAsk(ctx, { kind: "generic_yes_no", question: "q", buttons: [{ id: 1, label: "Sim" }, { id: 0, label: "Não" }] })
    const r = await promptClose(ctx)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.closed).toBe(true)
    expect(activePrompt()).toBeUndefined()
  })
})

describe("sem menu protegido ativo → comportamento legado", () => {
  it("offer_choice já respondido: um prompt do n8n de kind desconhecido entra normalmente", async () => {
    seedWithPlatformOfferChoice()
    db.chat_prompts[0].status = "answered"
    const { promptAsk } = await import("@/lib/journey/chat-send")
    const r = await promptAsk(ctx, { kind: "negotiation_l1", question: "q", buttons: [{ id: 2, label: "Sim, quero regularizar" }, { id: 3, label: "Agora não" }] })
    expect(r.ok).toBe(true)
    expect(activePrompt()!.created_by).toBe("n8n")
  })
})

describe("assessPromptActionability (pura)", () => {
  it("regras por kind", async () => {
    const { assessPromptActionability } = await import("@/lib/journey/chat-send")
    const offers = new Set([OFFER_A])
    expect(assessPromptActionability({ kind: "offer_choice", buttons: [{ id: 2, label: "x", value: OFFER_A }] }, offers).ok).toBe(true)
    expect(assessPromptActionability({ kind: "offer_choice", buttons: [{ id: 98, label: "Voltar" }] }, offers)).toEqual({ ok: false, code: "offer_choice_without_items" })
    expect(assessPromptActionability({ kind: "offer_choice", buttons: [{ id: 2, label: "x" }] }, offers)).toEqual({ ok: false, code: "offer_id_unknown" })
    expect(assessPromptActionability({ kind: "generic_yes_no", buttons: [{ id: 1, label: "Sim" }] }, offers)).toEqual({ ok: false, code: "boolean_missing_yes_no" })
    expect(assessPromptActionability({ kind: "generic_yes_no", buttons: [{ id: 1, label: "Sim" }, { id: 0, label: "Não" }, { id: 99, label: "Atendente" }] }, offers).ok).toBe(true)
    expect(assessPromptActionability({ kind: "post_payment_link", buttons: [{ id: 98, label: "Voltar" }] }, offers)).toEqual({ ok: false, code: "kind_reserved_platform" })
    expect(assessPromptActionability({ kind: "custom", buttons: [{ id: 1, label: "Sim" }, { id: 98, label: "Voltar" }] }, offers).ok).toBe(true)
    expect(assessPromptActionability({ kind: "custom", buttons: [{ id: 2, label: "x", value: OFFER_A }, { id: 3, label: "y" }] }, offers)).toEqual({ ok: false, code: "button_action_unmapped" })
    expect(assessPromptActionability({ kind: "", buttons: [{ id: 1, label: "Sim" }] }, offers)).toEqual({ ok: false, code: "kind_missing" })
    expect(assessPromptActionability({ kind: "offer_choice", buttons: [] }, offers)).toEqual({ ok: false, code: "buttons_empty" })
  })
})
