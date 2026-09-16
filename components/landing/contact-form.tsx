"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { useForm, type Resolver } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { Mail, MessageCircle } from "lucide-react"
import { submitContactLead } from "@/app/actions/contact-lead"
import { citizenNotice, contact } from "@/content/home"
import { CONTACT_EMAIL, PRIVACY_URL, whatsappHref as buildWhatsappHref } from "@/content/site"
import { contactLeadSchema, type ContactLeadFormValues, type ContactTipo } from "@/lib/contact/schema"

const DEFAULT_VALUES: ContactLeadFormValues = {
  nome: "",
  email: "",
  telefone: "",
  organizacao: "",
  tipo: "empresa",
  mensagem: "",
  consentimento: false,
  campo_site: "",
}

function tipoFromQuery(value: string | null): ContactTipo | null {
  if (!value) return null
  if (value === "publico" || value === "orgao_publico") return "orgao_publico"
  if (value === "empresa") return "empresa"
  if (value === "cobranca" || value === "recebi_cobranca") return "recebi_cobranca"
  return null
}

export function ContactForm() {
  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<ContactLeadFormValues>({
    resolver: zodResolver(contactLeadSchema) as Resolver<ContactLeadFormValues>,
    defaultValues: DEFAULT_VALUES,
  })

  const [status, setStatus] = useState<"idle" | "success" | "error">("idle")
  const [serverError, setServerError] = useState("")

  // Le ?tipo= da URL para pre-selecionar (window.location.search em useEffect;
  // NUNCA useSearchParams, para nao quebrar a renderizacao estatica da pagina)
  useEffect(() => {
    const tipo = tipoFromQuery(new URLSearchParams(window.location.search).get("tipo"))
    if (tipo) {
      setValue("tipo", tipo)
    }
  }, [setValue])

  const whatsappHref = buildWhatsappHref()
  const isCitizen = watch("tipo") === "recebi_cobranca"

  const onSubmit = handleSubmit(async (values) => {
    if (isCitizen) return

    setStatus("idle")
    setServerError("")

    try {
      const result = await submitContactLead(values)

      if (result.ok) {
        setStatus("success")
        reset(DEFAULT_VALUES)
      } else {
        setStatus("error")
        setServerError(result.error || contact.errorMessage)
      }
    } catch {
      setStatus("error")
      setServerError(contact.errorMessage)
    }
  })

  const inputClass =
    "w-full rounded-lg border border-gray-300 bg-white px-4 py-2.5 text-altea-navy focus:border-altea-navy focus:outline-none focus:ring-2 focus:ring-altea-navy/30"

  return (
    <form className="mt-10 space-y-5" onSubmit={onSubmit} noValidate>
      {/* Honeypot: campo invisivel para pessoas, isca para bots */}
      <input
        type="text"
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        className="hidden"
        {...register("campo_site")}
      />

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <div>
          <label htmlFor="contato-nome" className="mb-1.5 block font-medium text-altea-navy">
            Nome
          </label>
          <input
            id="contato-nome"
            type="text"
            autoComplete="name"
            required
            aria-invalid={Boolean(errors.nome)}
            aria-describedby={errors.nome ? "contato-nome-erro" : undefined}
            className={inputClass}
            {...register("nome")}
          />
          {errors.nome ? (
            <p id="contato-nome-erro" className="mt-1 text-sm text-red-600">
              {errors.nome.message}
            </p>
          ) : null}
        </div>

        <div>
          <label htmlFor="contato-email" className="mb-1.5 block font-medium text-altea-navy">
            E-mail
          </label>
          <input
            id="contato-email"
            type="email"
            autoComplete="email"
            required
            aria-invalid={Boolean(errors.email)}
            aria-describedby={errors.email ? "contato-email-erro" : undefined}
            className={inputClass}
            {...register("email")}
          />
          {errors.email ? (
            <p id="contato-email-erro" className="mt-1 text-sm text-red-600">
              {errors.email.message}
            </p>
          ) : null}
        </div>

        <div>
          <label htmlFor="contato-telefone" className="mb-1.5 block font-medium text-altea-navy">
            Telefone/WhatsApp <span className="font-normal text-gray-500">(opcional)</span>
          </label>
          <input
            id="contato-telefone"
            type="tel"
            autoComplete="tel"
            aria-invalid={Boolean(errors.telefone)}
            aria-describedby={errors.telefone ? "contato-telefone-erro" : undefined}
            className={inputClass}
            {...register("telefone")}
          />
          {errors.telefone ? (
            <p id="contato-telefone-erro" className="mt-1 text-sm text-red-600">
              {errors.telefone.message}
            </p>
          ) : null}
        </div>

        <div>
          <label htmlFor="contato-organizacao" className="mb-1.5 block font-medium text-altea-navy">
            Organização
          </label>
          <input
            id="contato-organizacao"
            type="text"
            autoComplete="organization"
            required
            aria-invalid={Boolean(errors.organizacao)}
            aria-describedby={errors.organizacao ? "contato-organizacao-erro" : undefined}
            className={inputClass}
            {...register("organizacao")}
          />
          {errors.organizacao ? (
            <p id="contato-organizacao-erro" className="mt-1 text-sm text-red-600">
              {errors.organizacao.message}
            </p>
          ) : null}
        </div>
      </div>

      <div>
        <label htmlFor="contato-tipo" className="mb-1.5 block font-medium text-altea-navy">
          Sou
        </label>
        <select id="contato-tipo" className={inputClass} {...register("tipo")}>
          {contact.typeOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      {isCitizen ? (
        <div
          className="rounded-xl border border-altea-gold bg-white p-5 text-gray-700"
          role="status"
          aria-live="polite"
        >
          <p>{contact.citizenGuidance}</p>
          <div className="mt-4 flex flex-col gap-3 sm:flex-row">
            <Link
              href={citizenNotice.ctaPortal.href}
              className="rounded-lg bg-altea-navy px-5 py-2.5 text-center font-semibold text-white transition-colors hover:bg-altea-navy-light"
            >
              {citizenNotice.ctaPortal.label}
            </Link>
            <a
              href={`mailto:${CONTACT_EMAIL}`}
              className="rounded-lg border border-gray-300 px-5 py-2.5 text-center font-medium text-altea-navy transition-colors hover:border-altea-navy"
            >
              {CONTACT_EMAIL}
            </a>
            {whatsappHref ? (
              <a
                href={whatsappHref}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-lg border border-gray-300 px-5 py-2.5 text-center font-medium text-altea-navy transition-colors hover:border-altea-navy"
              >
                {contact.whatsappLabel}
              </a>
            ) : null}
          </div>
        </div>
      ) : (
        <>
          <div>
            <label htmlFor="contato-mensagem" className="mb-1.5 block font-medium text-altea-navy">
              Mensagem
            </label>
            <textarea
              id="contato-mensagem"
              required
              rows={5}
              aria-invalid={Boolean(errors.mensagem)}
              aria-describedby={errors.mensagem ? "contato-mensagem-erro" : undefined}
              className={inputClass}
              {...register("mensagem")}
            />
            {errors.mensagem ? (
              <p id="contato-mensagem-erro" className="mt-1 text-sm text-red-600">
                {errors.mensagem.message}
              </p>
            ) : null}
          </div>

          <div>
            <div className="flex items-start gap-2.5">
              <input
                id="contato-consentimento"
                type="checkbox"
                aria-invalid={Boolean(errors.consentimento)}
                aria-describedby={errors.consentimento ? "contato-consentimento-erro" : undefined}
                className="mt-1 h-4 w-4 accent-[var(--color-altea-navy)]"
                {...register("consentimento")}
              />
              <label htmlFor="contato-consentimento" className="text-sm text-gray-600">
                Li e concordo com a{" "}
                <a href={PRIVACY_URL} className="font-medium text-altea-navy underline underline-offset-4">
                  Política de Privacidade
                </a>
                .
              </label>
            </div>
            {errors.consentimento ? (
              <p id="contato-consentimento-erro" className="mt-1 text-sm text-red-600">
                {errors.consentimento.message}
              </p>
            ) : null}
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <button
              type="submit"
              disabled={isSubmitting}
              className="rounded-lg bg-altea-navy px-6 py-3 font-semibold text-white transition-colors hover:bg-altea-navy-light disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSubmitting ? "Enviando..." : contact.submitLabel}
            </button>
            {whatsappHref ? (
              <a
                href={whatsappHref}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-6 py-3 text-center font-medium text-altea-navy transition-colors hover:border-altea-navy"
              >
                <MessageCircle className="h-4 w-4" aria-hidden="true" />
                {contact.whatsappLabel}
              </a>
            ) : null}
            <a
              href={`mailto:${CONTACT_EMAIL}`}
              className="inline-flex items-center gap-2 font-medium text-altea-navy underline underline-offset-4 transition-colors hover:text-altea-navy-light"
            >
              <Mail className="h-4 w-4" aria-hidden="true" />
              {CONTACT_EMAIL}
            </a>
          </div>
        </>
      )}

      <p role="status" aria-live="polite" className="min-h-5 text-sm">
        {status === "success" ? <span className="font-medium text-green-700">{contact.successMessage}</span> : null}
        {status === "error" ? <span className="font-medium text-red-600">{serverError}</span> : null}
      </p>
    </form>
  )
}
