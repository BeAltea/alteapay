// D2/A3 — RETOMADA (§2.2 / C7 / R-17 / R-42). Montado no SERVIDOR (sobrevive a
// reload) por função pura a partir de sinais PRESERVADOS em chat_messages/
// chat_prompts — NÃO de journey_events (append-only, opaco, C2/D44). Ao retomar,
// o chat abre com card + UMA saudação de retorno + (último outcome) + menu; o
// histórico anterior fica atrás de "Ver conversa completa" (client, chat-display).
//
// A3: o texto do recap É a saudação de retorno (Apêndice B): "Olá de novo,
// {primeiro_nome}. Você já viu os detalhes do valor em aberto. Como prefere
// seguir?" — uma só saudação na tela (N4/N-D5-6): a saudação original (bolha
// stage=greeting) fica recolhida na retomada. A copy final é da A4; a estrutura
// (estado retomável + label real + primeiro nome) é daqui.
//
// O recap é entregue pelo GET /api/chat/messages num campo `recap` (só no 1º poll,
// quando `since` está ausente = carregamento inicial/retomada). A UI renderiza um
// bloco ACIMA do log quando recap != null. Best-effort: se falhar, recap=null e o
// chat funciona normalmente (degradação graciosa).

import { createServiceClient } from "@/lib/supabase/service"
import { firstNameOf } from "./acknowledgement"

/** Estado retomável que escolhe o template do recap. */
export type RecapState =
  | "after_link" // link de pagamento/acordo entregue
  | "after_negotiate" // escolheu negociar (viu/escolheu parcelas)
  | "after_payment_claim" // avisou que já pagou
  | "after_not_recognized" // não reconheceu a dívida
  | "after_decision" // tomou uma decisão genérica (fallback com label)

export interface Recap {
  state: RecapState
  /** saudação de retorno (Apêndice B), carta de voz, para renderizar acima do log. Sem PII além do primeiro nome. */
  text: string
  /** label real do último clique de decisão (R-42), quando houver. */
  lastDecisionLabel: string | null
  /** primeiro nome do cliente (vazio → null); a copy cai no genérico "Olá de novo." */
  firstName: string | null
}

/** Saudação de retorno (Apêndice B). Sem valor (o card já mostra), sem emoji. */
export function returnGreeting(firstName: string | null | undefined): string {
  const name = (firstName ?? "").trim()
  return `Olá de novo${name ? `, ${name}` : ""}. Você já viu os detalhes do valor em aberto. Como prefere seguir?`
}

/** Reconhece uma URL http(s) crua (a bolha do link é persistida como texto). */
function hasPaymentLink(text: string | null | undefined): boolean {
  return typeof text === "string" && /https?:\/\/\S+/i.test(text)
}

/**
 * Reconhece a bolha PRESERVADA de "Já paguei" (paymentClaimReply em actions.ts —
 * A4/S18: "Obrigado por avisar. Vamos conferir o pagamento…"; histórico anterior:
 * "Registramos que você já pagou este valor…"). O payment_claim NÃO seta
 * wait_state (handlePaymentClaim só registra o caso e persiste esta bolha), então
 * o recap detecta o desfecho pelo TEXTO preservado (a mesma fonte canônica de
 * C7/R-42: chat_messages), sem depender de uma coluna de estado nem tocar
 * journey_events. Casa a âncora estável de CADA geração da frase, não a copy
 * inteira (bolhas já gravadas continuam reconhecidas).
 */
function hasPaymentClaim(text: string | null | undefined): boolean {
  return (
    typeof text === "string" &&
    /vamos conferir o pagamento|registramos que você já pagou/i.test(text)
  )
}

/**
 * Monta o recap da sessão a partir dos sinais PRESERVADOS (thread corrente):
 *   - última DECISION: bolha role='customer' com button_id (o label real clicado);
 *   - último OUTCOME: link de pagamento/acordo, "já paguei", "não reconheço",
 *     derivado do wait_state da sessão e das bolhas com link;
 *   - estado da sessão (wait_state) para escolher o template;
 *   - primeiro nome do cliente (A3): `opts.firstName` quando o chamador já o tem;
 *     senão lê customers.name pela sessão (uma leitura, só na retomada).
 *
 * Retorna null quando NÃO há o que recapitular — pós-login SEM decisão ainda (a UI
 * mostra o menu normalmente, sem recap). NUNCA lança: erro → null (o poll segue).
 *
 * `threadEpoch` filtra a thread corrente (C3): o recap reflete a conversa ATUAL,
 * não épocas arquivadas (que o painel/reconstrução leem à parte).
 */
