import Link from "next/link"
import { CheckCircle, ShieldCheck } from "lucide-react"
import { Section } from "./section"
import { citizenNotice } from "@/content/home"

export function CitizenNotice() {
  return (
    <Section id="recebeu-mensagem" labelledBy="recebeu-mensagem-title" className="bg-altea-navy text-white">
      <div className="max-w-3xl">
        <h2 id="recebeu-mensagem-title" className="text-3xl font-bold sm:text-4xl">
          {citizenNotice.h2}
        </h2>
        <p className="mt-4 text-lg text-blue-100">{citizenNotice.intro}</p>

        <h3 className="mt-8 text-xl font-semibold">{citizenNotice.verifyTitle}</h3>
        <ul className="mt-4 space-y-3">
          {citizenNotice.verifyItems.map((item) => (
            <li key={item} className="flex items-start gap-3 text-blue-100">
              <ShieldCheck className="mt-1 h-5 w-5 shrink-0 text-altea-gold" aria-hidden="true" />
              {item}
            </li>
          ))}
        </ul>

        <h3 className="mt-8 text-xl font-semibold">{citizenNotice.actionsTitle}</h3>
        <ul className="mt-4 space-y-3">
          {citizenNotice.actionsItems.map((item) => (
            <li key={item} className="flex items-start gap-3 text-blue-100">
              <CheckCircle className="mt-1 h-5 w-5 shrink-0 text-altea-gold" aria-hidden="true" />
              {item}
            </li>
          ))}
        </ul>

        <div className="mt-8 flex flex-col gap-4 sm:flex-row">
          <Link
            href={citizenNotice.ctaPortal.href}
            className="rounded-lg bg-altea-gold px-6 py-3 text-center font-semibold text-altea-navy transition-colors hover:bg-altea-gold-bright"
          >
            {citizenNotice.ctaPortal.label}
          </Link>
          <a
            href={citizenNotice.ctaSupport.href}
            className="rounded-lg border border-white/60 px-6 py-3 text-center font-medium text-white transition-colors hover:border-altea-gold hover:text-altea-gold"
          >
            {citizenNotice.ctaSupport.label}
          </a>
        </div>
      </div>
    </Section>
  )
}
