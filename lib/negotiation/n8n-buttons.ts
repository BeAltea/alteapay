// N8N-2 — contrato de BOTÕES do n8n (lado plataforma).
//
// Forma CANÔNICA (a única que o caminho estrito aceita; lib/journey/buttons.ts):
//   args.prompt = { kind: string, question: string, buttons: Button[] }
//   Button      = { id: int, label: string, value?: string, order?: number }
//     - id 2..97  = item de lista (oferta, método de pagamento, opção genérica);
//     - id 1/0    = Sim/Não (em `debt_acknowledgement`: reconheço / não reconheço);
//     - id 96     = "Já paguei";  98 = Voltar;  99 = Atendimento (handoff);
//     - oferta    = kind 'offer_choice' + `value` = offer_id de uma oferta
//                   'presented' da sessão (gerada pelo SERVIDOR via offer.list).
//
// Duas camadas, ambas chamadas no início de chat.send / prompt.ask:
//
//  1) SEMPRE (flag off ou on): todo botão cujo `value` é uma oferta vigente da
//     sessão tem o rótulo REGENERADO a partir da oferta do servidor
//     (offerButtonLabel). O devedor nunca vê valor escrito pelo n8n num botão
//     que cobra a oferta do servidor (regra de ouro; D3 "cobra-se o que se viu").
//     Não muda o que é aceito — só o que é exibido.
//
//  2) ADAPTADOR LEGADO (N8N_LEGACY_BUTTONS_ADAPTER=on; default OFF): converte os
//     formatos que os fluxos do n8n emitem hoje (ids string, `text` no lugar de
//     `label`, métodos PIX/BOLETO/CARTAO como id, parcelas "Nx de R$ …" com valor
//     calculado pelo n8n, envelope `{sessionId, output, buttons}`) para a forma
//     canônica, SÓ quando o mapeamento é inequívoco. O que não mapeia é
//     descartado (com motivo). Sem nenhum botão válido, o texto entra como bolha e
//     a sessão fica com o menu determinístico (nunca beco sem saída).
//
// Telemetria: journey_events `chat.engine_buttons_adapted` (sem PII: só ids,
// contagens e motivos — nunca rótulos, valores ou documento).
//
// Documentação: docs/N8N_INTEGRATION.md §20 e ops/n8n-sync-fix/14-n8n2-botoes.md.

import { BTN_BACK, BTN_HANDOFF, BTN_NO, BTN_YES, type Button } from "@/lib/journey/buttons"
import type { OfferTerms } from "@/lib/negotiation/offers"

/** "Já paguei" — mesmo id do eco do payment_claim (lib/journey/double-tap.ts). */
export const BTN_PAYMENT_CLAIM = 96

const LIST_MIN = 2
const LIST_MAX = 97

/** Rótulos do servidor para métodos de pagamento (o n8n não escreve prazo/valor). */
export const PAYMENT_METHOD_LABELS: Readonly<Record<string, string>> = {
  PIX: "Pix",
  BOLETO: "Boleto",
  CREDIT_CARD: "Cartão de crédito",
}

/** Rótulos padrão das ações quando o n8n não manda um rótulo utilizável. */
export const ACTION_DEFAULT_LABELS: Readonly<Record<number, string>> = {
  [BTN_YES]: "Sim",
  [BTN_NO]: "Não",
  [BTN_PAYMENT_CLAIM]: "Já paguei",
  [BTN_BACK]: "Voltar",
  [BTN_HANDOFF]: "Falar com atendimento",
}

const BOOLEAN_KINDS: ReadonlySet<string> = new Set(["debt_acknowledgement", "generic_yes_no", "payment_confirmation"])

/** Flag do adaptador legado. Default OFF: o caminho estrito segue inalterado. */
export function legacyButtonsAdapterEnabled(): boolean {
  const v = (process.env.N8N_LEGACY_BUTTONS_ADAPTER ?? "").trim().toLowerCase()
  return v === "on" || v === "true" || v === "1"
}

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

/** Oferta vigente da sessão (negotiation_offers.status='presented', não vencida). */
export interface ServerOffer {
  id: string
  terms: OfferTerms
}

