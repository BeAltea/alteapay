"use client"

// Tela de escolha do link único (V1/V4). Aparece ANTES de qualquer
// autenticação e SEM nenhum dado da dívida: só marca do credor, texto neutro
// e três ações. Resolve L3 (botões) e L2 (opt-out): as três opções existem
// sempre, sob nosso controle e auditáveis.
import { useRouter } from "next/navigation"

export function ChoiceScreen({ token }: { token: string }) {
  const router = useRouter()
  return (
    <div className="flex flex-1 flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">Há uma atualização em seu nome</h1>
        <p className="mt-2 text-sm text-neutral-600">
          Existe uma atualização sobre um contrato registrado em seu nome. Por segurança, o
          credor e os detalhes só aparecem após a confirmação dos seus dados. Escolha uma opção
          abaixo.
        </p>
      </div>

      <div className="flex flex-col gap-3">
        <button
          type="button"
          onClick={() => router.push(`/c/${token}/consultar`)}
          style={{ backgroundColor: "var(--brand-secondary)" }}
          className="h-12 rounded-md text-base font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 focus-visible:ring-offset-2"
        >
          Consultar atualização
        </button>

        <button
          type="button"
          onClick={() => router.push(`/c/${token}/cancelar`)}
          className="h-11 rounded-md border border-neutral-300 bg-white text-sm font-medium text-neutral-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 focus-visible:ring-offset-2"
        >
          Cancelar inscrição (não quero mais mensagens)
        </button>

        <button
          type="button"
          onClick={() => router.push(`/c/${token}/bloquear`)}
          className="h-11 rounded-md border border-neutral-300 bg-white text-sm font-medium text-neutral-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 focus-visible:ring-offset-2"
        >
          Bloquear este número
        </button>
      </div>

      <p className="mt-auto text-[11px] text-neutral-400">
        Para sua segurança, os detalhes só aparecem após a confirmação dos seus dados.
      </p>
    </div>
  )
}
