import Link from "next/link"
import { Linkedin } from "lucide-react"
import { footer } from "@/content/home"
import { CNPJ, CONTACT_EMAIL, addressLine, site, whatsappHref } from "@/content/site"

export function SiteFooter() {
  const year = new Date().getFullYear()

  // Linha legal renderiza apenas os campos preenchidos (C.1/C.3 pendentes) + CNPJ fixo
  const legalLine = [site.legalName, `CNPJ ${CNPJ}`, addressLine()].filter(Boolean).join(" · ")

  const whatsapp = whatsappHref()

  return (
    <footer className="bg-altea-navy px-4 py-12 text-white">
      <div className="container mx-auto max-w-6xl">
        <div className="grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-5">
          <div className="sm:col-span-2">
            <Link href="/" className="flex items-center gap-3" aria-label="AlteaPay, ir para a página inicial">
              <span className="rounded-lg bg-altea-gold p-1.5" aria-hidden="true">
                <span className="flex h-5 w-5 items-center justify-center rounded-sm bg-altea-navy">
                  <span className="text-xs font-bold text-altea-gold">A</span>
                </span>
              </span>
              <span className="text-lg font-semibold">AlteaPay</span>
            </Link>
            <p className="mt-4 max-w-sm text-sm text-blue-100">{footer.description}</p>
            {site.linkedinUrl ? (
              <a
                href={site.linkedinUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-4 inline-flex items-center gap-2 text-sm text-blue-100 transition-colors hover:text-altea-gold"
              >
                <Linkedin className="h-4 w-4" aria-hidden="true" />
                LinkedIn
              </a>
            ) : null}
          </div>

          <nav aria-label={footer.nav.title}>
            <h2 className="mb-4 font-semibold">{footer.nav.title}</h2>
            <ul className="space-y-2 text-sm">
              {footer.nav.links.map((link) => (
                <li key={link.href}>
                  <a href={link.href} className="text-blue-100 transition-colors hover:text-altea-gold">
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>

          <nav aria-label={footer.access.title}>
            <h2 className="mb-4 font-semibold">{footer.access.title}</h2>
            <ul className="space-y-2 text-sm">
              {footer.access.links.map((link) => (
                <li key={link.href}>
                  <Link href={link.href} className="text-blue-100 transition-colors hover:text-altea-gold">
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>

          <div>
            <nav aria-label={footer.legal.title}>
              <h2 className="mb-4 font-semibold">{footer.legal.title}</h2>
              <ul className="space-y-2 text-sm">
                {footer.legal.links.map((link) => (
                  <li key={link.href}>
                    <a href={link.href} className="text-blue-100 transition-colors hover:text-altea-gold">
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
            <h2 className="mb-4 mt-6 font-semibold">{footer.contactTitle}</h2>
            <ul className="space-y-2 text-sm">
              <li>
                <a href={`mailto:${CONTACT_EMAIL}`} className="text-blue-100 transition-colors hover:text-altea-gold">
                  {CONTACT_EMAIL}
                </a>
              </li>
              {whatsapp ? (
                <li>
                  <a
                    href={whatsapp}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-100 transition-colors hover:text-altea-gold"
                  >
                    WhatsApp
                  </a>
                </li>
              ) : null}
            </ul>
          </div>
        </div>

        <div className="mt-10 border-t border-white/20 pt-6 text-center text-xs text-blue-100 sm:text-sm">
          <p>
            {legalLine} · © {year} AlteaPay. Todos os direitos reservados.
          </p>
        </div>
      </div>
    </footer>
  )
}
