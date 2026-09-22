// Carregamento server-side da aba "Comunicações" (o envio avulso atual, intacto).
// Extraído de app/super-admin/send-email/page.tsx sem mudança de comportamento:
// destinatários por empresa (excluindo débitos pagos) + histórico de envio.
import "server-only"
import { createAdminClient } from "@/lib/supabase/server"
import {
  PAID_AGREEMENT_STATUSES,
  PAID_ASAAS_STATUSES,
  PAID_PAYMENT_STATUSES,
  PAID_VMAX_STATUSES,
} from "@/lib/constants/payment-status"

export interface CommsCompany {
  id: string
  name: string
}
export interface CommsRecipient {
  id: string
  name: string
  email: string
  daysOverdue: number
}
export interface CommsTrackingData {
  sentAt: string
  subject: string
  status: string
  history: Array<{ sentAt: string; subject: string; status: string }>
}
export interface CommunicationsData {
  companies: CommsCompany[]
  recipientsMap: Record<string, CommsRecipient[]>
  emailTrackingMap: Record<string, CommsTrackingData>
}

interface EmailRecipient {
  id: string
  client_name: string | null
  client_email: string
  company_id: string
  daysOverdue?: number
}
interface EmailTrackingRecord {
  id: string
  user_id: string
  sent_at: string
  status: "sent" | "failed"
  email_subject: string
}

