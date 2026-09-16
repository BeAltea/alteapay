import { ArrowRight } from "lucide-react"
import { Section } from "./section"
import { audiences } from "@/content/home"

export function Audiences() {
  return (
    <Section id="para-quem" labelledBy="para-quem-title" className="bg-white text-altea-navy">
      <h2 id="para-quem-title" className="text-center text-3xl font-bold text-altea-navy sm:text-4xl">
        {audiences.h2}
      </h2>
      <div className="mt-10 grid grid-cols-1 gap-6 lg:grid-cols-3">
        {audiences.items.map((item) => (
          <article key={item.title} className="flex flex-col rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
            <h3 className="text-lg font-semibold text-altea-navy">{item.title}</h3>
            <p className="mt-2 flex-1 text-gray-600">{item.description}</p>
            <a
              href={item.link.href}
              className="mt-4 inline-flex items-center gap-1 font-medium text-altea-navy underline underline-offset-4 transition-colors hover:text-altea-navy-light"
            >
              {item.link.label}
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </a>
          </article>
        ))}
      </div>
    </Section>
  )
}
