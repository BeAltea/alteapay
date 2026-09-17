/**
 * Config institucional do site (fonte unica para URLs, contatos e dados legais).
 *
 * Regra de omissao: campo opcional ausente NUNCA renderiza nada (nem
 * placeholder). Componentes e JSON-LD checam a presenca antes de renderizar.
 */

export const SITE_URL = "https://alteapay.com"
export const SITE_NAME = "AlteaPay"
export const CNPJ = "65.041.795/0001-21"
export const CONTACT_EMAIL = "relacionamento@alteapay.com"
export const LOGIN_URL = "/auth/login"
export const REGISTER_URL = "/auth/register"
export const PORTAL_URL = "/auth/portal-register"
export const PRIVACY_URL = "/politica-de-privacidade"
export const TERMS_URL = "/termos-de-uso"

export interface SiteConfig {
  /** TODO_FABIO C.1 — razao social. Ausente = linha legal mostra so o CNPJ. */
  legalName?: string
  /** TODO_FABIO C.2 — WhatsApp comercial. Ausente = CTAs de WhatsApp nao renderizam (hero usa e-mail) e o JSON-LD fica sem contactPoint. */
  whatsapp?: {
    /** Numero em E.164 sem "+" (ex.: 5511999999999). */
    number: string
    /** Texto pre-preenchido da conversa no wa.me. */
    presetText: string
  }
  /** TODO_FABIO C.3 — endereco. Ausente = nao renderiza (footer e JSON-LD). */
  address?: {
    street: string
    city: string
    region: string
    postalCode?: string
  }
  /** TODO_FABIO C.10 — URL do LinkedIn. Ausente = sem sameAs no JSON-LD e sem link no footer. */
  linkedinUrl?: string
  /** TODO_FABIO C.11 — encarregado (DPO). Ausente = sem mencao a "encarregado nomeado". */
  dpo?: {
    name: string
    email: string
  }
  /** TODO_FABIO C.12 — prazo de implantacao em dias. Ausente = copy generica ("poucos dias"). */
  onboardingDays?: number
  /** Prazo de resposta prometido nos textos de contato. */
  responseTime: string
}

export const site: SiteConfig = {
  responseTime: "1 dia útil",
}

/** Link wa.me montado a partir de site.whatsapp; null quando nao configurado. */
export function whatsappHref(): string | null {
  if (!site.whatsapp) return null
  const query = site.whatsapp.presetText ? `?text=${encodeURIComponent(site.whatsapp.presetText)}` : ""
  return `https://wa.me/${site.whatsapp.number}${query}`
}

/** Endereco em linha unica para o footer; null quando nao configurado. */
export function addressLine(): string | null {
  if (!site.address) return null
  const { street, city, region, postalCode } = site.address
  return [street, `${city} - ${region}`, postalCode].filter(Boolean).join(", ")
}
