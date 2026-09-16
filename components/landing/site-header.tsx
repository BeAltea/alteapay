"use client"

import { useEffect, useRef, useState } from "react"
import Link from "next/link"
import { Menu, X } from "lucide-react"
import { homeNav } from "@/content/home"

const MOBILE_MENU_ID = "lp-menu-mobile"

export function SiteHeader() {
  const [menuOpen, setMenuOpen] = useState(false)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  // Fecha com Esc (devolvendo o foco ao botao) e com clique fora do painel
  useEffect(() => {
    if (!menuOpen) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false)
        toggleRef.current?.focus()
        return
      }

      // Mantem o foco dentro do painel enquanto aberto
      if (event.key === "Tab" && panelRef.current) {
        const focusables = panelRef.current.querySelectorAll<HTMLElement>("a[href], button:not([disabled])")
        if (focusables.length === 0) return
        const first = focusables[0]
        const last = focusables[focusables.length - 1]
        const active = document.activeElement

        if (event.shiftKey && (active === first || active === toggleRef.current)) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && active === last) {
          event.preventDefault()
          first.focus()
        }
      }
    }

    const onClick = (event: MouseEvent) => {
      const target = event.target as Node
      if (panelRef.current?.contains(target) || toggleRef.current?.contains(target)) return
      setMenuOpen(false)
    }

    document.addEventListener("keydown", onKeyDown)
    document.addEventListener("click", onClick)
    return () => {
      document.removeEventListener("keydown", onKeyDown)
      document.removeEventListener("click", onClick)
    }
  }, [menuOpen])

  // Foca o primeiro link ao abrir o menu mobile
  useEffect(() => {
    if (menuOpen) {
      panelRef.current?.querySelector<HTMLElement>("a[href]")?.focus()
    }
  }, [menuOpen])

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
            href="/auth/login"
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

        <button
          ref={toggleRef}
          type="button"
          className="rounded-lg p-2 text-white transition-colors hover:text-altea-gold lg:hidden"
          aria-expanded={menuOpen}
          aria-controls={MOBILE_MENU_ID}
          aria-label={menuOpen ? "Fechar menu" : "Abrir menu"}
          onClick={() => setMenuOpen((open) => !open)}
        >
          {menuOpen ? <X className="h-6 w-6" aria-hidden="true" /> : <Menu className="h-6 w-6" aria-hidden="true" />}
        </button>
      </div>

      <div
        ref={panelRef}
        id={MOBILE_MENU_ID}
        hidden={!menuOpen}
        className="border-t border-white/10 bg-altea-navy lg:hidden"
      >
        <nav aria-label="Principal (menu móvel)" className="container mx-auto max-w-6xl px-4 py-4">
          <ul className="flex flex-col gap-1">
            {homeNav.map((item) => (
              <li key={item.href}>
                <a
                  href={item.href}
                  className="block rounded-lg px-3 py-2 text-white transition-colors hover:bg-altea-navy-light hover:text-altea-gold"
                  onClick={() => setMenuOpen(false)}
                >
                  {item.label}
                </a>
              </li>
            ))}
          </ul>
          <div className="mt-4 flex flex-col gap-3 border-t border-white/10 pt-4">
            <Link
              href="/auth/login"
              className="rounded-lg border border-white/60 px-4 py-2.5 text-center font-medium text-white transition-colors hover:border-altea-gold hover:text-altea-gold"
              onClick={() => setMenuOpen(false)}
            >
              Entrar
            </Link>
            <a
              href="/#contato"
              className="rounded-lg bg-altea-gold px-4 py-2.5 text-center font-semibold text-altea-navy transition-colors hover:bg-altea-gold-bright"
              onClick={() => setMenuOpen(false)}
            >
              Agendar demonstração
            </a>
          </div>
        </nav>
      </div>
    </header>
  )
}
