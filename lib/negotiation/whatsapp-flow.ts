// Máquina de estados do fluxo inicial de WhatsApp (canal DORMANTE):
// saudação → identidade (CPF + data) → resumo da dívida → reconhecimento
// (1-Sim 2-Não 3-Atendente) → handoff (deep link do chatbot).
//
// Estado por telefone no Redis (TTL 24h). Mensagens pré-sessão ficam
// bufferizadas e são despejadas em conversation_messages quando a sessão
// nasce (na verificação de identidade) — o schema exige session_id.
//
// Janela de 24h da Meta: fora da janela seria obrigatório template HSM
// aprovado (stub documentado em enviarTemplateForaDaJanela).

import { createHash } from "node:crypto"
import IORedis from "ioredis"

import { getWhatsAppProvider } from "@/lib/notifications/whatsapp"
import { createServiceClient } from "@/lib/supabase/service"
import { agingDays } from "./config"
import { sha256Hex } from "./crypto"
import { maskCpf, onlyDigits } from "./pii"
import { createHandoffSession, loadTenantConfig, recordMessage } from "./sessions"

const STATE_TTL_SECONDS = 24 * 3600
const MAX_IDENTITY_ATTEMPTS = 3

let redisClient: IORedis | null = null
function redis(): IORedis {
  if (!redisClient) {
    redisClient = new IORedis(process.env.REDIS_URL || "redis://localhost:6379", {
      maxRetriesPerRequest: 2,
      lazyConnect: true,
    })
    redisClient.on("error", (err) => console.warn("[whatsapp:flow] redis:", err.message))
  }
  return redisClient
}

type FlowStep = "greeting" | "awaiting_identity" | "awaiting_acknowledgment" | "closed"

interface BufferedMessage {
  direction: "inbound" | "outbound"
  content: string
  provider_message_id?: string | null
}

interface FlowState {
  step: FlowStep
  attempts: number
  session_id?: string
  company_id?: string
  customer_id?: string
  debt_id?: string
  buffered: BufferedMessage[]
}

function stateKey(phone: string): string {
  return `wa:flow:${sha256Hex(onlyDigits(phone))}`
}

async function loadState(phone: string): Promise<FlowState> {
  try {
    const raw = await redis().get(stateKey(phone))
    if (raw) return JSON.parse(raw) as FlowState
  } catch {
    /* estado novo */
  }
  return { step: "greeting", attempts: 0, buffered: [] }
}

async function saveState(phone: string, state: FlowState): Promise<void> {
  await redis().set(stateKey(phone), JSON.stringify(state), "EX", STATE_TTL_SECONDS)
}

/** DOB sintética determinística — MESMO algoritmo de app/platform_data.py do
 * agente (sha256 do documento), para as identidades de treino baterem E2E. */
export function syntheticDob(document: string): string {
  const h = createHash("sha256").update(onlyDigits(document)).digest()
  const year = 1955 + (h[0] % 45)
  const month = 1 + (h[1] % 12)
  const day = 1 + (h[2] % 28)
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
}

function parseIdentity(text: string): { document: string; dob: string } | null {
  const digits = text.replace(/[.\-/]/g, "")
  const cpfMatch = digits.match(/\b\d{11}\b/)
  if (!cpfMatch) return null
  const isoDob = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/)
  const brDob = text.match(/\b(\d{2})\/(\d{2})\/(\d{4})\b/)
  let dob: string | null = null
  if (isoDob) dob = `${isoDob[1]}-${isoDob[2]}-${isoDob[3]}`
  else if (brDob) dob = `${brDob[3]}-${brDob[2]}-${brDob[1]}`
  if (!dob) return null
  return { document: cpfMatch[0], dob }
}

async function reply(phone: string, text: string, state: FlowState): Promise<void> {
  const provider = getWhatsAppProvider()
  const result = await provider.sendMessage({ to: phone, text })
  state.buffered.push({ direction: "outbound", content: text, provider_message_id: result.id })
  if (provider.name === "mock") {
    // Outbox compartilhada p/ o simulador dev (processos web e worker distintos)
    try {
      await redis().rpush(
        `wa:mock:outbox:${onlyDigits(phone)}`,
        JSON.stringify({ text, id: result.id, at: new Date().toISOString() }),
      )
      await redis().expire(`wa:mock:outbox:${onlyDigits(phone)}`, STATE_TTL_SECONDS)
    } catch {
      /* somente conveniência de dev */
    }
  }
  // Sessão já existe → grava direto na auditoria central
  if (state.session_id && state.company_id) {
    await recordMessage({
      session: { id: state.session_id, company_id: state.company_id },
      channel: "whatsapp",
      direction: "outbound",
      sender: "system",
      content: text,
      provider_message_id: result.id,
    }).catch((err) => console.error("[whatsapp:flow] audit outbound:", err.message))
    state.buffered = []
  }
}

