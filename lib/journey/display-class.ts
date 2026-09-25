// D2 — CLASSES DE EXIBIÇÃO (§10.1 / C4). Função PURA que deriva a classe de
// apresentação de cada linha de chat_messages a partir de sinais que a própria
// linha JÁ carrega (role, button_id, engine, offers_snapshot, prompt_id). Sem
// coluna nova obrigatória: `classifyMessage(msg)` é a fonte única da verdade e
// roda tanto no servidor (cache best-effort) quanto no client (poda §10.1).
//
// Por que derivada e não coluna: zero backfill — o histórico VMAX já gravado é
// classificado de graça; a classe é sempre coerente com os sinais canônicos (não
// há divergência entre uma coluna estática e o dado real). A coluna
// chat_messages.display_class (migration 20260936) é ADITIVA/OPCIONAL — cache de
// telemetria do painel, preenchida best-effort na escrita nova, NUNCA lida como
// autoridade (null cai nesta função).
//
// As 7 classes (§10.1):
//   pinned      — card fixo (valor/cedente). NÃO é linha de chat_messages; a
//                 classe existe só para completude do domínio (o card vem do GET
//                 num campo próprio pinned_debt, não do fluxo de mensagens).
//   decision    — a ESCOLHA do devedor (bolha role='customer' com button_id):
//                 "Quero pagar — R$ 250,00", "3x de R$ 90,00", "Consultar dívida".
//                 Memória da escolha; sempre visível (C8).
//   outcome     — RESULTADO: link de pagamento/acordo (bolha com action ou marca
//                 de link), "já paguei", resultado de reconhecimento. Sempre
//                 visível e destacado; NUNCA some (C8).
//   guidance    — texto do assistente que conduz (saudação, pergunta de menu,
//                 "vou buscar as condições", dados da dívida). Repetições colapsam.
//   ephemeral   — indicadores de espera/consulta/geração de link. São CLIENT-ONLY
//                 (nunca persistidos): a classe é atribuída no client, não aqui.
//                 Uma linha persistida NUNCA é ephemeral (garantia C6 no reload).
//   superseded  — pergunta de menu cujo prompt já foi substituído/respondido
//                 (o prompt ativo é filtrado no render; as bolhas-pergunta antigas
//                 colapsam). Deriva da relação com o prompt ativo (parâmetro).
//   system      — item técnico que NUNCA renderiza: msg engine='n8n' em estado
//                 absorvente, role='system', códigos de erro internos.

import { isAbsorbingForEngineMsg, type WaitState } from "./wait-machine"

export type DisplayClass =
  | "pinned"
  | "decision"
  | "outcome"
  | "guidance"
  | "ephemeral"
  | "superseded"
  | "system"

/** As 7 classes do domínio §10.1 (para validação/telemetria). */
export const DISPLAY_CLASSES: readonly DisplayClass[] = [
  "pinned",
  "decision",
  "outcome",
  "guidance",
  "ephemeral",
  "superseded",
  "system",
] as const

/** Sinais canônicos que a linha de chat_messages JÁ carrega (sem PII). */
export interface ClassifiableMessage {
  role: string | null // 'customer' | 'assistant' | 'system'
  buttonId?: number | null
  engine?: string | null // 'platform' | 'n8n' | null
  /** true quando a bolha carrega um botão-link externo (offers_snapshot.message_action)
   *  OU quando a rota já resolveu uma action para o client. Marca de outcome. */
  hasAction?: boolean
  /** prompt_id da bolha (quando é a pergunta de um prompt). */
  promptId?: string | null
  /** texto (usado só para reconhecer o link de pagamento persistido como texto). */
  text?: string | null
}

/** Contexto opcional da classificação (sem ele, cai em heurística por sinais). */
export interface ClassifyContext {
  /** id do prompt ATIVO da sessão — bolha-pergunta com este prompt_id é a viva
   *  (não superseded); as demais bolhas-pergunta são superseded. */
  activePromptId?: string | null
  /** estado de espera corrente — decide se uma msg engine='n8n' é system (estado
   *  absorvente: link entregue/quitada/não reconhecida) ou guidance. */
  waitState?: WaitState | null
}