export type DropReason =
  | "button_shape"
  | "label_missing"
  | "offer_stale"
  | "offer_amount_mismatch"
  | "offer_unresolved"
  | "action_unknown"
  | "id_invalid"
  | "duplicate"
  | "not_allowed_in_kind"

export interface DroppedButton {
  /** posição do botão no array recebido (0-based). Sem rótulo/valor (PII). */
  index: number
  reason: DropReason
}

export interface ButtonsReport {
  mode: "strict" | "legacy_adapter"
  /** true quando a forma recebida não era a canônica e foi convertida. */
  adapted: boolean
  kind_in: string | null
  kind_out: string | null
  received: number
  kept: number
  relabeled: number
  dropped_buttons: DroppedButton[]
  /** 'assisted_menu' quando nenhum botão sobrou e a sessão ficou com o menu determinístico. */
  fallback: "assisted_menu" | null
}

export interface RawPrompt {
  kind?: unknown
  question?: unknown
  buttons?: unknown
}

export interface AdaptedPrompt {
  kind: string
  question: string
  buttons: Button[]
}

export type LabelFor = (terms: OfferTerms) => string

// ---------------------------------------------------------------------------
// Helpers puros
// ---------------------------------------------------------------------------

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : ""
}

/** Normaliza tokens de ação: minúsculas, sem acento, espaços/hífens → '_'. */
export function normalizeToken(v: string): string {
  return v
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
}

const PAYMENT_TOKENS: Readonly<Record<string, string>> = {
  pix: "PIX",
  boleto: "BOLETO",
  cartao: "CREDIT_CARD",
  cartao_credito: "CREDIT_CARD",
  cartao_de_credito: "CREDIT_CARD",
  credit_card: "CREDIT_CARD",
}

/** Tokens de ação não-oferta → id da plataforma (+ se implica reconhecimento). */
const ACTION_TOKENS: Readonly<Record<string, { id: number; ack?: boolean }>> = {
  acknowledge: { id: BTN_YES, ack: true },
  acknowledge_debt: { id: BTN_YES, ack: true },
  debt_acknowledge: { id: BTN_YES, ack: true },
  reconheco: { id: BTN_YES, ack: true },
  reconhecer: { id: BTN_YES, ack: true },
  not_recognized: { id: BTN_NO, ack: true },
  nao_reconheco: { id: BTN_NO, ack: true },
  dispute: { id: BTN_NO, ack: true },
  yes: { id: BTN_YES },
  sim: { id: BTN_YES },
  no: { id: BTN_NO },
  nao: { id: BTN_NO },
  ja_paguei: { id: BTN_PAYMENT_CLAIM },
  already_paid: { id: BTN_PAYMENT_CLAIM },
  payment_claim: { id: BTN_PAYMENT_CLAIM },
  voltar: { id: BTN_BACK },
  back: { id: BTN_BACK },
  handoff: { id: BTN_HANDOFF },
  human: { id: BTN_HANDOFF },
  human_transfer: { id: BTN_HANDOFF },
  atendimento: { id: BTN_HANDOFF },
  atendente: { id: BTN_HANDOFF },
}

