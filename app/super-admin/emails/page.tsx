import { fetchCommunicationsData } from "./data"
import { EmailsPageClient } from "@/components/super-admin/emails/emails-page-client"

export const dynamic = "force-dynamic"
export const revalidate = 0

export default async function EmailsPage() {
  const { companies, recipientsMap, emailTrackingMap } = await fetchCommunicationsData()

  return (
    <div className="min-h-screen w-full overflow-x-hidden bg-background space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Gerenciamento de E-mails</h1>
        <p className="text-muted-foreground">
          Envie comunicações em massa e gerencie os templates de e-mail (negociação e comunicação).
        </p>
      </div>

      <EmailsPageClient
        companies={companies}
        recipientsMap={recipientsMap}
        emailTrackingMap={emailTrackingMap}
      />
    </div>
  )
}
