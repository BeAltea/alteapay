// Probe do disparo Voxuy (enterprise_v1) — GATE W0. Roda no runtime de PRODUÇÃO
// (onde VOXUY_WEBHOOK_URL existe), executando o MESMO probe do CLI
// (scripts/ops/voxuy-probe.ts): UM POST com corpo INVÁLIDO de propósito
// (`{ probe: true }`) esperando 400 (integração viva, rejeita inválido).
//
// ⚠️ SEGURANÇA CRÍTICA: a VOXUY_WEBHOOK_URL é A CREDENCIAL da conta. Esta rota:
//   - lê a URL SÓ de process.env (nunca de argumento/body/query);
//   - NUNCA devolve a URL, o segredo, nem o corpo bruto da resposta (que poderia
//     — em tese — ecoar algo sensível): devolve SÓ { status, latency_ms, verdict }.
// Auth server-a-servidor por Bearer CRON_SECRET. Espelha app/api/n8n/probe/route.ts.

import { NextRequest, NextResponse } from "next/server"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const TIMEOUT_MS = 10_000

// Formato CANÔNICO da URL-credencial (host webhooks.voxuy.com + /voxuyapi/<uuid>).
// Espelha VOXUY_WEBHOOK_URL_RE de lib/whatsapp/voxuy/config.ts.
const VOXUY_WEBHOOK_URL_RE = /^https:\/\/webhooks\.voxuy\.com\/voxuyapi\/[0-9a-f-]{36}$/

/** Veredito operacional por status (nunca cita a URL). */
function verdictFor(status: number | null, error: string | null): string {
  if (error) return `${error} (sem status) — investigar conectividade`
  switch (status) {
    case 400:
      return "OK (integração viva; rejeita corpo inválido)"
    case 404:
      return "URL ERRADA (endpoint não existe) — PARAR"
    case 401:
      return "integração DESABILITADA / credencial inválida — PARAR"
    case 200:
      return "INESPERADO: pode ter aceitado o corpo (risco de disparo) — PARAR e reportar"
    default:
      return `inesperado (HTTP ${status}) — investigar`
  }
}

export async function POST(request: NextRequest) {
  if (request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const url = process.env.VOXUY_WEBHOOK_URL
  // env ausente → 500 SEM ecoar a URL (nunca há URL para ecoar aqui, mas mantém
  // o mesmo contrato de segurança do CLI).
  if (!url) {
    return NextResponse.json({ ok: false, error: "env ausente", missing: ["VOXUY_WEBHOOK_URL"] }, { status: 500 })
  }
  if (!VOXUY_WEBHOOK_URL_RE.test(url)) {
    // NUNCA devolve a URL — só diz que o formato é inesperado.
    return NextResponse.json({ ok: false, error: "VOXUY_WEBHOOK_URL em formato inesperado" }, { status: 500 })
  }

  // Corpo inválido de propósito: NÃO dispara mensagem a ninguém.
  const body = JSON.stringify({ probe: true })
  const t0 = Date.now()
  let status: number | null = null
  let error: string | null = null
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    status = resp.status
    // Drena o corpo para liberar a conexão; o conteúdo NÃO é devolvido.
    await resp.text().catch(() => "")
  } catch (err) {
    error = err instanceof Error && err.name === "TimeoutError" ? "timeout" : "network_error"
  }
  const latency_ms = Date.now() - t0

  // Só 400 é "verde": integração viva rejeitando corpo inválido.
  const verdict = verdictFor(status, error)
  const pass = status === 400
  // Devolve SÓ status/latência/veredito — nunca a URL, o segredo ou o corpo.
  return NextResponse.json({ ok: true, gate_w0: pass ? "PASSA" : "FALHA", pass, status, latency_ms, verdict })
}
