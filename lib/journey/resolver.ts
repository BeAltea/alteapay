// Resolução de cliente + dívidas abertas por documento (N1, GATE N0: consolidado).
//
// Fonte primária = `customers` (documento normalizado dos DOIS lados). VMAX é
// só um sinal auxiliar de aging/faturas; um documento que existe SÓ na VMAX
// (sem customers) resolve para `null` e o chamador emite `auth.unresolved` —
// NUNCA se cria registro aqui.
//
// Invariantes:
//   - company_id SEMPRE restringe (nunca cruza tenant).
//   - dívidas abertas = status `pending` + `in_negotiation` (CHECK real).
//   - consolidado: debtIds = TODAS as abertas; primaryDebtId = a mais antiga.
//   - agingDays pela fatura/vencimento mais antigo (vmax_invoices › debts.due_date).

import { createServiceClient } from "@/lib/supabase/service"
import { agingDays as agingFromDueDate } from "@/lib/negotiation/config"
import { normalizeDocument } from "./document"

/** Status de dívida considerados "em aberto" (CHECK real: pending|paid|cancelled|in_negotiation). */
export const OPEN_DEBT_STATUSES = ["pending", "in_negotiation"] as const

export interface ResolvedDebtor {
  customerId: string
  customerName: string
  document: string // normalizado (só dígitos)
  debtIds: string[]
  primaryDebtId: string
  totalOpen: number // soma dos valores em aberto (reais)
  agingDays: number // pela fatura/vencimento mais antigo
  invoiceCount: number
  oldestDueDate: string | null
}

interface ResolveInput {
  companyId: string
  document: string
}

interface DebtRow {
  id: string
  status: string
  amount: number | null
  current_amount: number | null
  due_date: string | null
}

/**
 * Resolve o devedor pelo documento no tenant. `null` = não há cliente em
 * `customers` com esse documento (inclui o caso "só VMAX") OU não há dívida
 * aberta — o chamador trata os dois como resposta uniforme (nunca revela qual).
 */
export async function resolveByDocument(input: ResolveInput): Promise<ResolvedDebtor | null> {
  const doc = normalizeDocument(input.document)
  if (!doc) return null
  const supabase = createServiceClient()

  // 1) cliente por documento NORMALIZADO dos dois lados; company_id restringe.
  //    A base pode ter o documento com ou sem pontuação (N0: 2 casos) — por isso
  //    a comparação é sobre os dígitos, não sobre o texto cru.
  const { data: customers, error: custErr } = await supabase
    .from("customers")
    .select("id, name, document")
    .eq("company_id", input.companyId)
    .filter("document", "not.is", null)
  if (custErr) throw new Error(`resolveByDocument/customers: ${custErr.message}`)

  const customer = (customers ?? []).find((c) => normalizeDocument(c.document) === doc)
  if (!customer) return null // inexistente OU só-VMAX → null (auth.unresolved no chamador)

  // 2) dívidas abertas (consolidado) — TODAS as pending/in_negotiation do cliente.
  const { data: debts, error: debtErr } = await supabase
    .from("debts")
    .select("id, status, amount, current_amount, due_date")
    .eq("company_id", input.companyId)
    .eq("customer_id", customer.id)
    .in("status", OPEN_DEBT_STATUSES as unknown as string[])
    .order("due_date", { ascending: true })
  if (debtErr) throw new Error(`resolveByDocument/debts: ${debtErr.message}`)

  const open = (debts ?? []) as DebtRow[]
  if (open.length === 0) return null // sem dívida aberta → resposta uniforme

  const debtIds = open.map((d) => d.id)
  const primaryDebtId = debtIds[0] // ordenado por due_date asc → mais antiga
  const totalOpen = open.reduce(
    (sum, d) => sum + Number(d.current_amount ?? d.amount ?? 0),
    0,
  )

  // 3) aging + faturas: vmax_invoices é o detalhe mais fino (por fatura); se não
  //    houver, cai para o due_date mais antigo das dívidas. company_id via id_company.
  const { data: invoices, error: invErr } = await supabase
    .from("vmax_invoices")
    .select("fatura, vencimento, saldo")
    .eq("id_company", input.companyId)
    .eq("doc", doc)
    .order("vencimento", { ascending: true })
  if (invErr) throw new Error(`resolveByDocument/vmax_invoices: ${invErr.message}`)

  const oldestInvoiceDue = invoices?.[0]?.vencimento ?? null
  const oldestDebtDue = open.map((d) => d.due_date).filter(Boolean).sort()[0] ?? null
  const oldestDueDate = oldestInvoiceDue ?? oldestDebtDue

  return {
    customerId: customer.id,
    customerName: customer.name ?? "",
    document: doc,
    debtIds,
    primaryDebtId,
    totalOpen: Math.round(totalOpen * 100) / 100,
    agingDays: oldestDueDate ? agingFromDueDate(oldestDueDate) : 0,
    invoiceCount: invoices?.length ?? open.length,
    oldestDueDate,
  }
}

/**
 * Resolve o company_id a partir do slug do tenant genérico. O slug vem de
 * `tenant_chat_config.branding->>'slug'` (aditivo, sem nova coluna) e, na
 * ausência, do nome da empresa "slugificado". `null` = slug desconhecido → 404.
 */
export async function resolveCompanyBySlug(slug: string): Promise<string | null> {
  const clean = slug.trim().toLowerCase()
  if (!clean) return null
  const supabase = createServiceClient()

  // 1) match explícito em branding->>'slug'
  const { data: cfgs } = await supabase
    .from("tenant_chat_config")
    .select("company_id, branding")
    .filter("branding->>slug", "eq", clean)
    .limit(1)
  if (cfgs && cfgs.length > 0) return cfgs[0].company_id

  // 2) fallback: nome da empresa slugificado (sem depender de coluna nova)
  const { data: companies } = await supabase.from("companies").select("id, name")
  const match = (companies ?? []).find((c) => slugify(c.name) === clean)
  return match?.id ?? null
}

export function slugify(name: string | null | undefined): string {
  return (name ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
}
