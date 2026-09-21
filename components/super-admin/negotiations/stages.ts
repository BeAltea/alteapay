// Configuração compartilhada de estágios da página de negociações (T5).
//
// PURO (sem React, sem banco): importado pelo route.ts (server), pelas páginas
// e pelos testes. A ordem/rank espelha a projeção de T1 (lib/journey/negotiation-state),
// mas mantemos uma tabela LOCAL rotulada em pt-BR para exibição sem treino
// (critério vn-operacao). Não importamos STAGE_RANK aqui para não acoplar a
// build de UI ao módulo de banco de T1 — os ranks são um espelho verificado
// por teste contra o contrato do relatório T1_dados.md (Apêndice A).

export type ContactProfile = "mobile" | "email_only" | "both" | "none"

/** Grupos de estágio (colunas de contadores no topo, em ordem do funil). */
export interface StageMeta {
  stage: string
  rank: number
  label: string
  /** Tom do badge (tailwind classes neutras — sem depender de design system externo). */
  tone: "neutral" | "muted" | "info" | "warn" | "danger" | "success"
}

// Espelho do Apêndice A (T1_dados.md §4). Rótulos pt-BR compreensíveis sem treino.
export const STAGE_META: StageMeta[] = [
  { stage: "not_started", rank: 0, label: "Não iniciado", tone: "muted" },
  { stage: "no_contact", rank: 1, label: "Sem contato", tone: "muted" },
  { stage: "opted_out", rank: 5, label: "Opt-out", tone: "danger" },
  { stage: "blocked", rank: 5, label: "Bloqueado", tone: "danger" },
  { stage: "queued", rank: 10, label: "Na fila", tone: "neutral" },
  { stage: "dispatched", rank: 20, label: "Enviado", tone: "info" },
  { stage: "delivered", rank: 30, label: "Entregue", tone: "info" },
  { stage: "read", rank: 35, label: "Lido", tone: "info" },
  { stage: "link_opened", rank: 40, label: "Link aberto", tone: "info" },
  { stage: "dispute", rank: 45, label: "Contestação", tone: "warn" },
  { stage: "human_handoff", rank: 45, label: "Atend. humano", tone: "warn" },
  { stage: "authenticated", rank: 50, label: "Autenticado", tone: "info" },
  { stage: "chat_idle", rank: 55, label: "Chat inativo", tone: "muted" },
  { stage: "in_chat", rank: 60, label: "Em conversa", tone: "info" },
  { stage: "not_recognized", rank: 64, label: "Não reconhece", tone: "warn" },
  { stage: "acknowledged", rank: 65, label: "Reconheceu", tone: "success" },
  { stage: "offer_presented", rank: 70, label: "Oferta apresentada", tone: "success" },
  { stage: "charge_cancelled", rank: 75, label: "Cobrança cancelada", tone: "warn" },
  { stage: "charge_generated", rank: 80, label: "Cobrança gerada", tone: "success" },
  { stage: "overdue", rank: 85, label: "Em atraso", tone: "danger" },
  { stage: "paid", rank: 100, label: "Pago", tone: "success" },
]

const STAGE_BY_KEY = new Map(STAGE_META.map((m) => [m.stage, m]))

export function stageMeta(stage: string | null | undefined): StageMeta {
  const found = stage ? STAGE_BY_KEY.get(stage) : undefined
  return (
    found ?? {
      stage: stage ?? "not_started",
      rank: 0,
      label: stage ?? "—",
      tone: "muted",
    }
  )
}

export function stageLabel(stage: string | null | undefined): string {
  return stageMeta(stage).label
}

/** Ordem canônica dos estágios (ranks crescentes) para exibir contadores. */
export const STAGE_ORDER: string[] = STAGE_META.map((m) => m.stage)

// ------------------------------------------------------------------
// Perfil de contato — rótulos + ícone (lucide) por perfil
// ------------------------------------------------------------------
export const CONTACT_PROFILE_META: Record<
  ContactProfile,
  { label: string; icon: "smartphone" | "mail" | "contact" | "ban" }
> = {
  mobile: { label: "Celular", icon: "smartphone" },
  email_only: { label: "Só e-mail", icon: "mail" },
  both: { label: "Celular + e-mail", icon: "contact" },
  none: { label: "Sem contato", icon: "ban" },
}

export const CONTACT_PROFILES: ContactProfile[] = ["mobile", "email_only", "both", "none"]

// ------------------------------------------------------------------
// Contadores por estágio — fechamento (total = soma). Puro e testável.
// ------------------------------------------------------------------
export interface StageCount {
  stage: string
  label: string
  count: number
}

/**
 * Constrói os contadores por estágio a partir de um agregado
 * { stage -> count } vindo do servidor. Sempre em STAGE_ORDER; inclui apenas
 * estágios presentes (>0), preservando a ordem do funil.
 */
export function buildStageCounts(byStage: Record<string, number>): StageCount[] {
  const out: StageCount[] = []
  for (const meta of STAGE_META) {
    const c = byStage[meta.stage] ?? 0
    if (c > 0) out.push({ stage: meta.stage, label: meta.label, count: c })
  }
  // estágios fora do mapa (defensivo): aparecem ao final com o próprio nome
  for (const [stage, c] of Object.entries(byStage)) {
    if (!STAGE_BY_KEY.has(stage) && c > 0) {
      out.push({ stage, label: stage, count: c })
    }
  }
  return out
}

/** Soma dos contadores por estágio. Deve fechar com o total de linhas. */
export function sumStageCounts(counts: StageCount[]): number {
  return counts.reduce((s, c) => s + c.count, 0)
}

/**
 * Verificação de fechamento: a soma dos contadores por estágio é IGUAL ao total
 * de devedores filtrados. Retornada ao cliente para exibir o "assert" visível e
 * exercida diretamente em teste (critério §5 do T5).
 */
export function countersReconcile(byStage: Record<string, number>, total: number): boolean {
  const sum = Object.values(byStage).reduce((s, c) => s + c, 0)
  return sum === total
}
