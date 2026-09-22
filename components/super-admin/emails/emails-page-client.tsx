"use client"

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { SendEmailForm } from "@/components/super-admin/send-email-form"
import { EmailActivity } from "@/components/super-admin/email-activity"
import { TemplatesManager } from "@/components/super-admin/emails/templates-manager"
import { Send, BarChart3, LayoutTemplate, Megaphone } from "lucide-react"

interface Company {
  id: string
  name: string
}
interface Recipient {
  id: string
  name: string
  email: string
  daysOverdue: number
}
interface EmailTrackingData {
  sentAt: string
  subject: string
  status: string
  history: Array<{ sentAt: string; subject: string; status: string }>
}

interface EmailsPageClientProps {
  companies: Company[]
  recipientsMap: Record<string, Recipient[]>
  emailTrackingMap: Record<string, EmailTrackingData>
}

export function EmailsPageClient({ companies, recipientsMap, emailTrackingMap }: EmailsPageClientProps) {
  return (
    <Tabs defaultValue="communications" className="w-full">
      <TabsList className="grid w-full max-w-md grid-cols-2">
        <TabsTrigger value="communications" className="gap-2">
          <Megaphone className="h-4 w-4" />
          Comunicações
        </TabsTrigger>
        <TabsTrigger value="templates" className="gap-2">
          <LayoutTemplate className="h-4 w-4" />
          Templates
        </TabsTrigger>
      </TabsList>

      {/* Comunicações: o envio avulso atual, INTACTO (sub-abas Enviar / Atividade). */}
      <TabsContent value="communications" className="mt-6">
        <Tabs defaultValue="send" className="w-full">
          <TabsList className="grid w-full max-w-md grid-cols-2">
            <TabsTrigger value="send" className="gap-2">
              <Send className="h-4 w-4" />
              Enviar Email
            </TabsTrigger>
            <TabsTrigger value="activity" className="gap-2">
              <BarChart3 className="h-4 w-4" />
              Atividade de Emails
            </TabsTrigger>
          </TabsList>
          <TabsContent value="send" className="mt-6">
            <SendEmailForm
              companies={companies}
              recipientsMap={recipientsMap}
              emailTrackingMap={emailTrackingMap}
            />
          </TabsContent>
          <TabsContent value="activity" className="mt-6">
            <EmailActivity companies={companies} />
          </TabsContent>
        </Tabs>
      </TabsContent>

      {/* Templates: lista / criar / editar / duplicar / preview / padrão / arquivar. */}
      <TabsContent value="templates" className="mt-6">
        <TemplatesManager companies={companies} />
      </TabsContent>
    </Tabs>
  )
}
