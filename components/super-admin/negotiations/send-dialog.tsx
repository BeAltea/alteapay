// Diálogo de confirmação de "Enviar negociação" (T5 §4.2).
//
// Fluxo: abrir → chama /send-preview (servidor) e mostra distribuição por canal,
// excluídos com motivo, quantos com cobrança viva (informativo), o mode vigente
// (com troca whatsapp_chat↔charge_email quando o tenant permitir) e o link
// /n/{code}. Confirmar → /send (dryRun disponível). Mostra resultado por devedor
// (sent/failed/suppressed/skipped) e devolve os contadores ao pai.
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
import {
  type SendMode,
  type SendPreviewResponse,
  type SendRequestBody,
  type SendResponse,
} from "./send-contract"

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

const MODE_LABEL: Record<SendMode, string> = {
  whatsapp_chat: "WhatsApp + chat",
  charge_email: "Cobrança por e-mail",
  both: "Ambos",
}

function toBody(
  selection: SelectionPayload,
  companyId: string,
  mode: SendMode,
  dryRun: boolean,
): SendRequestBody {
  const base = { companyId, mode, dryRun }
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
  const [mode, setMode] = useState<SendMode>("whatsapp_chat")
  const [dryRun, setDryRun] = useState(false)
  const [result, setResult] = useState<SendResponse | null>(null)

  async function loadPreview(nextMode?: SendMode) {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch("/api/super-admin/negotiations/send-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(toBody(selection, companyId, nextMode ?? mode, true)),
      })
      if (!res.ok) {
        setError(`Falha ao pré-visualizar (${res.status}).`)
        setPreview(null)
        return
      }
      const data = (await res.json()) as SendPreviewResponse
      setPreview(data)
      if (data.mode) setMode(data.mode)
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
    void loadPreview()
  }
  if (!open && loadedFor) {
    setLoadedFor(false)
    setPreview(null)
    setResult(null)
    setError(null)
  }

  async function confirmSend() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch("/api/super-admin/negotiations/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(toBody(selection, companyId, mode, dryRun)),
      })
      if (!res.ok) {
        setError(`Falha ao enviar (${res.status}).`)
        return
      }
      const data = (await res.json()) as SendResponse
      setResult(data)
      onDone?.(data)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const canSwitchMode = (preview?.allowedModes.length ?? 0) > 1

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Enviar negociação</DialogTitle>
          <DialogDescription>
            {selectedCount} devedor(es) selecionado(s). Revise antes de confirmar.
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <p className="rounded-md border border-red-200 bg-red-50 p-2 text-sm text-red-700">
            {error}
          </p>
        ) : null}

        {!result ? (
          <div className="space-y-4">
            {loading && !preview ? (
              <p className="text-sm text-muted-foreground">Calculando pré-visualização…</p>
            ) : preview ? (
              <>
                <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                  <Stat label="Total" value={preview.total} />
                  <Stat label="WhatsApp" value={preview.byChannel.whatsapp} />
                  <Stat label="E-mail" value={preview.byChannel.email} />
                  <Stat label="Cobrança viva" value={preview.withLiveCharge} muted />
                </div>

                <div className="rounded-md border p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="font-medium">Modo:</span>
                    {(["whatsapp_chat", "charge_email", "both"] as SendMode[]).map((m) => {
                      const allowed = preview.allowedModes.includes(m)
                      return (
                        <label
                          key={m}
                          className={`flex items-center gap-1.5 ${
                            allowed ? "cursor-pointer" : "cursor-not-allowed opacity-40"
                          }`}
                        >
                          <input
                            type="radio"
                            name="send-mode"
                            checked={mode === m}
                            disabled={!allowed || !canSwitchMode}
                            onChange={() => {
                              setMode(m)
                              void loadPreview(m)
                            }}
                          />
                          {MODE_LABEL[m]}
                        </label>
                      )
                    })}
                  </div>
                  {!canSwitchMode ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Este cedente permite apenas o modo {MODE_LABEL[mode]}.
                    </p>
                  ) : null}
                  <p className="mt-2 text-xs">
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
                  </p>
                </div>

                {preview.excluded.length > 0 ? (
                  <details className="rounded-md border p-3 text-sm">
                    <summary className="cursor-pointer font-medium">
                      Excluídos ({preview.excluded.length})
                    </summary>
                    <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto">
                      {preview.excluded.map((e) => (
                        <li key={e.customerId} className="flex justify-between gap-2 text-xs">
                          <span className="font-mono">{e.documentMasked}</span>
                          <span className="text-muted-foreground">{e.reason}</span>
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}

                <label className="flex items-center gap-2 text-sm">
                  <Checkbox checked={dryRun} onCheckedChange={(v) => setDryRun(!!v)} />
                  Simular (dry run) — não envia nada, só reporta o resultado por devedor
                </label>
              </>
            ) : null}
          </div>
        ) : (
          <SendResultView result={result} />
        )}

        <DialogFooter>
          {!result ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
                Cancelar
              </Button>
              <Button onClick={confirmSend} disabled={loading || !preview || preview.total === 0}>
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

function Stat({ label, value, muted }: { label: string; value: number; muted?: boolean }) {
  return (
    <div className={`rounded-md border p-2 text-center ${muted ? "bg-neutral-50" : ""}`}>
      <div className="text-lg font-semibold">{value}</div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
    </div>
  )
}

const OUTCOME_LABEL: Record<string, string> = {
  sent: "Enviado",
  failed: "Falhou",
  suppressed: "Suprimido",
  skipped: "Ignorado",
}
const OUTCOME_CLASS: Record<string, string> = {
  sent: "text-green-700",
  failed: "text-red-700",
  suppressed: "text-amber-700",
  skipped: "text-muted-foreground",
}

function SendResultView({ result }: { result: SendResponse }) {
  return (
    <div className="space-y-3">
      {result.dryRun ? (
        <p className="rounded-md border border-blue-200 bg-blue-50 p-2 text-sm text-blue-700">
          Simulação (dry run) — nada foi enviado.
        </p>
      ) : null}
      <div className="grid grid-cols-4 gap-2 text-sm">
        {(["sent", "failed", "suppressed", "skipped"] as const).map((k) => (
          <div key={k} className="rounded-md border p-2 text-center">
            <div className={`text-lg font-semibold ${OUTCOME_CLASS[k]}`}>{result.counts[k]}</div>
            <div className="text-[11px] text-muted-foreground">{OUTCOME_LABEL[k]}</div>
          </div>
        ))}
      </div>
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
            {result.results.map((r) => (
              <tr key={r.customerId} className="border-t">
                <td className="p-2 font-mono">{r.documentMasked}</td>
                <td className="p-2">{r.channel ?? "—"}</td>
                <td className={`p-2 font-medium ${OUTCOME_CLASS[r.outcome]}`}>
                  {OUTCOME_LABEL[r.outcome]}
                </td>
                <td className="p-2 text-muted-foreground">{r.detail ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
