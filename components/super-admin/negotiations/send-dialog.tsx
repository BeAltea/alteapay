// Diálogo de confirmação de "Enviar negociação" (F1 §4.2).
//
// Fluxo: abrir → escolher CANAL (WhatsApp/e-mail, ambos por padrão) e "não
// duplicar" → chama /send-preview (servidor) e mostra distribuição POR CANAL,
// o CRUZAMENTO (quantos recebem pelos dois), excluídos com motivo por canal,
// quantos com cobrança viva (informativo) e o link /n/{code}. Confirmar → /send
// (dryRun disponível). Mostra resultado por (devedor, canal) e devolve os
// contadores ao pai.
"use client"

import { useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Progress } from "@/components/ui/progress"
import {
  detailLabel,
  failureRows,
  summarizeByChannel,
  summarizeForDisplay,
  type ChannelResultSummary,
  type EmailTemplateInfo,
  type SendChannel,
  type SendPreviewExcluded,
  type SendPreviewResponse,
  type SendRequestBody,
  type SendResponse,
} from "./send-contract"

/**
 * Lê o corpo NDJSON do /send (stream), linha a linha, chamando `onProgress` a
 * cada evento `progress` e devolvendo o `result` do evento `done`. Lança em
 * `error` (o chamador exibe e oferece nova tentativa). Robusto a chunks partidos
 * no meio de uma linha (bufferiza até o \n).
 */
async function readSendStream(
  body: ReadableStream<Uint8Array>,
  onProgress: (done: number, total: number) => void,
): Promise<SendResponse> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let result: SendResponse | null = null
  let streamError: string | null = null

  const handleLine = (line: string) => {
    const trimmed = line.trim()
    if (!trimmed) return
    let evt: { type?: string; done?: number; total?: number; result?: SendResponse; error?: string }
    try {
      evt = JSON.parse(trimmed)
    } catch {
      return // linha incompleta/ruído: ignora (o buffer cuida das partidas)
    }
    if (evt.type === "progress") {
      onProgress(evt.done ?? 0, evt.total ?? 0)
    } else if (evt.type === "done" && evt.result) {
      result = evt.result
    } else if (evt.type === "error") {
      streamError = evt.error ?? "Erro no envio"
    }
  }

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buffer.indexOf("\n")) >= 0) {
      handleLine(buffer.slice(0, idx))
      buffer = buffer.slice(idx + 1)
    }
  }
  // flush do resto (última linha sem \n).
  if (buffer) handleLine(buffer)

  if (streamError) throw new Error(streamError)
  if (!result) throw new Error("Envio interrompido: resultado não recebido.")
  return result
}

type SelectionPayload =
  | { kind: "ids"; customerIds: string[] }
  | { kind: "allFiltered"; filters: Record<string, unknown>; expectedCount: number }

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  companyId: string
  selection: SelectionPayload
  selectedCount: number
  onDone?: (result: SendResponse) => void
}

function toBody(
  selection: SelectionPayload,
  companyId: string,
  channels: SendChannel[],
  dedupe: boolean,
  dryRun: boolean,
  allowResend: boolean,
  idempotencyKey?: string | null,
): SendRequestBody {
  const base = { companyId, channels, dedupe, dryRun, allowResend, ...(idempotencyKey ? { idempotencyKey } : {}) }
  return selection.kind === "ids"
    ? { ...base, customerIds: selection.customerIds }
    : { ...base, allFiltered: { filters: selection.filters, expectedCount: selection.expectedCount } }
}

