// Detalhe de sessão (super-admin): transcrição turno-a-turno com
// n8n_execution_id, ofertas, cartão do acordo e linha do tempo. Documento
// mascarado. Sem PII em claro.
import { notFound, redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { adminSessionDetail } from "@/lib/journey/history"
import { getTimeline } from "@/lib/journey/events"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

export const dynamic = "force-dynamic"

const BRL = (v: number | null) =>
  v == null ? "—" : new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v)

export default async function SessionDetailPage({
  params,
}: {
  params: Promise<{ sessionId: string }>
}) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect("/auth/login")
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single()
  if (profile?.role !== "super_admin") redirect("/")

  const { sessionId } = await params
  const detail = await adminSessionDetail(sessionId)
  if (!detail.session) notFound()

  const timeline = await getTimeline({
    companyId: detail.session.company_id,
    sessionId,
    limit: 200,
  })

  const s = detail.session
  const a = detail.agreement

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Sessão</h1>
        <p className="text-muted-foreground">
          {s.brand_name ?? "—"} · {s.channel ?? "—"} · {s.customer_name_masked} · {s.customer_masked}
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Resumo</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <p>Engine: <span className="font-mono text-xs">{s.engine ?? "—"}</span></p>
            <p>Status: {s.status ?? "—"}</p>
            <p>Desfecho: {s.outcome ?? "—"}</p>
            <p>Início: {new Date(s.created_at).toLocaleString("pt-BR")}</p>
            <p>
              Duração: {s.duration_seconds == null ? "—" : `${Math.round(s.duration_seconds / 60)}m`}
            </p>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Acordo</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            {a ? (
              <div className="space-y-1">
                <p>Total: {BRL(a.total_value)}
                  {a.discount_percentage ? ` (${a.discount_percentage.toFixed(0)}% desc.)` : ""}</p>
                <p>
                  {a.installments && a.installments > 1
                    ? `${a.installments}x de ${BRL(a.installment_amount)}`
                    : "à vista"}{" · "}{a.billing_type ?? "—"}
                </p>
                <p>1º vencimento: {a.first_due_date ?? "—"}</p>
                <p>Status: {a.status ?? "—"} · Pagamento: {a.payment_status ?? "—"}</p>
              </div>
            ) : (
              <p className="text-muted-foreground">Sem acordo nesta sessão.</p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Transcrição ({detail.messages.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {detail.messages.length === 0 ? (
            <p className="text-sm text-muted-foreground">Sem mensagens.</p>
          ) : (
            detail.messages.map((m) => (
              <div key={m.id} className="rounded-md border p-2 text-sm">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span className="font-medium">{m.role}</span>
                  <span className="flex gap-2">
                    {m.engine ? <span>engine: {m.engine}</span> : null}
                    {m.latency_ms != null ? <span>{m.latency_ms}ms</span> : null}
                    {m.n8n_execution_id ? (
                      <span className="font-mono">exec: {m.n8n_execution_id}</span>
                    ) : null}
                    <span>{new Date(m.created_at).toLocaleTimeString("pt-BR")}</span>
                  </span>
                </div>
                <p className="mt-1 whitespace-pre-wrap">{m.text}</p>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Ofertas ({detail.offers.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-xs">
          {detail.offers.length === 0 ? (
            <p className="text-sm text-muted-foreground">Sem ofertas.</p>
          ) : (
            detail.offers.map((o) => (
              <p key={o.id} className="font-mono">
                {o.status} · {JSON.stringify(o.terms)}
              </p>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Linha do tempo ({timeline.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-xs">
          {timeline.length === 0 ? (
            <p className="text-sm text-muted-foreground">Sem eventos.</p>
          ) : (
            timeline.map((t: { id: number; event_type: string; actor: string; occurred_at: string }) => (
              <p key={t.id}>
                <span className="text-muted-foreground">
                  {new Date(t.occurred_at).toLocaleTimeString("pt-BR")}
                </span>{" "}
                <span className="font-mono">{t.event_type}</span> · {t.actor}
              </p>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  )
}
