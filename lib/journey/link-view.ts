// QA round 4 (R-10/R-20, S1) — UM LINK, UM PAINEL, UMA FILEIRA PÓS-LINK por
// cobrança, em qualquer caminho (Pagar desta aba, aceite de parcela, cobrança
// criada em outra aba/dispositivo, retomada). Lógica PURA (sem React) — o
// components/journey/chat.tsx só consome.
//
// Causa (rodada 66b): a tela tinha DUAS fontes para o mesmo link — o resultado
// local do clique (`payResult`) e a bolha persistida. A reconciliação casava só
// por `href ===`, e o painel local nunca consultava `dead_payment_links`: 2
// bolhas/2 painéis/2 fileiras quando os hrefs diferiam (aceite de parcela, outra
// aba) e "Abrir link" vivo para uma cobrança cancelada até o F5.
//
// Regras:
//  (1) o painel Abrir/Copiar deriva EXCLUSIVAMENTE da bolha persistida: só a
//      ÚLTIMA bolha de link VIVO (servidor: `live:false` / `dead_payment_links`)
//      ganha o painel (`panelMessageId`);
//  (2) o resultado local é só OTIMISTA: enquanto nenhuma bolha persistida o
//      reconcilia (por id devolvido pelo servidor, por href normalizado, ou por
//      QUALQUER bolha de link viva na tela), ele ocupa o slot do resultado com a
//      copy "gerando" — nunca um 2º painel. Só se a bolha não chegar dentro da
//      carência (`graceExpired`, falha de persistência) o painel local aparece, e
//      apenas se o href não estiver morto;
//  (3) href local morto → nada (e `clearLocal` pede ao client para zerar o
//      estado local: a cobrança foi cancelada);
//  (4) a fileira pós-link é a do PROMPT do servidor (`post_payment_link`); a
//      fileira local só existe quando não há prompt nenhum e o painel local está
//      na tela (rede de segurança) — nunca as duas.
// Sem PII.

import { isLivePaymentLink, paymentLinkActionOf, type ChatMsg } from "@/components/journey/chat-display"

/** Carência para a bolha persistida do link chegar (poll pós-POST) antes de o
 *  painel local (rede de segurança) aparecer. */
export const LINK_BUBBLE_GRACE_MS = 6000

/**
 * Normaliza um href de pagamento para comparação (nunca para exibição): host em
 * minúsculas, sem barra final, sem parâmetros `utm_*`, sem fragmento. Inválido →
 * o próprio texto aparado.
 */
export function normalizePaymentHref(href: string | null | undefined): string {
  const raw = (href ?? "").trim()
  if (!raw) return ""
  try {
    const u = new URL(raw)
    u.hash = ""
    for (const k of [...u.searchParams.keys()]) if (/^utm_/i.test(k)) u.searchParams.delete(k)
    const path = u.pathname.replace(/\/+$/, "")
    const qs = u.searchParams.toString()
    return `${u.protocol}//${u.host.toLowerCase()}${path}${qs ? `?${qs}` : ""}`
  } catch {
    return raw.replace(/\/+$/, "")
  }
}

/** true quando o href (normalizado) está entre as cobranças terminais do poll. */
export function isHrefDead(href: string | null | undefined, deadHrefs: ReadonlySet<string> | null | undefined): boolean {
  if (!href || !deadHrefs || deadHrefs.size === 0) return false
  if (deadHrefs.has(href)) return true
  const n = normalizePaymentHref(href)
  for (const d of deadHrefs) if (normalizePaymentHref(d) === n) return true
  return false
}

/** Conjunto de hrefs mortos acrescido das formas normalizadas (para os
 *  seletores que comparam por igualdade exata). */
export function withNormalizedHrefs(deadHrefs: ReadonlySet<string>): ReadonlySet<string> {
  if (deadHrefs.size === 0) return deadHrefs
  const out = new Set<string>(deadHrefs)
  for (const d of deadHrefs) out.add(normalizePaymentHref(d))
  return out
}

/** Link de uma bolha é vivo considerando também a forma normalizada do href. */
function bubbleLive(m: ChatMsg, deadHrefs: ReadonlySet<string>): boolean {
  const a = paymentLinkActionOf(m)
  if (!a || !isLivePaymentLink(a, deadHrefs)) return false
  return !isHrefDead(a.href, deadHrefs)
}

export interface LocalLinkResult {
  status: "link" | "processing" | "error"
  link: string | null
  /** id da bolha persistida devolvido pelo servidor (link_message_id). */
  linkMessageId?: string | null
}

export type LinkFallback =
  | null
  /** resultado local ainda sem bolha: copy "gerando", sem link nem botões. */
  | { mode: "generating" }
  /** carência expirada sem bolha persistida: painel local (href vivo). */
  | { mode: "panel"; href: string }

export interface LinkView {
  /** id da ÚNICA bolha persistida que ganha o painel Abrir/Copiar. */
  panelMessageId: string | null
  /** o que ocupa o slot do resultado local (nunca um 2º painel ao lado da bolha). */
  fallback: LinkFallback
  /** de onde vêm as ações pós-link (Voltar/Falar/Já paguei). */
  postLinkRow: "server" | "local" | "none"
  /** o estado local do link deve ser zerado (href morto: cobrança cancelada). */
  clearLocal: boolean
  /** há um link VIVO na tela (bolha ou painel local) — a afordância "Já paguei
   *  este valor" do pós-link só faz sentido com ele. */
  hasLiveLink: boolean
}

export function resolveLinkView(input: {
  payResult: LocalLinkResult | null
  messages: ChatMsg[]
  deadHrefs: ReadonlySet<string>
  activePromptKind: string | null
  graceExpired?: boolean
}): LinkView {
  const dead = input.deadHrefs
  let panelMessageId: string | null = null
  for (let i = input.messages.length - 1; i >= 0; i--) {
    if (bubbleLive(input.messages[i], dead)) {
      panelMessageId = input.messages[i].id
      break
    }
  }
  const serverRow = input.activePromptKind === "post_payment_link"
  const pr = input.payResult
  if (!pr || pr.status !== "link") {
    return {
      panelMessageId,
      fallback: null,
      postLinkRow: serverRow ? "server" : "none",
      clearLocal: false,
      hasLiveLink: panelMessageId !== null,
    }
  }
  const localHref = pr.link ? normalizePaymentHref(pr.link) : null
  const reconciled =
    panelMessageId !== null ||
    input.messages.some((m) => {
      const a = paymentLinkActionOf(m)
      if (!a) return false
      if (pr.linkMessageId && m.id === pr.linkMessageId) return true
      return !!localHref && normalizePaymentHref(a.href) === localHref
    })
  const localDead = !!pr.link && isHrefDead(pr.link, dead)
  if (reconciled || localDead || !pr.link) {
    return {
      panelMessageId,
      // sem link no resultado local e nada reconciliado: a copy "gerando" segura
      // o slot até o poll (nunca um painel sem href).
      fallback: !reconciled && !localDead && !pr.link ? { mode: "generating" } : null,
      postLinkRow: serverRow ? "server" : "none",
      clearLocal: localDead,
      hasLiveLink: panelMessageId !== null,
    }
  }
  if (!input.graceExpired) {
    return {
      panelMessageId,
      fallback: { mode: "generating" },
      postLinkRow: serverRow ? "server" : "none",
      clearLocal: false,
      hasLiveLink: false,
    }
  }
  return {
    panelMessageId,
    fallback: { mode: "panel", href: pr.link },
    postLinkRow: serverRow ? "server" : input.activePromptKind ? "none" : "local",
    clearLocal: false,
    hasLiveLink: true,
  }
}