/** Reconhece uma URL http(s) "crua" no texto — a bolha do link de pagamento é
 *  PERSISTIDA como texto (a URL numa linha) para sobreviver ao reload. Isso a
 *  torna um outcome (link sempre visível, C8), mesmo sem action anexada. */
function carriesPaymentLink(text: string | null | undefined): boolean {
  return typeof text === "string" && /https?:\/\/\S+/i.test(text)
}

/**
 * Classe de exibição de UMA linha de chat_messages (§10.1). Determinística e sem
 * efeitos: mesma entrada → mesma classe. É a unidade sobre a qual todas as regras
 * de poda operam (R-10). Ordem das regras = precedência do domínio:
 *   1) role='system'            → system (nunca renderiza)
 *   2) engine='n8n' absorvente  → system (resposta tardia do motor, M12)
 *   3) role='customer'          → decision (a escolha; button_id opcional)
 *   4) assistant + action/link  → outcome (link de pagamento/acordo, contato)
 *   5) assistant pergunta de prompt NÃO-ativo → superseded (menu substituído)
 *   6) demais assistant         → guidance
 * `ephemeral` NÃO sai daqui: efêmeros são client-only e recebem a classe no
 * client (uma linha PERSISTIDA nunca é ephemeral — garantia C6 no reload).
 */
export function classifyMessage(
  msg: ClassifiableMessage,
  ctx: ClassifyContext = {},
): DisplayClass {
  const role = (msg.role ?? "").toLowerCase()

  // 1) system explícito (role='system'): item técnico, nunca renderiza.
  if (role === "system") return "system"

  // 2) resposta do motor (engine='n8n') em ESTADO ABSORVENTE (link entregue,
  //    quitada, não reconhecida): descartada (M12) → system. Fora do estado
  //    absorvente, uma msg n8n renderizável é guidance (ou outcome se trouxer
  //    link/action, tratado abaixo).
  const isEngineMsg = role !== "customer" && msg.engine === "n8n"
  if (isEngineMsg && ctx.waitState && isAbsorbingForEngineMsg(ctx.waitState)) {
    return "system"
  }

  // 3) escolha do devedor: bolha role='customer'. É a DECISION (memória da
  //    escolha, sempre visível). O button_id é opcional (o eco do clique sempre
  //    tem, mas uma eventual msg livre do cliente também conta como decisão).
  if (role === "customer") return "decision"

  // A partir daqui: assistant (ou engine fora de estado absorvente).

  // 4) OUTCOME: bolha com botão-link externo anexado (action) OU com um link de
  //    pagamento/acordo embutido no texto (persistido para sobreviver ao reload).
  //    Sempre visível/destacado; NUNCA some (C8).
  if (msg.hasAction === true) return "outcome"
  if (carriesPaymentLink(msg.text)) return "outcome"

  // 5) SUPERSEDED: bolha-pergunta de um prompt que NÃO é mais o ativo. A pergunta
  //    do prompt vivo aparece no bloco de botões (filtrada do log); as perguntas
  //    de menus anteriores (bootstrap, pós-consult, offer_choice, "voltar") viram
  //    superseded e colapsam — não empilham (C5). Só quando a bolha tem promptId:
  //    sem promptId ela é uma guidance comum.
  if (msg.promptId) {
    const active = ctx.activePromptId ?? null
    if (active === null || msg.promptId !== active) return "superseded"
    // promptId === activePromptId → é a pergunta viva; no render ela é filtrada
    // (mostrada no bloco de botões). Classificamos como guidance (a pergunta é
    // conteúdo do assistente); a filtragem do prompt ativo é feita no render.
    return "guidance"
  }

  // 6) demais assistant: guidance (conduz a decisão; repetições colapsam).
  return "guidance"
}

/** true se a classe NUNCA pode ser podada/escondida (C8: decision + outcome). */
export function isProtectedClass(cls: DisplayClass): boolean {
  return cls === "decision" || cls === "outcome"
}

/** true se a classe NÃO deve ser renderizada no client (system).
 *  ephemeral também não vem do servidor, mas é tratado no client. */
export function isNonRenderableClass(cls: DisplayClass): boolean {
  return cls === "system"
}
