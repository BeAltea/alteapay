/**
 * voxuy-probe — sonda de conectividade + segurança do disparo Voxuy (enterprise_v1).
 *
 * ⚠️ SEGURANÇA CRÍTICA: a `VOXUY_WEBHOOK_URL` é A CREDENCIAL da conta (quem a
 * tem envia mensagem). Este script:
 *   - lê a URL SÓ de `process.env.VOXUY_WEBHOOK_URL` (NUNCA por argumento);
 *   - valida contra o formato canônico antes de qualquer fetch;
 *   - se ausente / fora do formato → console.error + exit(1) SEM imprimir a URL;
 *   - NUNCA imprime a URL (nem em log, nem em erro).
 *
 * O probe faz UM POST com corpo INVÁLIDO DE PROPÓSITO (`{ probe: true }`, sem
 * flowId/contact) esperando 400 `{"success":false,"message":"..."}` — a resposta
 * de erro da Voxuy NÃO contém segredo, então imprimimos só `{status, ms, body}`
 * (body truncado em 400 chars). O corpo do POST não carrega nenhum dado real:
 * é inválido justamente para NÃO disparar mensagem a ninguém.
 *
 * VEREDITO (o que fazer com o status):
 *   - 400  → OK: a integração está VIVA e rejeita corpo inválido. Prosseguir.
 *   - 404  → URL ERRADA (endpoint não existe). PARAR e revisar VOXUY_WEBHOOK_URL.
 *   - 401  → integração DESABILITADA / credencial inválida. PARAR.
 *   - 200  → INESPERADO: a Voxuy pode ter ACEITADO o corpo (risco de disparo).
 *            PARAR e reportar — não deveríamos conseguir disparar com corpo inválido.
 *
 * Uso:
 *   pnpm exec tsx scripts/ops/voxuy-probe.ts
 *
 * Requer no ambiente (nunca hardcode, nunca argumento):
 *   VOXUY_WEBHOOK_URL   URL-credencial canônica (webhooks.voxuy.com/voxuyapi/<uuid>)
 */

const TIMEOUT_MS = 10_000
const BODY_MAX = 400

// Formato CANÔNICO da URL-credencial (host webhooks.voxuy.com + /voxuyapi/<uuid>).
// Inline (script standalone via tsx, sem resolução de alias @/). Espelha
// VOXUY_WEBHOOK_URL_RE de lib/whatsapp/voxuy/config.ts.
const VOXUY_WEBHOOK_URL_RE = /^https:\/\/webhooks\.voxuy\.com\/voxuyapi\/[0-9a-f-]{36}$/
const isCanonicalVoxuyWebhookUrl = (u: string | null | undefined): boolean =>
  typeof u === "string" && VOXUY_WEBHOOK_URL_RE.test(u)

/**
 * Lê e valida a URL-credencial. Faltando / fora do formato → erro + exit 1.
 * NUNCA loga o valor da URL (só o NOME da variável). Retorna a URL (segredo)
 * apenas para uso interno do fetch — jamais para impressão.
 */
function readWebhookUrl(): string {
  const url = process.env.VOXUY_WEBHOOK_URL
  if (!url) {
    console.error("[voxuy-probe] env ausente: VOXUY_WEBHOOK_URL (valor nunca é logado)")
    process.exit(1)
  }
  if (!isCanonicalVoxuyWebhookUrl(url)) {
    // NUNCA ecoa a URL — só diz que o formato é inesperado.
    console.error("[voxuy-probe] VOXUY_WEBHOOK_URL em formato inesperado (valor nunca é logado)")
    process.exit(1)
  }
  return url
}

/** Traduz o status HTTP no veredito operacional (sem citar a URL). */
function verdictFor(status: number): string {
  if (status === 400) return "OK (integração viva; rejeita corpo inválido) — prosseguir"
  if (status === 404) return "URL ERRADA (endpoint não existe) — PARAR"
  if (status === 401) return "integração DESABILITADA / credencial inválida — PARAR"
  if (status === 200) return "INESPERADO: pode ter aceitado o corpo (risco de disparo) — PARAR e reportar"
  return `inesperado (HTTP ${status}) — investigar`
}

async function main(): Promise<void> {
  const url = readWebhookUrl() // segredo: usado só no fetch, nunca impresso
  console.log("[voxuy-probe] alvo: VOXUY_WEBHOOK_URL (valor omitido por segurança)")
  console.log("[voxuy-probe] POST com corpo INVÁLIDO de propósito ({probe:true}) — espera 400\n")

  const body = JSON.stringify({ probe: true })
  const t0 = Date.now()
  let status = 0
  let label = ""
  let text = ""
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    status = resp.status
    // A resposta de ERRO da Voxuy não contém segredo → pode ser impressa (truncada).
    text = await resp.text().catch(() => "")
  } catch (err) {
    label = err instanceof Error && err.name === "TimeoutError" ? "timeout" : "network_error"
  }
  const ms = Date.now() - t0

  if (label) {
    console.log(JSON.stringify({ status: null, ms, error: label }))
    console.log(`[voxuy-probe] veredito: ${label} (sem status) — investigar conectividade`)
    process.exit(1)
  }

  // Imprime SÓ {status, ms, body} — nunca a URL.
  console.log(JSON.stringify({ status, ms, body: text.slice(0, BODY_MAX) }))
  console.log(`[voxuy-probe] veredito: ${verdictFor(status)}`)

  // Só 400 é "verde" (integração viva rejeitando inválido).
  process.exit(status === 400 ? 0 : 1)
}

void main()
