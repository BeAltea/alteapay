// Provider Voxuy — contrato de ENVIO conforme documentação pública conhecida
// (POST /api/{account}/webhooks/voxuy/transaction). O formato inbound ainda
// não foi confirmado pela Voxuy (Apêndice C.8): o parser aceita o contrato
// normalizado proposto e QUALQUER payload desconhecido é capturado bruto em
// whatsapp_provider_events (processed=false) — nunca 500, nunca perde evento.

import { createHash } from "node:crypto"
import { isMockMode } from "@/lib/integrations/mock-mode"
import type { NormalizedWhatsAppEvent, SendCampaignMessageInput, SendResult, WhatsAppProvider } from "./provider"

const eventHash = (s: string) => createHash("sha256").update(s).digest("hex")

export class VoxuyProvider implements WhatsAppProvider {
  name = "voxuy" as const

  private get accountCode() {
    return process.env.VOXUY_ACCOUNT_CODE ?? ""
  }
  private get apiToken() {
    return process.env.VOXUY_API_TOKEN ?? ""
  }

  async sendCampaignMessage(input: SendCampaignMessageInput): Promise<SendResult> {
    if (isMockMode("voxuy")) {
      console.log(`[mock:voxuy] send message=${input.messageId}`)
      return { accepted: true, providerMessageId: `voxuy-mock-${input.messageId.slice(0, 8)}` }
    }
    if (!this.accountCode || !this.apiToken) {
      return { accepted: false, error: "VOXUY_NOT_CONFIGURED" }
    }
    const tenantPlan = input.variables as unknown as Record<string, string>
    const body = {
      apiToken: this.apiToken,
      planId: tenantPlan.voxuy_plan_id ?? process.env.VOXUY_PLAN_ID ?? "",
      customEvent: tenantPlan.voxuy_custom_event ?? process.env.VOXUY_CUSTOM_EVENT ?? "alteapay_cobranca",
      clientPhoneNumber: input.to,
      clientName: input.customerName,
      clientDocument: input.document,
      id: input.messageId,
      // Campo para o fluxo ler a URL de consulta — A CONFIRMAR com a Voxuy
      // (pergunta C.8a); enviado também em customFields por segurança.
      consultUrl: input.variables.consult_url,
      customFields: {
        consult_url: input.variables.consult_url,
        brand_name: input.variables.brand_name,
        sender_label: input.variables.sender_label,
      },
      paymentType: 1,
      status: 1,
    }
    const res = await fetch(
      `https://sistema.voxuy.com/api/${this.accountCode}/webhooks/voxuy/transaction`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    )
    const raw = await res.json().catch(() => ({}))
    const accepted = res.ok && (raw as { Success?: boolean }).Success !== false
    return { accepted, providerMessageId: input.messageId, raw, error: accepted ? undefined : `HTTP ${res.status}` }
  }

  async parseInboundEvent(rawBody: string, headers: Headers): Promise<NormalizedWhatsAppEvent[]> {
    // Autenticação: header compartilhado até a Voxuy definir o mecanismo real
    const secret = process.env.VOXUY_WEBHOOK_SECRET ?? ""
    const given = headers.get("x-alteapay-webhook-secret") ?? new URL("http://x/?" + rawBody).searchParams.get("secret") ?? ""
    if (!secret || given !== secret) {
      throw Object.assign(new Error("unauthorized"), { status: 401 })
    }
    let body: Record<string, unknown>
    try {
      body = JSON.parse(rawBody)
    } catch {
      return [] // corpo não-JSON: capturado bruto pelo route handler
    }
    // Mapeador por fixtures: hoje aceita o contrato normalizado (A.3). Payloads
    // reais da Voxuy entram aqui quando a documentação chegar
    // (tests/fixtures/voxuy/*.json pinam o comportamento).
    const ev = body as {
      event?: string
      message_ref?: string
      phone?: string
      button?: "consult" | "optout" | "block"
      occurred_at?: string
      text?: string
    }
    const at = ev.occurred_at ?? new Date().toISOString()
    switch (ev.event) {
      case "sent": case "delivered": case "read": case "failed":
        return [{ type: ev.event, providerMessageId: ev.message_ref ?? "", at }]
      case "clicked":
        return [{ type: "clicked", providerMessageId: ev.message_ref ?? "", button: ev.button ?? "consult", at }]
      case "optout": case "block":
        return [{ type: ev.event, phone: ev.phone ?? "", at }]
      case "reply":
        return [{ type: "reply", phone: ev.phone ?? "", text: ev.text ?? "", at }]
      default:
        return [] // desconhecido → captura bruta no handler
    }
  }
}

export const voxuyEventHash = eventHash
