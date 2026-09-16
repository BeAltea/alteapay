import { Section } from "./section"
import { pricingModels } from "@/content/home"

export function PricingModels() {
  return (
    <Section id="modelos" labelledBy="modelos-title" className="bg-white">
      <h2 id="modelos-title" className="text-center text-3xl font-bold text-altea-navy sm:text-4xl">
        {pricingModels.h2}
      </h2>
      <div className="mt-10 grid grid-cols-1 gap-6 lg:grid-cols-3">
        {pricingModels.items.map((item) => (
          <article key={item.title} className="rounded-xl border border-gray-200 bg-white p-6 text-center shadow-sm">
            <h3 className="text-lg font-semibold text-altea-navy">{item.title}</h3>
            <p className="mt-2 text-gray-600">{item.description}</p>
          </article>
        ))}
      </div>
      <p className="mt-8 text-center text-gray-600">{pricingModels.note}</p>
    </Section>
  )
}
