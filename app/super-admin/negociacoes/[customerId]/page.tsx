// Detalhe do devedor (super-admin, T5 §6): estado atual + timeline (com
// PROCEDÊNCIA/actor) + transcrição + reconhecimento + ofertas + acordo +
// pagamentos + casos + mensagens por canal. Documento SEMPRE mascarado.
// Honestidade de dados (E4): entrega/leitura por canal só afirmadas quando o
// provedor informou; caso 'none' → "não informado pelo provedor".
import { notFound, redirect } from "next/navigation"
import Link from "next/link"
import { createClient } from "@/lib/supabase/server"
import { queryNegotiationDetail } from "@/components/super-admin/negotiations/detail-query"
import { StageBadge } from "@/components/super-admin/negotiations/badges"
import { stageLabel } from "@/components/super-admin/negotiations/stages"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

export const dynamic = "force-dynamic"

const BRL = (v: number | null) =>
  v == null ? "—" : new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v)

export default async function NegociacaoDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ customerId: string }>
  searchParams: Promise<{ companyId?: string }>
}) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect("/auth/login")
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single()
  if (profile?.role !== "super_admin") redirect("/")

  const { customerId } = await params
  const { companyId } = await searchParams
  if (!companyId) notFound()

  const detail = await queryNegotiationDetail(companyId, customerId)
  if (!detail.found) notFound()

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/super-admin/negociacoes"
          className="text-xs text-primary underline underline-offset-2"
        >
          ← Voltar
        </Link>
        <h1 className="mt-1 text-2xl font-bold">{detail.nameMasked}</h1>
        <p className="text-muted-foreground">
          {detail.cedente ?? "—"} · <span className="font-mono">{detail.documentMasked}</span> ·{" "}
          {detail.channel ?? "sem canal"}
        </p>
      </div>

      {/* Estado atual */}
      <Card>
        <CardHeader>
          <CardTitle>Estágio atual</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-4 text-sm">
          <StageBadge stage={detail.stage} at={detail.stageAt} />
          <span>
            Cobrança viva:{" "}
            <strong>{detail.hasLiveCharge ? "sim" : "não"}</strong>
          </span>
          <span className="text-xs text-muted-foreground">
            {detail.providerStatusSource === "none"
              ? "entrega/leitura: não informado pelo provedor"
              : `fonte do status: ${detail.providerStatusSource}`}
          </span>
        </CardContent>
      </Card>

      {/* Reconhecimento em destaque */}
      <Card
        className={
          detail.acknowledgement == null
            ? "border-neutral-200"
            : detail.acknowledgement.acknowledged
              ? "border-green-500 bg-green-50"
              : "border-amber-500 bg-amber-50"
        }
      >
        <CardHeader>
          <CardTitle>Reconhecimento da dívida</CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          {detail.acknowledgement == null ? (
            <p className="text-muted-foreground">Sem resposta de reconhecimento registrada.</p>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-base font-semibold">
                {detail.acknowledgement.acknowledged
                  ? "Reconhece a dívida"
                  : "NÃO reconhece a dívida"}
              </span>
              <span className="text-xs text-muted-foreground">
                {new Date(detail.acknowledgement.created_at).toLocaleString("pt-BR")}
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Acordo */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Acordo</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            {detail.agreement ? (
              <div className="space-y-1">
                <p>
                  Total: {BRL(detail.agreement.total_value)}
                  {detail.agreement.discount_percentage
                    ? ` (${detail.agreement.discount_percentage.toFixed(0)}% desc.)`
                    : ""}
                </p>
                <p>
                  {detail.agreement.installments && detail.agreement.installments > 1
                    ? `${detail.agreement.installments}x de ${BRL(detail.agreement.installment_amount)}`
                    : "à vista"}
                  {" · "}
                  {detail.agreement.billing_type ?? "—"}
                </p>
                <p>1º vencimento: {detail.agreement.first_due_date ?? "—"}</p>
                <p>
                  Status: {detail.agreement.status ?? "—"} · Pagamento:{" "}
                  {detail.agreement.payment_status ?? "—"}
                </p>
              </div>
            ) : (
              <p className="text-muted-foreground">Sem acordo.</p>
            )}
          </CardContent>
        </Card>

        {/* Pagamentos */}
        <Card>
          <CardHeader>
            <CardTitle>Pagamentos ({detail.payments.length})</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-xs">
            {detail.payments.length === 0 ? (
              <p className="text-sm text-muted-foreground">Sem parcelas.</p>
            ) : (
              detail.payments.map((p) => (
                <p key={p.id} className="flex justify-between">
                  <span>{p.due_date ?? "—"}</span>
                  <span>{BRL(p.amount)}</span>
                  <span className="text-muted-foreground">{p.status ?? "—"}</span>
                </p>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      {/* Ofertas */}
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
                {new Date(o.presented_at).toLocaleString("pt-BR")} · {o.status} · origem:{" "}
                {o.source} · {JSON.stringify(o.terms)}
              </p>
            ))
          )}
        </CardContent>
      </Card>

      {/* Casos */}
      <Card>
        <CardHeader>
          <CardTitle>Casos ({detail.cases.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-xs">
          {detail.cases.length === 0 ? (
            <p className="text-sm text-muted-foreground">Sem casos.</p>
          ) : (
            detail.cases.map((c) => (
              <div key={c.id} className="rounded-md border p-2">
                <span className="font-medium">{c.type}</span> · {c.status}
                {c.resolution ? <span> · {c.resolution}</span> : null}
                <span className="ml-2 text-muted-foreground">
                  {new Date(c.created_at).toLocaleString("pt-BR")}
                </span>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {/* Mensagens por canal — honestidade E4 (entrega/leitura só quando informada) */}
      <Card>
        <CardHeader>
          <CardTitle>Mensagens por canal ({detail.channelMessages.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-xs">
          {detail.channelMessages.length === 0 ? (
            <p className="text-sm text-muted-foreground">Sem mensagens de canal.</p>
          ) : (
            detail.channelMessages.map((m) => (
              <p key={m.id} className="flex flex-wrap items-center gap-2">
                <span className="text-muted-foreground">
                  {new Date(m.created_at).toLocaleString("pt-BR")}
                </span>
                <span className="rounded bg-neutral-100 px-1.5 font-mono">{m.channel ?? "—"}</span>
                <span>
                  {(m.provider_status_source ?? "none") === "none" ? (
                    <span className="italic text-muted-foreground">
                      status: não informado pelo provedor
                    </span>
                  ) : (
                    <>status: {m.status ?? "—"}</>
                  )}
                </span>
              </p>
            ))
          )}
        </CardContent>
      </Card>

      {/* Transcrição */}
      <Card>
        <CardHeader>
          <CardTitle>Transcrição ({detail.transcript.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {detail.transcript.length === 0 ? (
            <p className="text-sm text-muted-foreground">Sem mensagens de chat.</p>
          ) : (
            detail.transcript.map((m) => (
              <div key={m.id} className="rounded-md border p-2 text-sm">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span className="font-medium">{m.role}</span>
                  <span className="flex gap-2">
                    {m.engine ? <span>engine: {m.engine}</span> : null}
                    <span>{new Date(m.created_at).toLocaleString("pt-BR")}</span>
                  </span>
                </div>
                <p className="mt-1 whitespace-pre-wrap">{m.text}</p>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {/* Timeline com procedência (actor) — E5: 'in_chat' distinto de 'replied_whatsapp' */}
      <Card>
        <CardHeader>
          <CardTitle>Linha do tempo ({detail.timeline.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-xs">
          {detail.timeline.length === 0 ? (
            <p className="text-sm text-muted-foreground">Sem eventos.</p>
          ) : (
            detail.timeline.map((t) => (
              <p key={t.id} className="flex flex-wrap items-center gap-2">
                <span className="text-muted-foreground">
                  {new Date(t.occurred_at).toLocaleString("pt-BR")}
                </span>
                <span className="font-mono">{t.event_type}</span>
                <span className="rounded bg-neutral-100 px-1.5">procedência: {t.actor}</span>
                {t.event_type === "chat.turn.customer" ? (
                  <span className="rounded bg-blue-50 px-1.5 text-blue-700">in_chat</span>
                ) : null}
                <span className="text-muted-foreground">({stageLabel(mapEventStage(t.event_type))})</span>
              </p>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  )
}

/** Mapeia (para exibição) o event_type ao estágio-fonte — rótulo pt-BR ao lado do
 * evento. Espelho mínimo do mapa de T1 (só para legibilidade da timeline). */
function mapEventStage(eventType: string): string {
  const map: Record<string, string> = {
    "message.queued": "queued",
    "message.suppressed": "no_contact",
    "message.accepted": "dispatched",
    "message.sent": "dispatched",
    "message.delivered": "delivered",
    "message.read": "read",
    "message.failed": "no_contact",
    "link.clicked": "link_opened",
    "auth.success": "authenticated",
    "session.started": "authenticated",
    "chat.turn.customer": "in_chat",
    "chat.turn.assistant": "in_chat",
    "debt.viewed": "in_chat",
    "debt.acknowledged": "acknowledged",
    "debt.not_recognized": "not_recognized",
    "offer.presented": "offer_presented",
    "agreement.created": "charge_generated",
    "payment.generated": "charge_generated",
    "payment.overdue": "overdue",
    "payment.paid": "paid",
    "payment.cancelled": "charge_cancelled",
    "human.transfer": "human_handoff",
    "optout.received": "opted_out",
    "block.received": "blocked",
  }
  return map[eventType] ?? "not_started"
}
