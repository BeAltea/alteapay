// Simulador do laboratório: injeta eventos normalizados no webhook mock.
// SÓ existe com MOCK_ALL_INTEGRATIONS=1 ou fora de produção.

import { NextRequest, NextResponse } from "next/server"

export const dynamic = "force-dynamic"

export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV === "production" && process.env.MOCK_ALL_INTEGRATIONS !== "1") {
    return NextResponse.json({ error: "not found" }, { status: 404 })
  }
  const body = await req.text()
  const base = process.env.NEXT_PUBLIC_APP_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`
  const res = await fetch(`${base}/api/webhooks/whatsapp/mock`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  })
  return NextResponse.json(await res.json(), { status: res.status })
}
