import type React from "react"
import { cn } from "@/lib/utils"

interface SectionProps {
  id: string
  labelledBy: string
  className?: string
  containerClassName?: string
  children: React.ReactNode
}

/**
 * Wrapper padrao de secao da landing: ancora com scroll-mt-16 (header sticky de
 * 64px), aria-labelledby apontando para o H2 da secao e container centralizado.
 */
export function Section({ id, labelledBy, className, containerClassName, children }: SectionProps) {
  return (
    <section id={id} aria-labelledby={labelledBy} className={cn("scroll-mt-16 py-12 sm:py-16 lg:py-20", className)}>
      <div className={cn("container mx-auto max-w-6xl px-4", containerClassName)}>{children}</div>
    </section>
  )
}
