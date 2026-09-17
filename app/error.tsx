"use client"

// Error boundary de rota (App Router): renderiza uma página amigável quando algo
// falha em runtime, em vez de uma tela quebrada. Client component obrigatório.
import { useEffect } from "react"
import Link from "next/link"

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    // Log no console do cliente; o digest ajuda a correlacionar no servidor.
    console.error("[app/error]", error?.digest ?? "", error?.message)
  }, [error])

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-white px-4 py-16 text-center text-altea-navy">
      <div className="mx-auto max-w-xl">
        <p className="text-sm font-semibold uppercase tracking-wide text-altea-navy-light">
          Estamos ajustando algo
        </p>
        <h1 className="mt-2 text-3xl font-bold text-altea-navy sm:text-4xl">
          Tivemos um probleminha por aqui
        </h1>
        <p className="mt-4 text-lg text-gray-600">
          Não foi você — algo do nosso lado não respondeu como devia. Você pode
          tentar de novo em instantes ou voltar para a página inicial. Se
          continuar, fale com a gente que resolvemos rápido.
        </p>
        <div className="mt-8 flex flex-col justify-center gap-4 sm:flex-row">
          <button
            onClick={() => reset()}
            className="rounded-lg bg-altea-navy px-6 py-3 font-semibold text-white transition-colors hover:bg-altea-navy-light"
          >
            Tentar novamente
          </button>
          <Link
            href="/"
            className="rounded-lg border border-gray-300 px-6 py-3 font-medium text-altea-navy transition-colors hover:border-altea-navy"
          >
            Ir para a página inicial
          </Link>
          <a
            href="/#contato"
            className="rounded-lg border border-gray-300 px-6 py-3 font-medium text-altea-navy transition-colors hover:border-altea-navy"
          >
            Falar com a AlteaPay
          </a>
        </div>
        {error?.digest ? (
          <p className="mt-6 text-xs text-gray-400">Código de referência: {error.digest}</p>
        ) : null}
      </div>
    </div>
  )
}
