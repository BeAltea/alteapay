import type { LucideIcon } from "lucide-react"
import { BarChart3, Clock, Code, CreditCard, Database, Handshake, LayoutDashboard } from "lucide-react"
import { Section } from "./section"
import { features } from "@/content/home"

const icons: Record<(typeof features.items)[number]["icon"], LucideIcon> = {
  clock: Clock,
  handshake: Handshake,
  layout: LayoutDashboard,
  "credit-card": CreditCard,
  database: Database,
  "bar-chart": BarChart3,
  code: Code,
}

export function Features() {
  return (
    <Section id="solucoes" labelledBy="solucoes-title" className="bg-white text-altea-navy">
      <h2 id="solucoes-title" className="text-center text-3xl font-bold text-altea-navy sm:text-4xl">
        {features.h2}
      </h2>
      <div className="mt-10 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {features.items.map((item) => {
          const Icon = icons[item.icon]
          return (
            <article key={item.title} className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
              <span className="inline-flex rounded-lg bg-altea-navy p-3" aria-hidden="true">
                <Icon className="h-6 w-6 text-altea-gold" />
              </span>
              <h3 className="mt-4 text-lg font-semibold text-altea-navy">{item.title}</h3>
              <p className="mt-2 text-gray-600">{item.description}</p>
            </article>
          )
        })}
      </div>
    </Section>
  )
}
