// POST /api/super-admin/negotiations/send
//
// Dispara a negociação por (devedor, CANAL). O corpo carrega os CANAIS marcados
// no diálogo (channels: ["whatsapp","email"]) e `dedupe` ("não duplicar"). Cada
// devedor recebe por TODOS os canais que possuir (E2/E3); com dedupe, quem tem os
// dois vai só por WhatsApp. NÃO cria cobrança nem e-mail de cobrança — o link do
// chat (/n/{code}) vai por WhatsApp (Voxuy mock) e/ou por e-mail (SendGrid).
//
// Canais em SEQUÊNCIA INDEPENDENTE (E3): uma falha no e-mail não afeta o WhatsApp.
//
// Fonte da verdade do FORMATO: components/super-admin/negotiations/send-contract.ts
// (a rota emite { dryRun, channels, dedupe, counts, results } que o diálogo lê).
//
// EMAIL_SEND_MODE/DISPATCH_MODE=inline|queue (default queue). inline dispara na
// request, com teto INLINE_DISPATCH_MAX_BATCH (25) + TRAVA em super_admin. Acima
// do teto orienta dividir em lotes. dryRun = resultado completo sem enviar.
//
// Segurança (§3): só admin do tenant e super_admin; company_id DERIVADO no
// servidor. Provider mock é o default (nada sai).

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { maskDocument } from "@/lib/journey/document"
import { createHubCampaign, loadTenantHubConfig } from "@/lib/journey/campaigns"
import { runHubSend, type HubSendItem } from "@/lib/journey/campaign-send"
import { pingRedis } from "@/lib/queue"
import { resolveSelection, type SelectionBody } from "../selection"
import type {
  SendChannel,
  SendOutcome,
  SendResultRow,
} from "@/components/super-admin/negotiations/send-contract"

export const dynamic = "force-dynamic"
export const revalidate = 0
export const maxDuration = 120

const noCache = { "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0" }

const INLINE_DISPATCH_MAX_BATCH = Number(process.env.INLINE_DISPATCH_MAX_BATCH ?? "25")

interface SendBody extends SelectionBody {
  companyId?: string
  channels?: string[]
  dedupe?: boolean
  dryRun?: boolean
  /** Override explícito do dono: quando true, ignora APENAS a janela de cooldown
   * de contato (permite reenviar ao mesmo devedor dentro da janela). As demais
   * exclusões (supressão, cobrança viva, sem contato, etc.) seguem valendo. */
  allowResend?: boolean
  /** A1: chave de idempotência gerada 1x pelo diálogo. Double-click/retry com a
   * mesma chave reusam a mesma campanha (não duplicam envio real). */
  idempotencyKey?: string
}

async function resolveCompany(request: NextRequest, bodyCompanyId?: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: NextResponse.json({ error: "Não autenticado" }, { status: 401, headers: noCache }) }
  const { data: profile } = await supabase
    .from("profiles")
    .select("role, company_id, full_name")
    .eq("id", user.id)
    .single()
  const role = profile?.role
  if (role !== "super_admin" && role !== "admin") {
    return { error: NextResponse.json({ error: "Sem permissão" }, { status: 403, headers: noCache }) }
  }
  let companyId: string | null
  if (role === "super_admin") {
    companyId = bodyCompanyId ?? profile?.company_id ?? null
  } else {
    companyId = profile?.company_id ?? null
    if (bodyCompanyId && bodyCompanyId !== companyId) {
      return { error: NextResponse.json({ error: "company_id não pertence ao usuário" }, { status: 403, headers: noCache }) }
    }
  }
  if (!companyId) {
    return { error: NextResponse.json({ error: "companyId obrigatório" }, { status: 400, headers: noCache }) }
  }
  return { companyId, role: role as "admin" | "super_admin", userId: user.id, fullName: profile?.full_name ?? null }
}

function resolveDispatch(): "inline" | "queue" {
  // EMAIL_SEND_MODE/DISPATCH_MODE compartilham o mesmo eixo (inline dispara na
  // request; queue enfileira). Qualquer um dos dois em 'inline' liga o modo inline.
  const raw = (process.env.EMAIL_SEND_MODE ?? process.env.DISPATCH_MODE ?? "queue").toLowerCase()
  return raw === "inline" ? "inline" : "queue"
}

/** Timeout do ping de saúde do Redis (ms). Curto de propósito: só queremos saber
 * se dá para enfileirar AGORA; se o Upstash/worker estão fora, caímos no inline
 * sem travar a request. */
const REDIS_PING_TIMEOUT_MS = Number(process.env.REDIS_PING_TIMEOUT_MS ?? "1500")

