"use client"

// D2 — CARD FIXO do débito (§10.1 pinned / C1 / R-11). Componente PRÓPRIO,
// renderizado FIXO no topo do chat, FORA do fluxo de mensagens (fora do div
// role=log): NÃO é linha de chat_messages, aparece 1x. Alimentado pelo bloco
// `pinned_debt` que o GET /api/chat/messages devolve (montado no servidor por
// buildAckContext — mesma fonte canônica do resumo).
//
// ESTRUTURA é de D2; o ESTILO (mobile 360, valor em destaque, hierarquia) é de D3
// (className/tokens). Aqui deixo a marcação semântica e o layout mínimo; D3 refina.

/** Shape espelhado de lib/journey/pinned-debt.ts:PinnedDebt (valores em reais). */
export interface PinnedDebtData {
  creditor_name: string
  updated_value: number
  oldest_due_date: string | null
  invoice_count: number
}

/** Formata reais no MESMO padrão do buildAckContext (R$ 250,00). */
function formatBRL(value: number): string {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(
    Number.isFinite(value) ? value : 0,
  )
}

/** dd/mm/aaaa a partir de ISO/date; vazio → "". */
function formatDue(iso: string | null): string {
  if (!iso) return ""
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  if (m) return `${m[3]}/${m[2]}/${m[1]}`
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("pt-BR")
}

/**
 * Card fixo do débito. Renderiza null quando não há dado (o pinned não veio do
 * servidor — degradação graciosa; o chat funciona sem o card). Semântica: um bloco
 * de resumo (não um alerta/erro); o valor é o dado em destaque; o cedente é
 * identificado. Sem PII.
 */
export function DebtCard({ debt }: { debt: PinnedDebtData | null }) {
  if (!debt) return null
  const due = formatDue(debt.oldest_due_date)
  const multi = debt.invoice_count > 1
  return (
    <section
      aria-label="Resumo da dívida"
      className="rounded-lg border border-neutral-200 bg-white px-4 py-3 shadow-sm"
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-xs font-medium text-neutral-500">{debt.creditor_name}</span>
        {due ? (
          <span className="shrink-0 text-xs text-neutral-500">venc. {due}</span>
        ) : null}
      </div>
      <div className="mt-0.5 text-2xl font-bold text-neutral-900">{formatBRL(debt.updated_value)}</div>
      {multi ? (
        <div className="mt-0.5 text-xs text-neutral-500">{debt.invoice_count} faturas</div>
      ) : null}
    </section>
  )
}
