// D2 — CARD FIXO do débito (§10.1 pinned / C1 / R-11). Bloco montado no SERVIDOR e
// entregue pelo GET /api/chat/messages num campo `pinned_debt`. NÃO é linha de
// chat_messages: é o ESTADO da tela (valor/cedente), renderizado FIXO no topo do
// chat, aparece 1x, imutável entre polls e sobrevive a reload (vem do servidor a
// cada poll). Alimentado por buildAckContext — a MESMA fonte canônica do resumo
// (D3 ALTO exige valor do card = valor cobrado).
//
// Consequência (R-12): o valor DEIXA de aparecer em guidance/perguntas de menu;
// mora só no card (pinned) e nos outcomes. A reescrita das strings (threeOptions
// Summary sem número etc.) é de D3.
//
// Best-effort: se qualquer leitura falhar, devolve null e o card simplesmente não
// renderiza (degradação graciosa — nunca derruba o poll). Sem PII (nada de
// documento): só credor, valor, vencimento, nº de faturas.

import { createServiceClient } from "@/lib/supabase/service"
import { buildAckContext } from "./acknowledgement"

export interface PinnedDebt {
  creditor_name: string
  updated_value: number // reais (a UI formata)
  oldest_due_date: string | null
  invoice_count: number
}

/**
 * Monta o card fixo da sessão. Resolve os debt_ids/customer da sessão e reusa
 * buildAckContext (soma de todas as dívidas, credor do branding). Retorna null
 * quando não há dívida associada (nada a fixar) ou em qualquer falha. NUNCA lança.
 */
export async function buildPinnedDebt(
  sessionId: string,
  companyId: string,
): Promise<PinnedDebt | null> {
  try {
    const supabase = createServiceClient()
    const { data: session } = await supabase
      .from("negotiation_sessions")
      .select("customer_id, debt_id, debt_ids, primary_debt_id")
      .eq("id", sessionId)
      .eq("company_id", companyId)
      .maybeSingle()
    if (!session) return null

    const s = session as {
      customer_id?: string | null
      debt_id?: string | null
      debt_ids?: string[] | null
      primary_debt_id?: string | null
    }
    const customerId = s.customer_id
    if (!customerId) return null

    // debt_ids consolida o valor (buildAckContext soma todos). Fallback: primary/
    // debt_id da sessão. Sem nenhum id → nada a fixar.
    const rawIds = Array.isArray(s.debt_ids) ? s.debt_ids.filter(Boolean) : []
    const fallback = s.primary_debt_id ?? s.debt_id ?? null
    const debtIds = rawIds.length > 0 ? rawIds : fallback ? [fallback] : []
    if (debtIds.length === 0) return null

    const ctx = await buildAckContext({ companyId, customerId, debtIds })
    return {
      creditor_name: ctx.creditorName,
      updated_value: ctx.updatedValue,
      oldest_due_date: ctx.oldestDueDate,
      invoice_count: ctx.invoiceCount,
    }
  } catch (err) {
    console.warn("[journey] buildPinnedDebt (não-fatal):", (err as Error).message)
    return null
  }
}
