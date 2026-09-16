import type { Metadata } from "next"
import Link from "next/link"
import { SiteHeader } from "@/components/landing/site-header"
import { SiteFooter } from "@/components/landing/site-footer"

export const metadata: Metadata = {
  title: "Página não encontrada",
  robots: {
    index: false,
    follow: false,
  },
}

export default function NotFound() {
  return (
    <div className="lp-root flex min-h-screen flex-col bg-white">
      <SiteHeader />
      <main id="conteudo" className="flex flex-1 items-center px-4 py-16">
        <div className="container mx-auto max-w-2xl text-center">
          <p className="text-sm font-semibold uppercase tracking-wide text-altea-navy-light">Erro 404</p>
          <h1 className="mt-2 text-3xl font-bold text-altea-navy sm:text-4xl">Página não encontrada</h1>
          <p className="mt-4 text-lg text-gray-600">
            O endereço que você acessou não existe ou foi movido. Você pode voltar para a página inicial, falar com a
            gente ou acessar o Portal do Cliente.
          </p>
          <div className="mt-8 flex flex-col justify-center gap-4 sm:flex-row">
            <Link
              href="/"
              className="rounded-lg bg-altea-navy px-6 py-3 font-semibold text-white transition-colors hover:bg-altea-navy-light"
            >
              Ir para a página inicial
            </Link>
            <a
              href="/#contato"
              className="rounded-lg border border-gray-300 px-6 py-3 font-medium text-altea-navy transition-colors hover:border-altea-navy"
            >
              Falar com a AlteaPay
            </a>
            <Link
              href="/auth/portal-register"
              className="rounded-lg border border-gray-300 px-6 py-3 font-medium text-altea-navy transition-colors hover:border-altea-navy"
            >
              Portal do Cliente
            </Link>
          </div>
        </div>
      </main>
      <SiteFooter />
    </div>
  )
}