export async function buildRecap(
  sessionId: string,
  companyId: string,
  opts: { firstName?: string | null } = {},
): Promise<Recap | null> {
  try {
    const supabase = createServiceClient()

    // estado da sessão (wait_state) + época corrente + cliente (primeiro nome).
    const { data: session } = await supabase
      .from("negotiation_sessions")
      .select("wait_state, thread_epoch, customer_id")
      .eq("id", sessionId)
      .eq("company_id", companyId)
      .maybeSingle()
    const sess = session as { wait_state?: string | null; thread_epoch?: number | null; customer_id?: string | null } | null
    const waitState = sess?.wait_state ?? null
    const epoch = Number(sess?.thread_epoch ?? 0)

    // mensagens da THREAD CORRENTE (época atual OU null = época 0, compat). Ordena
    // DESCENDING e limita a 200 para que a fatia contenha as mais RECENTES (a
    // decisão/outcome corrente); numa sessão com muitas épocas arquivadas, as 200
    // MAIS ANTIGAS poderiam não conter a thread atual. Re-ordena ascending em
    // memória para a varredura cronológica. Filtro de época na query quando
    // epoch>0 (defensivo: coluna ausente derruba o SELECT → cai no fallback sem
    // filtro; para epoch 0 o filtro em memória já basta e é no-op).
    let query = supabase
      .from("chat_messages")
      .select("role, text, button_id, offers_snapshot, thread_epoch, created_at")
      .eq("session_id", sessionId)
      .eq("company_id", companyId)
      .order("created_at", { ascending: false })
      .limit(200)
    if (epoch > 0) query = query.eq("thread_epoch", epoch)
    let { data: rawMessages, error: msgErr } = await query
    if (msgErr && epoch > 0) {
      // coluna thread_epoch pode não existir em prod (20260935 pendente) → refaz
      // sem o filtro de época e cai no filtro em memória (compat total).
      const fb = await supabase
        .from("chat_messages")
        .select("role, text, button_id, offers_snapshot, thread_epoch, created_at")
        .eq("session_id", sessionId)
        .eq("company_id", companyId)
        .order("created_at", { ascending: false })
        .limit(200)
      rawMessages = fb.data
    }
    const messages = (rawMessages ?? [])
      .filter((m) => {
        const e = (m as { thread_epoch?: number | null }).thread_epoch
        return e == null ? epoch === 0 : Number(e) === epoch
      })
      .reverse() // volta à ordem cronológica ascending

    if (messages.length === 0) return null

    // último clique de decisão (role='customer' com button_id) → label real (R-42).
    let lastDecisionLabel: string | null = null
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i] as { role?: string | null; text?: string | null; button_id?: number | null }
      if (m.role === "customer" && m.button_id != null) {
        lastDecisionLabel = (m.text ?? "").trim() || null
        break
      }
    }

    // sem NENHUMA decisão ainda (pós-login puro) → sem recap: a UI mostra o menu.
    if (!lastDecisionLabel) return null

    // há um link de pagamento/acordo entregue nesta thread? (bolha assistant com
    // URL crua OU com botão-link em offers_snapshot.message_action).
    const hasLink = messages.some((m) => {
      const row = m as { role?: string | null; text?: string | null; offers_snapshot?: unknown }
      if (row.role === "customer") return false
      if (hasPaymentLink(row.text)) return true
      const snap = row.offers_snapshot as { message_action?: unknown } | null
      return !!(snap && typeof snap === "object" && snap.message_action)
    })

    // avisou que já pagou nesta thread? (bolha PRESERVADA do paymentClaimReply — o
    // payment_claim não seta wait_state, então o sinal é o texto persistido). Tem
    // precedência sobre o link no template: quem clicou "Já paguei" quer o recap da
    // conferência, não "seu link está aqui".
    const claimed = messages.some((m) => {
      const row = m as { role?: string | null; text?: string | null }
      return row.role !== "customer" && hasPaymentClaim(row.text)
    })

    // primeiro nome (A3): do chamador ou de customers.name (só aqui, na retomada).
    let firstName: string | null = opts.firstName ?? null
    if (opts.firstName === undefined && sess?.customer_id) {
      const { data: customer } = await supabase
        .from("customers")
        .select("name")
        .eq("id", sess.customer_id)
        .eq("company_id", companyId)
        .maybeSingle()
      firstName = firstNameOf((customer as { name?: string | null } | null)?.name) || null
    }

    // escolhe o estado retomável a partir de wait_state + sinais das bolhas.
    const state = resolveRecapState(waitState, hasLink, claimed)
    return { state, text: recapText(state, lastDecisionLabel, firstName), lastDecisionLabel, firstName }
  } catch (err) {
    console.warn("[journey] buildRecap (não-fatal):", (err as Error).message)
    return null
  }
}

/**
 * Escolhe o estado retomável (template) a partir do wait_state e dos sinais das
 * bolhas preservadas. `claimed` (payment_claim detectado pelo texto) tem
 * precedência sobre o link — quem avisou que já pagou deve retomar no recap de
 * conferência, não no "seu link está aqui". `nao_reconhecida` continua no topo.
 */
export function resolveRecapState(
  waitState: string | null,
  hasLink: boolean,
  claimed = false,
): RecapState {
  if (waitState === "nao_reconhecida") return "after_not_recognized"
  if (claimed) return "after_payment_claim"
  if (waitState === "link_entregue" || hasLink) return "after_link"
  if (waitState === "aguardando_motor" || waitState === "menu_degradado") return "after_negotiate"
  return "after_decision"
}

/**
 * A4/S6 (Apêndice B "Saudação de retorno") — a frase do bloco de retomada é a
 * saudação de retorno, ÚNICA para todos os estados: "Olá de novo, {primeiro_nome}.
 * Você já viu os detalhes do valor em aberto. Como prefere seguir?". O que a
 * última escolha produziu (link/acordo/"já paguei") NÃO é narrado aqui: o outcome
 * preservado é exibido acima do menu (§2.2 — mecanismo da A3), e o valor mora no
 * card fixo. `state`/`decisionLabel` seguem na assinatura (o Recap os expõe para
 * a UI/A3). `firstName` ausente/vazio → "Olá de novo." (nunca "Olá de novo, .").
 * Sem PII. Mecanismo (nome lido em buildRecap) é da A3; copy é da A4.
 */
export function recapText(
  _state: RecapState,
  _decisionLabel: string | null,
  firstName?: string | null,
): string {
  // A3: a frase mora em returnGreeting (fonte única, também usada por buildRecap).
  return returnGreeting(firstName)
}
