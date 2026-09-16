import { createElement } from "react"
import { faq, seo, siteConfig } from "@/content/home"

type JsonLdObject = Record<string, unknown>

/**
 * Organization: campos opcionais (legalName, address, telephone, sameAs)
 * so entram quando preenchidos em siteConfig (pendencias C.1/C.2/C.3/C.10).
 */
export function organizationJsonLd(): JsonLdObject {
  const data: JsonLdObject = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: siteConfig.name,
    url: siteConfig.url,
    taxID: siteConfig.cnpj,
    email: siteConfig.email,
  }

  if (siteConfig.legalName) {
    data.legalName = siteConfig.legalName
  }

  if (siteConfig.address) {
    data.address = {
      "@type": "PostalAddress",
      streetAddress: siteConfig.address,
      addressCountry: "BR",
    }
  }

  if (siteConfig.whatsappNumber) {
    data.contactPoint = {
      "@type": "ContactPoint",
      contactType: "sales",
      telephone: `+${siteConfig.whatsappNumber}`,
      availableLanguage: "Portuguese",
    }
  }

  if (siteConfig.linkedin) {
    data.sameAs = [siteConfig.linkedin]
  }

  return data
}

export function webSiteJsonLd(): JsonLdObject {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: siteConfig.name,
    url: siteConfig.url,
    inLanguage: "pt-BR",
  }
}

export function softwareApplicationJsonLd(): JsonLdObject {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: siteConfig.name,
    url: siteConfig.url,
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
