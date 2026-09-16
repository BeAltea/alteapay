import { createElement } from "react"
import { faq, seo } from "@/content/home"
import { CNPJ, CONTACT_EMAIL, SITE_NAME, SITE_URL, site } from "@/content/site"

type JsonLdObject = Record<string, unknown>

/**
 * Organization: campos opcionais (legalName, address, telephone, sameAs)
 * so entram quando preenchidos em content/site.ts (pendencias C.1/C.2/C.3/C.10).
 */
export function organizationJsonLd(): JsonLdObject {
  const data: JsonLdObject = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: SITE_NAME,
    url: SITE_URL,
    taxID: CNPJ,
    email: CONTACT_EMAIL,
  }

  if (site.legalName) {
    data.legalName = site.legalName
  }

  if (site.address) {
    data.address = {
      "@type": "PostalAddress",
      streetAddress: site.address.street,
      addressLocality: site.address.city,
      addressRegion: site.address.region,
      ...(site.address.postalCode ? { postalCode: site.address.postalCode } : {}),
      addressCountry: "BR",
    }
  }

  // contactPoint.telephone so existe com o WhatsApp configurado (C.2)
  if (site.whatsapp) {
    data.contactPoint = {
      "@type": "ContactPoint",
      contactType: "sales",
      telephone: `+${site.whatsapp.number}`,
      availableLanguage: "Portuguese",
    }
  }

  if (site.linkedinUrl) {
    data.sameAs = [site.linkedinUrl]
  }

  return data
}

export function webSiteJsonLd(): JsonLdObject {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: SITE_NAME,
    url: SITE_URL,
    inLanguage: "pt-BR",
  }
}

export function softwareApplicationJsonLd(): JsonLdObject {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: SITE_NAME,
    url: SITE_URL,
    description: seo.description,
    applicationCategory: "BusinessApplication",
    operatingSystem: "Web",
  }
}

/** FAQPage com exatamente as 10 perguntas aprovadas no F1_copy.md. */
export function faqPageJsonLd(): JsonLdObject {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faq.items.map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: item.answer,
      },
    })),
  }
}

export function JsonLd({ data }: { data: JsonLdObject }) {
  return createElement("script", {
    type: "application/ld+json",
    dangerouslySetInnerHTML: {
      __html: JSON.stringify(data).replace(/</g, "\\u003c"),
    },
  })
}
