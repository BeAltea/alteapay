import { createAdminClient } from "@/lib/supabase/server"
import { SendEmailForm } from "@/components/super-admin/send-email-form"

export const dynamic = "force-dynamic"
export const revalidate = 0

interface EmailRecipient {
  id: string
  client_name: string | null
  client_email: string
  company_id: string
}

interface EmailTrackingRecord {
  id: string
  user_id: string
  sent_at: string
  status: "sent" | "failed"
}

async function fetchData() {
  console.log("[v0] ========== SEND EMAIL PAGE ==========")

  const supabase = createAdminClient()

  // Fetch all companies
  const { data: companiesData, error: companiesError } = await supabase
    .from("companies")
    .select("id, name")
    .order("name")

  if (companiesError) {
    console.error("[v0] Error fetching companies:", companiesError)
    return { companies: [], recipientsMap: {}, emailTrackingMap: {} }
  }

  console.log("[v0] Fetched", companiesData?.length || 0, "companies")

  // Fetch all email recipients from the new table
  let allRecipients: EmailRecipient[] = []
  let page = 0
  const pageSize = 1000
  let hasMore = true

  while (hasMore) {
    const { data: recipientsPage, error: recipientsError } = await supabase
      .from("company_email_recipients")
      .select("id, client_name, client_email, company_id")
      .range(page * pageSize, (page + 1) * pageSize - 1)

    if (recipientsError) {
      console.error("[v0] Error fetching email recipients:", recipientsError)
      break
    }

    if (recipientsPage && recipientsPage.length > 0) {
      allRecipients = [...allRecipients, ...recipientsPage]
      page++
      hasMore = recipientsPage.length === pageSize
    } else {
      hasMore = false
    }
  }

  console.log("[v0] Fetched", allRecipients.length, "email recipients")

  // Fetch email tracking data - get the latest successful send for each user
  let allTracking: EmailTrackingRecord[] = []
  page = 0
  hasMore = true

  while (hasMore) {
    const { data: trackingPage, error: trackingError } = await supabase
      .from("email_sent_tracking")
      .select("id, user_id, sent_at, status")
      .eq("status", "sent")
      .order("sent_at", { ascending: false })
      .range(page * pageSize, (page + 1) * pageSize - 1)

    if (trackingError) {
      console.error("[v0] Error fetching email tracking:", trackingError)
      // Continue even if tracking table doesn't exist yet
      break
    }

    if (trackingPage && trackingPage.length > 0) {
      allTracking = [...allTracking, ...trackingPage]
      page++
      hasMore = trackingPage.length === pageSize
    } else {
      hasMore = false
    }
  }

  console.log("[v0] Fetched", allTracking.length, "tracking records")

  // Create a map of user_id -> latest sent_at timestamp
  const emailTrackingMap: Record<string, string> = {}
  for (const record of allTracking) {
    // Since we order by sent_at DESC, the first occurrence for each user_id is the latest
    if (!emailTrackingMap[record.user_id]) {
      emailTrackingMap[record.user_id] = record.sent_at
    }
  }

  console.log("[v0] Created tracking map for", Object.keys(emailTrackingMap).length, "users")

  // Group recipients by company
  const recipientsMap: Record<string, { id: string; name: string; email: string }[]> = {}
  for (const recipient of allRecipients) {
    if (!recipientsMap[recipient.company_id]) {
      recipientsMap[recipient.company_id] = []
    }
    recipientsMap[recipient.company_id].push({
      id: recipient.id,
      name: recipient.client_name || recipient.client_email,
      email: recipient.client_email,
    })
  }

  console.log("[v0] ========== END SEND EMAIL PAGE ==========")

  return {
    companies: companiesData || [],
    recipientsMap,
    emailTrackingMap,
  }
}

export default async function SendEmailPage() {
  const { companies, recipientsMap, emailTrackingMap } = await fetchData()

  return (
    <div className="w-full overflow-x-hidden space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Enviar Email</h1>
        <p className="text-muted-foreground">
          Envie emails em massa para clientes de uma empresa específica.
        </p>
      </div>

      {/* Form */}
      <SendEmailForm
        companies={companies}
        recipientsMap={recipientsMap}
        emailTrackingMap={emailTrackingMap}
      />
    </div>
  )
}
