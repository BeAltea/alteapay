// GET /api/negotiation/health — saúde do agente de negociação (proxy).

import { NextResponse } from "next/server"

import { agentHealth } from "@/lib/negotiation/agent-client"

export const dynamic = "force-dynamic"

export async function GET() {
  const agent = await agentHealth()
  return NextResponse.json(
    { success: agent.ok, agent },
    { status: agent.ok ? 200 : 503 },
  )
}
