import { redirect } from "next/navigation"

import { RedirectsContent } from "@/components/negotiation/redirects-content"
import { loadRedirectEvents } from "@/lib/negotiation/admin-data"
import { createClient } from "@/lib/supabase/server"

export const dynamic = "force-dynamic"

export default async function SuperAdminRedirecionamentosPage() {
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

  const events = await loadRedirectEvents(null)

  return (
    <div className="container mx-auto space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold">Redirecionamentos ao canal oficial (global)</h1>
        <p className="text-muted-foreground">
          Evidência de disposição a pagar gerada pela cobrança AlteaPay, por empresa — insumo de
          faturamento do cenário 2.
        </p>
      </div>
      <RedirectsContent events={events} isSuperAdmin />
    </div>
  )
}
