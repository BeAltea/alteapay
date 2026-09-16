import { ShieldCheck } from "lucide-react"
import { Section } from "./section"
import { compliance, siteConfig } from "@/content/home"

export function Compliance() {
  return (
    <Section id="conformidade" labelledBy="conformidade-title" className="bg-gray-50">
      <h2 id="conformidade-title" className="text-center text-3xl font-bold text-altea-navy sm:text-4xl">
        {compliance.h2}
      </h2>
      <div className="mt-10 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {compliance.items.map((item) => (
          <article key={item.title} className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
            <span className="inline-flex rounded-lg bg-altea-navy p-3" aria-hidden="true">
              <ShieldCheck className="h-6 w-6 text-altea-gold" />
            </span>
            <h3 className="mt-4 text-lg font-semibold text-altea-navy">{item.title}</h3>
            <p className="mt-2 text-gray-600">
              {item.description}
              {/* C.11: mencao ao encarregado so renderiza com o DPO preenchido */}
              {item.title === "LGPD" && siteConfig.dpo ? ` Encarregado nomeado: ${siteConfig.dpo}.` : null}
            </p>
            {"link" in item && item.link ? (
              <a
                href={item.link.href}
                className="mt-3 inline-block font-medium text-altea-navy underline underline-offset-4 transition-colors hover:text-altea-navy-light"
              >
                {item.link.label}
              </a>
            ) : null}
          </article>
        ))}
      </div>
    </Section>
  )
}
