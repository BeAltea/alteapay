// Documento (CPF/CNPJ) mascarado por padrão, com ação "revelar" por linha e
// auditada (privacidade A5). O componente NUNCA recebe o documento em claro:
// ele recebe apenas a versão MASCARADA (do servidor) + o id da linha e o
// companyId, e busca o claro sob demanda em POST /api/super-admin/reveal-document,
// que grava journey_events (type='document.revealed') antes de responder.
"use client"

import { useState } from "react"
import { Eye, EyeOff, Loader2 } from "lucide-react"
import { toast } from "sonner"

interface Props {
  /** Documento já mascarado (ex.: "***.366.958-**"), renderizado por padrão. */
  masked: string
  /** id da linha (VMAX.id) para o endpoint resolver o claro no servidor. */
  id: string
  /** escopo multi-tenant; o servidor valida id_company. */
  companyId: string
  className?: string
}

export function RevealableDocument({ masked, id, companyId, className }: Props) {
  const [clear, setClear] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function reveal() {
    if (loading) return
    setLoading(true)
    try {
      const res = await fetch("/api/super-admin/reveal-document", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // motivo padrão "consulta operacional" (o endpoint aplica o default).
        body: JSON.stringify({ id, companyId, reason: "consulta operacional" }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        toast.error(err?.error || "Não foi possível revelar o documento")
        return
      }
      const data = (await res.json()) as { document?: string }
      setClear(data.document ?? masked)
    } catch {
      toast.error("Não foi possível revelar o documento")
    } finally {
      setLoading(false)
    }
  }

  function hide() {
    setClear(null)
  }

  const revealed = clear !== null

  return (
    <span className={`inline-flex items-center gap-1 ${className ?? ""}`}>
      <span className="font-mono">{revealed ? clear : masked}</span>
      <button
        type="button"
        onClick={revealed ? hide : reveal}
        disabled={loading || !id || !companyId}
        aria-label={revealed ? "Ocultar documento" : "Revelar documento"}
        title={
          !id || !companyId
            ? "Documento indisponível para revelar"
            : revealed
              ? "Ocultar documento"
              : "Revelar documento (ação auditada)"
        }
        className="text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
      >
        {loading ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : revealed ? (
          <EyeOff className="h-3.5 w-3.5" />
        ) : (
          <Eye className="h-3.5 w-3.5" />
        )}
      </button>
    </span>
  )
}