async function flushBuffered(state: FlowState): Promise<void> {
  if (!state.session_id || !state.company_id) return
  for (const msg of state.buffered) {
    await recordMessage({
      session: { id: state.session_id, company_id: state.company_id },
      channel: "whatsapp",
      direction: msg.direction,
      sender: msg.direction === "inbound" ? "debtor" : "system",
      content: msg.content,
      provider_message_id: msg.provider_message_id ?? null,
    }).catch((err) => console.error("[whatsapp:flow] flush:", err.message))
  }
  state.buffered = []
}

/** Parser do envelope Cloud API (formato único do webhook, independente do
 * provider de ENVIO selecionado — o mock só simplifica a saída). */
export function parseCloudApiEnvelope(payload: unknown): Array<{ from: string; text: string; messageId: string }> {
  const body = payload as {
    entry?: Array<{
      changes?: Array<{
        value?: { messages?: Array<{ from: string; id: string; text?: { body: string } }> }
      }>
    }>
  }
  const out: Array<{ from: string; text: string; messageId: string }> = []
  for (const entry of body?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const m of change.value?.messages ?? []) {
        out.push({ from: m.from, text: m.text?.body ?? "", messageId: m.id })
      }
    }
  }
  return out
}

/** Stub documentado: fora da janela de 24h a Meta exige template aprovado. */
export function enviarTemplateForaDaJanela(): never {
  throw new Error(
    "Fora da janela de 24h: envio exige template HSM aprovado pela Meta. " +
      "Fase 1 não contempla templates (ver §10 do plano) — stub proposital.",
  )
}

const GREETING =
  "Olá! Aqui é a assistente digital da AlteaPay. Estou entrando em contato sobre uma pendência financeira. " +
  "Para sua segurança, preciso confirmar sua identidade antes de qualquer informação. " +
  "Por favor, me envie seu CPF e sua data de nascimento (ex.: 111.444.777-35 1985-03-12)."

