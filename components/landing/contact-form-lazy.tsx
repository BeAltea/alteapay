"use client"

import dynamic from "next/dynamic"

/**
 * Carrega o formulario (react-hook-form + zod) em chunk proprio, fora do
 * First Load JS da home. O chunk baixa logo apos a hidratacao; o placeholder
 * reserva altura para evitar salto de layout na secao (abaixo da dobra).
 */
export const ContactFormLazy = dynamic(() => import("./contact-form").then((mod) => mod.ContactForm), {
  ssr: false,
  loading: () => <div className="mt-10 min-h-[560px]" aria-hidden="true" />,
})