/**
 * Modo de envio EFETIVO. Parte do modo resolvido por env (resolveDispatch) e,
 * quando ele é `queue`, faz um PING rápido no Redis: se o Redis não responde
 * (fora do ar / timeout), FORÇA `inline` — assim lotes pequenos saem mesmo com o
 * Upstash/worker desligados, em vez de enfileirar num Redis morto. Se já era
 * `inline`, segue direto (sem ping). Se o Redis está OK, o modo `queue` é mantido
 * intacto. NÃO expõe segredo no log (só o fato binário do ping).
 */
async function resolveEffectiveDispatch(): Promise<{ mode: "inline" | "queue"; forcedInline: boolean }> {
  const envMode = resolveDispatch()
  if (envMode === "inline") return { mode: "inline", forcedInline: false }
  const alive = await pingRedis(REDIS_PING_TIMEOUT_MS)
  if (alive) return { mode: "queue", forcedInline: false }
  console.warn(
    "[negotiations/send] Redis indisponível (ping falhou/timeout): forçando envio inline neste lote (fallback automático).",
  )
  return { mode: "inline", forcedInline: true }
}

/** Header que liga o streaming NDJSON (progresso item-a-item). Ausente = JSON de
 * hoje (compat com callers/testes existentes). Defensivo: se o objeto de request
 * não expõe headers (mocks antigos), trata como não-stream. */
function wantsStream(request: NextRequest): boolean {
  try {
    return request.headers?.get("x-stream") === "1"
  } catch {
    return false
  }
}

const ALL: SendChannel[] = ["whatsapp", "email"]

function parseChannels(raw: unknown): SendChannel[] {
  if (!Array.isArray(raw)) return [...ALL]
  const out = raw.filter((c): c is SendChannel => c === "whatsapp" || c === "email")
  return Array.from(new Set(out))
}

/** status do item do hub → desfecho do contrato. São nomes iguais, mas o cast
 * garante o tipo do contrato mesmo se os conjuntos divergirem no futuro. */
function toOutcome(status: HubSendItem["status"]): SendOutcome {
  switch (status) {
    case "sent":
    case "failed":
    case "suppressed":
    case "skipped":
      return status
    default:
      return "skipped"
  }
}

