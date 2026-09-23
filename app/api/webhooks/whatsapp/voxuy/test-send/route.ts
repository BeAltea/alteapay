// DEBUG — disparo REAL Voxuy (enterprise_v1) para UM contato, devolvendo o
// RETORNO COMPLETO da Voxuy. Objetivo: entender por que uma mensagem ACEITA
// (`{success:true}` / HTTP 200) não é ENTREGUE no WhatsApp — para isso
// precisamos VER o corpo cru da resposta (o `message` que a Voxuy devolve).
//
// Monta EXATAMENTE o mesmo payload que o envio de campanha real monta
// (lib/journey/campaign-send.ts → buildProviderSelector → VoxuyApiProvider,
// dialeto enterprise_v1): { flowId, contact:{ name, phoneNumber, variables:{
// link_negociacao, primeiro_nome, credor } } }. Reusa o builder oficial
// `buildEnterprisePayload` de lib/whatsapp/voxuy/api-provider.ts (fonte da verdade
// do contrato), então o corpo é bit-a-bit o do provider real.
//
// ⚠️ SEGURANÇA CRÍTICA: a VOXUY_WEBHOOK_URL é A CREDENCIAL da conta (contém o
// companyId embutido). Esta rota:
//   - lê a URL/flowId/branding SÓ de process.env e do DB (tenant_chat_config) —
//     NUNCA de argumento/body/query;
//   - NUNCA devolve, loga nem ecoa a VOXUY_WEBHOOK_URL (nem parcial);
//   - o telefone é MASCARADO (só os últimos 4) no retorno.
// O corpo da RESPOSTA da Voxuy PODE ser mostrado — é o envelope `{success, message}`
// e NÃO contém a URL-credencial. Auth server-a-servidor por Bearer CRON_SECRET
// (espelha app/api/n8n/probe/route.ts).

import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { buildEnterprisePayload } from "@/lib/whatsapp/voxuy/api-provider"
import { coerceFlowId, isCanonicalVoxuyWebhookUrl } from "@/lib/whatsapp/voxuy/config"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const TIMEOUT_MS = 10_000
// VMAX (default quando o body não trouxer companyId).
const DEFAULT_COMPANY_ID = "1f7729ee-a537-43fc-a27f-5747c177988d"
const E164 = /^\+\d{8,15}$/

/** Só os últimos 4 dígitos (nunca o telefone inteiro). */
function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "")
  return digits.length <= 4 ? "****" : `****${digits.slice(-4)}`
}

interface TestSendBody {
  companyId?: unknown
  phoneNumber?: unknown
  name?: unknown
  link?: unknown
}

export async function POST(request: NextRequest) {
  // 1) Auth server-a-servidor (espelha app/api/n8n/probe/route.ts).
  if (request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  // 6) A URL-credencial vem SÓ do env. Ausente => 500 (sem ecoar valor algum).
  const webhookUrl = process.env.VOXUY_WEBHOOK_URL
  if (!webhookUrl) {
    return NextResponse.json({ error: "env ausente", missing: ["VOXUY_WEBHOOK_URL"] }, { status: 500 })
  }
  if (!isCanonicalVoxuyWebhookUrl(webhookUrl)) {
    // Formato inesperado (host errado / URL colada de outro lugar). Nunca ecoa a URL.
    return NextResponse.json(
      { error: "VOXUY_WEBHOOK_URL com formato inesperado (host webhooks.voxuy.com + /voxuyapi/<uuid>)" },
      { status: 500 },
    )
  }

  // 2) Body: { companyId, phoneNumber (E.164), name, link? }. Default = VMAX.
  let body: TestSendBody
  try {
    body = (await request.json()) as TestSendBody
  } catch {
    return NextResponse.json({ error: "corpo inválido (JSON esperado)" }, { status: 400 })
  }
  const companyId = typeof body.companyId === "string" && body.companyId ? body.companyId : DEFAULT_COMPANY_ID
  const phoneNumber = typeof body.phoneNumber === "string" ? body.phoneNumber.trim() : ""
  const name = typeof body.name === "string" ? body.name.trim() : ""
  const linkOverride = typeof body.link === "string" && body.link ? body.link : null
  if (!E164.test(phoneNumber)) {
    return NextResponse.json({ error: "phoneNumber deve ser E.164 (ex.: +5511974602123)" }, { status: 400 })
  }
  const firstName = name.split(/\s+/)[0] ?? ""

  // 3) Carrega voxuy_flow_id + branding + public_link_code do tenant_chat_config,
  //    EXATAMENTE como o envio real (campaign-send.ts). branding.brand_name é o
  //    `credor`; se ausente, cai no company.name → "AlteaPay" (mesmo fallback).
  const supabase = createServiceClient()
  const [{ data: cfg }, { data: company }] = await Promise.all([
    supabase
      .from("tenant_chat_config")
      .select("voxuy_flow_id, branding, public_link_code")
      .eq("company_id", companyId)
      .maybeSingle(),
    supabase.from("companies").select("name").eq("id", companyId).maybeSingle(),
  ])

  const flowId = coerceFlowId(cfg?.voxuy_flow_id ?? process.env.VOXUY_FLOW_ID)
  if (flowId == null) {
    return NextResponse.json(
      { error: "voxuy_flow_id ausente no tenant_chat_config (e sem fallback VOXUY_FLOW_ID)", companyId },
      { status: 500 },
    )
  }
  const branding = (cfg?.branding ?? {}) as { brand_name?: string; creditor_name?: string }
  const brandName = branding.brand_name ?? "AlteaPay"
  const creditorName = branding.creditor_name ?? company?.name ?? brandName

  // Link de negociação: override do body, senão o link opaco do cedente
  // (/n/<public_link_code>), como no fluxo real de e-mail/jornada.
  const publicLinkCode = typeof cfg?.public_link_code === "string" ? cfg.public_link_code : null
  const link =
    linkOverride ??
    (publicLinkCode ? `https://alteapay.com/n/${publicLinkCode}` : "https://alteapay.com/n/")

  // 3) Payload enterprise_v1 — MESMO builder do provider real.
  const payload = buildEnterprisePayload({
    flowId,
    firstName,
    phoneE164: phoneNumber,
    link,
    creditorName,
  })

  // 4) POST na URL-credencial. Sem apiToken/Bearer/header próprio (a conta é
  //    identificada pela URL). Content-Type: application/json, timeout 10s.
  const t0 = Date.now()
  let status: number | null = null
  let ok = false
  let rawBody: unknown = null
  let networkError: string | null = null
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    status = res.status
    ok = res.ok
    const text = await res.text()
    // Devolve o corpo CRU: tenta JSON, cai para texto. (Corpo é {success,message};
    // não contém a URL-credencial — pode ser mostrado para diagnóstico.)
    try {
      rawBody = JSON.parse(text)
    } catch {
      rawBody = text
    }
  } catch (e) {
    networkError = e instanceof Error && e.name === "TimeoutError" ? "timeout" : "network_error"
  }
  const latencyMs = Date.now() - t0

  // 5) RETORNO COMPLETO para diagnóstico. NUNCA inclui a VOXUY_WEBHOOK_URL.
  return NextResponse.json({
    status,
    ok,
    body: rawBody,
    networkError,
    latency_ms: latencyMs,
    flowId,
    companyId,
    phoneSent: maskPhone(phoneNumber),
    // Forma do payload enviado (SÓ as chaves — nunca a URL nem valores sensíveis).
    payloadShape: {
      flowId: payload.flowId,
      contactKeys: Object.keys(payload.contact),
      variableKeys: Object.keys(payload.contact.variables),
    },
  })
}
