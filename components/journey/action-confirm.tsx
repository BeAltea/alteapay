"use client"

// Confirmação em UM clique + confirmar para as ações destrutivas (V4.3).
// O GET só renderiza este componente; a ação real é um POST com o CSRF de
// sessão curta. Prefetch de link nunca dispara o POST.
import { useState } from "react"

export function ActionConfirm({
  token,
  kind,
  csrf,
  brandName,
  officialChannelUrl,
  officialChannelLabel,
}: {
  token: string
  kind: "optout" | "block"
  csrf: string
  brandName: string
  officialChannelUrl: string | null
  officialChannelLabel: string | null
}) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle")

  const title = kind === "optout" ? "Cancelar inscrição" : "Bloquear este número"
  const question =
    kind === "optout"
      ? "Você deixará de receber mensagens desta negociação neste número. Deseja confirmar?"
      : "Este número será bloqueado e não receberá mais nenhuma mensagem. Deseja confirmar?"

  async function confirm() {
    setState("busy")
    try {
      const res = await fetch("/api/chat/optout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, kind, csrf }),
      })
      setState(res.ok ? "done" : "error")
    } catch {
      setState("error")
    }
  }

  if (state === "done") {
    return (
      <div className="flex flex-1 flex-col gap-4">
        <h1 className="text-xl font-semibold">Pronto</h1>
        <p className="text-sm text-neutral-600">
          Você não receberá mais mensagens neste número.
        </p>
        <p className="text-sm text-neutral-500">
          Se isso foi sem querer, fale com o nosso atendimento
          {officialChannelUrl ? (
            <>
              {" "}
              <a
                href={officialChannelUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="underline underline-offset-2"
              >
                {officialChannelLabel ?? "pelo canal oficial"}
              </a>
            </>
          ) : null}
          .
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col gap-5">
      <div>
        <h1 className="text-xl font-semibold">{title}</h1>
        <p className="mt-2 text-sm text-neutral-600">{question}</p>
      </div>
      {state === "error" ? (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
          Não foi possível concluir agora. Tente novamente pelo link recebido.
        </p>
      ) : null}
      <button
        type="button"
        onClick={confirm}
        disabled={state === "busy"}
        className="mt-auto h-11 rounded-md bg-neutral-900 text-base font-semibold text-white disabled:opacity-40"
      >
        {state === "busy" ? "Confirmando..." : "Confirmar"}
      </button>
      <a href={`/c/${token}`} className="text-center text-sm text-neutral-500 underline underline-offset-2">
        Voltar
      </a>
    </div>
  )
}
