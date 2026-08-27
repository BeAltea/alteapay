import { redirect } from "next/navigation"

import { RedirectsContent } from "@/components/negotiation/redirects-content"
import { loadRedirectEvents } from "@/lib/negotiation/admin-data"
import { createClient } from "@/lib/supabase/server"

export const dynamic = "force-dynamic"

export default async function RedirecionamentosPage() {
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

  const events = await loadRedirectEvents(profile.company_id)

  return (
    <div className="container mx-auto space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold">Redirecionamentos ao canal oficial</h1>
        <p className="text-muted-foreground">
          Devedores que, após a cobrança AlteaPay, confirmaram intenção de pagar e foram
          direcionados ao canal oficial — evidência para faturamento (cenário 2).
        </p>
      </div>
      <RedirectsContent events={events} isSuperAdmin={false} />
    </div>
  )
}
