"use client"

import { useEffect, useRef, useState } from "react"
import Link from "next/link"
import { Menu, X } from "lucide-react"
import { homeNav } from "@/content/home"
import { LOGIN_URL } from "@/content/site"

const MOBILE_MENU_ID = "lp-menu-mobile"

/**
 * Menu mobile (client) separado do site-header (server): botao de toggle +
 * painel ancorado logo abaixo do header sticky (top-16 = altura h-16).
 */
export function MobileNav() {
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
    <>
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

      <div
        ref={panelRef}
        id={MOBILE_MENU_ID}
        hidden={!menuOpen}
        className="absolute inset-x-0 top-16 border-t border-white/10 bg-altea-navy shadow-lg lg:hidden"
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
              href={LOGIN_URL}
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
    </>
  )
}
