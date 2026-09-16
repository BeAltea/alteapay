import { CheckCircle } from "lucide-react"
import { Section } from "./section"
import { publicSector } from "@/content/home"

export function PublicSector() {
  return (
    <Section id="setor-publico" labelledBy="setor-publico-title" className="bg-gray-50">
      <div className="max-w-3xl">
        <h2 id="setor-publico-title" className="text-3xl font-bold text-altea-navy sm:text-4xl">
          {publicSector.h2}
        </h2>
        <p className="mt-4 text-lg text-gray-600">{publicSector.intro}</p>
        <ul className="mt-6 space-y-3">
          {publicSector.bullets.map((bullet) => (
            <li key={bullet} className="flex items-start gap-3 text-gray-600">
              <CheckCircle className="mt-1 h-5 w-5 shrink-0 text-altea-navy" aria-hidden="true" />
              {bullet}
            </li>
          ))}
        </ul>
        {/* Link com query ?tipo=publico: navegacao completa para o form pre-selecionar o tipo */}
        <a
          href={publicSector.cta.href}
          className="mt-8 inline-block rounded-lg bg-altea-navy px-6 py-3 font-semibold text-white transition-colors hover:bg-altea-navy-light"
        >
          {publicSector.cta.label}
        </a>
        <p className="mt-4 text-sm text-gray-500">{publicSector.note}</p>
      </div>
    </Section>
  )
}
