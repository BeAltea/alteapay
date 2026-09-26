"use server"

import { clientIpFromHeaders } from "@/lib/journey/client-ip"
import { headers } from "next/headers"
import { sendEmailViaSendGrid } from "@/lib/notifications/sendgrid"
import { CONTACT_EMAIL } from "@/content/site"
import { contactLeadSchema, type ContactLeadFormValues } from "@/lib/contact/schema"

const TIPO_LABELS: Record<string, string> = {
  empresa: "Empresa",
  orgao_publico: "Órgão público",
}

export interface ContactLeadResult {
  ok: boolean
  error?: string
}

/**
 * Rate limit best-effort em memoria por IP (5 envios/minuto).
 * Limitacao documentada: o Map vive por instancia de funcao/processo; em
 * ambiente serverless (Netlify) cada instancia tem seu proprio contador e o
 * estado zera em cold start. Serve como barreira leve contra rajadas, nao
 * como protecao definitiva.
 */
const RATE_LIMIT_MAX = 5
const RATE_LIMIT_WINDOW_MS = 60_000
const rateLimitByIp: Map<string, number[]> = new Map()

function isRateLimited(ip: string): boolean {
  const now = Date.now()
  const windowStart = now - RATE_LIMIT_WINDOW_MS
  const recent = (rateLimitByIp.get(ip) || []).filter((timestamp) => timestamp > windowStart)

  if (recent.length >= RATE_LIMIT_MAX) {
    rateLimitByIp.set(ip, recent)
    return true
  }

  recent.push(now)
  rateLimitByIp.set(ip, recent)
  return false
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

export async function submitContactLead(input: ContactLeadFormValues): Promise<ContactLeadResult> {
  const startedAt = Date.now()
  const log = (tipo: string, ok: boolean) => {
    // Sem PII nos logs: apenas tipo, resultado e duracao
    console.log("[contact-lead]", { tipo, ok, durationMs: Date.now() - startedAt })
  }

  const parsed = contactLeadSchema.safeParse(input)
  if (!parsed.success) {
    log(typeof input?.tipo === "string" ? input.tipo : "invalido", false)
    return { ok: false, error: "Dados inválidos. Verifique os campos e tente novamente." }
  }

  const lead = parsed.data

  // Honeypot preenchido (verificado DEPOIS do parse): responde sucesso falso,
  // sem enviar nada, para nao dar sinal ao bot
  if (lead.campo_site) {
    log(lead.tipo, true)
    return { ok: true }
  }

  // Este tipo nunca deve chegar aqui (o cliente mostra orientacao e nao envia)
  if (lead.tipo === "recebi_cobranca") {
    log(lead.tipo, false)
    return {
      ok: false,
      error: "Para consultar ou negociar uma cobrança, acesse o Portal do Cliente.",
    }
  }

  const requestHeaders = headers()
  // QA rodada 5 (Q1-5): IP só de cabeçalho de proxy confiável (nunca o 1º do XFF).
  const ip = clientIpFromHeaders(requestHeaders) ?? "desconhecido"

  if (isRateLimited(ip)) {
    log(lead.tipo, false)
    return { ok: false, error: "Muitas tentativas. Aguarde um minuto e tente novamente." }
  }

  const tipoLabel = TIPO_LABELS[lead.tipo] || lead.tipo
  const subject = `[Site] Novo contato: ${tipoLabel}${lead.organizacao ? ` · ${lead.organizacao}` : ""}`

  const lines = [
    `Nome: ${lead.nome}`,
    `E-mail: ${lead.email}`,
    `Telefone/WhatsApp: ${lead.telefone || "(nao informado)"}`,
    `Organizacao: ${lead.organizacao || "(nao informada)"}`,
    `Tipo: ${tipoLabel}`,
    "",
    "Mensagem:",
    lead.mensagem,
  ]
  const text = lines.join("\n")
  const html = `<pre style="font-family: inherit; white-space: pre-wrap;">${escapeHtml(text)}</pre>`

  if (process.env.CONTACT_FORM_DRY_RUN === "true") {
    console.log("[contact-lead] dry-run", { tipo: lead.tipo, ok: true })
    log(lead.tipo, true)
    return { ok: true }
  }

  try {
    const result = await sendEmailViaSendGrid({
      to: CONTACT_EMAIL,
      subject,
      html,
      text,
      replyTo: lead.email,
    })

    log(lead.tipo, result.success)

    if (!result.success) {
      return { ok: false, error: "Não foi possível enviar sua mensagem. Tente novamente em instantes." }
    }

    return { ok: true }
  } catch {
    log(lead.tipo, false)
    return { ok: false, error: "Não foi possível enviar sua mensagem. Tente novamente em instantes." }
  }
}
