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
  Search,
  Globe,
  Mail,
  Handshake,
  Zap,
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
  current: boolean
  badge?: number
}

interface NavGroup {
  label: string
  items: NavItem[]
}

export function SuperAdminSidebar({ user }: SuperAdminSidebarProps) {
  const pathname = usePathname()
  const { isMobileMenuOpen, setIsMobileMenuOpen } = useMobileSuperAdminSidebar()

  const navigationGroups: NavGroup[] = [
    {
      label: "Principal",
      items: [
        {
          name: "Dashboard",
          href: "/super-admin",
          icon: LayoutDashboard,
          current: pathname === "/super-admin",
        },
        {
          name: "Empresas",
          href: "/super-admin/companies",
          icon: Building2,
          current: pathname.startsWith("/super-admin/companies"),
        },
        {
          name: "Usuários",
          href: "/super-admin/users",
          icon: Users,
          current: pathname.startsWith("/super-admin/users"),
        },
      ],
    },
    {
      label: "Análises",
      items: [
        {
          name: "Análise de Crédito",
          href: "/super-admin/analises",
          icon: Search,
          current: pathname === "/super-admin/analises",
        },
        {
          name: "Análise 360",
          href: "/super-admin/analises/comportamental",
          icon: Globe,
          current: pathname.startsWith("/super-admin/analises/comportamental"),
        },
        // Hidden: Análise Consolidada - preserved for future use
        // {
        //   name: "Análise Consolidada",
        //   href: "/super-admin/analises/consolidada",
        //   icon: LayoutGrid,
        //   current: pathname.startsWith("/super-admin/analises/consolidada"),
        // },
      ],
    },
    {
      label: "Operações",
      items: [
        {
          name: "Réguas de Cobrança",
          href: "/super-admin/collection-rules",
          icon: Zap,
          current: pathname.startsWith("/super-admin/collection-rules"),
        },
        {
          name: "Enviar Email",
          href: "/super-admin/send-email",
          icon: Mail,
          current: pathname.startsWith("/super-admin/send-email"),
        },
        {
          name: "Negociações",
          href: "/super-admin/negotiations",
          icon: Handshake,
          current: pathname.startsWith("/super-admin/negotiations"),
        },
      ],
    },
    {
      label: "Relatórios",
      items: [
        {
          name: "Relatórios Globais",
          href: "/super-admin/reports",
          icon: BarChart3,
          current: pathname.startsWith("/super-admin/reports"),
        },
        // Hidden: Analytics - preserved for future use
        // {
        //   name: "Analytics",
        //   href: "/super-admin/analytics",
        //   icon: TrendingUp,
        //   current: pathname.startsWith("/super-admin/analytics"),
        // },
      ],
    },
    {
      label: "Sistema",
      items: [
        // Hidden: Auditoria - preserved for future use
        // {
        //   name: "Auditoria",
        //   href: "/super-admin/audit",
        //   icon: ClipboardList,
        //   current: pathname.startsWith("/super-admin/audit"),
        // },
        // Hidden: Sistema - preserved for future use
        // {
        //   name: "Sistema",
        //   href: "/super-admin/system",
        //   icon: Monitor,
        //   current: pathname.startsWith("/super-admin/system"),
        // },
        {
          name: "Configurações",
          href: "/super-admin/settings",
          icon: Settings,
          current: pathname.startsWith("/super-admin/settings"),
        },
      ],
    },
  ]

  const SidebarContent = () => (
    <>
      {/* Logo */}
      <div className="flex h-16 items-center px-5 border-b border-[#323647]">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-gradient-to-br from-[#F5A623] to-[#C77A00] rounded-[10px] flex items-center justify-center flex-shrink-0">
            <span className="text-[#0F1117] font-bold text-lg">A</span>
          </div>
          <div className="min-w-0">
            <span className="text-xl font-bold text-[#F0F1F5] font-serif">Altea Pay</span>
            <div className="text-[11px] text-[#F5A623] uppercase tracking-[1.5px] font-semibold">
              Super Admin
            </div>
          </div>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-4 overflow-y-auto">
        {navigationGroups.map((group) => (
          <div key={group.label} className="mb-2">
            <div className="text-[10px] uppercase tracking-[2px] text-[#6B7188] px-3 py-4 font-semibold">
              {group.label}
            </div>
            {group.items.map((item) => (
              <Link key={item.name} href={item.href} onClick={() => setIsMobileMenuOpen(false)}>
                <div
                  className={cn(
                    "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200 cursor-pointer mb-0.5",
                    item.current
                      ? "bg-gradient-to-r from-[rgba(245,166,35,0.15)] to-[rgba(245,166,35,0.05)] text-[#F5A623] border border-[rgba(245,166,35,0.2)]"
                      : "text-[#9DA3B7] hover:bg-[#252836] hover:text-[#F0F1F5]"
                  )}
                >
                  <item.icon className="h-5 w-5 flex-shrink-0" />
                  <span className="truncate flex-1">{item.name}</span>
                  {item.badge && (
                    <span className="ml-auto bg-[#F06868] text-white text-[10px] px-2 py-0.5 rounded-full font-semibold">
                      {item.badge}
                    </span>
                  )}
                </div>
              </Link>
            ))}
          </div>
        ))}
      </nav>

      {/* User Info */}
      {user && (
        <div className="border-t border-[#323647] p-4">
          <div className="flex items-center gap-3 w-full min-w-0">
            <div className="w-9 h-9 rounded-full bg-gradient-to-br from-[#F5A623] to-[#C77A00] flex items-center justify-center flex-shrink-0">
              <span className="text-[#0F1117] font-bold text-sm">SA</span>
            </div>
            <div className="flex-1 text-left min-w-0">
              <p className="text-[13px] font-semibold text-[#F0F1F5] truncate">
                {user.user_metadata?.full_name || "Super Admin"}
              </p>
              <p className="text-[11px] text-[#6B7188] truncate">{user.email || "admin@alteapay.com"}</p>
            </div>
          </div>
        </div>
      )}
    </>
  )

  return (
    <>
      <div className="hidden lg:flex h-full flex-col bg-[#1A1D27] border-r border-[#323647]">
        <SidebarContent />
      </div>

      <Sheet open={isMobileMenuOpen} onOpenChange={setIsMobileMenuOpen}>
        <SheetContent side="left" className="p-0 w-80 max-w-[85vw] bg-[#1A1D27] border-r border-[#323647]">
          <div className="flex h-full flex-col">
            <SidebarContent />
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}
