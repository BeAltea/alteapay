import { SiteHeader } from "./site-header"
import { Hero } from "./hero"
import { Audiences } from "./audiences"
import { HowItWorks } from "./how-it-works"
import { Features } from "./features"
import { Companies } from "./companies"
import { PublicSector } from "./public-sector"
import { PricingModels } from "./pricing-models"
import { Compliance } from "./compliance"
import { CitizenNotice } from "./citizen-notice"
import { Faq } from "./faq"
import { Contact } from "./contact"
import { SiteFooter } from "./site-footer"

/**
 * Composicao server-side da home, na ordem fixa do wireframe (F1_wireframe.md):
 * header → hero → para quem e → como funciona → solucoes → empresas →
 * setor publico → modelos → conformidade → recebeu mensagem → faq → contato → footer.
 */
export function LandingPage() {
  return (
    <div className="lp-root min-h-screen bg-white text-altea-navy">
      <SiteHeader />
      <main id="conteudo">
        <Hero />
        <Audiences />
        <HowItWorks />
        <Features />
        <Companies />
        <PublicSector />
        <PricingModels />
        <Compliance />
        <CitizenNotice />
        <Faq />
        <Contact />
      </main>
      <SiteFooter />
    </div>
  )
}
