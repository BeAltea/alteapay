// QA round 2 (QAB1-H2 / QAB1-H5) — FEEDBACK DO CLIQUE no client, lógica PURA (sem
// React) para ser testada no node do vitest; components/journey/chat.tsx só
// consome.
//
// QAB1-H2: um 2º clique num prompt OBSOLETO enquanto o vencedor (outra aba, POST
// concorrente) ainda processa recebe 409 { prompt_stale, active_prompt:null } —
// o servidor ainda não criou o prompt seguinte. O client não pode ficar mudo nem
// reabilitar o mesmo menu: mostra "Já estou processando a sua escolha." e mantém o
// poll até o próximo prompt/outcome. O mesmo vale para 200 { duplicate:true }
// sem `prompt`.
//
// QAB1-H5: os atalhos do painel de pagamento (Voltar às opções / Pagar agora /
// Tentar de novo / Falar com atendimento) não tinham guarda de clique duplo — dois
// POST /api/chat/reopen. `createInFlightGuard` é a guarda: enquanto um atalho
// está em voo, os demais toques são ignorados.
//
// Sem PII.

/** Aviso humano quando o clique chegou tarde e o servidor ainda processa a escolha. */
export const PROCESSING_CHOICE_NOTICE = "Já estou processando a sua escolha."

/** Prompt no shape do GET /api/chat/messages (o que o PromptButtons renderiza). */
export interface RenderablePrompt {
  id: string
  kind: string
  question: string
  buttons: Array<{ id: number; label: string; value?: string; order?: number }>
}

/**
 * Prompt devolvido no CORPO de uma resposta (mesmo shape do GET active_prompt).
 * Só aceita o que o bloco de botões consegue renderizar: id/kind string e ≥ 1
 * botão com id numérico e rótulo. Qualquer outra coisa → null.
 */
export function toRenderablePrompt(raw: unknown): RenderablePrompt | null {
  if (!raw || typeof raw !== "object") return null
  const p = raw as Record<string, unknown>
  if (typeof p.id !== "string" || !p.id || typeof p.kind !== "string") return null
  if (!Array.isArray(p.buttons) || p.buttons.length === 0) return null
  const buttons = p.buttons.filter(
    (b): b is RenderablePrompt["buttons"][number] =>
      !!b &&
      typeof b === "object" &&
      typeof (b as { id?: unknown }).id === "number" &&
      typeof (b as { label?: unknown }).label === "string",
  )
  if (buttons.length === 0) return null
  return { id: p.id, kind: p.kind, question: typeof p.question === "string" ? p.question : "", buttons }
}

export type StaleClickFeedback = "rehydrate" | "processing"

/**
 * Decide o feedback de um clique que o servidor recusou como OBSOLETO (409
 * prompt_stale/prompt_not_active) ou absorveu como DUPLICADO (200 duplicate):
 *  - o corpo traz um prompt renderizável (`active_prompt` ou `prompt`) →
 *    'rehydrate' (aviso "Esta opção já foi atualizada…" + o prompt ativo);
 *  - sem prompt (o vencedor ainda processa) → 'processing' ("Já estou
 *    processando a sua escolha." + poll até o próximo prompt/outcome). Nunca mudo.
 */
export function staleClickFeedback(
  data: { active_prompt?: unknown; prompt?: unknown } | null | undefined,
): StaleClickFeedback {
  if (!data) return "processing"
  const p = toRenderablePrompt(data.active_prompt) ?? toRenderablePrompt(data.prompt)
  return p ? "rehydrate" : "processing"
}

/** Guarda de clique duplo para ações assíncronas: só uma em voo por vez. */
export interface InFlightGuard {
  /** true enquanto uma ação está em voo. */
  readonly busy: boolean
  /** Executa `fn` se nada está em voo; senão ignora (devolve undefined). Libera
   *  sempre (também em exceção). */
  run<T>(fn: () => Promise<T>): Promise<T | undefined>
}

export function createInFlightGuard(): InFlightGuard {
  let busy = false
  return {
    get busy() {
      return busy
    },
    async run<T>(fn: () => Promise<T>): Promise<T | undefined> {
      if (busy) return undefined
      busy = true
      try {
        return await fn()
      } finally {
        busy = false
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Correção B8 (A-1) — `200 { ignored:'double_tap', prompt }`: o servidor NÃO
// respondeu o prompt clicado (toque múltiplo). O client não o marca como
// consumido, o bloco de botões NÃO fica "respondido" (reabilita, mesmo quando o
// prompt ativo devolvido tem o mesmo id e o componente não remonta) e um aviso
// curto explica o toque. Nunca uma tela sem próximo passo (D36).

/** O clique consumiu o prompt no servidor? (200 efetivo ou 409 obsoleto). */
export function shouldConsumeClickedPrompt(
  httpOk: boolean,
  status: number,
  data: { ignored?: unknown } | null | undefined,
): boolean {
  if (status === 409) return true
  return httpOk && data?.ignored !== "double_tap"
}

/** Resultado do clique devolvido ao bloco de botões quando o servidor o ignorou. */
export const IGNORED_CLICK_RESULT = { ok: false as const, code: "ignored" as const }