/** Método de pagamento pelo INÍCIO do rótulo (Pix/Boleto/Cartão). null se ambíguo. */
export function paymentFromLabel(label: string): string | null {
  const t = normalizeToken(label)
  if (/^pix(_|$|\()/.test(t)) return "PIX"
  if (/^boleto(_|$|\()/.test(t)) return "BOLETO"
  if (/^cartao(_|$|\()/.test(t) || /^credit_card(_|$)/.test(t)) return "CREDIT_CARD"
  return null
}

const FIXED_ACTION_IDS: ReadonlySet<number> = new Set([BTN_YES, BTN_NO, BTN_PAYMENT_CLAIM, BTN_BACK, BTN_HANDOFF])

/** "R$ 1.470,00" → 1470. Primeiro valor monetário do texto; null se não houver. */
export function parseBrlAmount(label: string): number | null {
  const m = label.match(/R\$\s*([\d.]+(?:,\d{1,2})?)/i)
  if (!m) return null
  const n = Number(m[1].replace(/\./g, "").replace(",", "."))
  return Number.isFinite(n) ? n : null
}

/** Nº de parcelas anunciado no rótulo ("3x", "3 x"; "à vista" = 1). null se ausente. */
export function parseInstallments(label: string): number | null {
  const m = label.match(/(\d{1,2})\s*x\b/i)
  if (m) return Number(m[1])
  if (/\bvista\b/i.test(label.normalize("NFD").replace(/[̀-ͯ]/g, ""))) return 1
  return null
}

function isPayIntegral(o: ServerOffer): boolean {
  return (o.terms as { purpose?: string } | null)?.purpose === "pay_integral"
}

/**
 * Casa um rótulo com valor ("Nx de R$ X", "À vista R$ X") com EXATAMENTE uma
 * oferta da matriz da sessão: mesmo nº de parcelas E o 1º valor do rótulo igual
 * (ao centavo) à parcela (N>1) ou ao total (à vista). Ambíguo/sem casamento →
 * motivo de descarte. A oferta integral do Pagar não conta (não é da matriz).
 */
export function matchOfferByLabel(
  label: string,
  offers: readonly ServerOffer[],
): { ok: true; offer: ServerOffer } | { ok: false; reason: DropReason } {
  const amount = parseBrlAmount(label)
  if (amount == null) return { ok: false, reason: "offer_unresolved" }
  const n = parseInstallments(label)
  const matrix = offers.filter((o) => !isPayIntegral(o) && o.terms && Number.isFinite(o.terms.total_value))
  const byN = n == null ? matrix : matrix.filter((o) => o.terms.installments === n)
  if (byN.length === 0) return { ok: false, reason: n == null ? "offer_unresolved" : "offer_amount_mismatch" }
  const exact = byN.filter((o) => {
    const expected = o.terms.installments > 1 ? o.terms.installment_value : o.terms.total_value
    return Math.abs(Number(expected) - amount) < 0.005
  })
  if (exact.length === 1) return { ok: true, offer: exact[0] }
  return { ok: false, reason: exact.length === 0 ? "offer_amount_mismatch" : "offer_unresolved" }
}

function termsLabelable(t: OfferTerms | null | undefined): t is OfferTerms {
  return !!t && Number.isFinite(t.total_value) && Number.isFinite(t.installments)
}

/**
 * true quando o prompt JÁ está na forma canônica: array não-vazio, todo botão com
 * id inteiro >= 0, `label` string não-vazia e nenhum campo legado (`text`,
 * `offer_id`, `action`). Nesse caso o adaptador não reescreve ids/kind.
 */
export function isCanonicalButtons(buttons: unknown): boolean {
  if (!Array.isArray(buttons) || buttons.length === 0) return false
  return buttons.every((b) => {
    if (!isObj(b)) return false
    if (typeof b.id !== "number" || !Number.isInteger(b.id) || b.id < 0) return false
    if (typeof b.label !== "string" || !b.label.trim()) return false
    return !("text" in b) && !("offer_id" in b) && !("action" in b)
  })
}

// ---------------------------------------------------------------------------
// Camada 1 — rótulo das ofertas SEMPRE do servidor (flag off ou on)
// ---------------------------------------------------------------------------

/**
 * PURA. Para cada botão cujo `value` é uma oferta vigente, troca o rótulo pelo do
 * servidor. Não remove nem reordena nada (o caminho estrito segue decidindo o que
 * aceita). Retorna o prompt (novo objeto) e quantos rótulos mudaram.
 */
export function relabelOfferButtons(
  prompt: AdaptedPrompt,
  offers: readonly ServerOffer[],
  labelFor: LabelFor,
): { prompt: AdaptedPrompt; relabeled: number } {
  if (!Array.isArray(prompt.buttons)) return { prompt, relabeled: 0 }
  const byId = new Map(offers.map((o) => [o.id, o]))
  let relabeled = 0
  const buttons = prompt.buttons.map((b) => {
    if (!isObj(b) || typeof b.value !== "string") return b
    const offer = byId.get(b.value)
    if (!offer || !termsLabelable(offer.terms)) return b
    const label = labelFor(offer.terms)
    if (label === b.label) return b
    relabeled++
    return { ...b, label }
  })
  return { prompt: { ...prompt, buttons }, relabeled }
}

// ---------------------------------------------------------------------------
// Camada 2 — adaptador legado (PURO)
// ---------------------------------------------------------------------------

type Mapped =
  | { type: "offer"; offer: ServerOffer; preferredId: number | null; order: unknown }
  | { type: "payment"; billing: string; preferredId: number | null; order: unknown }
  | { type: "action"; id: number; label: string; ack: boolean; order: unknown }
  | { type: "generic"; id: number; label: string; value?: string; order: unknown }

function listId(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v) : NaN
  return Number.isInteger(n) && n >= LIST_MIN && n <= LIST_MAX ? n : null
}

function numericId(v: unknown): number | null {
  if (typeof v === "number") return Number.isInteger(v) && v >= 0 ? v : null
  if (typeof v === "string" && /^\d+$/.test(v.trim())) return Number(v)
  return null
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function mapOne(
  raw: unknown,
  offers: readonly ServerOffer[],
  offerIds: ReadonlySet<string>,
  kindIn: string | null,
): Mapped | { drop: DropReason } {
  if (!isObj(raw)) return { drop: "button_shape" }
  const label = str(raw.label) || str(raw.text) || str(raw.title)
  const valueStr = typeof raw.value === "string" ? raw.value.trim() : ""
  const order = raw.order
  const valueIsPayment = !!valueStr && !!PAYMENT_TOKENS[normalizeToken(valueStr)]

  // (a) referência a OFERTA: offer_id explícito; value que é um offer_id da
  //     sessão; value com cara de offer_id (uuid); ou qualquer value não-método
  //     num prompt 'offer_choice'. Oferta que não está vigente → descartada.
  const offerRef =
    str(raw.offer_id) ||
    (valueStr &&
    (offerIds.has(valueStr) ||
      UUID_RE.test(valueStr) ||
      (kindIn === "offer_choice" && !valueIsPayment && !FIXED_ACTION_IDS.has(numericId(raw.id) ?? -1)))
      ? valueStr
      : "")
  if (offerRef) {
    const offer = offers.find((o) => o.id === offerRef)
    if (!offer) return { drop: "offer_stale" }
    return { type: "offer", offer, preferredId: listId(raw.id), order }
  }

  // (b) token de ação/método: `action` explícito, id não-numérico ("PIX",
  //     "nao_reconheco") ou value de método de pagamento.
  const idStr = typeof raw.id === "string" && !/^\d+$/.test(raw.id.trim()) ? raw.id : ""
  const tokenSrc = str(raw.action) || idStr || (valueIsPayment ? valueStr : "")
  if (tokenSrc) {
    const token = normalizeToken(tokenSrc)
    const billing = PAYMENT_TOKENS[token]
    if (billing) return { type: "payment", billing, preferredId: listId(raw.id), order }
    const act = ACTION_TOKENS[token]
    if (!act) return { drop: "action_unknown" }
    const safeLabel = label && parseBrlAmount(label) == null ? label : ACTION_DEFAULT_LABELS[act.id]
    return { type: "action", id: act.id, label: safeLabel, ack: act.ack === true, order }
  }

  // (c) rótulo com VALOR: só vale se casar exatamente com uma oferta do servidor
  //     (o valor nunca é do n8n). Vem antes do id: nas parcelas legadas o id é o
  //     nº de parcelas ("1".."N") e colidiria com Sim(1)/Não(0).
  if (label && parseBrlAmount(label) != null) {
    const m = matchOfferByLabel(label, offers)
    if (!m.ok) return { drop: m.reason }
    return { type: "offer", offer: m.offer, preferredId: null, order }
  }

  // (d) id numérico (inteiro ou string de dígitos).
  const id = numericId(raw.id)
  if (id == null) {
    // O "4. Send Msg & Update" atual faz Number("PIX") → NaN → `null` no JSON:
    // o método só sobrevive no rótulo ("Pix (à vista)", "Boleto (à vista)",
    // "Cartão (em até 6x)"). Rótulo que COMEÇA pelo método é inequívoco.
    const billing = paymentFromLabel(label)
    if (billing) return { type: "payment", billing, preferredId: null, order }
    return { drop: "id_invalid" }
  }
  if (!label) {
    if (FIXED_ACTION_IDS.has(id)) return { type: "action", id, label: ACTION_DEFAULT_LABELS[id], ack: false, order }
    return { drop: "label_missing" }
  }
  if (FIXED_ACTION_IDS.has(id)) return { type: "action", id, label, ack: false, order }
  if (id >= LIST_MIN && id <= LIST_MAX) {
    // num 'offer_choice' todo item de lista É uma oferta: sem oferta resolvida, o
    // clique cairia no ramo de parcelas sem efeito (beco sem saída) → descarta.
    if (kindIn === "offer_choice") return { drop: "offer_unresolved" }
    return { type: "generic", id, label, ...(valueStr ? { value: valueStr } : {}), order }
  }
  return { drop: "id_invalid" }
}

/**
 * PURA — adaptador legado. Converte `raw` (forma canônica OU legada) num prompt
 * canônico, descartando o que não mapeia com segurança. `null` em `prompt` quando
 * nenhum botão sobra (o chamador cai no menu determinístico). Rótulos de oferta
 * SEMPRE do servidor. Kind derivado dos botões mapeados:
 *   - há oferta           → 'offer_choice' (só ofertas + 98/99);
 *   - há método de pagto. → 'payment_method_choice' (só métodos + 98/99);
 *   - só {0,1,99} com token de reconhecimento → 'debt_acknowledgement';
 *   - só {0,1,99} com 1 e 0 → kind booleano recebido, senão 'generic_yes_no';
 *   - resto → kind recebido (se não for offer/payment), senão 'generic_choice'.
 */
export function adaptLegacyPrompt(
  raw: RawPrompt,
  offers: readonly ServerOffer[],
  labelFor: LabelFor,
): { prompt: AdaptedPrompt | null; report: ButtonsReport } {
  const kindIn = typeof raw.kind === "string" && raw.kind.trim() ? raw.kind.trim() : null
  const question = typeof raw.question === "string" ? raw.question : ""
  const list: unknown[] = Array.isArray(raw.buttons) ? raw.buttons : []
  const canonical = isCanonicalButtons(list)
  const offerIds = new Set(offers.map((o) => o.id))
  const dropped: DroppedButton[] = []
  const mapped: Array<{ index: number; m: Mapped }> = []

  list.forEach((b, index) => {
    const r = mapOne(b, offers, offerIds, kindIn)
    if ("drop" in r) dropped.push({ index, reason: r.drop })
    else mapped.push({ index, m: r })
  })

  const hasOffer = mapped.some((x) => x.m.type === "offer")
  const hasPayment = !hasOffer && mapped.some((x) => x.m.type === "payment")
  const listType = hasOffer ? "offer" : hasPayment ? "payment" : null

  // Em lista de ofertas/métodos só entram os itens do tipo + Voltar/Atendimento
  // (um 0/1/96 numa lista de ofertas cairia no ramo offer_choice do clique sem
  // efeito — beco sem saída).
  const kept: Array<{ index: number; m: Mapped }> = []
  for (const x of mapped) {
    if (listType) {
      const allowed =
        x.m.type === listType || (x.m.type === "action" && (x.m.id === BTN_BACK || x.m.id === BTN_HANDOFF))
      if (!allowed) {
        dropped.push({ index: x.index, reason: "not_allowed_in_kind" })
        continue
      }
    }
    kept.push(x)
  }

  // ids: fixos para ações; itens de lista preservam o id recebido (2..97, livre)
  // ou recebem o próximo livre a partir de 2, na ordem recebida.
  const used = new Set<number>()
  const seenOffer = new Set<string>()
  const seenBilling = new Set<string>()
  const out: Array<{ index: number; button: Button; ack: boolean }> = []
  for (const x of kept) {
    if (x.m.type === "action" || x.m.type === "generic") {
      if (used.has(x.m.id)) { dropped.push({ index: x.index, reason: "duplicate" }); continue }
      used.add(x.m.id)
      const button: Button = { id: x.m.id, label: x.m.label }
      if (x.m.type === "generic" && x.m.value) button.value = x.m.value
      out.push({ index: x.index, button, ack: x.m.type === "action" && x.m.ack })
    }
  }
  const nextFree = (preferred: number | null): number | null => {
    if (preferred != null && !used.has(preferred)) return preferred
    for (let i = LIST_MIN; i <= LIST_MAX; i++) if (!used.has(i)) return i
    return null
  }
  for (const x of kept) {
    if (x.m.type === "offer") {
      if (seenOffer.has(x.m.offer.id)) { dropped.push({ index: x.index, reason: "duplicate" }); continue }
      if (!termsLabelable(x.m.offer.terms)) { dropped.push({ index: x.index, reason: "offer_unresolved" }); continue }
      const id = nextFree(x.m.preferredId)
      if (id == null) { dropped.push({ index: x.index, reason: "id_invalid" }); continue }
      used.add(id)
      seenOffer.add(x.m.offer.id)
      out.push({ index: x.index, button: { id, label: labelFor(x.m.offer.terms), value: x.m.offer.id }, ack: false })
    } else if (x.m.type === "payment") {
      if (seenBilling.has(x.m.billing)) { dropped.push({ index: x.index, reason: "duplicate" }); continue }
      const id = nextFree(x.m.preferredId)
      if (id == null) { dropped.push({ index: x.index, reason: "id_invalid" }); continue }
      used.add(id)
      seenBilling.add(x.m.billing)
      out.push({ index: x.index, button: { id, label: PAYMENT_METHOD_LABELS[x.m.billing], value: x.m.billing }, ack: false })
    }
  }

  // Ordem de exibição: a do n8n (índice recebido), Voltar/Atendimento por último.
  // Forma canônica com `order` explícito preserva o `order` recebido.
  out.sort((a, b) => a.index - b.index)
  const tail = (id: number) => id === BTN_BACK || id === BTN_HANDOFF
  const ordered = [...out.filter((o) => !tail(o.button.id)), ...out.filter((o) => tail(o.button.id))]
  // Forma canônica: `order` só se o n8n mandou (sem ele, o sort legado por id
  // segue valendo). Forma legada: order = posição, para preservar a ordem do n8n
  // (ex.: Sim antes de Não, embora os ids sejam 1/0).
  const buttons: Button[] = ordered.map((o, i) => {
    const incoming = (list[o.index] as { order?: unknown } | undefined)?.order
    if (!canonical) return { ...o.button, order: i }
    return typeof incoming === "number" ? { ...o.button, order: incoming } : o.button
  })

  dropped.sort((a, b) => a.index - b.index)
  const ids = new Set(buttons.map((b) => b.id))
  let kindOut: string | null = null
  if (buttons.length > 0) {
    const onlyBoolean = [...ids].every((id) => id === BTN_YES || id === BTN_NO || id === BTN_HANDOFF)
    if (listType === "offer") kindOut = "offer_choice"
    else if (listType === "payment") kindOut = "payment_method_choice"
    else if (onlyBoolean && ordered.some((o) => o.ack)) kindOut = "debt_acknowledgement"
    else if (onlyBoolean && ids.has(BTN_YES) && ids.has(BTN_NO)) {
      kindOut = kindIn && BOOLEAN_KINDS.has(kindIn) ? kindIn : "generic_yes_no"
    } else if (kindIn && kindIn !== "offer_choice" && kindIn !== "payment_method_choice") kindOut = kindIn
    else kindOut = "generic_choice"
  }

  const prompt = buttons.length > 0 && kindOut ? { kind: kindOut, question, buttons } : null
  const relabeled = ordered.filter((o) => {
    const src = list[o.index]
    return o.button.value && offerIds.has(o.button.value) && isObj(src) && str(src.label) !== o.button.label
  }).length
  const adapted =
    !canonical || dropped.length > 0 || (prompt !== null && prompt.kind !== kindIn)
  return {
    prompt,
    report: {
      mode: "legacy_adapter",
      adapted,
      kind_in: kindIn,
      kind_out: prompt?.kind ?? null,
      received: list.length,
      kept: buttons.length,
      relabeled,
      dropped_buttons: dropped,
      fallback: prompt ? null : "assisted_menu",
    },
  }
}

// ---------------------------------------------------------------------------
// Envelope legado `{sessionId, output, buttons}` (antigo "4. Send Msg & Update")
// ---------------------------------------------------------------------------

/**
 * Com o adaptador ligado, converte o envelope legado (sem `action`) num
 * `chat.send` canônico ANTES do parse do corpo. `event_id` vem do header
 * x-alteapay-event-id (o fluxo antigo só o mandava lá). Flag off ou corpo que não
 * é o envelope legado → devolve o corpo intacto (o schema estrito decide: 422).
 */
export function normalizeLegacyN8nEnvelope(body: unknown, headerEventId: string | null): unknown {
  if (!legacyButtonsAdapterEnabled()) return body
  if (!isObj(body) || "action" in body) return body
  if (typeof body.sessionId !== "string" || !("output" in body || "buttons" in body)) return body
  const output = typeof body.output === "string" ? body.output : ""
  const buttons = Array.isArray(body.buttons) && body.buttons.length > 0 ? body.buttons : null
  const eventId = typeof headerEventId === "string" && headerEventId.length >= 8 && headerEventId.length <= 128
    ? headerEventId
    : null
  return {
    action: "chat.send",
    session_id: body.sessionId,
    ...(eventId ? { event_id: eventId } : {}),
    args: {
      text: output,
      ...(buttons ? { prompt: { kind: "", question: output, buttons } } : {}),
      legacy_envelope: true,
    },
  }
}

// ---------------------------------------------------------------------------
// Wrappers com I/O (chamados por lib/journey/chat-send.ts)
// ---------------------------------------------------------------------------

interface SessionRef {
  sessionId: string
  companyId: string
  customerId: string
  debtId: string
}

/** Ofertas vigentes da sessão (presented, não vencidas). Nunca lança (vazio em falha). */
export async function loadSessionServerOffers(sessionId: string): Promise<ServerOffer[]> {
  try {
    const { createServiceClient } = await import("@/lib/supabase/service")
    const { data } = await createServiceClient()
      .from("negotiation_offers")
      .select("id, terms, valid_until, status")
      .eq("session_id", sessionId)
      .eq("status", "presented")
    const now = Date.now()
    return ((data ?? []) as Array<{ id: string; terms: OfferTerms; valid_until: string | null }>)
      .filter((o) => !o.valid_until || !Number.isFinite(Date.parse(o.valid_until)) || Date.parse(o.valid_until) > now)
      .map((o) => ({ id: o.id, terms: o.terms }))
  } catch {
    return []
  }
}

async function offerLabelFn(): Promise<LabelFor> {
  const { offerButtonLabel } = await import("@/lib/journey/acknowledgement")
  return offerButtonLabel
}

export type PrepareResult =
  | { ok: true; prompt: AdaptedPrompt | null; report: ButtonsReport | null }
  | { ok: false; status: 422; code: "buttons_invalid"; message: string; report: ButtonsReport }

/**
 * Prepara `args.prompt` de chat.send/prompt.ask. Sem prompt → no-op.
 *  - flag OFF: só a camada 1 (rótulos de oferta do servidor); o prompt segue para
 *    a validação estrita inalterado no resto. `report` só quando algo mudou.
 *  - flag ON: adaptador legado. `prompt:null` = nenhum botão válido (o chamador
 *    grava só o texto e garante o menu determinístico). Sem texto utilizável para
 *    exibir (`hasText=false`) → 422 `buttons_invalid`.
 */
export async function prepareN8nPrompt(
  ctx: SessionRef,
  raw: RawPrompt | undefined,
  hasText: boolean,
): Promise<PrepareResult> {
  if (!raw) return { ok: true, prompt: null, report: null }
  const rawButtons: unknown[] = Array.isArray(raw.buttons) ? raw.buttons : []
  const adapter = legacyButtonsAdapterEnabled()
  const offers = rawButtons.length > 0 ? await loadSessionServerOffers(ctx.sessionId) : []
  const labelFor = await offerLabelFn()

  if (!adapter) {
    const base = raw as AdaptedPrompt
    const { prompt, relabeled } = relabelOfferButtons(base, offers, labelFor)
    const report: ButtonsReport | null = relabeled > 0
      ? {
          mode: "strict", adapted: false, kind_in: typeof raw.kind === "string" ? raw.kind : null,
          kind_out: typeof raw.kind === "string" ? raw.kind : null, received: rawButtons.length,
          kept: rawButtons.length, relabeled, dropped_buttons: [], fallback: null,
        }
      : null
    return { ok: true, prompt, report }
  }

  const { prompt, report } = adaptLegacyPrompt(raw, offers, labelFor)
  if (!prompt && !hasText) {
    return {
      ok: false, status: 422, code: "buttons_invalid",
      message: "nenhum botão utilizável e nenhum texto para exibir", report: { ...report, fallback: null },
    }
  }
  // Forma canônica que passou sem mudança nenhuma: sem relatório/telemetria.
  const untouched = !report.adapted && report.relabeled === 0 && report.dropped_buttons.length === 0
  return { ok: true, prompt, report: untouched ? null : report }
}

/**
 * Rede de segurança: sem prompt ATIVO na sessão, reabre o menu de 3 opções do
 * assistido (o mesmo do clique em prompt do n8n — ensureAssistedPrompt da rota
 * /api/chat/button). Com prompt ativo, ele É o menu. Devolve o id do ativo.
 * Nunca lança.
 */
export async function ensureDeterministicMenu(ctx: SessionRef): Promise<string | null> {
  try {
    const { getActivePrompt } = await import("@/lib/journey/prompts")
    const active = await getActivePrompt(ctx.sessionId)
    if (active) return active.id
    const { reopenThreeOptions, resolveSessionDebtIds } = await import("@/lib/journey/acknowledgement")
    const { debtIds, primaryDebtId } = await resolveSessionDebtIds(ctx.sessionId, ctx.debtId)
    const back = await reopenThreeOptions({
      companyId: ctx.companyId, sessionId: ctx.sessionId, customerId: ctx.customerId, debtIds, primaryDebtId,
    })
    return back.ok ? back.promptId : null
  } catch (err) {
    console.warn("[n8n-buttons] menu determinístico falhou (não-fatal):", err instanceof Error ? err.name : "")
    return null
  }
}

/** Telemetria sem PII (ids, contagens, motivos). Best-effort, nunca lança. */
export async function recordButtonsTelemetry(
  ctx: SessionRef,
  report: ButtonsReport,
  extra: { source: "chat.send" | "prompt.ask" | "legacy_envelope"; eventId?: string; promptId?: string | null; messageId?: string | null; status?: number },
): Promise<void> {
  try {
    const { recordEvent } = await import("@/lib/journey/events")
    await recordEvent({
      companyId: ctx.companyId,
      customerId: ctx.customerId,
      debtId: ctx.debtId,
      sessionId: ctx.sessionId,
      type: "chat.engine_buttons_adapted",
      actor: "n8n",
      ...(extra.eventId ? { eventId: `chat.buttons|${extra.source}|${extra.eventId}` } : {}),
      payload: {
        source: extra.source,
        mode: report.mode,
        adapted: report.adapted,
        kind_in: report.kind_in,
        kind_out: report.kind_out,
        received: report.received,
        kept: report.kept,
        relabeled: report.relabeled,
        dropped: report.dropped_buttons,
        fallback: report.fallback,
        prompt_id: extra.promptId ?? null,
        message_id: extra.messageId ?? null,
        status: extra.status ?? 200,
      },
    })
  } catch (err) {
    console.warn("[n8n-buttons] telemetria falhou (não-fatal):", err instanceof Error ? err.name : "")
  }
}
