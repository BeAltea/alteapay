import type { Metadata } from "next"
import { RecoveryRedirect } from "@/components/auth/recovery-redirect"
import { LandingPage } from "@/components/landing/landing-page"
import {
  JsonLd,
  faqPageJsonLd,
  organizationJsonLd,
  softwareApplicationJsonLd,
  webSiteJsonLd,
} from "@/lib/seo/jsonld"
import { seo } from "@/content/home"

export const metadata: Metadata = {
  title: { absolute: seo.title },
  description: seo.description,
}

export default function HomePage() {
  return (
    <>
      {/* Componente para detectar e redirecionar tokens de recovery do Supabase */}
      <RecoveryRedirect />
      <JsonLd data={organizationJsonLd()} />
      <JsonLd data={webSiteJsonLd()} />
      <JsonLd data={softwareApplicationJsonLd()} />
      <JsonLd data={faqPageJsonLd()} />
      <LandingPage />
    </>
  )
}
