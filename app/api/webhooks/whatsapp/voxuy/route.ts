// Rota CANÔNICA de captura do callback da Voxuy (V5).
//
// A Voxuy NÃO faz HMAC: a proteção é URL com segredo (`?s=<VOXUY_INBOUND_SECRET>`)
// OU um header configurável (`VOXUY_INBOUND_SECRET_HEADER`, default
// `x-alteapay-webhook-secret`). O contrato de saída REAL não tem `delivered`/
// `read`: o corpo traz `contact` (hash/id/invalidWhatsApp/tags/customVariables)
// e, quando há venda, `transaction`. O mapeador correlaciona por `contact.hash`
// /`id` e deriva `failed` de `invalidWhatsApp: true`; o resto fica bruto.
//
// Esta rota:
//  - valida o segredo (header configurável OU query ?s=);
//  - grava TUDO em whatsapp_provider_events (dedupe por event_hash);
//  - responde 200 sempre que o segredo estiver correto;
//  - NUNCA 500 (um provedor que recebe 5xx pode desativar o webhook).

import { NextRequest, NextResponse } from "next/server"
import { mapVoxuyInbound } from "@/lib/whatsapp/voxuy/inbound"
import { captureRawInbound } from "@/lib/whatsapp/inbound-apply"
import { voxuyInboundSecret, voxuyInboundSecretHeader } from "@/lib/whatsapp/voxuy/config"
import type { NormalizedWhatsAppEvent } from "@/lib/whatsapp/provider"

export const dynamic = "force-dynamic"

export async function POST(req: NextRequest) {
  // Segredo/URL fora do try externo NÃO pode derrubar a rota: um payload/URL
  // malformado nunca gera 500 (um provedor que recebe 5xx pode desativar o
  // webhook). Todo o resto é captura pura.
  let given = ""
  try {
    const headerName = voxuyInboundSecretHeader()
    given =
      req.headers.get(headerName) ??
      new URL(req.url).searchParams.get("s") ??
      ""
  } catch {
    given = ""
  }
  const secret = voxuyInboundSecret()
  if (!secret || given !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  }

  // Ler o corpo pode falhar (stream abortado); mapear pode receber lixo. Ambos
  // são resilientes: corpo ilegível => "", mapeador de lixo => [] (o
  // captureRawInbound grava o bruto com processed=false).
  let rawBody = ""
  try {
    rawBody = await req.text()
  } catch (err) {
    console.error("[voxuy-webhook] read body:", (err as Error).message)
    return NextResponse.json({ ok: true, captured: false })
  }
  let events: NormalizedWhatsAppEvent[]
  try {
    events = mapVoxuyInbound(rawBody, req.headers)
  } catch (err) {
    // mapVoxuyInbound já é defensivo, mas nunca deixamos escapar um throw.
    console.error("[voxuy-webhook] map:", (err as Error).message)
    events = []
  }
  try {
    const result = await captureRawInbound({ provider: "voxuy", rawBody, events })
    if (result.duplicate) return NextResponse.json({ ok: true, duplicate: true })
    return NextResponse.json({ ok: true, applied: result.applied })
  } catch (err) {
    // NUNCA 500.
    console.error("[voxuy-webhook] capture:", (err as Error).message)
    return NextResponse.json({ ok: true, captured: false })
  }
}