export async function processInboundMessage(phone: string, text: string, wamid: string | null): Promise<void> {
  const state = await loadState(phone)
  state.buffered.push({ direction: "inbound", content: text, provider_message_id: wamid })

  // Sessão já criada → registra inbound direto na auditoria
  if (state.session_id && state.company_id) {
    await recordMessage({
      session: { id: state.session_id, company_id: state.company_id },
      channel: "whatsapp",
      direction: "inbound",
      sender: "debtor",
      content: text,
      provider_message_id: wamid,
    }).catch((err) => console.error("[whatsapp:flow] audit inbound:", err.message))
    state.buffered = state.buffered.filter((m) => m.content !== text)
  }

  const supabase = createServiceClient()

  switch (state.step) {
    case "greeting": {
      state.step = "awaiting_identity"
      await reply(phone, GREETING, state)
      break
    }

    case "awaiting_identity": {
      const identity = parseIdentity(text)
      if (!identity) {
        await reply(
          phone,
          "Não consegui identificar os dados. Me envie o CPF (11 dígitos) e a data de nascimento (AAAA-MM-DD ou DD/MM/AAAA) na mesma mensagem, por favor.",
          state,
        )
        break
      }
      const digits = onlyDigits(identity.document)
      const { data: customers } = await supabase
        .from("customers")
        .select("id, name, document, company_id")
        .eq("document", digits)
        .range(0, 10)
      const customer = customers?.[0]
      const dobOk = customer ? identity.dob === syntheticDob(digits) : false

      if (!customer || !dobOk) {
        state.attempts += 1
        if (state.attempts >= MAX_IDENTITY_ATTEMPTS) {
          state.step = "closed"
          await reply(
            phone,
            "Por segurança, não consegui confirmar sua identidade. Um atendente humano vai assumir o contato. Obrigada!",
            state,
          )
        } else {
          await reply(
            phone,
            "Os dados não conferem. Vamos tentar de novo? Me envie o CPF e a data de nascimento do titular.",
            state,
          )
        }
        break
      }

      // Identidade OK → dívida em aberto do cliente
      const { data: debts } = await supabase
        .from("debts")
        .select("id, amount, due_date, description, company_id, status")
        .eq("customer_id", customer.id)
        .eq("company_id", customer.company_id)
        .eq("status", "pending")
        .order("amount", { ascending: false })
        .limit(1)
      const debt = debts?.[0]
      if (!debt) {
        state.step = "closed"
        await reply(
          phone,
          `Obrigada, ${customer.name.split(" ")[0]}! Não encontrei pendências em aberto no seu CPF ${maskCpf(digits)}. Se acredita que há algo em aberto, um atendente pode verificar.`,
          state,
        )
        break
      }

      // Cria a sessão (identidade verificada AQUI) e despeja o buffer
      const { session, token, deep_link } = await createHandoffSession({
        company_id: debt.company_id,
        customer_id: customer.id,
        debt_id: debt.id,
        document: digits,
        channel_origin: "whatsapp",
        identity_verified: true,
      })
      void token // em claro só dentro do deep_link enviado ao titular
      state.session_id = session.id
      state.company_id = debt.company_id
      state.customer_id = customer.id
      state.debt_id = debt.id
      await flushBuffered(state)

      const valor = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(
        Number(debt.amount),
      )
      state.step = "awaiting_acknowledgment"
      await reply(
        phone,
        `Identidade confirmada, ${customer.name.split(" ")[0]}! Encontrei uma pendência de ${valor}` +
          `${debt.description ? ` (${debt.description})` : ""}, vencida há ${agingDays(debt.due_date)} dias.\n\n` +
          "Você reconhece este débito?\n1 - Sim\n2 - Não\n3 - Falar com atendente",
        state,
      )
      // guarda o deep link para enviar no reconhecimento
      await redis().set(`wa:link:${state.session_id}`, deep_link, "EX", STATE_TTL_SECONDS)
      break
    }

    case "awaiting_acknowledgment": {
      const choice = text.trim().charAt(0)
      if (choice === "1") {
        const { data: updated } = await supabase
          .from("negotiation_sessions")
          .update({ debt_acknowledged_at: new Date().toISOString() })
          .eq("id", state.session_id!)
          .select("id")
        if (!updated?.length) console.error("[whatsapp:flow] falha ao marcar reconhecimento")
        const deepLink = (await redis().get(`wa:link:${state.session_id}`)) ?? ""
        state.step = "closed"
        await reply(
          phone,
          "Perfeito! Preparei um espaço seguro para você negociar as condições no seu ritmo. " +
            `Acesse: ${deepLink}\n\nO link é pessoal e vale por 24 horas.`,
          state,
        )
      } else if (choice === "2") {
        // Modo C: contestação → canal oficial de atendimento do credor
        const tenant = state.company_id ? await loadTenantConfig(state.company_id) : null
        const canal = tenant?.official_channel_label || "o canal oficial de atendimento do credor"
        const { data: updated } = await supabase
          .from("negotiation_sessions")
          .update({ outcome: "redirected_official" })
          .eq("id", state.session_id!)
          .select("id")
        if (!updated?.length) console.error("[whatsapp:flow] falha ao marcar contestação")
        state.step = "closed"
        await reply(
          phone,
          `Entendo. Para contestação ou revisão deste débito, o atendimento é feito por ${canal}. ` +
            "Não vou gerar nenhuma cobrança. Obrigada!",
          state,
        )
      } else if (choice === "3") {
        const { data: updated } = await supabase
          .from("negotiation_sessions")
          .update({ outcome: "handoff_human" })
          .eq("id", state.session_id!)
          .select("id")
        if (!updated?.length) console.error("[whatsapp:flow] falha ao marcar handoff")
        state.step = "closed"
        await reply(phone, "Claro! Um atendente humano vai assumir a conversa em breve. Obrigada pela paciência!", state)
      } else {
        await reply(phone, "Responda com 1 (Sim), 2 (Não) ou 3 (Falar com atendente), por favor.", state)
      }
      break
    }

    case "closed": {
      await reply(
        phone,
        "Este atendimento foi finalizado. Se recebeu um link de negociação, ele continua válido por 24 horas.",
        state,
      )
      break
    }
  }

  await saveState(phone, state)
}
