import { redirect } from "next/navigation"

import { ChatSessionsContent } from "@/components/negotiation/chat-sessions-content"
import { loadChatDebtors } from "@/lib/negotiation/admin-data"
import { createClient } from "@/lib/supabase/server"

export const dynamic = "force-dynamic"

export default async function SuperAdminNegociacoesChatPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect("/auth/login")

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single()
  if (profile?.role !== "super_admin" && profile?.role !== "viewer") redirect("/")

  const { debtors, kpis } = await loadChatDebtors(null)

  return (
    <div className="container mx-auto space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold">Negociações — Chatbot (global)</h1>
        <p className="text-muted-foreground">
          Devedores em negociação com o assistente digital, em todas as empresas.
        </p>
      </div>
      <ChatSessionsContent
        debtors={debtors}
        kpis={kpis}
        isSuperAdmin={profile?.role === "super_admin"}
      />
    </div>
  )
}
