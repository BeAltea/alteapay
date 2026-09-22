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
  const ack = detail.acknowledgement
  const sig = detail.engineSignals
  const tc = detail.turnCounters
  // Turno do assistente sem n8n_execution_id numa sessão de engine n8n é um
  // forte indício de turno de fallback (o fluxo não respondeu → resposta neutra
  // gravada sem execução). Usado só como marcador visual por turno.
  const flagFallbackTurn = (m: { role: string; engine: string | null; n8n_execution_id: string | null }) =>
    sig.hadFallback && m.role === "assistant" && m.engine === "n8n" && !m.n8n_execution_id

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Sessão</h1>
        <p className="text-muted-foreground">
          {s.brand_name ?? "—"} · {s.channel ?? "—"} · {s.customer_name_masked} · {s.customer_masked}
        </p>
      </div>

      {/* Contadores do topo (X4): turnos enviados/respondidos, fallback e ações recusadas. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Turnos do cliente</p>
            <p className="text-2xl font-bold">{tc.customerTurns}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Respostas do assistente</p>
            <p className="text-2xl font-bold">{tc.assistantTurns}</p>
          </CardContent>
        </Card>
        <Card className={tc.fallbackTurns > 0 ? "border-amber-500 bg-amber-50" : undefined}>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Turnos em fallback</p>
            <p className="text-2xl font-bold">{tc.fallbackTurns}</p>
          </CardContent>
        </Card>
        <Card className={tc.refusedActions > 0 ? "border-amber-500 bg-amber-50" : undefined}>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Ações recusadas</p>
            <p className="text-2xl font-bold">{tc.refusedActions}</p>
          </CardContent>
        </Card>
      </div>

      {/* Banner de fallback do engine (X4): só aparece quando houve algum sinal. */}
      {sig.hadFallback ? (
        <Card className="border-amber-500 bg-amber-50">
          <CardHeader>
            <CardTitle>Fallback do engine detectado</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <div className="flex flex-wrap gap-2">
              {sig.engineErrors > 0 ? (
                <span className="rounded bg-amber-200 px-2 py-0.5 font-mono text-xs">
                  chat.engine_error: {sig.engineErrors}
                </span>
              ) : null}
              {sig.engineUnavailable > 0 ? (
                <span className="rounded bg-amber-200 px-2 py-0.5 font-mono text-xs">
                  engine_unavailable: {sig.engineUnavailable}
                </span>
              ) : null}
              {sig.invalidActions > 0 ? (
                <span className="rounded bg-amber-200 px-2 py-0.5 font-mono text-xs">
                  chat.engine_invalid_action: {sig.invalidActions}
                </span>
              ) : null}
            </div>
            {sig.fallbackAt.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                Em: {sig.fallbackAt.map((t) => new Date(t).toLocaleTimeString("pt-BR")).join(", ")}
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {/* Reconhecimento da dívida em DESTAQUE (onda R). */}
      <Card
        className={
          ack == null
            ? "border-neutral-200"
            : ack.acknowledged
              ? "border-green-500 bg-green-50"
              : "border-amber-500 bg-amber-50"
        }
      >
        <CardHeader>
          <CardTitle>Reconhecimento da dívida</CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          {ack == null ? (
            <p className="text-muted-foreground">Sem resposta de reconhecimento registrada.</p>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-base font-semibold">
                {ack.acknowledged ? "Reconhece a dívida" : "NÃO reconhece a dívida"}
              </span>
              <span className="rounded bg-neutral-200 px-2 py-0.5 font-mono text-xs">
                button_id: {ack.button_id}
              </span>
              <span className="text-xs text-muted-foreground">
                {new Date(ack.created_at).toLocaleString("pt-BR")}
              </span>
            </div>
          )}
        </CardContent>
      </Card>

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
                    {/* badge do button_id: só no painel admin (esta rota é super_admin). */}
                    {m.button_id != null ? (
                      <span className="rounded bg-neutral-200 px-1.5 font-mono text-neutral-700">
                        botão {m.button_id}
                      </span>
                    ) : null}
                    {m.engine ? <span>engine: {m.engine}</span> : null}
                    {m.latency_ms != null ? <span>{m.latency_ms}ms</span> : null}
                    {m.n8n_execution_id ? (
                      <span className="font-mono">exec: {m.n8n_execution_id}</span>
                    ) : null}
                    {flagFallbackTurn(m) ? (
                      <span className="rounded bg-amber-200 px-1.5 font-mono text-amber-800">
                        fallback
                      </span>
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
          <CardTitle>Prompts / botões ({detail.prompts.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-xs">
          {detail.prompts.length === 0 ? (
            <p className="text-sm text-muted-foreground">Sem prompts.</p>
          ) : (
            detail.prompts.map((p) => (
              <div key={p.id} className="rounded-md border p-2">
                <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
                  <span className="rounded bg-neutral-200 px-1.5 font-mono">{p.kind}</span>
                  <span>{p.status}</span>
                  <span>por: {p.created_by}</span>
                  {p.answered_button_id != null ? (
                    <span className="rounded bg-blue-100 px-1.5 font-mono text-blue-800">
                      resp. botão {p.answered_button_id}
                      {p.answered_value ? ` (${p.answered_value})` : ""}
                    </span>
                  ) : null}
                  {p.n8n_execution_id ? (
                    <span className="font-mono">exec: {p.n8n_execution_id}</span>
                  ) : null}
                </div>
                <p className="mt-1">{p.question}</p>
                <p className="mt-1 font-mono text-neutral-500">
                  {(p.buttons ?? []).map((b) => `[${b.id}] ${b.label}`).join("  ")}
                </p>
              </div>
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
