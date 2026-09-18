// Hub do painel super-admin de Negociação IA (jornada de negociação).
import Link from "next/link"
import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

export const dynamic = "force-dynamic"

const SECTIONS = [
  {
    href: "/super-admin/negociacao-ia/matriz",
    title: "Matriz de condições",
    desc: "Faixas de aging, descontos, entrada e parcelamento por empresa.",
  },
  {
    href: "/super-admin/negociacao-ia/campanhas",
    title: "Campanhas",
    desc: "Disparo por lista explícita de clientes e contadores de elegibilidade.",
  },
  {
    href: "/super-admin/negociacao-ia/sessoes",
    title: "Sessões",
    desc: "Sessões de chat: canal, engine, desfecho, transcrição e n8n_execution_id.",
  },
  {
    href: "/super-admin/negociacao-ia/jornada",
    title: "Jornada",
    desc: "Busca por documento mascarado e linha do tempo dos eventos.",
  },
  {
    href: "/super-admin/negociacao-ia/casos",
    title: "Casos",
    desc: "Contestações, 'já paguei' e handoffs — com resolução.",
  },
]

export default async function NegociacaoIaHome() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect("/auth/login")
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single()
  if (profile?.role !== "super_admin") redirect("/")

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Negociação IA</h1>
        <p className="text-muted-foreground">Gestão da jornada de negociação white-label.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {SECTIONS.map((s) => (
          <Link key={s.href} href={s.href}>
            <Card className="transition-colors hover:border-primary">
              <CardHeader>
                <CardTitle>{s.title}</CardTitle>
                <CardDescription>{s.desc}</CardDescription>
              </CardHeader>
              <CardContent />
            </Card>
          </Link>
        ))}
      </div>
    </div>
  )
}
