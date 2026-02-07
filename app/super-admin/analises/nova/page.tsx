import { Suspense } from "react"
import { redirect } from "next/navigation"
import { createServerClient } from "@/lib/supabase/server"
import NewAnalysisForm from "@/components/super-admin/new-analysis-form"

export default async function NovaAnalisePage() {
  const supabase = await createServerClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect("/auth/login")
  }

  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single()

  if (profile?.role !== "super_admin") {
    redirect("/dashboard")
  }

  return (
    <div className="w-full space-y-6">
      <div className="max-w-2xl mx-auto">
        <h1 className="text-3xl font-bold mb-6">Nova Análise Assertiva</h1>
        <p className="text-muted-foreground mb-8">
          Execute análise comportamental completa (assíncrona) para CPF ou CNPJ. O resultado será processado em 2-5
          minutos.
        </p>

        <Suspense fallback={<div>Carregando...</div>}>
          <NewAnalysisForm />
        </Suspense>
      </div>
    </div>
  )
}
