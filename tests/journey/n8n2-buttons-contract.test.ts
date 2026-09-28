// N8N-2 — contrato de botões no chat.send / prompt.ask (fake Supabase):
//  - flag OFF (default): caminho estrito inalterado (legado → 422), mas o rótulo
//    de um botão de oferta é SEMPRE o do servidor;
//  - flag ON: formas legadas mapeadas; descartes com motivo; nenhum botão válido
//    → bolha + menu determinístico (nunca beco sem saída);
//  - invariantes: 1 prompt ativo por sessão; janela do n8n (422
//    prompt_outside_window) preservada; idempotência por event_id; telemetria
//    sem PII.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"
import type { OfferTerms } from "@/lib/negotiation/offers"

const CO = "eeeeeeee-0000-0000-0000-0000000n8n02"
const SID = "sess-n8n2"
const ctx = { sessionId: SID, companyId: CO, customerId: "cust-n8n2", debtId: "debt-n8n2" }

let db: FakeDb
const events: Array<{ type: string; payload?: Record<string, unknown>; eventId?: string }> = []
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => makeFakeSupabase(db) }))
vi.mock("@/lib/journey/events", () => ({
  recordEvent: async (e: { type: string; payload?: Record<string, unknown>; eventId?: string }) => {
    if (e.eventId && events.some((x) => x.eventId === e.eventId)) return { ok: true, duplicate: true }
    events.push(e)
    return { ok: true, duplicate: false }
  },
}))
// Menu determinístico: o reopen real monta o menu de 3 opções a partir da
// dívida/tenant; aqui só registramos que ele foi reaberto (1 prompt ativo).
vi.mock("@/lib/journey/acknowledgement", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/journey/acknowledgement")>()
  return {
    ...orig,
    resolveSessionDebtIds: async (_sid: string, debtId: string) => ({ debtIds: [debtId], primaryDebtId: debtId }),
    reopenThreeOptions: async (input: { sessionId: string; companyId: string }) => {
      db.chat_prompts.push({
        id: "p-menu", company_id: input.companyId, session_id: input.sessionId, kind: "debt_three_options",
        status: "active", created_by: "platform", question: "",
        buttons: [{ id: 4, label: "Pagar", order: 0 }, { id: 1, label: "Negociar", order: 1 }, { id: 0, label: "Não reconheço", order: 2 }],
        created_at: new Date().toISOString(),
      })
      return { ok: true, reply: "Como prefere seguir?", promptId: "p-menu" }
    },
  }
})

const terms = (t: Partial<OfferTerms>): OfferTerms => ({
  original_value: 180, discount_pct: 0, discount_value: 0, entry_value: 0, installments: 1,
  installment_value: 180, total_value: 180, billing_type: "PIX", first_due_date: "2026-10-04", ...t,
})
const OA = "a7ae147d-0b12-42e1-9c69-cb234417c6a3"
const OB = "b272e8b9-7adc-45a7-a033-3eb68b4f9806"
const TA = terms({ discount_pct: 5, discount_value: 9, installment_value: 171, total_value: 171 })
const TB = terms({ discount_pct: 2.5, discount_value: 4.5, installments: 2, installment_value: 87.75, total_value: 175.5, billing_type: "BOLETO" })

function seed(extra: Partial<FakeDb> = {}) {
  events.length = 0
  db = {
    negotiation_sessions: [{ id: SID, company_id: CO, thread_epoch: 0 }],
    negotiation_offers: [
      { id: OA, session_id: SID, status: "presented", terms: TA, valid_until: null },
      { id: OB, session_id: SID, status: "presented", terms: TB, valid_until: null },
      { id: "c0ffee00-0000-4000-8000-000000000001", session_id: SID, status: "expired", terms: TB, valid_until: null },
    ],
    chat_prompts: [],
    chat_messages: [],
    ...extra,
  }
}
const active = () => db.chat_prompts.filter((p) => p.status === "active")
const LEGACY_YES_NO = [{ id: "1", text: "Sim" }, { id: "0", text: "Não" }]

const OLD_FLAG = process.env.N8N_LEGACY_BUTTONS_ADAPTER
afterEach(() => {
  if (OLD_FLAG === undefined) delete process.env.N8N_LEGACY_BUTTONS_ADAPTER
  else process.env.N8N_LEGACY_BUTTONS_ADAPTER = OLD_FLAG
})

