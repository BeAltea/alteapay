import { CheckCircle } from "lucide-react"
import { Section } from "./section"
import { companies } from "@/content/home"

export function Companies() {
  return (
    <Section id="empresas" labelledBy="empresas-title" className="bg-altea-navy text-white">
      <div className="max-w-3xl">
        <h2 id="empresas-title" className="text-3xl font-bold sm:text-4xl">
          {companies.h2}
        </h2>
        <p className="mt-4 text-lg text-blue-100">{companies.intro}</p>
        <ul className="mt-6 space-y-3">
          {companies.bullets.map((bullet) => (
            <li key={bullet} className="flex items-start gap-3 text-blue-100">
              <CheckCircle className="mt-1 h-5 w-5 shrink-0 text-altea-gold" aria-hidden="true" />
              {bullet}
            </li>
          ))}
        </ul>
        <a
          href={companies.cta.href}
          className="mt-8 inline-block rounded-lg bg-altea-gold px-6 py-3 font-semibold text-altea-navy transition-colors hover:bg-altea-gold-bright"
        >
          {companies.cta.label}
        </a>
      </div>
    </Section>
  )
}
