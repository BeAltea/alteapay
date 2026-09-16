import Link from "next/link"
import { homeNav } from "@/content/home"
import { LOGIN_URL } from "@/content/site"
import { MobileNav } from "./mobile-nav"

/**
 * Header da landing (server): logo, navegacao desktop e CTAs renderizados no
 * servidor; a interatividade do menu mobile vive em mobile-nav.tsx (client).
 */
export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 bg-altea-navy text-white shadow-md">
      <a href="#conteudo" className="lp-skip-link">
        Ir para o conteúdo
      </a>
      <div className="container mx-auto flex h-16 max-w-6xl items-center justify-between px-4">
        <Link href="/" className="flex items-center gap-3" aria-label="AlteaPay, ir para a página inicial">
          <span className="rounded-lg bg-altea-gold p-1.5" aria-hidden="true">
            <span className="flex h-6 w-6 items-center justify-center rounded-sm bg-altea-navy">
              <span className="text-sm font-bold text-altea-gold">A</span>
            </span>
          </span>
          <span className="text-xl font-bold">AlteaPay</span>
        </Link>

        <nav aria-label="Principal" className="hidden lg:block">
          <ul className="flex items-center gap-6">
            {homeNav.map((item) => (
              <li key={item.href}>
                <a href={item.href} className="text-sm text-white transition-colors hover:text-altea-gold">
                  {item.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="hidden items-center gap-3 lg:flex">
          <Link
            href={LOGIN_URL}
            className="rounded-lg border border-white/60 px-4 py-2 text-sm font-medium text-white transition-colors hover:border-altea-gold hover:text-altea-gold"
          >
            Entrar
          </Link>
          <a
            href="/#contato"
            className="rounded-lg bg-altea-gold px-4 py-2 text-sm font-semibold text-altea-navy transition-colors hover:bg-altea-gold-bright"
          >
            Agendar demonstração
          </a>
        </div>

        <MobileNav />
      </div>
    </header>
  )
}
