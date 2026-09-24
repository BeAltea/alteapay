// POST /api/dev/n8n-stub (N3.5) — fluxo n8n FALSO para laboratório/E2E.
// Só existe fora de produção OU com MOCK_ALL_INTEGRATIONS=1 (senão 404).
// Recebe o payload chat.turn que a plataforma envia a N8N_CHAT_FLOW_URL,
// VERIFICA a assinatura HMAC do NOSSO lado (mesmo esquema do webhook inbound) e
// devolve uma resposta determinística no contrato do engine (Apêndice A.2).
//
// Uso: NEGOTIATION_ENGINE=n8n + N8N_CHAT_FLOW_URL=<origin>/api/dev/n8n-stub.
import { NextResponse } from "next/server"
import {
  N8N_SIGNATURE_HEADER,
  N8N_TIMESTAMP_HEADER,
  verifyN8nRequest,
} from "@/lib/negotiation/n8n"

export const dynamic = "force-dynamic"

function devAllowed(): boolean {
  return process.env.NODE_ENV !== "production" || process.env.MOCK_ALL_INTEGRATIONS === "1"
}

interface TurnPayload {
  message?: string
  session_id?: string
  event?: string
  /**
   * N8N_SYNC fix (E2E determinístico): quando presente, o stub ECOA esta forma
   * como resposta síncrona — permite exercitar o parser SYNC do kickoff com a
   * forma enxuta `{text, buttons?}` OU o contrato `{reply,...}`. Sem ele, o stub
   * mantém o roteiro determinístico por `message` (comportamento atual).
   */
  stub_reply?: {
    text?: string
    reply?: string
    buttons?: Array<{ id: number; label: string; value?: string }>
    message?: string
    prompt?: { kind?: string; question?: string; buttons?: Array<{ id: number; label: string; value?: string }> }
  }
}

/** Roteiro determinístico: espelha o stubChat, mas no formato de resposta do fluxo. */
function reply(message: string): {
  reply: string
  events: string[]
  verified: boolean
  close_offer_id: string | null
  n8n_execution_id: string
  prompt_version: string
  tool_calls: Array<{ name: string; args: unknown }>
} {
  const text = (message || "").toLowerCase()
  const base = {
    verified: true,
    close_offer_id: null as string | null,
    n8n_execution_id: `exec_${Date.now()}`,
    prompt_version: "n8n-stub-v1",
  }
  if (/fatura|detalhe|resumo|quanto|valor|dívida|divida|deve/.test(text)) {
    return { ...base, reply: "Aqui está o resumo da sua dívida.", events: ["debt_summary"], tool_calls: [{ name: "debt.summary", args: {} }] }
  }
  if (/opç|opc|pagar|parcel|desconto|à vista|a vista|acordo|negoci/.test(text)) {
    return { ...base, reply: "Estas são as condições disponíveis. Escolha uma ao lado.", events: ["offers_listed"], tool_calls: [{ name: "offer.list", args: {} }] }
  }
  if (/já paguei|ja paguei|paguei|quitei/.test(text)) {
    return { ...base, reply: "Vou registrar que você já pagou para conferência.", events: ["payment_claim"], tool_calls: [{ name: "payment_claim.register", args: {} }] }
  }
  if (/contest|não reconhe|nao reconhe|indevid/.test(text)) {
    return { ...base, reply: "Registrei sua contestação; a equipe vai analisar.", events: ["dispute"], tool_calls: [{ name: "dispute.register", args: {} }] }
  }
  if (/atendente|humano|falar com|atendimento/.test(text)) {
    return { ...base, reply: "Vou transferir você para um atendente.", events: ["handoff"], tool_calls: [{ name: "human.transfer", args: {} }] }
  }
  return {
    ...base,
    reply: "Olá! Como posso ajudar com a sua negociação hoje?",
    events: ["greeting"],
    tool_calls: [{ name: "debt.summary", args: {} }],
  }
}

export async function POST(request: Request) {
  if (!devAllowed()) return NextResponse.json({ error: "not found" }, { status: 404 })

  const rawBody = await request.text()
  const verdict = verifyN8nRequest(
    rawBody,
    request.headers.get(N8N_SIGNATURE_HEADER),
    request.headers.get(N8N_TIMESTAMP_HEADER),
  )
  if (!verdict.ok) return NextResponse.json({ error: verdict.reason }, { status: verdict.status })

  let payload: TurnPayload
  try {
    payload = JSON.parse(rawBody) as TurnPayload
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 })
  }

  // N8N_SYNC fix: forma enxuta parametrizada para o E2E do kickoff (SYNC).
  // Ecoa exatamente `stub_reply` — permite testar {text,buttons?} | {reply} |
  // {message:"Workflow was started"} (async/vazio) de forma determinística.
  if (payload.stub_reply) {
    return NextResponse.json(payload.stub_reply)
  }

  return NextResponse.json(reply(payload.message ?? ""))
}