export async function fetchCommunicationsData(): Promise<CommunicationsData> {
  const supabase = createAdminClient()

  const { data: companiesData, error: companiesError } = await supabase
    .from("companies")
    .select("id, name")
    .order("name")

  if (companiesError) {
    return { companies: [], recipientsMap: {}, emailTrackingMap: {} }
  }

  const pageSize = 1000

  // Destinatários (paginado).
  let allRecipients: EmailRecipient[] = []
  {
    let page = 0
    let hasMore = true
    while (hasMore) {
      const { data, error } = await supabase
        .from("company_email_recipients")
        .select("id, client_name, client_email, company_id")
        .range(page * pageSize, (page + 1) * pageSize - 1)
      if (error) break
      if (data && data.length > 0) {
        allRecipients = [...allRecipients, ...data]
        page++
        hasMore = data.length === pageSize
      } else hasMore = false
    }
  }

  // VMAX (dias de atraso + docs pagos).
  let vmaxData: any[] = []
  {
    let page = 0
    let hasMore = true
    while (hasMore) {
      const { data, error } = await supabase
        .from("VMAX")
        .select('id, Email, "CPF/CNPJ", "Dias Inad.", id_company, negotiation_status')
        .range(page * pageSize, (page + 1) * pageSize - 1)
      if (error) break
      if (data && data.length > 0) {
        vmaxData = [...vmaxData, ...data]
        page++
        hasMore = data.length === pageSize
      } else hasMore = false
    }
  }

  // Acordos (para identificar débitos pagos).
  let allAgreements: any[] = []
  {
    let page = 0
    let hasMore = true
    while (hasMore) {
      const { data, error } = await supabase
        .from("agreements")
        .select("id, customer_id, company_id, status, asaas_status, payment_status")
        .range(page * pageSize, (page + 1) * pageSize - 1)
      if (error) break
      if (data && data.length > 0) {
        allAgreements = [...allAgreements, ...data]
        page++
        hasMore = data.length === pageSize
      } else hasMore = false
    }
  }

  const { data: customers } = await supabase.from("customers").select("id, document, company_id")
  const customerIdToDoc = new Map<string, string>()
  for (const c of customers || []) {
    if (c.document) customerIdToDoc.set(c.id, c.document.replace(/\D/g, ""))
  }

  const paidDocsByCompany = new Map<string, Set<string>>()
  for (const a of allAgreements) {
    const isPaid =
      PAID_AGREEMENT_STATUSES.includes(a.status) ||
      PAID_PAYMENT_STATUSES.includes(a.payment_status) ||
      PAID_ASAAS_STATUSES.includes(a.asaas_status)
    if (isPaid) {
      const doc = customerIdToDoc.get(a.customer_id)
      if (doc && a.company_id) {
        if (!paidDocsByCompany.has(a.company_id)) paidDocsByCompany.set(a.company_id, new Set())
        paidDocsByCompany.get(a.company_id)!.add(doc)
      }
    }
  }

  const paidVmaxDocs = new Map<string, Set<string>>()
  for (const v of vmaxData) {
    if (PAID_VMAX_STATUSES.includes(v.negotiation_status)) {
      const doc = (v["CPF/CNPJ"] || "").replace(/\D/g, "")
      const companyId = v.id_company
      if (doc && companyId) {
        if (!paidVmaxDocs.has(companyId)) paidVmaxDocs.set(companyId, new Set())
        paidVmaxDocs.get(companyId)!.add(doc)
      }
    }
  }

  const emailToDocMap = new Map<string, { doc: string; companyId: string }>()
  const emailToDaysMap = new Map<string, number>()
  for (const v of vmaxData) {
    const email = (v.Email || "").toLowerCase().trim()
    const doc = (v["CPF/CNPJ"] || "").replace(/\D/g, "")
    const companyId = v.id_company
    if (email && companyId) {
      const key = `${companyId}:${email}`
      if (doc) emailToDocMap.set(key, { doc, companyId })
      const diasInadStr = String(v["Dias Inad."] || "0")
      const diasInad = Number(diasInadStr.replace(/\./g, "")) || 0
      const existing = emailToDaysMap.get(key) || 0
      if (diasInad > existing) emailToDaysMap.set(key, diasInad)
    }
  }

  for (const recipient of allRecipients) {
    const email = recipient.client_email.toLowerCase().trim()
    const key = `${recipient.company_id}:${email}`
    recipient.daysOverdue = emailToDaysMap.get(key) || 0
  }

  // Histórico de envio (paginado, apenas 'sent').
  let allTracking: EmailTrackingRecord[] = []
  {
    let page = 0
    let hasMore = true
    while (hasMore) {
      const { data, error } = await supabase
        .from("email_sent_tracking")
        .select("id, user_id, sent_at, status, email_subject")
        .eq("status", "sent")
        .order("sent_at", { ascending: false })
        .range(page * pageSize, (page + 1) * pageSize - 1)
      if (error) break
      if (data && data.length > 0) {
        allTracking = [...allTracking, ...data]
        page++
        hasMore = data.length === pageSize
      } else hasMore = false
    }
  }

  const emailTrackingMap: Record<string, CommsTrackingData> = {}
  for (const record of allTracking) {
    if (!emailTrackingMap[record.user_id]) {
      emailTrackingMap[record.user_id] = {
        sentAt: record.sent_at,
        subject: record.email_subject,
        status: record.status,
        history: [],
      }
    }
    emailTrackingMap[record.user_id].history.push({
      sentAt: record.sent_at,
      subject: record.email_subject,
      status: record.status,
    })
  }

  // Agrupa por empresa, EXCLUINDO clientes com débito pago (comportamento atual).
  const recipientsMap: Record<string, CommsRecipient[]> = {}
  for (const recipient of allRecipients) {
    const email = recipient.client_email.toLowerCase().trim()
    const key = `${recipient.company_id}:${email}`
    const docInfo = emailToDocMap.get(key)
    if (docInfo) {
      const companyPaidDocs = paidDocsByCompany.get(docInfo.companyId) || new Set()
      const companyPaidVmax = paidVmaxDocs.get(docInfo.companyId) || new Set()
      if (companyPaidDocs.has(docInfo.doc) || companyPaidVmax.has(docInfo.doc)) continue
    }
    if (!recipientsMap[recipient.company_id]) recipientsMap[recipient.company_id] = []
    recipientsMap[recipient.company_id].push({
      id: recipient.id,
      name: recipient.client_name || recipient.client_email,
      email: recipient.client_email,
      daysOverdue: recipient.daysOverdue || 0,
    })
  }

  return { companies: companiesData || [], recipientsMap, emailTrackingMap }
}
