import { redirect } from "next/navigation"

import { ChatSessionsContent } from "@/components/negotiation/chat-sessions-content"
import { loadChatDebtors } from "@/lib/negotiation/admin-data"
import { createClient } from "@/lib/supabase/server"

export const dynamic = "force-dynamic"

export default async function NegociacoesChatPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect("/auth/login")

  const { data: profile } = await supabase
    .from("profiles")
    .select("company_id, role")
    .eq("id", user.id)
    .single()
  if (!profile?.company_id) {
    return (
      <div className="container mx-auto p-6">
        <p className="text-muted-foreground">Sua conta não está vinculada a nenhuma empresa.</p>
      </div>
    )
  }

  const { debtors, kpis } = await loadChatDebtors(profile.company_id)

  return (
    <div className="container mx-auto space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold">Negociações — Chatbot</h1>
        <p className="text-muted-foreground">
          Devedores em negociação com o assistente digital (WhatsApp + chat web), com funil e auditoria.
        </p>
      </div>
      <ChatSessionsContent debtors={debtors} kpis={kpis} isSuperAdmin={false} />
    </div>
  )
}