describe("flag OFF (default) — caminho estrito", () => {
  beforeEach(() => {
    delete process.env.N8N_LEGACY_BUTTONS_ADAPTER
    seed()
  })

  it("forma canônica aceita e gravada como veio", async () => {
    const { chatSend } = await import("@/lib/journey/chat-send")
    const { offerButtonLabel } = await import("@/lib/journey/acknowledgement")
    const buttons = [{ id: 2, label: offerButtonLabel(TA), value: OA }, { id: 98, label: "Voltar" }]
    const r = await chatSend(ctx, { text: "Escolha:", prompt: { kind: "offer_choice", question: "Escolha:", buttons } }, "evt-canon")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.buttons_report).toBeUndefined()
    expect(active()).toHaveLength(1)
    expect(active()[0].buttons).toEqual(buttons)
  })

  it("forma legada segue recusada com 422 button_id_invalid (nada gravado)", async () => {
    const { chatSend } = await import("@/lib/journey/chat-send")
    const r = await chatSend(ctx, { text: "Reconhece?", prompt: { kind: "generic_yes_no", question: "Reconhece?", buttons: LEGACY_YES_NO as never } }, "evt-legacy-off")
    expect(r.ok).toBe(false)
    if (!r.ok) expect([r.status, r.code]).toEqual([422, "button_id_invalid"])
    expect(db.chat_messages).toHaveLength(0)
    expect(db.chat_prompts).toHaveLength(0)
  })

  it("rótulo com valor falso num botão de oferta vira o rótulo do servidor", async () => {
    const { chatSend } = await import("@/lib/journey/chat-send")
    const { offerButtonLabel } = await import("@/lib/journey/acknowledgement")
    const r = await chatSend(ctx, {
      text: "Oferta",
      prompt: { kind: "offer_choice", question: "Oferta", buttons: [{ id: 2, label: "À vista R$ 18,00 (90%)", value: OA }] },
    }, "evt-fake-label")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.buttons_report).toMatchObject({ mode: "strict", relabeled: 1 })
    expect(active()[0].buttons[0].label).toBe(offerButtonLabel(TA))
    expect(JSON.stringify(db.chat_prompts)).not.toContain("18,00")
  })
})

