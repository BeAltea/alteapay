import type { NextRequest } from "next/server"
import { GET as canonicalGET, POST as canonicalPOST } from "@/app/api/asaas/webhook/payments/route"

/**
 * @deprecated Rota legada do webhook ASAAS. Delega INTEGRALMENTE à rota canônica
 * `POST /api/asaas/webhook/payments` (mesmo token `asaas-access-token`, mesmo
 * dedup em asaas_webhook_events, mesmo portão de quitação F8-01, mesma regra de
 * parcelas e mesma jornada).
 *
 * Por que delegar (2026-09-28):
 * - Não está em uso: `GET /v3/webhooks` da conta ASAAS de produção lista só
 *   `https://alteapay.com/api/asaas/webhook/payments` para o AlteaPay; e a rota
 *   legada não conseguia sequer gravar em asaas_webhook_events (chamava `.catch`
 *   no builder do supabase-js, que não o tem → TypeError → 500 em todo evento
 *   novo), então nenhum dos 8.145 eventos da tabela veio dela.
 * - Ainda assim, uma cópia paralela da lógica de pagamento sem o portão de
 *   quitação é um risco (quitação refeita, status regredindo, notificação
 *   duplicada) se alguém a reconfigurar a partir da documentação antiga.
 *   Delegar remove a divergência sem perder eventos (um 410 faria o ASAAS
 *   pausar a fila e descartar pagamentos).
 */
export async function POST(request: NextRequest) {
  console.warn("[ASAAS Webhook legacy] /api/webhooks/asaas chamada; delegando a /api/asaas/webhook/payments")
  return canonicalPOST(request)
}

export async function GET(request: NextRequest) {
  return canonicalGET(request)
}
