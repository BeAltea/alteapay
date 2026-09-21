// Verificação FUNCIONAL de captcha (Cloudflare Turnstile) — server-side.
//
// Não é stub: quando ligado, chama de fato o endpoint de siteverify da
// Cloudflare com o secret do deploy e só passa se `success === true`.
//
// Ligar (todas as três, produção):
//   CHAT_CAPTCHA_ENABLED=true
//   CHAT_CAPTCHA_PROVIDER=turnstile        (default)
//   CHAT_CAPTCHA_SECRET=<secret do widget>
// Desligado (default) → sempre passa (não bloqueia o fluxo assistido/local).
//
// O sitekey PÚBLICO (widget no browser) é NEXT_PUBLIC_CHAT_CAPTCHA_SITEKEY —
// nunca o secret. Falha de rede/timeout = NÃO passa (fail-closed quando ligado).

const TURNSTILE_VERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify"

/** true se o captcha está exigido neste deploy. */
export function captchaEnabled(): boolean {
  return process.env.CHAT_CAPTCHA_ENABLED === "true"
}

/** Sitekey público do widget (browser). Vazio quando desligado/não configurado. */
export function captchaSiteKey(): string {
  return process.env.NEXT_PUBLIC_CHAT_CAPTCHA_SITEKEY || ""
}

interface TurnstileResponse {
  success?: boolean
  "error-codes"?: string[]
}

/**
 * Verifica o token do Turnstile. Desligado → true. Ligado sem secret/token,
 * provider desconhecido ou falha de rede → false (fail-closed).
 * `remoteIp` é opcional (a Cloudflare aceita e melhora o sinal antifraude).
 */
export async function verifyCaptcha(
  token: string | null | undefined,
  remoteIp?: string | null,
): Promise<boolean> {
  if (!captchaEnabled()) return true

  const provider = process.env.CHAT_CAPTCHA_PROVIDER || "turnstile"
  const secret = process.env.CHAT_CAPTCHA_SECRET
  if (provider !== "turnstile") return false
  if (!token || !secret) return false

  try {
    const form = new URLSearchParams()
    form.set("secret", secret)
    form.set("response", token)
    if (remoteIp) form.set("remoteip", remoteIp)

    const resp = await fetch(TURNSTILE_VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      signal: AbortSignal.timeout(5000),
    })
    if (!resp.ok) return false
    const json = (await resp.json()) as TurnstileResponse
    return json.success === true
  } catch {
    return false
  }
}
