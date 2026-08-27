"use client"

import { createContext, useContext } from "react"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent } from "@/components/ui/sheet"
import { cn } from "@/lib/utils"
import Link from "next/link"
import { usePathname } from "next/navigation"
import {
  LayoutDashboard,
  Building2,
  Users,
  BarChart3,
  Settings,
  Shield,
  Target,
  CreditCard,
  Sparkles,
  LayoutGrid,
  Mail,
  Handshake,
  Calculator,
  FileUp,
  MapPin,
} from "lucide-react"

interface SuperAdminSidebarProps {
  user?: {
    id: string
    email?: string
    user_metadata?: {
      full_name?: string
    }
  }
}

const MobileSuperAdminSidebarContext = createContext<{
  isMobileMenuOpen: boolean
  setIsMobileMenuOpen: (open: boolean) => void
}>({
  isMobileMenuOpen: false,
  setIsMobileMenuOpen: () => {},
})

export function useMobileSuperAdminSidebar() {
  return useContext(MobileSuperAdminSidebarContext)
}

export { MobileSuperAdminSidebarContext }

interface NavItem {
  name: string
  href: string
  icon: React.ComponentType<{ className?: string }>
  hidden?: boolean
}

interface NavSection {
  label: string
  items: NavItem[]
}

export function SuperAdminSidebar({ user }: SuperAdminSidebarProps) {
  const pathname = usePathname()
  const { isMobileMenuOpen, setIsMobileMenuOpen } = useMobileSuperAdminSidebar()

  // Grouped navigation with section labels
  const navigationSections: NavSection[] = [
    {
      label: "PRINCIPAL",
      items: [
        {
          name: "Dashboard",
          href: "/super-admin",
          icon: LayoutDashboard,
        },
        {
          name: "Empresas",
          href: "/super-admin/companies",
          icon: Building2,
        },
        {
          name: "Clientes",
          href: "/super-admin/clientes",
          icon: Users,
        },
      ],
    },
    {
      label: "ANÁLISES",
      items: [
        {
          name: "Análise de Crédito",
          href: "/super-admin/analises",
          icon: CreditCard,
        },
        {
          name: "Análise 360",
          href: "/super-admin/analises/comportamental",
          icon: Sparkles,
        },
        {
          name: "Localize",
          href: "/super-admin/analises/localize",
          icon: MapPin,
        },
        // Hidden: Análise Consolidada (code preserved but not visible)
        {
          name: "Análise Consolidada",
          href: "/super-admin/analises/consolidada",
          icon: LayoutGrid,
          hidden: true,
        },
      ],
    },
    {
      label: "OPERAÇÕES",
      items: [
        {
          name: "Réguas de Cobrança",
          href: "/super-admin/collection-rules",
          icon: Target,
        },
        {
          name: "Enviar Email",
          href: "/super-admin/send-email",
          icon: Mail,
        },
        {
          name: "Negociações",
          href: "/super-admin/negotiations",
          icon: Handshake,
        },
        {
          name: "Negociações Chat",
          href: "/super-admin/negociacoes-chat",
          icon: Handshake,
        },
        {
          name: "Redirecionamentos",
          href: "/super-admin/redirecionamentos",
          icon: Handshake,
        },
        {
          name: "Importar Dados",
          href: "/super-admin/importar-dados",
          icon: FileUp,
        },
      ],
    },
    {
      label: "RELATÓRIOS",
      items: [
        {
          name: "Relatórios Globais",
          href: "/super-admin/reports",
          icon: BarChart3,
        },
        {
          name: "Contabilidade",
          href: "/super-admin/contabilidade",
          icon: Calculator,
        },
      ],
    },
    {
      label: "ADMINISTRAÇÃO",
      items: [
        {
          name: "Usuários & Acessos",
          href: "/super-admin/users",
          icon: Shield,
        },
        {
          name: "Configurações",
          href: "/super-admin/settings",
          icon: Settings,
        },
      ],
    },
  ]

  const isItemActive = (href: string) => {
    if (href === "/super-admin") {
      return pathname === "/super-admin"
    }
    return pathname.startsWith(href)
  }

  const SidebarContent = () => (
    <>
      {/* Logo */}
      <div className="flex h-16 items-center px-4 sm:px-6 border-b border-gray-200 dark:border-[oklch(0.26_0.02_240)]">
        <div className="flex items-center space-x-3">
          <div className="bg-altea-gold p-2 rounded-lg flex-shrink-0">
            <div className="h-5 w-5 bg-altea-navy rounded-sm flex items-center justify-center">
              <span className="text-altea-gold font-bold text-xs">A</span>
            </div>
          </div>
          <div className="min-w-0">
            <span className="text-lg font-semibold text-gray-900 dark:text-white truncate">Altea Pay</span>
            <div className="flex items-center space-x-1">
              <Shield className="h-3 w-3 text-altea-gold" />
              <span className="text-xs text-altea-gold font-medium">Super Admin</span>
            </div>
          </div>
        </div>
      </div>

      {/* Navigation with grouped sections */}
      <nav className="flex-1 px-3 py-4 overflow-y-auto">
        {navigationSections.map((section) => {
          // Filter out hidden items
          const visibleItems = section.items.filter(item => !item.hidden)

          // Don't render section if all items are hidden
          if (visibleItems.length === 0) return null

          return (
            <div key={section.label} className="mb-4">
              {/* Section Label */}
              <div className="px-3 py-2">
                <span className="text-[10px] font-semibold uppercase tracking-[2px] text-gray-400 dark:text-gray-500">
                  {section.label}
                </span>
              </div>

              {/* Section Items */}
              <div className="space-y-1">
                {visibleItems.map((item) => {
                  const isActive = isItemActive(item.href)
                  return (
                    <Link key={item.name} href={item.href} onClick={() => setIsMobileMenuOpen(false)}>
                      <Button
                        variant={isActive ? "secondary" : "ghost"}
                        className={cn(
                          "w-full justify-start text-left h-10 px-3 transition-all duration-200",
                          isActive
                            ? "bg-altea-gold/10 text-altea-navy dark:bg-[oklch(0.82_0.18_85)] dark:text-[oklch(0.12_0.02_240)] font-semibold"
                            : "text-gray-700 dark:text-[oklch(0.92_0_0)] hover:bg-gray-100 dark:hover:bg-[oklch(0.2_0.02_240)] hover:text-gray-900 dark:hover:text-[oklch(0.98_0_0)]",
                        )}
                      >
                        <item.icon className="mr-3 h-4 w-4 flex-shrink-0" />
                        <span className="truncate">{item.name}</span>
                      </Button>
                    </Link>
                  )
                })}
              </div>
            </div>
          )
        })}
      </nav>

      {/* User Info */}
      {user && (
        <div className="border-t border-gray-200 dark:border-[oklch(0.26_0.02_240)] p-4">
          <div className="flex items-center space-x-3 w-full min-w-0">
            <div className="bg-altea-gold/10 dark:bg-altea-gold/20 p-2 rounded-full flex-shrink-0">
              <Shield className="h-4 w-4 text-altea-navy dark:text-altea-gold" />
            </div>
            <div className="flex-1 text-left min-w-0">
              <p className="text-sm font-medium text-gray-900 dark:text-white truncate">
                {user.user_metadata?.full_name || "Super Admin"}
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400 truncate">Altea Pay</p>
            </div>
          </div>
        </div>
      )}
    </>
  )

  return (
    <>
      <div className="hidden lg:flex h-full flex-col bg-white dark:bg-[oklch(0.12_0.02_240)] border-r border-gray-200 dark:border-[oklch(0.26_0.02_240)]">
        <SidebarContent />
      </div>

      <Sheet open={isMobileMenuOpen} onOpenChange={setIsMobileMenuOpen}>
        <SheetContent side="left" className="p-0 w-80 max-w-[85vw] bg-white dark:bg-[oklch(0.12_0.02_240)]">
          <div className="flex h-full flex-col">
            <SidebarContent />
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}
