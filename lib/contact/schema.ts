import { z } from "zod"

/**
 * Schema compartilhado do formulario de contato da home.
 * Usado pelo client (react-hook-form + zodResolver) e pela server action
 * (safeParse) — sem "use server" aqui para poder ser importado dos dois lados.
 */

export const CONTACT_TIPOS = ["empresa", "orgao_publico", "recebi_cobranca"] as const
export type ContactTipo = (typeof CONTACT_TIPOS)[number]

export const contactLeadSchema = z.object({
  nome: z.string().trim().min(2, "Informe seu nome.").max(80, "Use no máximo 80 caracteres."),
  email: z.string().trim().email("Informe um e-mail válido."),
  telefone: z
    .string()
    .optional()
    .transform((value) => (value ?? "").replace(/\D/g, ""))
    .refine((digits) => digits === "" || (digits.length >= 10 && digits.length <= 13), {
      message: "Informe um telefone com DDD (10 a 13 dígitos).",
    }),
  organizacao: z
    .string()
    .trim()
    .min(2, "Informe a organização.")
    .max(120, "Use no máximo 120 caracteres."),
  tipo: z.enum(CONTACT_TIPOS),
  mensagem: z
    .string()
    .trim()
    .min(10, "Conte um pouco mais (mínimo de 10 caracteres).")
    .max(2000, "Use no máximo 2000 caracteres."),
  consentimento: z.literal(true, {
    errorMap: () => ({ message: "É preciso concordar com a Política de Privacidade." }),
  }),
  // Honeypot: humanos nunca preenchem este campo
  campo_site: z.string().optional(),
})

/** Valores do formulario (antes do parse) — tipo dos campos no react-hook-form. */
export interface ContactLeadFormValues {
  nome: string
  email: string
  telefone: string
  organizacao: string
  tipo: ContactTipo
  mensagem: string
  consentimento: boolean
  campo_site: string
}

/** Dados validados/transformados (saida do schema). */
export type ContactLead = z.output<typeof contactLeadSchema>
