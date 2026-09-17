// Rota CANÔNICA de captura inbound da Voxuy (V5). A doc da Voxuy é 100% de
// entrada (L1): não há contrato de webhook de saída. Esta rota:
//  - valida VOXUY_INBOUND_SECRET (header x-alteapay-webhook-secret OU query ?s=,
//    porque não sabemos qual a Voxuy suporta);
//  - grava TUDO em whatsapp_provider_events (dedupe por event_hash);
//  - responde 200 sempre que o segredo estiver correto;
//  - NUNCA 500 (um provedor que recebe 5xx pode desativar o webhook).
// O mapeador (lib/whatsapp/voxuy/inbound.ts) só reconhece o contrato A.5; o
// resto fica processed=false para análise.

import { NextRequest, NextResponse } from "next/server"
import { mapVoxuyInbound } from "@/lib/whatsapp/voxuy/inbound"
import { captureRawInbound } from "@/lib/whatsapp/inbound-apply"
import { voxuyInboundSecret } from "@/lib/whatsapp/voxuy/config"

export const dynamic = "force-dynamic"

export async function POST(req: NextRequest) {
  const secret = voxuyInboundSecret()
  const given =
    req.headers.get("x-alteapay-webhook-secret") ??
    new URL(req.url).searchParams.get("s") ??
    ""
  if (!secret || given !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  }

  const rawBody = await req.text()
  const events = mapVoxuyInbound(rawBody, req.headers)
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
