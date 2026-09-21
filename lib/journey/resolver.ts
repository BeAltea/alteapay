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
  due_date: string | null
}

interface CustomerRow {
  id: string
  name: string | null
  document: string | null
}

/** Tamanho de página do scan de fallback (limite default do PostgREST). */
const CUSTOMER_PAGE_SIZE = 1000

/**
 * Formatos candidatos de `customers.document` para um documento normalizado.
 * A base guarda quase tudo como dígitos crus (11 ou 14) e poucos casos
 * pontuados — então buscamos por [cru, pontuado] e deixamos o `.find()`
 * normalizado no chamador cobrir pontuações parciais. Retorna um único valor
 * (o cru) para comprimentos atípicos: o fallback paginado cobre esses casos.
 */
export function documentCandidates(doc: string): string[] {
  if (doc.length === 11) {
    // CPF pontuado: XXX.XXX.XXX-XX
    const dotted = `${doc.slice(0, 3)}.${doc.slice(3, 6)}.${doc.slice(6, 9)}-${doc.slice(9, 11)}`
    return [doc, dotted]
  }
  if (doc.length === 14) {
    // CNPJ pontuado: XX.XXX.XXX/XXXX-XX
    const dotted = `${doc.slice(0, 2)}.${doc.slice(2, 5)}.${doc.slice(5, 8)}/${doc.slice(8, 12)}-${doc.slice(12, 14)}`
    return [doc, dotted]
  }
  return [doc]
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

  // 1) cliente por documento — query DIRETA por valor (indexável, SEM o limite
  //    de 1000 linhas do PostgREST e sem o "carrega todos + find" que só
  //    enxergava os 1000 primeiros de tenants grandes como a VMAX, 3196 clientes).
  //    A base pode ter o documento com ou sem pontuação — buscamos os dois
  //    formatos e confirmamos por dígitos (cobre pontuação parcial dos poucos
  //    casos). company_id SEMPRE restringe (nunca cruza tenant).
  const candidates = documentCandidates(doc)
  const { data: direct, error: custErr } = await supabase
    .from("customers")
    .select("id, name, document")
    .eq("company_id", input.companyId)
    .in("document", candidates)
    .limit(5)
  if (custErr) throw new Error(`resolveByDocument/customers: ${custErr.message}`)

  let customer =
    (direct as CustomerRow[] | null ?? []).find((c) => normalizeDocument(c.document) === doc) ?? null

  // Fallback RARO: documento gravado num formato atípico não coberto pelos
  //   candidatos (ex.: pontuação parcial/espaços). Scan paginado por company_id
  //   (páginas de 1000 via .range) até casar por dígitos ou esgotar. É caro, mas
  //   raríssimo; o padding (~600ms) da rota pública absorve o timing extra.
  if (!customer) {
    let page = 0
    for (;;) {
      const { data: pageRows, error: pageErr } = await supabase
        .from("customers")
        .select("id, name, document")
        .eq("company_id", input.companyId)
        .filter("document", "not.is", null)
        .range(page * CUSTOMER_PAGE_SIZE, (page + 1) * CUSTOMER_PAGE_SIZE - 1)
      if (pageErr) throw new Error(`resolveByDocument/customers(scan): ${pageErr.message}`)
      const rows = (pageRows as CustomerRow[] | null) ?? []
      const hit = rows.find((c) => normalizeDocument(c.document) === doc)
      if (hit) {
        customer = hit
        break
      }
      if (rows.length < CUSTOMER_PAGE_SIZE) break // última página
      page++
    }
  }

  if (!customer) return null // inexistente OU só-VMAX → null (auth.unresolved no chamador)

  // 2) dívidas abertas (consolidado) — TODAS as pending/in_negotiation do cliente.
  const { data: debts, error: debtErr } = await supabase
    .from("debts")
    .select("id, status, amount, due_date")
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
    (sum, d) => sum + Number(d.amount ?? 0),
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

  // 2) fallback: nome da empresa slugificado (sem depender de coluna nova).
  //    NOTA: carrega TODAS as companies e faz find() em JS — o mesmo anti-padrão
  //    "sem paginação" que quebrava resolveByDocument. Aqui é ACEITÁVEL porque
  //    `companies` é uma tabela minúscula (2 linhas hoje, ordem de dezenas no
  //    máximo) e o slug não é indexável de forma trivial (slugify em JS). Se um
  //    dia companies passar de ~1000, este scan precisará de paginação/coluna slug.
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
