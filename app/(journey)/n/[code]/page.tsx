// Entrada do LINK ÚNICO /n/{code} (Hub §1): tela neutra com uma linha do que é,
// campo ÚNICO CPF ou CNPJ (máscara dinâmica), consentimento LGPD e captcha
// quando ligado. NADA da dívida antes de autenticar; a marca do credor só
// aparece pós-login (o layout decide via cookie de sessão).
//
// Link inválido/desligado/expirado → o layout já renderiza a casca neutra "não
// há negociação disponível"; aqui devolvemos notFound() para não montar o form
// (o gate/middleware não bloqueia /n para não vazar por status).
import { notFound } from "next/navigation"
import { PublicAuthForm } from "@/components/journey/public-auth-form"
import { captchaEnabled, captchaSiteKey } from "@/lib/journey/captcha"
import { loadPublicLinkTenant } from "./_lib/tenant"

export const dynamic = "force-dynamic"

export default async function PublicLinkPage({
  params,
}: {
  params: Promise<{ code: string }>
}) {
  if (process.env.CHAT_JOURNEY_ENABLED !== "true") notFound()
  const { code } = await params
  const result = await loadPublicLinkTenant(code)
  // ok:false → o layout mostra a casca neutra; o children não deve montar o form.
  if (!result.ok) return null

  return (
    <PublicAuthForm
      code={code}
      successHref={`/n/${code}/chat`}
      captchaEnabled={captchaEnabled()}
      captchaSiteKey={captchaSiteKey()}
    />
  )
}