describe("flag ON — adaptador legado", () => {
  beforeEach(() => {
    process.env.N8N_LEGACY_BUTTONS_ADAPTER = "on"
    seed()
  })

  it("canônico continua aceito sem relatório", async () => {
    const { chatSend } = await import("@/lib/journey/chat-send")
    const buttons = [{ id: 1, label: "Sim" }, { id: 0, label: "Não" }]
    const r = await chatSend(ctx, { text: "Vamos?", prompt: { kind: "generic_yes_no", question: "Vamos?", buttons } }, "evt-canon-on")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.buttons_report).toBeUndefined()
    // idêntico ao caminho estrito (createPrompt ordena por id quando não há `order`).
    const { sortButtons } = await import("@/lib/journey/buttons")
    expect(active()[0].buttons).toEqual(sortButtons(buttons))
    expect(events.filter((e) => e.type === "chat.engine_buttons_adapted")).toHaveLength(0)
  })

  it("Sim/Não legado → prompt canônico + telemetria sem PII", async () => {
    const { chatSend } = await import("@/lib/journey/chat-send")
    const r = await chatSend(ctx, { text: "", prompt: { kind: "", question: "Reconhece o débito?", buttons: LEGACY_YES_NO as never } }, "evt-lv2")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.buttons_report).toMatchObject({ mode: "legacy_adapter", adapted: true, kept: 2, dropped_buttons: [] })
    expect(active()).toHaveLength(1)
    expect(active()[0].kind).toBe("generic_yes_no")
    expect(active()[0].buttons.map((b: { id: number }) => b.id)).toEqual([1, 0])
    const tel = events.filter((e) => e.type === "chat.engine_buttons_adapted")
    expect(tel).toHaveLength(1)
    expect(JSON.stringify(tel[0].payload)).not.toMatch(/Sim|Não|Reconhece/)
  })

  it("parcelas legadas: valor do servidor casa, valor do n8n é descartado com motivo", async () => {
    const { chatSend } = await import("@/lib/journey/chat-send")
    const { offerButtonLabel } = await import("@/lib/journey/acknowledgement")
    const r = await chatSend(ctx, {
      text: "",
      prompt: {
        kind: "offer_choice", question: "Escolha as parcelas",
        buttons: [{ id: "1", text: "1x de R$ 171,00" }, { id: "2", text: "2x de R$ 99,99" }] as never,
      },
    }, "evt-lv4")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.buttons_report!.dropped_buttons).toEqual([{ index: 1, reason: "offer_amount_mismatch" }])
    expect(active()[0].buttons).toEqual([{ id: 2, label: offerButtonLabel(TA), value: OA, order: 0 }])
  })

  it("offer_id antigo/expirado é descartado", async () => {
    const { chatSend } = await import("@/lib/journey/chat-send")
    const r = await chatSend(ctx, {
      text: "x",
      prompt: {
        kind: "offer_choice", question: "x",
        buttons: [{ id: 2, label: "2x", value: "c0ffee00-0000-4000-8000-000000000001" }, { id: 3, label: "2x", offer_id: OB }] as never,
      },
    }, "evt-stale")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.buttons_report!.dropped_buttons).toEqual([{ index: 0, reason: "offer_stale" }])
    expect(active()[0].buttons.map((b: { value?: string }) => b.value)).toEqual([OB])
  })

  it("todos inválidos → bolha + menu determinístico (sem prompt do n8n)", async () => {
    const { chatSend } = await import("@/lib/journey/chat-send")
    const r = await chatSend(ctx, {
      text: "",
      prompt: { kind: "offer_choice", question: "Escolha as parcelas", buttons: [{ id: 1, label: "1x de R$ 1.470,00" }] },
    }, "evt-all-bad")
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.prompt_id).toBeUndefined()
      expect(r.fallback_prompt_id).toBe("p-menu")
      expect(r.buttons_report).toMatchObject({ fallback: "assisted_menu", kept: 0 })
    }
    expect(db.chat_messages).toHaveLength(1)
    expect(db.chat_messages[0].prompt_id).toBeNull()
    expect(active().map((p) => p.id)).toEqual(["p-menu"])
  })

  it("todos inválidos e nada para exibir → 422 buttons_invalid, nada gravado", async () => {
    const { promptAsk } = await import("@/lib/journey/chat-send")
    const r = await promptAsk(ctx, { kind: "offer_choice", question: "", buttons: [{ id: "zzz", text: "?" }] as never })
    expect(r.ok).toBe(false)
    if (!r.ok) expect([r.status, r.code]).toEqual([422, "buttons_invalid"])
    expect(db.chat_prompts).toHaveLength(0)
    expect(db.chat_messages).toHaveLength(0)
  })

  it("prompt fora da janela do n8n → 422 prompt_outside_window (parcelas do assistido ficam)", async () => {
    seed({
      chat_prompts: [{
        id: "p-offer", company_id: CO, session_id: SID, kind: "offer_choice", status: "active", created_by: "platform",
        question: "…", buttons: [{ id: 2, label: "À vista", value: OA }, { id: 98, label: "Voltar às opções" }],
        context: { offer_ids: [OA, OB] }, created_at: new Date(Date.now() - 60_000).toISOString(),
      }],
    })
    const { chatSend } = await import("@/lib/journey/chat-send")
    const r = await chatSend(ctx, {
      text: "",
      prompt: { kind: "offer_choice", question: "Parcelas", buttons: [{ id: "2", text: "2x de R$ 87,75" }] as never },
    }, "evt-late")
    expect(r.ok).toBe(false)
    if (!r.ok) expect([r.status, r.code]).toEqual([422, "prompt_outside_window"])
    expect(active().map((p) => p.id)).toEqual(["p-offer"])
    expect(db.chat_messages).toHaveLength(0)
  })

  it("event_id duplicado: 1 mensagem, 1 prompt, 1 telemetria", async () => {
    const { chatSend } = await import("@/lib/journey/chat-send")
    const args = { text: "Reconhece?", prompt: { kind: "", question: "Reconhece?", buttons: LEGACY_YES_NO as never } }
    const a = await chatSend(ctx, args, "evt-dup-n8n2")
    const b = await chatSend(ctx, args, "evt-dup-n8n2")
    expect(a.ok && b.ok).toBe(true)
    if (a.ok && b.ok) {
      expect(b.duplicate).toBe(true)
      expect(b.message_id).toBe(a.message_id)
    }
    expect(db.chat_messages).toHaveLength(1)
    expect(db.chat_prompts).toHaveLength(1)
    expect(events.filter((e) => e.type === "chat.engine_buttons_adapted")).toHaveLength(1)
  })

  it("um único menu ativo: prompt do n8n anterior é substituído; fallback não empilha menu", async () => {
    const { chatSend } = await import("@/lib/journey/chat-send")
    await chatSend(ctx, { text: "", prompt: { kind: "", question: "1ª", buttons: LEGACY_YES_NO as never } }, "evt-m1")
    await chatSend(ctx, {
      text: "",
      prompt: { kind: "offer_choice", question: "2ª", buttons: [{ id: "PIX", text: "Pix (à vista)" }, { id: "BOLETO", text: "Boleto (à vista)" }] as never },
    }, "evt-m2")
    expect(active()).toHaveLength(1)
    expect(active()[0].kind).toBe("payment_method_choice")
    // todos inválidos com um ativo presente: o ativo É o menu; nada novo empilha.
    const r = await chatSend(ctx, { text: "", prompt: { kind: "offer_choice", question: "3ª", buttons: [{ id: 9, label: "9x de R$ 1,00" }] } }, "evt-m3")
    expect(r.ok).toBe(true)
    expect(active()).toHaveLength(1)
    expect(active()[0].kind).toBe("payment_method_choice")
    expect(db.chat_prompts.filter((p) => p.id === "p-menu")).toHaveLength(0)
  })
})
