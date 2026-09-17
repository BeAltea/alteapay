// Simulador dev: monta um envelope Cloud API sintético, assina com o secret
// mock e POSTa no webhook real — valida o fluxo completo sem conexão externa.
// SOMENTE com MOCK_ALL_INTEGRATIONS=1 ou NODE_ENV=development.

import { createHmac } from "node:crypto"
import { NextResponse } from "next/server"
import { z } from "zod"

export const dynamic = "force-dynamic"

function devModeEnabled(): boolean {
  return process.env.MOCK_ALL_INTEGRATIONS === "1" || process.env.NODE_ENV === "development"
}

const bodySchema = z.object({
  from: z.string().min(8),
  text: z.string().min(1).max(2000),
})

let seq = 0

export async function POST(request: Request) {
  if (!devModeEnabled()) {
    return NextResponse.json({ success: false, error: "não encontrado" }, { status: 404 })
  }
  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: "body inválido" }, { status: 422 })
  }
  const { from, text } = parsed.data

  const envelope = {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "mock-waba",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "5511999990000", phone_number_id: "mock-phone-id" },
              contacts: [{ profile: { name: "Simulador" }, wa_id: from.replace(/\D/g, "") }],
              messages: [
                {
                  from: from.replace(/\D/g, ""),
                  id: `wamid.mock.${Date.now()}.${++seq}`,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: "text",
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  }

  const raw = JSON.stringify(envelope)
  const secret = process.env.WHATSAPP_APP_SECRET || "mock-app-secret"
  const signature = `sha256=${createHmac("sha256", secret).update(raw, "utf8").digest("hex")}`

  const base = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"
  const resp = await fetch(`${base}/api/webhooks/whatsapp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Hub-Signature-256": signature },
    body: raw,
  })
  const data = await resp.json().catch(() => null)
  return NextResponse.json({ success: resp.ok, webhook_status: resp.status, webhook_response: data })
}
