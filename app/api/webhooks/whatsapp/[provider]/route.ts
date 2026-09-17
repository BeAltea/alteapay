// Webhook inbound de WhatsApp (rota DINÂMICA). Para a Voxuy a rota canônica é
// a estática /api/webhooks/whatsapp/voxuy (V5); esta mantém compat e serve o
// mock. Autentica por segredo, deduplica por event_hash, normaliza e aplica
// efeitos. Payload desconhecido: captura bruta + 200 (nunca 500).

import { NextRequest, NextResponse } from "next/server"
import { parseInboundFor } from "@/lib/whatsapp"
import { captureRawInbound } from "@/lib/whatsapp/inbound-apply"
import { voxuyInboundSecret } from "@/lib/whatsapp/voxuy/config"

export const dynamic = "force-dynamic"

export async function POST(req: NextRequest, ctx: { params: { provider: string } }) {
  const providerName = ctx.params.provider
  if (providerName !== "voxuy" && providerName !== "mock") {
    return NextResponse.json({ error: "unknown provider" }, { status: 404 })
  }
  // Mock só existe fora de produção ou com mocks ligados
  if (providerName === "mock" && process.env.NODE_ENV === "production" && process.env.MOCK_ALL_INTEGRATIONS !== "1") {
    return NextResponse.json({ error: "not found" }, { status: 404 })
  }

  // Autenticação: voxuy exige VOXUY_INBOUND_SECRET (header ou ?s=); mock não.
  if (providerName === "voxuy") {
    const secret = voxuyInboundSecret()
    const given =
      req.headers.get("x-alteapay-webhook-secret") ??
      new URL(req.url).searchParams.get("s") ??
      ""
    if (!secret || given !== secret) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 })
    }
  }

  const rawBody = await req.text()
  // Parse do inbound SEM exigir credenciais de envio (captura funciona antes).
  const events = await parseInboundFor(providerName, rawBody, req.headers)
  try {
    const result = await captureRawInbound({ provider: providerName, rawBody, events })
    if (result.duplicate) return NextResponse.json({ ok: true, duplicate: true })
    return NextResponse.json({ ok: true, applied: result.applied })
  } catch (err) {
    // NUNCA 500: um provedor que recebe 5xx pode desativar o webhook.
    console.error("[whatsapp-webhook] capture:", (err as Error).message)
    return NextResponse.json({ ok: true, captured: false })
  }
}
