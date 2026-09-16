import Link from "next/link"
import { CheckCircle } from "lucide-react"
import { hero, siteConfig } from "@/content/home"

export function Hero() {
  const whatsappHref = siteConfig.whatsappNumber ? `https://wa.me/${siteConfig.whatsappNumber}` : null

  return (
    <section aria-labelledby="hero-title" className="bg-altea-navy px-4 py-14 text-white sm:py-20 lg:py-24">
      <div className="container mx-auto max-w-6xl">
        <div className="max-w-3xl">
          <h1 id="hero-title" className="text-balance text-3xl font-bold sm:text-4xl lg:text-5xl">
            {hero.h1}
          </h1>
          <p className="mt-6 text-pretty text-lg text-blue-100 sm:text-xl">{hero.subtitle}</p>

          <div className="mt-8 flex flex-col gap-4 sm:flex-row">
            <a
              href={hero.ctaPrimary.href}
              className="rounded-lg bg-altea-gold px-6 py-3 text-center font-semibold text-altea-navy transition-colors hover:bg-altea-gold-bright"
            >
              {hero.ctaPrimary.label}
            </a>
            {whatsappHref ? (
              <a
                href={whatsappHref}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-lg border border-white/60 px-6 py-3 text-center font-medium text-white transition-colors hover:border-altea-gold hover:text-altea-gold"
              >
                {hero.ctaWhatsAppLabel}
              </a>
            ) : (
              <a
                href={hero.ctaFallback.href}
                className="rounded-lg border border-white/60 px-6 py-3 text-center font-medium text-white transition-colors hover:border-altea-gold hover:text-altea-gold"
              >
                {hero.ctaFallback.label}
              </a>
            )}
          </div>

          <p className="mt-6">
            <Link
              href={hero.loginLink.href}
              className="text-sm text-blue-100 underline underline-offset-4 transition-colors hover:text-altea-gold"
            >
              {hero.loginLink.label}
            </Link>
          </p>
        </div>

        <ul className="mt-12 grid grid-cols-1 gap-3 border-t border-white/10 pt-8 sm:grid-cols-2 lg:grid-cols-4">
          {hero.trustBand.map((item) => (
            <li key={item} className="flex items-center gap-2 text-sm text-blue-100">
              <CheckCircle className="h-4 w-4 shrink-0 text-altea-gold" aria-hidden="true" />
              {item}
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}
