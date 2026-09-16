"use client"

import { useEffect, useState } from "react"
import type React from "react"
import Link from "next/link"
import { Mail, MessageCircle } from "lucide-react"
import { submitContactLead } from "@/app/actions/contact-lead"
import { citizenNotice, contact } from "@/content/home"
import { CONTACT_EMAIL, PRIVACY_URL, whatsappHref as buildWhatsappHref } from "@/content/site"

type ContactType = "empresa" | "orgao_publico" | "recebi_cobranca"

interface FormState {
  nome: string
  email: string
  telefone: string
  organizacao: string
  tipo: ContactType
  mensagem: string
  lgpd: boolean
  campo_site: string
}

const INITIAL_FORM: FormState = {
  nome: "",
  email: "",
  telefone: "",
  organizacao: "",
  tipo: "empresa",
  mensagem: "",
  lgpd: false,
  campo_site: "",
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function tipoFromQuery(value: string | null): ContactType | null {
  if (!value) return null
  if (value === "publico" || value === "orgao_publico") return "orgao_publico"
  if (value === "empresa") return "empresa"
  if (value === "cobranca" || value === "recebi_cobranca") return "recebi_cobranca"
  return null
}

export function Contact() {
  const [form, setForm] = useState<FormState>(INITIAL_FORM)
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({})
  const [status, setStatus] = useState<"idle" | "sending" | "success" | "error">("idle")
  const [serverError, setServerError] = useState("")

  // Le ?tipo= da URL para pre-selecionar (sem useSearchParams para nao
  // quebrar a renderizacao estatica da pagina)
  useEffect(() => {
    const tipo = tipoFromQuery(new URLSearchParams(window.location.search).get("tipo"))
    if (tipo) {
      setForm((current) => ({ ...current, tipo }))
    }
  }, [])

  const whatsappHref = buildWhatsappHref()
  const isCitizen = form.tipo === "recebi_cobranca"

  const setField = <K extends keyof FormState>(field: K, value: FormState[K]) => {
    setForm((current) => ({ ...current, [field]: value }))
    setErrors((current) => ({ ...current, [field]: undefined }))
  }

  const validate = (): boolean => {
    const nextErrors: Partial<Record<keyof FormState, string>> = {}

    if (form.nome.trim().length < 2) nextErrors.nome = "Informe seu nome."
    if (!EMAIL_REGEX.test(form.email.trim())) nextErrors.email = "Informe um e-mail válido."
    if (!form.mensagem.trim()) nextErrors.mensagem = "Escreva uma mensagem."
    if (!form.lgpd) nextErrors.lgpd = "É preciso concordar com a Política de Privacidade."

    setErrors(nextErrors)
    return Object.keys(nextErrors).length === 0
  }

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (isCitizen || status === "sending") return
    if (!validate()) return

    setStatus("sending")
    setServerError("")

    try {
      const result = await submitContactLead({
        nome: form.nome.trim(),
        email: form.email.trim(),
        telefone: form.telefone.trim(),
        organizacao: form.organizacao.trim(),
        tipo: form.tipo,
        mensagem: form.mensagem.trim(),
        lgpd: form.lgpd,
        campo_site: form.campo_site,
      })

      if (result.ok) {
        setStatus("success")
        setForm(INITIAL_FORM)
      } else {
        setStatus("error")
        setServerError(result.error || contact.errorMessage)
      }
    } catch {
      setStatus("error")
      setServerError(contact.errorMessage)
    }
  }

  const inputClass =
    "w-full rounded-lg border border-gray-300 bg-white px-4 py-2.5 text-altea-navy focus:border-altea-navy focus:outline-none focus:ring-2 focus:ring-altea-navy/30"

  return (
    <section id="contato" aria-labelledby="contato-title" className="scroll-mt-16 bg-gray-50 py-12 sm:py-16 lg:py-20">
      <div className="container mx-auto max-w-6xl px-4">
        <div className="mx-auto max-w-2xl">
          <h2 id="contato-title" className="text-center text-3xl font-bold text-altea-navy sm:text-4xl">
            {contact.h2}
          </h2>
          <p className="mt-4 text-center text-lg text-gray-600">{contact.intro}</p>

          <form className="mt-10 space-y-5" onSubmit={handleSubmit} noValidate>
            {/* Honeypot: campo invisivel para pessoas, iscas para bots */}
            <input
              type="text"
              name="campo_site"
              value={form.campo_site}
              onChange={(event) => setField("campo_site", event.target.value)}
              tabIndex={-1}
              autoComplete="off"
              aria-hidden="true"
              className="hidden"
            />

            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
              <div>
                <label htmlFor="contato-nome" className="mb-1.5 block font-medium text-altea-navy">
                  Nome
                </label>
                <input
                  id="contato-nome"
                  name="nome"
                  type="text"
                  autoComplete="name"
                  required
                  value={form.nome}
                  onChange={(event) => setField("nome", event.target.value)}
                  aria-invalid={Boolean(errors.nome)}
                  aria-describedby={errors.nome ? "contato-nome-erro" : undefined}
                  className={inputClass}
                />
                {errors.nome ? (
                  <p id="contato-nome-erro" className="mt-1 text-sm text-red-600">
                    {errors.nome}
                  </p>
                ) : null}
              </div>

              <div>
                <label htmlFor="contato-email" className="mb-1.5 block font-medium text-altea-navy">
                  E-mail
                </label>
                <input
                  id="contato-email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                  value={form.email}
                  onChange={(event) => setField("email", event.target.value)}
                  aria-invalid={Boolean(errors.email)}
                  aria-describedby={errors.email ? "contato-email-erro" : undefined}
                  className={inputClass}
                />
                {errors.email ? (
                  <p id="contato-email-erro" className="mt-1 text-sm text-red-600">
                    {errors.email}
                  </p>
                ) : null}
              </div>

              <div>
                <label htmlFor="contato-telefone" className="mb-1.5 block font-medium text-altea-navy">
                  Telefone/WhatsApp <span className="font-normal text-gray-500">(opcional)</span>
                </label>
                <input
                  id="contato-telefone"
                  name="telefone"
                  type="tel"
                  autoComplete="tel"
                  value={form.telefone}
                  onChange={(event) => setField("telefone", event.target.value)}
                  className={inputClass}
                />
              </div>

              <div>
                <label htmlFor="contato-organizacao" className="mb-1.5 block font-medium text-altea-navy">
                  Organização <span className="font-normal text-gray-500">(opcional)</span>
                </label>
                <input
                  id="contato-organizacao"
                  name="organizacao"
                  type="text"
                  autoComplete="organization"
                  value={form.organizacao}
                  onChange={(event) => setField("organizacao", event.target.value)}
                  className={inputClass}
                />
              </div>
            </div>

            <div>
              <label htmlFor="contato-tipo" className="mb-1.5 block font-medium text-altea-navy">
                Sou
              </label>
              <select
                id="contato-tipo"
                name="tipo"
                value={form.tipo}
                onChange={(event) => setField("tipo", event.target.value as ContactType)}
                className={inputClass}
              >
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
                    name="mensagem"
                    required
                    rows={5}
                    value={form.mensagem}
                    onChange={(event) => setField("mensagem", event.target.value)}
                    aria-invalid={Boolean(errors.mensagem)}
                    aria-describedby={errors.mensagem ? "contato-mensagem-erro" : undefined}
                    className={inputClass}
                  />
                  {errors.mensagem ? (
                    <p id="contato-mensagem-erro" className="mt-1 text-sm text-red-600">
                      {errors.mensagem}
                    </p>
                  ) : null}
                </div>

                <div>
                  <div className="flex items-start gap-2.5">
                    <input
                      id="contato-lgpd"
                      name="lgpd"
                      type="checkbox"
                      checked={form.lgpd}
                      onChange={(event) => setField("lgpd", event.target.checked)}
                      aria-invalid={Boolean(errors.lgpd)}
                      aria-describedby={errors.lgpd ? "contato-lgpd-erro" : undefined}
                      className="mt-1 h-4 w-4 accent-[var(--color-altea-navy)]"
                    />
                    <label htmlFor="contato-lgpd" className="text-sm text-gray-600">
                      Li e concordo com a{" "}
                      <a
                        href={PRIVACY_URL}
                        className="font-medium text-altea-navy underline underline-offset-4"
                      >
                        Política de Privacidade
                      </a>
                      .
                    </label>
                  </div>
                  {errors.lgpd ? (
                    <p id="contato-lgpd-erro" className="mt-1 text-sm text-red-600">
                      {errors.lgpd}
                    </p>
                  ) : null}
                </div>

                <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                  <button
                    type="submit"
                    disabled={status === "sending"}
                    className="rounded-lg bg-altea-navy px-6 py-3 font-semibold text-white transition-colors hover:bg-altea-navy-light disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {status === "sending" ? "Enviando..." : contact.submitLabel}
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
        </div>
      </div>
    </section>
  )
}
