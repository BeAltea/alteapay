// Webhook WhatsApp Cloud API (Meta) — DORMANTE atrás de WHATSAPP_CHANNEL_ENABLED.
// GET: verificação do webhook (hub.challenge). POST: valida HMAC SHA-256
// (X-Hub-Signature-256), persiste o payload bruto (idempotente por wamid) e
// enfileira o processamento — NUNCA processa síncrono na rota.

import { createHmac, timingSafeEqual } from "node:crypto"
import { NextResponse } from "next/server"

import { sha256Hex } from "@/lib/negotiation/crypto"
import { whatsappQueue } from "@/lib/queue/queues"
import { createServiceClient } from "@/lib/supabase/service"

export const dynamic = "force-dynamic"

function verifyToken(): string {
  return process.env.WHATSAPP_VERIFY_TOKEN || process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || "mock-verify-token"
}

function appSecret(): string {
  // Em modo mock o simulador assina com este mesmo default.
  return process.env.WHATSAPP_APP_SECRET || "mock-app-secret"
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const mode = url.searchParams.get("hub.mode")
  const token = url.searchParams.get("hub.verify_token")
  const challenge = url.searchParams.get("hub.challenge")
  if (mode === "subscribe" && token === verifyToken() && challenge) {
    return new NextResponse(challenge, { status: 200 })
  }
  return NextResponse.json({ success: false, error: "verificação inválida" }, { status: 403 })
}

function validSignature(rawBody: string, header: string | null): boolean {
  if (!header?.startsWith("sha256=")) return false
  const expected = createHmac("sha256", appSecret()).update(rawBody, "utf8").digest("hex")
  const provided = header.slice("sha256=".length)
  if (provided.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(provided, "hex"), Buffer.from(expected, "hex"))
}

type CloudApiEnvelope = {
  entry?: Array<{
    changes?: Array<{
      value?: {
        messages?: Array<{ id?: string; from?: string }>
      }
    }>
  }>
}

export async function POST(request: Request) {
  const rawBody = await request.text()
  if (!validSignature(rawBody, request.headers.get("x-hub-signature-256"))) {
    return NextResponse.json({ success: false, error: "assinatura inválida" }, { status: 401 })
  }

  let payload: CloudApiEnvelope
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ success: false, error: "JSON inválido" }, { status: 400 })
  }

  const supabase = createServiceClient()
  const inserted: string[] = []
  const messages =
    payload.entry?.flatMap((e) => e.changes ?? []).flatMap((c) => c.value?.messages ?? []) ?? []

  if (messages.length === 0) {
    // Status updates/read receipts: registra o envelope e encerra.
    await supabase
      .from("whatsapp_inbound_events")
      .insert({ payload, wamid: null, phone_hash: null, processed_at: new Date().toISOString() })
      .select("id")
    return NextResponse.json({ success: true, queued: 0 })
  }

  for (const msg of messages) {
    const wamid = msg.id ?? null
    const phoneHash = msg.from ? sha256Hex(msg.from.replace(/\D/g, "")) : null
    const { data, error } = await supabase
      .from("whatsapp_inbound_events")
      .insert({ payload, wamid, phone_hash: phoneHash })
      .select("id")
      .single()
    if (error) {
      // 23505 = wamid já visto (retry da Meta) — idempotência, não é erro
      if (error.code === "23505") continue
      console.error("[whatsapp:webhook] persist:", error.message)
      return NextResponse.json({ success: false, error: "falha ao persistir" }, { status: 500 })
    }
    await whatsappQueue.add(`wa-${wamid ?? data.id}`, { event_id: data.id })
    inserted.push(data.id)
  }

  return NextResponse.json({ success: true, queued: inserted.length })
}
