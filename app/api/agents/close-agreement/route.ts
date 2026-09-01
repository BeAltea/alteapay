// POST /api/agents/close-agreement — fechamento de acordo server-to-server
// (x-agent-token). Mantido por compatibilidade com integrações existentes;
// o domínio vive em lib/negotiation/close-agreement.ts (também exposto como
// ação agreement.close do webhook n8n).

import { NextResponse, type NextRequest } from "next/server"

import { closeAgreement } from "@/lib/negotiation/close-agreement"

export const dynamic = "force-dynamic"

interface CloseAgreementBody {
  company_id: string
  thread_id: string
  debt_id: string
  offer_id: string
  channel?: string
}

export async function POST(request: NextRequest) {
  try {
    const expectedToken = process.env.AGENT_APP_TOKEN
    if (!expectedToken) {
      return NextResponse.json(
        { success: false, error: "AGENT_APP_TOKEN não configurado" },
        { status: 503 },
      )
    }

    const providedToken = request.headers.get("x-agent-token")
    if (!providedToken || providedToken !== expectedToken) {
      return NextResponse.json({ success: false, error: "Não autorizado" }, { status: 401 })
    }

    let body: Partial<CloseAgreementBody>
    try {
      body = (await request.json()) ?? {}
    } catch {
      return NextResponse.json({ success: false, error: "JSON inválido" }, { status: 400 })
    }

    const { company_id, thread_id, debt_id, offer_id, channel } = body
    if (
      typeof company_id !== "string" || !company_id ||
      typeof thread_id !== "string" || !thread_id ||
      typeof debt_id !== "string" || !debt_id ||
      typeof offer_id !== "string" || !offer_id
    ) {
      return NextResponse.json(
        { success: false, error: "Campos obrigatórios: company_id, thread_id, debt_id, offer_id" },
        { status: 400 },
      )
    }

    const result = await closeAgreement({
      company_id,
      debt_id,
      offer_id,
      origin: `negotiation-agent thread ${thread_id}`,
      channel,
    })

    if (!result.ok) {
      return NextResponse.json({ success: false, error: result.error }, { status: result.status })
    }
    return NextResponse.json(
      { success: true, agreement_id: result.agreement_id, message: result.message },
      { status: 200 },
    )
  } catch (error: any) {
    console.error("[CLOSE-AGREEMENT] Error:", error)
    return NextResponse.json(
      { success: false, error: error?.message || "Erro desconhecido ao registrar acordo" },
      { status: 500 },
    )
  }
}
