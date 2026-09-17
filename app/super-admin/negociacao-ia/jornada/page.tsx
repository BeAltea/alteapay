// Jornada (super-admin): busca por documento MASCARADO → linha do tempo dos
// eventos (view journey_timeline, que já mascara o documento). Sem PII em claro.
import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { TimelineSearch } from "@/components/journey/timeline-search"

export const dynamic = "force-dynamic"

interface TimelineRow {
  id: number
  event_type: string
  actor: string
  occurred_at: string
  customer_document_masked: string | null
  debt_amount: number | null
}

export default async function JornadaPage({
  searchParams,
}: {
  searchParams: Promise<{ doc?: string }>
}) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect("/auth/login")
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single()
  if (profile?.role !== "super_admin") redirect("/")

  const { doc } = await searchParams
  let rows: TimelineRow[] = []
  if (doc) {
    const service = createServiceClient()
    const { data } = await service
      .from("journey_timeline")
      .select("id, event_type, actor, occurred_at, customer_document_masked, debt_amount")
      .eq("customer_document_masked", doc)
      .order("occurred_at", { ascending: true })
      .limit(500)
    rows = (data ?? []) as TimelineRow[]
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Jornada</h1>
        <p className="text-muted-foreground">
          Linha do tempo dos eventos da negociação por cliente (documento mascarado).
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Buscar</CardTitle>
        </CardHeader>
        <CardContent>
          <TimelineSearch initial={doc ?? ""} />
        </CardContent>
      </Card>

      {doc ? (
        <Card>
          <CardHeader>
            <CardTitle>Eventos ({rows.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Data/Hora</TableHead>
                  <TableHead>Evento</TableHead>
                  <TableHead>Ator</TableHead>
                  <TableHead>Documento</TableHead>
                  <TableHead>Valor dívida</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-muted-foreground">
                      Nenhum evento para este documento.
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="whitespace-nowrap text-sm">
                        {new Date(r.occurred_at).toLocaleString("pt-BR")}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{r.event_type}</TableCell>
                      <TableCell className="text-sm">{r.actor}</TableCell>
                      <TableCell className="font-mono text-xs">
                        {r.customer_document_masked ?? "—"}
                      </TableCell>
                      <TableCell className="text-sm">
                        {r.debt_amount != null
                          ? new Intl.NumberFormat("pt-BR", {
                              style: "currency",
                              currency: "BRL",
                            }).format(Number(r.debt_amount))
                          : "—"}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}
    </div>
  )
}
