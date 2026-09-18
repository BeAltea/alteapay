// Sessões (super-admin): lista das sessões de negociação com canal, tenant,
// cliente MASCARADO, engine, status, duração e desfecho. Filtro por desfecho.
// Sem PII em claro (documento/nome mascarados na fonte, lib/journey/history).
import Link from "next/link"
import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { adminSessions } from "@/lib/journey/history"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

export const dynamic = "force-dynamic"

const OUTCOMES = [
  { value: "", label: "Todos" },
  { value: "in_progress", label: "Em andamento" },
  { value: "agreement_closed", label: "Acordo fechado" },
  { value: "handoff_human", label: "Atendimento humano" },
  { value: "redirected_official", label: "Redirecionado" },
  { value: "expired", label: "Expirado" },
  { value: "abandoned", label: "Abandonado" },
]

function fmtDuration(seconds: number | null): string {
  if (seconds == null) return "—"
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}m${s ? ` ${s}s` : ""}`
}

export default async function SessoesPage({
  searchParams,
}: {
  searchParams: Promise<{ outcome?: string }>
}) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect("/auth/login")
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single()
  if (profile?.role !== "super_admin") redirect("/")

  const { outcome } = await searchParams
  const rows = await adminSessions({ outcome: outcome || undefined, limit: 200 })

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Sessões</h1>
        <p className="text-muted-foreground">
          Sessões de negociação (chat). Cliente mascarado; transcrição no detalhe.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Filtro por desfecho</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            {OUTCOMES.map((o) => (
              <Link
                key={o.value}
                href={o.value ? `?outcome=${o.value}` : "?"}
                className={
                  (outcome ?? "") === o.value
                    ? "rounded-full bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground"
                    : "rounded-full border px-3 py-1.5 text-xs text-muted-foreground hover:border-primary"
                }
              >
                {o.label}
              </Link>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Sessões ({rows.length})</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Início</TableHead>
                <TableHead>Tenant</TableHead>
                <TableHead>Canal</TableHead>
                <TableHead>Cliente</TableHead>
                <TableHead>Engine</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Desfecho</TableHead>
                <TableHead>Duração</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="text-center text-muted-foreground">
                    Nenhuma sessão.
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="whitespace-nowrap text-sm">
                      {new Date(r.created_at).toLocaleString("pt-BR")}
                    </TableCell>
                    <TableCell className="text-sm">{r.brand_name ?? "—"}</TableCell>
                    <TableCell className="text-xs">{r.channel ?? "—"}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {r.customer_name_masked} · {r.customer_masked}
                    </TableCell>
                    <TableCell className="text-xs">{r.engine ?? "—"}</TableCell>
                    <TableCell className="text-xs">{r.status ?? "—"}</TableCell>
                    <TableCell className="text-xs">{r.outcome ?? "—"}</TableCell>
                    <TableCell className="text-sm">{fmtDuration(r.duration_seconds)}</TableCell>
                    <TableCell>
                      <Link
                        href={`/super-admin/negociacao-ia/sessoes/${r.id}`}
                        className="text-xs text-primary underline underline-offset-2"
                      >
                        Detalhe
                      </Link>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
