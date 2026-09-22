// Contexto de DÉBITO para o e-mail de COBRANÇA (onda D1 — camada de dados).
//
// Monta, por devedor, os valores das 5 variáveis de débito que o template de
// cobrança (allow_debt_fields=true) injeta no CORPO do e-mail:
//   nome_cliente, documento_mascarado, valor_divida, vencimento_original,
//   qtd_faturas.
//
// FONTE ÚNICA (C4): valor/vencimento/qtd vêm de `buildAckContext` — a MESMA
// função que o chat usa no reconhecimento. NUNCA reimplementamos a soma de
// dívidas nem o vencimento mais antigo aqui: paridade total com o que o cliente
// vê no chat. Este módulo só ADICIONA nome (normalizado), documento mascarado e a
// FORMATAÇÃO pt-BR (R$ / DD/MM/AAAA) — nada de leitura de valor/vencimento própria.
//
// Cada devedor vira uma união discriminada { ok:true, ctx } | { ok:false, reason }
// com reason ESTÁVEL. O chamador (campaign-send) exclui os ok:false com o motivo,
// e falha FECHADA: um devedor sem nome/valor/vencimento/documento é EXCLUÍDO
// (nunca envia "R$ 0,00" / "-" / "{{valor_divida}}"). `link_indisponivel` é
// especial: bloqueia a CAMPANHA inteira (não é por devedor).

import { createServiceClient } from "@/lib/supabase/service"
import { buildAckContext } from "@/lib/journey/acknowledgement"
import { maskDocument, normalizeDocument, isAcceptableDocument } from "@/lib/journey/document"
import { invoiceCountPhrase } from "@/lib/email/templates/vmax-negotiation-template"

type ServiceClient = ReturnType<typeof createServiceClient>

/** Motivos ESTÁVEIS de exclusão de um devedor do e-mail de cobrança. */
export type DebtContextReason =
  | "sem_nome"
  | "sem_valor"
  | "sem_vencimento"
  | "documento_invalido"
  | "link_indisponivel"

/** Valores prontos (já formatados) das 5 variáveis de débito de UM devedor. */
export interface DebtEmailContext {
  /** Nome completo normalizado (CAPS → "Joao Da Silva"). */
  nome_cliente: string
  /** Primeiro nome (para {{primeiro_nome}}, paridade com o convite). */
  primeiro_nome: string
  /** CPF/CNPJ mascarado (via maskDocument): ***.456.789-**. */
  documento_mascarado: string
  /** Valor atualizado em pt-BR: "R$ 1.234,56". */
  valor_divida: string
  /** Vencimento original: "DD/MM/AAAA". */
  vencimento_original: string
  /** Quantidade de faturas (buildAckContext.invoiceCount) como string. */
  qtd_faturas: string
}

export type DebtEmailContextEntry =
  | { ok: true; ctx: DebtEmailContext }
  | { ok: false; reason: DebtContextReason }

/** Um devedor + as dívidas abertas dele (para o buildAckContext, sem N+1). */
export interface DebtContextInput {
  customerId: string
  debtIds: string[]
}

const PAGE_SIZE = 1000

// --- formatação pt-BR (isolada e testável) ---------------------------------

const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" })

/** "R$ 1.234,56" a partir de reais. */
export function formatBRL(value: number): string {
  return BRL.format(value)
}

/** "DD/MM/AAAA" a partir de uma data ISO/date. null/invalid → "". */
export function formatDatePtBR(iso: string | null | undefined): string {
  if (!iso) return ""
  // Aceita "YYYY-MM-DD" (date puro) sem timezone-shift: parse manual quando casar.
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (dateOnly) {
    const [, y, m, d] = dateOnly
    return `${d}/${m}/${y}`
  }
  const dt = new Date(iso)
  if (Number.isNaN(dt.getTime())) return ""
  const d = String(dt.getUTCDate()).padStart(2, "0")
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0")
  const y = dt.getUTCFullYear()
  return `${d}/${m}/${y}`
}

/**
 * Normaliza o nome para exibição: colapsa espaços e aplica Title Case
 * (CAPS/lower → "Joao Da Silva"). Mantém acentos. NÃO valida — só normaliza a
 * caixa. Devolve "" para entrada vazia.
 */
export function normalizeDisplayName(name: string | null | undefined): string {
  const raw = (name ?? "").trim().replace(/\s+/g, " ")
  if (!raw) return ""
  return raw
    .toLocaleLowerCase("pt-BR")
    .split(" ")
    .map((w) => (w ? w[0].toLocaleUpperCase("pt-BR") + w.slice(1) : w))
    .join(" ")
}

/** Nome "plausível": não vazio, não puramente numérico, ≥ 2 chars não-espaço. */
function isPlausibleName(name: string | null | undefined): boolean {
  const raw = (name ?? "").trim()
  if (raw.replace(/\s+/g, "").length < 2) return false
  if (/^\d+$/.test(raw.replace(/\s+/g, ""))) return false
  return true
}

/** Primeiro token do nome já normalizado. */
function firstNameOf(displayName: string): string {
  return displayName.split(" ")[0] ?? ""
}

interface CustomerRow {
  id: string
  name: string | null
  document: string | null
}

/**
 * Carrega em LOTE (uma query paginada, sem N+1) os customers pedidos, filtrando
 * por company_id no servidor. Usa .range() acima de 1000 (gotcha do Supabase).
 */