export function SendNegotiationDialog({
  open,
  onOpenChange,
  companyId,
  selection,
  selectedCount,
  onDone,
}: Props) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<SendPreviewResponse | null>(null)
  // Canal: ambos marcados por padrão (E1). "não duplicar" default OFF.
  const [whatsapp, setWhatsapp] = useState(true)
  const [email, setEmail] = useState(true)
  const [dedupe, setDedupe] = useState(false)
  const [dryRun, setDryRun] = useState(false)
  const [allowResend, setAllowResend] = useState(false)
  const [result, setResult] = useState<SendResponse | null>(null)
  // Envio em andamento: progresso REAL item-a-item via stream NDJSON. `sentTotal`
  // vem do servidor (nº de (devedor,canal) a processar); `sentDone` avança a cada
  // item processado. Quando o total ainda não chegou (0), a barra fica
  // indeterminada e mostramos só "Enviando…".
  const [sending, setSending] = useState(false)
  const [sentDone, setSentDone] = useState(0)
  const [sentTotal, setSentTotal] = useState(0)
  // A1: chave de idempotência gerada 1x por abertura do diálogo. Double-click/retry
  // reusam a MESMA chave → o servidor devolve a MESMA campanha (não duplica e-mail).
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null)

  const channels: SendChannel[] = [
    ...(whatsapp ? (["whatsapp"] as const) : []),
    ...(email ? (["email"] as const) : []),
  ]
  const noChannel = channels.length === 0

  async function loadPreview(next?: { channels?: SendChannel[]; dedupe?: boolean; allowResend?: boolean }) {
    const ch = next?.channels ?? channels
    if (ch.length === 0) {
      // sem canal: nada a pré-visualizar; o servidor default-a para ambos, então
      // evitamos a chamada e deixamos o preview vazio até o operador marcar um.
      setPreview(null)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const res = await fetch("/api/super-admin/negotiations/send-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(toBody(selection, companyId, ch, next?.dedupe ?? dedupe, true, next?.allowResend ?? allowResend)),
      })
      if (!res.ok) {
        setError(`Falha ao pré-visualizar (${res.status}).`)
        setPreview(null)
        return
      }
      const data = (await res.json()) as SendPreviewResponse
      setPreview(data)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  // Carrega o preview ao abrir (uma vez por abertura).
  const [loadedFor, setLoadedFor] = useState<boolean>(false)
  if (open && !loadedFor) {
    setLoadedFor(true)
    setResult(null)
    // nova chave por abertura: cada intenção de envio é uma campanha; o double-click
    // dentro da MESMA abertura compartilha a chave e é deduplicado no servidor.
    setIdempotencyKey(
      typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `hub-${Date.now()}`,
    )
    void loadPreview()
  }
  if (!open && loadedFor) {
    setLoadedFor(false)
    setPreview(null)
    setResult(null)
    setError(null)
    setSending(false)
    setSentDone(0)
    setSentTotal(0)
    setWhatsapp(true)
    setEmail(true)
    setDedupe(false)
    setDryRun(false)
    setAllowResend(false)
  }

  async function confirmSend() {
    setLoading(true)
    setSending(true)
    setError(null)
    setSentDone(0)
    setSentTotal(0)
    // Streaming NDJSON: pedimos progresso REAL item-a-item. No dry-run o servidor
    // ignora o header e devolve o JSON de uma vez (nada é enviado); tratamos os
    // dois casos: se o corpo NÃO for stream (dry-run/queue), lemos o JSON direto.
    const wantStream = !dryRun
    try {
      const res = await fetch("/api/super-admin/negotiations/send", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(wantStream ? { "x-stream": "1" } : {}),
        },
        body: JSON.stringify(toBody(selection, companyId, channels, dedupe, dryRun, allowResend, idempotencyKey)),
      })
      if (!res.ok) {
        const msg = await res.json().catch(() => null)
        setError(msg?.error ? String(msg.error) : `Falha ao enviar (${res.status}).`)
        return
      }
      const contentType = res.headers.get("content-type") ?? ""
      let data: SendResponse
      if (contentType.includes("ndjson") && res.body) {
        // caminho stream: lê linha a linha e atualiza a barra em tempo real.
        data = await readSendStream(res.body, (done, total) => {
          setSentDone(done)
          setSentTotal(total)
        })
      } else {
        // caminho JSON (dry-run, modo queue, ou navegador sem streaming): resposta
        // única — sem progresso item-a-item, mas o resultado é o mesmo formato.
        data = (await res.json()) as SendResponse
      }
      setResult(data)
      onDone?.(data)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSending(false)
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Enviar negociação</DialogTitle>
          <DialogDescription>
            {selectedCount} devedor(es) selecionado(s). Escolha o canal e revise antes de confirmar.
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <p className="rounded-md border border-red-200 bg-red-50 p-2 text-sm text-red-700">
            {error}
          </p>
        ) : null}

        {sending ? (
          <SendingProgress count={selectedCount} done={sentDone} total={sentTotal} dryRun={dryRun} />
        ) : !result ? (
          <div className="space-y-4">
            {/* Seleção de CANAL (E1) */}
            <div className="rounded-md border p-3 text-sm">
              <div className="mb-2 font-medium">Canais</div>
              <div className="flex flex-col gap-2">
                <label className="flex items-center gap-2">
                  <Checkbox
                    checked={whatsapp}
                    onCheckedChange={(v) => {
                      const nv = !!v
                      setWhatsapp(nv)
                      const nc: SendChannel[] = [...(nv ? (["whatsapp"] as const) : []), ...(email ? (["email"] as const) : [])]
                      void loadPreview({ channels: nc })
                    }}
                  />
                  <span>
                    WhatsApp (Voxuy)
                    {preview?.whatsappSimulated ? (
                      <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-700">
                        simulado
                      </span>
                    ) : null}
                  </span>
                </label>
                <label className="flex items-center gap-2">
                  <Checkbox
                    checked={email}
                    onCheckedChange={(v) => {
                      const nv = !!v
                      setEmail(nv)
                      const nc: SendChannel[] = [...(whatsapp ? (["whatsapp"] as const) : []), ...(nv ? (["email"] as const) : [])]
                      void loadPreview({ channels: nc })
                    }}
                  />
                  <span>E-mail (SendGrid)</span>
                </label>
                <label className="mt-1 flex items-center gap-2 border-t pt-2">
                  <Checkbox
                    checked={dedupe}
                    onCheckedChange={(v) => {
                      const nv = !!v
                      setDedupe(nv)
                      void loadPreview({ dedupe: nv })
                    }}
                  />
                  <span>Não duplicar (priorizar WhatsApp para quem tem os dois)</span>
                </label>
              </div>
              {noChannel ? (
                <p className="mt-2 text-xs text-red-600">
                  Marque ao menos um canal para enviar.
                </p>
              ) : null}
            </div>

            {loading && !preview ? (
              <p className="text-sm text-muted-foreground">Calculando pré-visualização…</p>
            ) : preview ? (
              <>
                {/* Destaque do CRUZAMENTO (E2): quantos recebem pelos dois. */}
                {channels.length === 2 ? (
                  <div className="rounded-md border border-blue-200 bg-blue-50 p-2 text-sm text-blue-800">
                    <strong>{preview.bothCount}</strong> devedor(es) receberão pelos{" "}
                    <strong>dois canais</strong> (WhatsApp + e-mail).{" "}
                    {preview.dedupe ? (
                      <span>Com &quot;não duplicar&quot; ativo, quem tem os dois vai só por WhatsApp.</span>
                    ) : (
                      <span>{preview.hasBothContacts} têm os dois contatos.</span>
                    )}
                  </div>
                ) : null}

                <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                  <Stat label="Total (distintos)" value={preview.total} />
                  <Stat label="WhatsApp" value={preview.perChannel.whatsapp.eligible} />
                  <Stat label="E-mail" value={preview.perChannel.email.eligible} />
                  <Stat label="Cobrança viva" value={preview.withLiveCharge} muted />
                </div>

                <div className="rounded-md border p-3 text-xs">
                  Link a enviar:{" "}
                  {preview.publicLink ? (
                    <code className="rounded bg-neutral-100 px-1.5 py-0.5 font-mono">
                      {preview.publicLink}
                    </code>
                  ) : (
                    <span className="text-amber-600">
                      link único desabilitado para este cedente
                    </span>
                  )}
                </div>

                {/* F4: qual template o E-MAIL usará (padrão do cedente / global / convite). */}
                {email && preview.emailTemplate ? (
                  <EmailTemplateLine info={preview.emailTemplate} />
                ) : null}

                {/* Excluídos POR CANAL (E4): nunca troca silenciosa. */}
                {channels.map((ch) => {
                  const ex = preview.perChannel[ch].excluded
                  if (ex.length === 0) return null
                  return <ExcludedList key={ch} channel={ch} excluded={ex} />
                })}

                <label className="flex items-center gap-2 text-sm">
                  <Checkbox checked={dryRun} onCheckedChange={(v) => setDryRun(!!v)} />
                  Simular (dry run) — não envia nada, só reporta o resultado por canal
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={allowResend}
                    onCheckedChange={(v) => {
                      setAllowResend(!!v)
                      // re-avalia o preview com o novo valor (senão os contadores ficam velhos)
                      void loadPreview({ allowResend: !!v })
                    }}
                  />
                  Permitir reenvio (ignorar janela de cooldown)
                </label>
              </>
            ) : null}
          </div>
        ) : (
          <SendResultView result={result} />
        )}

        <DialogFooter>
          {sending ? (
            <Button disabled>Enviando…</Button>
          ) : !result ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
                Cancelar
              </Button>
              <Button
                onClick={confirmSend}
                disabled={loading || noChannel || !preview || preview.total === 0}
              >
                {dryRun ? "Simular envio" : "Confirmar e enviar"}
              </Button>
            </>
          ) : (
            <Button onClick={() => onOpenChange(false)}>Fechar</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const CHANNEL_LABEL: Record<SendChannel, string> = {
  whatsapp: "WhatsApp",
  email: "E-mail",
}

function ExcludedList({ channel, excluded }: { channel: SendChannel; excluded: SendPreviewExcluded[] }) {
  return (
    <details className="rounded-md border p-3 text-sm">
      <summary className="cursor-pointer font-medium">
        Excluídos de {CHANNEL_LABEL[channel]} ({excluded.length})
      </summary>
      <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto">
        {excluded.map((e) => (
          <li key={`${channel}_${e.customerId}`} className="flex justify-between gap-2 text-xs">
            <span className="font-mono">{e.documentMasked}</span>
            <span className="text-muted-foreground">{detailLabel(e.reason)}</span>
          </li>
        ))}
      </ul>
    </details>
  )
}

function Stat({ label, value, muted }: { label: string; value: number; muted?: boolean }) {
  return (
    <div className={`rounded-md border p-2 text-center ${muted ? "bg-neutral-50" : ""}`}>
      <div className="text-lg font-semibold">{value}</div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
    </div>
  )
}

const TEMPLATE_SOURCE_LABEL: Record<EmailTemplateInfo["source"], string> = {
  cedente: "padrão do cedente",
  global: "padrão global",
  builtin: "convite padrão AlteaPay",
}

/**
 * F4: linha "E-mail usará: <template> (fonte)". Quando o cedente não tem padrão
 * definido (builtin), mostra o convite embutido e um link para Gerenciamento de
 * E-mails, onde o operador pode definir o padrão do cedente.
 */
function EmailTemplateLine({ info }: { info: EmailTemplateInfo }) {
  return (
    <div className="rounded-md border p-3 text-xs">
      E-mail usará:{" "}
      <strong>{info.name}</strong>{" "}
      <span className="text-muted-foreground">({TEMPLATE_SOURCE_LABEL[info.source]})</span>
      {info.source === "builtin" ? (
        <span className="ml-1 text-muted-foreground">
          — nenhum padrão definido para este cedente.{" "}
          <a href="/super-admin/emails" className="underline" target="_blank" rel="noopener noreferrer">
            Definir em Gerenciamento de E-mails
          </a>
        </span>
      ) : null}
    </div>
  )
}

const OUTCOME_CLASS: Record<string, string> = {
  sent: "text-green-700",
  failed: "text-red-700",
  suppressed: "text-amber-700",
  skipped: "text-muted-foreground",
}

/** Rótulo por linha: num dry run, "sent" é "Simulado" (nada saiu). */
function outcomeLabel(outcome: string, dryRun: boolean): string {
  if (outcome === "sent") return dryRun ? "Simulado" : "Enviado"
  if (outcome === "failed") return "Falhou"
  if (outcome === "suppressed") return "Suprimido"
  if (outcome === "skipped") return "Ignorado"
  return outcome
}

/**
 * Barra de progresso REAL durante o envio. `total` = nº de (devedor, canal) a
 * processar (vem do servidor via stream); `done` avança a cada item enviado. A
 * barra é honesta: reflete done/total. Enquanto o total não chegou (0), fica
 * indeterminada e mostra só "Enviando…". No dry-run/queue (sem stream) não há
 * item-a-item — mostramos a mensagem de processamento sem porcentagem.
 */
function SendingProgress({
  count,
  done,
  total,
  dryRun,
}: {
  count: number
  done: number
  total: number
  dryRun: boolean
}) {
  const hasProgress = total > 0
  const pct = hasProgress ? Math.min(100, Math.round((done / total) * 100)) : 0
  const verb = dryRun ? "Simulando" : "Enviando"
  return (
    <div className="space-y-3 py-2">
      <p className="text-sm font-medium">
        {hasProgress ? `${verb}… (${done} de ${total})` : `${verb} ${count} devedor(es)…`}
      </p>
      <Progress value={hasProgress ? pct : undefined} className={hasProgress ? undefined : "animate-pulse"} />
      <p className="text-xs text-muted-foreground">
        Processando a seleção no servidor. Não feche esta janela.
      </p>
    </div>
  )
}

/** Cartão de contador do resumo (A3.3). */
function SummaryStat({
  label,
  value,
  className,
}: {
  label: string
  value: number
  className?: string
}) {
  return (
    <div className="rounded-md border p-2 text-center">
      <div className={`text-lg font-semibold ${className ?? ""}`}>{value}</div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
    </div>
  )
}

/**
 * Frase de resumo por canal (painel de sucesso). Ex.: "WhatsApp: 12 aceitos"
 * / "E-mail: 8 enviados, 1 falha". Sem PII. Vazio → "nenhum item processado".
 */
function channelPhrase(c: ChannelResultSummary, dryRun: boolean): string {
  const parts: string[] = []
  if (c.sent > 0) {
    if (dryRun) parts.push(`${c.sent} simulados`)
    else parts.push(c.channel === "whatsapp" ? `${c.sent} aceitos` : `${c.sent} enviados`)
  }
  if (c.failed > 0) parts.push(`${c.failed} ${c.failed === 1 ? "falha" : "falhas"}`)
  if (c.suppressed > 0) parts.push(`${c.suppressed} suprimidos`)
  if (c.skipped > 0) parts.push(`${c.skipped} ignorados`)
  return parts.length > 0 ? parts.join(", ") : "nenhum item"
}

function SendResultView({ result }: { result: SendResponse }) {
  const summary = summarizeForDisplay(result)
  const failures = failureRows(result)
  const byChannel = summarizeByChannel(result)
  return (
    <div className="space-y-3">
      {/* Cabeçalho de SUCESSO: confirma que o envio terminou + resumo por canal. */}
      <div className="rounded-md border border-green-200 bg-green-50 p-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-green-800">
          <span aria-hidden>✓</span>
          <span>{result.dryRun ? "Simulação concluída" : "Envio concluído"}</span>
        </div>
        {byChannel.length > 0 ? (
          <ul className="mt-1.5 space-y-0.5 text-xs text-green-900">
            {byChannel.map((c) => (
              <li key={c.channel}>
                <span className="font-medium">{CHANNEL_LABEL[c.channel]}:</span>{" "}
                {channelPhrase(c, result.dryRun)}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1.5 text-xs text-green-900">Nenhum item foi processado.</p>
        )}
      </div>

      {result.dryRun ? (
        <p className="rounded-md border border-blue-200 bg-blue-50 p-2 text-sm text-blue-700">
          Simulação (dry run) — nada foi enviado.
        </p>
      ) : null}

      {/* Resumo: enviadas / simuladas / falharam / suprimidas / ignoradas.
          As linhas são por (devedor, canal). */}
      <div className="grid grid-cols-3 gap-2 text-sm sm:grid-cols-5">
        <SummaryStat label="Enviadas" value={summary.enviadas} className="text-green-700" />
        <SummaryStat label="Simuladas" value={summary.simuladas} className="text-blue-700" />
        <SummaryStat label="Falharam" value={summary.falharam} className="text-red-700" />
        <SummaryStat label="Suprimidas" value={summary.suprimidas} className="text-amber-700" />
        <SummaryStat label="Ignoradas" value={summary.ignoradas} className="text-muted-foreground" />
      </div>

      {/* Lista dedicada de FALHAS com motivo legível (A3.3). */}
      {failures.length > 0 ? (
        <div className="rounded-md border border-red-200 bg-red-50/40 p-3 text-sm">
          <div className="mb-2 font-medium text-red-700">Falhas ({failures.length})</div>
          <ul className="max-h-40 space-y-1 overflow-y-auto">
            {failures.map((f) => (
              <li key={`${f.channel ?? "-"}_${f.customerId}`} className="flex justify-between gap-2 text-xs">
                <span className="font-mono">{f.documentMasked}</span>
                <span className="text-muted-foreground">
                  {f.channel ? `${f.channel} · ` : ""}
                  {f.reason}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Detalhamento por (devedor, canal) (todos os desfechos). */}
      <div className="max-h-56 overflow-y-auto rounded-md border">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-neutral-50">
            <tr>
              <th className="p-2 text-left">Documento</th>
              <th className="p-2 text-left">Canal</th>
              <th className="p-2 text-left">Resultado</th>
              <th className="p-2 text-left">Detalhe</th>
            </tr>
          </thead>
          <tbody>
            {result.results.map((r, i) => (
              <tr key={`${r.customerId}_${r.channel ?? "-"}_${i}`} className="border-t">
                <td className="p-2 font-mono">{r.documentMasked}</td>
                <td className="p-2">{r.channel ?? "—"}</td>
                <td className={`p-2 font-medium ${OUTCOME_CLASS[r.outcome]}`}>
                  {outcomeLabel(r.outcome, result.dryRun)}
                </td>
                <td className="p-2 text-muted-foreground">{detailLabel(r.detail)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
