import { Section } from "./section"
import { howItWorks } from "@/content/home"

export function HowItWorks() {
  return (
    <Section id="como-funciona" labelledBy="como-funciona-title" className="bg-gray-50">
      <h2 id="como-funciona-title" className="text-center text-3xl font-bold text-altea-navy sm:text-4xl">
        {howItWorks.h2}
      </h2>
      <ol className="mt-10 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
        {howItWorks.steps.map((step, index) => (
          <li key={step.title} className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
            <span
              className="flex h-10 w-10 items-center justify-center rounded-full bg-altea-navy text-lg font-bold text-altea-gold"
              aria-hidden="true"
            >
              {index + 1}
            </span>
            <h3 className="mt-4 text-lg font-semibold text-altea-navy">{step.title}</h3>
            <p className="mt-2 text-gray-600">{step.description}</p>
          </li>
        ))}
      </ol>
    </Section>
  )
}