async function loadCustomersBatch(
  supabase: ServiceClient,
  companyId: string,
  customerIds: string[],
): Promise<Map<string, CustomerRow>> {
  const byId = new Map<string, CustomerRow>()
  // De-dup e chunk em blocos de PAGE_SIZE para o .in() (limite prático do IN).
  const unique = Array.from(new Set(customerIds))
  for (let i = 0; i < unique.length; i += PAGE_SIZE) {
    const chunk = unique.slice(i, i + PAGE_SIZE)
    const { data, error } = await supabase
      .from("customers")
      .select("id, name, document")
      .eq("company_id", companyId)
      .in("id", chunk)
      .range(0, PAGE_SIZE - 1)
    if (error) throw new Error(`resolveDebtEmailContext/customers: ${error.message}`)
    for (const row of (data ?? []) as CustomerRow[]) byId.set(row.id, row)
  }
  return byId
}

/**
 * Verifica se o LINK público do cedente está disponível (habilitado e dentro da
 * janela). Se não estiver, a campanha INTEIRA de cobrança é bloqueada
 * (link_indisponivel) — sem link não há CTA seguro para carregar dados do débito.
 * Leitura no-store (o kill-switch do link precisa refletir em tempo real).
 */
export async function isPublicLinkAvailable(companyId: string): Promise<boolean> {
  const supabase = createServiceClient({ noStore: true })
  const { data: cfg } = await supabase
    .from("tenant_chat_config")
    .select("public_link_code, public_link_enabled, public_link_valid_until")
    .eq("company_id", companyId)
    .maybeSingle()
  if (!cfg) return false
  if (!cfg.public_link_code) return false
  if (cfg.public_link_enabled === false) return false
  if (cfg.public_link_valid_until) {
    const until = new Date(cfg.public_link_valid_until as string)
    if (!Number.isNaN(until.getTime()) && until.getTime() < Date.now()) return false
  }
  return true
}

/**
 * Monta o contexto de débito por devedor para o e-mail de cobrança.
 *
 * @param companyId  cedente (isolamento no servidor).
 * @param inputs     um item por devedor com os IDs das dívidas ABERTAS dele
 *                   (os mesmos usados na elegibilidade). buildAckContext usa
 *                   esses debtIds para somar o valor e achar o vencimento.
 * @param opts.linkAvailable  já resolvido pelo chamador (isPublicLinkAvailable)?
 *                   quando FALSE, TODOS os devedores saem com link_indisponivel
 *                   (bloqueia a campanha). Se omitido, é resolvido aqui uma vez.
 *
 * Retorna Map<customerId, entry>. Cada entry é ok:true (ctx pronto) ou ok:false
 * (reason estável). REUSA buildAckContext para valor/vencimento/qtd (C4) — nunca
 * recalcula. Falha FECHADA: nome/valor/vencimento/documento faltando → excluído.
 */
export async function resolveDebtEmailContext(
  companyId: string,
  inputs: DebtContextInput[],
  opts?: { linkAvailable?: boolean },
): Promise<Map<string, DebtEmailContextEntry>> {
  const out = new Map<string, DebtEmailContextEntry>()
  if (inputs.length === 0) return out

  const supabase = createServiceClient()

  // Link fora do ar → a campanha inteira é bloqueada: todo devedor recebe
  // link_indisponivel. O chamador trata isso como falha da campanha.
  const linkAvailable =
    opts?.linkAvailable !== undefined ? opts.linkAvailable : await isPublicLinkAvailable(companyId)
  if (!linkAvailable) {
    for (const i of inputs) out.set(i.customerId, { ok: false, reason: "link_indisponivel" })
    return out
  }

  // Carrega os customers em LOTE (nome + documento). buildAckContext lê valor/
  // vencimento/qtd por devedor (C4), mas nome/documento vêm daqui em uma query.
  const customers = await loadCustomersBatch(
    supabase,
    companyId,
    inputs.map((i) => i.customerId),
  )

  for (const input of inputs) {
    const customer = customers.get(input.customerId)

    // nome: precisa ser plausível (não vazio/numérico/<2 chars).
    const displayName = normalizeDisplayName(customer?.name)
    if (!isPlausibleName(customer?.name) || !displayName) {
      out.set(input.customerId, { ok: false, reason: "sem_nome" })
      continue
    }

    // documento: precisa ser aceitável (CPF/CNPJ estrutural + DV válido).
    const rawDoc = normalizeDocument(customer?.document)
    if (!isAcceptableDocument(rawDoc)) {
      out.set(input.customerId, { ok: false, reason: "documento_invalido" })
      continue
    }

    // valor/vencimento/qtd via buildAckContext — MESMA fonte do chat (C4).
    const ack = await buildAckContext({
      companyId,
      customerId: input.customerId,
      debtIds: input.debtIds,
    })

    if (!(ack.updatedValue > 0)) {
      out.set(input.customerId, { ok: false, reason: "sem_valor" })
      continue
    }
    const vencimento = formatDatePtBR(ack.oldestDueDate)
    if (!vencimento) {
      out.set(input.customerId, { ok: false, reason: "sem_vencimento" })
      continue
    }

    out.set(input.customerId, {
      ok: true,
      ctx: {
        nome_cliente: displayName,
        primeiro_nome: firstNameOf(displayName),
        documento_mascarado: maskDocument(rawDoc),
        valor_divida: formatBRL(ack.updatedValue),
        vencimento_original: vencimento,
        // FRASE pronta (não o número cru): "Este valor reúne N faturas em aberto."
        // quando >1, "" quando <=1 — o template renderiza {{qtd_faturas}} direto,
        // sem lógica. Variante TEXTO (plain): o pipeline HTML-escapa as vars de
        // débito, então a frase entra como texto seguro nos dois corpos (html+txt).
        qtd_faturas: invoiceCountPhrase(ack.invoiceCount, "text").trim(),
      },
    })
  }

  return out
}
