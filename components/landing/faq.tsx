import { ChevronDown } from "lucide-react"
import { Section } from "./section"
import { faq } from "@/content/home"

export function Faq() {
  return (
    <Section id="faq" labelledBy="faq-title" className="bg-white">
      <h2 id="faq-title" className="text-center text-3xl font-bold text-altea-navy sm:text-4xl">
        {faq.h2}
      </h2>
      <div className="mx-auto mt-10 max-w-3xl space-y-3">
        {faq.items.map((item, index) => (
          <details
            key={item.question}
            className="lp-details rounded-xl border border-gray-200 bg-white shadow-sm"
            open={index === 0}
          >
            <summary className="flex items-center justify-between gap-4 p-5 font-semibold text-altea-navy">
              {item.question}
              <ChevronDown className="lp-details-icon h-5 w-5 shrink-0 text-altea-navy" aria-hidden="true" />
            </summary>
            <p className="px-5 pb-5 text-gray-600">{item.answer}</p>
          </details>
        ))}
      </div>
    </Section>
  )
}