/** Mascara o documento de cada customer (nunca em claro). */
async function maskedDocuments(companyId: string, customerIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (customerIds.length === 0) return out
  const supabase = createServiceClient()
  const chunk = 300
  for (let i = 0; i < customerIds.length; i += chunk) {
    const part = customerIds.slice(i, i + chunk)
    const { data } = await (supabase as any)
      .from("customers")
      .select("id, document")
      .eq("company_id", companyId)
      .in("id", part)
    for (const c of data ?? []) out.set(c.id, maskDocument(c.document ?? null))
  }
  return out
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as SendBody
    const auth = await resolveCompany(request, body.companyId)
    if ("error" in auth) return auth.error
    const { companyId, role, userId } = auth

    // Aceita { customerIds } OU { allFiltered }. Resolve ids no servidor.
    const selection = await resolveSelection(body, companyId)
    if ("error" in selection) {
      return NextResponse.json({ error: selection.error }, { status: selection.status, headers: noCache })
    }
    const { customerIds } = selection

    const channels = parseChannels(body.channels)
    if (channels.length === 0) {
      return NextResponse.json({ error: "Selecione ao menos um canal" }, { status: 400, headers: noCache })
    }
    const dedupe = body.dedupe === true
    const dryRun = body.dryRun === true
    const allowResend = body.allowResend === true

    const hub = await loadTenantHubConfig(companyId)
    // Modo EFETIVO: env decide inline/queue; quando `queue`, um ping rápido no
    // Redis pode FORÇAR inline (Upstash/worker fora) — fallback automático.
    const { mode: dispatchMode, forcedInline } = await resolveEffectiveDispatch()

    // inline só para super_admin (E2/§4): dispara na request, teto + rate-limit.
    // Acima do teto: orienta dividir em lotes (não trunca silenciosamente). Vale
    // TAMBÉM para o inline forçado pelo fallback (o teto protege o lote síncrono).
    if (dispatchMode === "inline" && !dryRun) {
      if (role !== "super_admin") {
        return NextResponse.json({ error: "inline dispatch restrito a super_admin" }, { status: 403, headers: noCache })
      }
      if (customerIds.length > INLINE_DISPATCH_MAX_BATCH) {
        return NextResponse.json(
          {
            error: `Envio inline limitado a ${INLINE_DISPATCH_MAX_BATCH} devedores por lote (recebidos ${customerIds.length}). Divida a seleção em lotes de até ${INLINE_DISPATCH_MAX_BATCH}.`,
            maxBatch: INLINE_DISPATCH_MAX_BATCH,
            received: customerIds.length,
            ...(forcedInline ? { forcedInline: true } : {}),
          },
          { status: 400, headers: noCache },
        )
      }
    }

    // O envio do hub dispara o LINK do chat por canal. Não cria cobrança.
    const { campaignId } = await createHubCampaign({
      companyId,
      name: `Hub ${new Date().toISOString().slice(0, 10)}`,
      templateKey: "hub_link",
      customerIds,
      createdBy: userId,
      sendMode: "whatsapp_chat",
      provider: hub.provider,
      channels,
      dedupe,
      allowResend,
      // dryRun não consome/colide com a chave do envio real.
      idempotencyKey: dryRun ? null : (typeof body.idempotencyKey === "string" ? body.idempotencyKey : null),
    })

    // Monta o payload JSON final (idêntico ao de hoje) a partir do resultado do
    // hub. Usado tanto pela resposta não-stream quanto pelo evento `done` do stream.
    const buildPayload = async (hubResult: Awaited<ReturnType<typeof runHubSend>>) => {
      const items: HubSendItem[] = hubResult.items
      const docs = await maskedDocuments(companyId, Array.from(new Set(items.map((i) => i.customerId))))
      const results: SendResultRow[] = items.map((i) => ({
        customerId: i.customerId,
        documentMasked: docs.get(i.customerId) ?? "***",
        channel: i.channel ?? null,
        outcome: toOutcome(i.status),
        detail: i.reason ?? null,
      }))
      return {
        dryRun,
        channels,
        dedupe,
        dispatchMode,
        forcedInline,
        campaignId,
        counts: hubResult.summary,
        results,
      }
    }

    // STREAMING (NDJSON): só quando o cliente pede (x-stream:1) E o envio é inline
    // real (não dry-run) — o único caminho com laço item-a-item. Cada item emite
    // uma linha `progress`; ao fim, uma linha `done` com o MESMO payload JSON.
    if (wantsStream(request) && dispatchMode === "inline" && !dryRun) {
      return streamSend({ campaignId, companyId, dispatchMode, allowResend, buildPayload })
    }

    // Não-stream (compat): roda até o fim e devolve o JSON de hoje.
    const hubResult = await runHubSend({ campaignId, companyId, dispatchMode, dryRun, allowResend })
    return NextResponse.json(await buildPayload(hubResult), { headers: noCache })
  } catch (error: any) {
    console.error("[negotiations/send] erro:", error?.message)
    return NextResponse.json({ error: error?.message ?? "Erro interno" }, { status: 500, headers: noCache })
  }
}

/**
 * Resposta em STREAM NDJSON do envio inline. Emite uma linha JSON por item
 * processado (`{"type":"progress","done","total","item":{customerId,channel,status}}`)
 * e, ao fim, `{"type":"done","result":{...payload...}}` — o MESMO objeto que a
 * resposta não-stream devolveria. Um erro no meio vira `{"type":"error","error"}`
 * na última linha (o cliente consegue exibir e oferecer nova tentativa). O item
 * NUNCA carrega documento em claro — só customerId/channel/status (a lista com
 * documento mascarado vai no payload final, montado por buildPayload).
 */
function streamSend(args: {
  campaignId: string
  companyId: string
  dispatchMode: "inline" | "queue"
  allowResend: boolean
  buildPayload: (hubResult: Awaited<ReturnType<typeof runHubSend>>) => Promise<Record<string, unknown>>
}): Response {
  const { campaignId, companyId, dispatchMode, allowResend, buildPayload } = args
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (obj: unknown) => controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"))
      try {
        const hubResult = await runHubSend({
          campaignId,
          companyId,
          dispatchMode,
          dryRun: false,
          allowResend,
          onProgress: (done, total, item) => {
            // linha de progresso: sem PII (só o customerId opaco + canal + status).
            write({
              type: "progress",
              done,
              total,
              item: { customerId: item.customerId, channel: item.channel ?? null, status: item.status },
            })
          },
        })
        const result = await buildPayload(hubResult)
        write({ type: "done", result })
      } catch (error: any) {
        write({ type: "error", error: error?.message ?? "Erro interno" })
      } finally {
        controller.close()
      }
    },
  })
  return new Response(stream, {
    headers: {
      ...noCache,
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "X-Accel-Buffering": "no",
    },
  })
}
