"use client"

import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { cn } from "@/lib/utils"
import { createClient } from "@/lib/supabase/client"
import {
  LayoutDashboard,
  Users,
  CreditCard,
  Handshake,
  BarChart3,
  Settings,
  LogOut,
  MessageSquarePlus,
  Bot,
  ExternalLink
} from "lucide-react"

interface NavItem {
  name: string
  href: string
  icon: React.ComponentType<{ className?: string }>
}

interface NavSection {
  label: string
  items: NavItem[]
}

const navigation: NavSection[] = [
  {
    label: "Principal",
    items: [
      { name: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
    ]
  },
  {
    label: "Gestao",
    items: [
      { name: "Clientes", href: "/dashboard/clientes", icon: Users },
      { name: "Acordos", href: "/dashboard/agreements", icon: Handshake },
      { name: "Negociações Chat", href: "/dashboard/negociacoes-chat", icon: Bot },
      { name: "Redirecionamentos", href: "/dashboard/redirecionamentos", icon: ExternalLink },
      { name: "Solicitacoes", href: "/dashboard/solicitacoes", icon: MessageSquarePlus },
    ]
  },
  {
    label: "Relatorios",
    items: [
      { name: "Relatorios", href: "/dashboard/relatorios", icon: BarChart3 },
    ]
  },
  {
    label: "Conta",
    items: [
      { name: "Configuracoes", href: "/dashboard/configuracoes", icon: Settings },
    ]
  }
]

interface AdminSidebarProps {
  user: {
    id: string
    email?: string
    profile?: {
      role: string
      company_id: string | null
      full_name: string | null
      company: {
        id: string
        name: string
      } | null
    }
  }
  isMobileMenuOpen?: boolean
  setIsMobileMenuOpen?: (open: boolean) => void
}

export function AdminSidebar({ user, isMobileMenuOpen, setIsMobileMenuOpen }: AdminSidebarProps) {
  const pathname = usePathname()
  const router = useRouter()

  const companyName = user?.profile?.company?.name || "Empresa"
  const displayName = user?.profile?.full_name || user?.email?.split("@")[0] || "Admin"
  const userInitials = displayName
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .substring(0, 2)

  const handleSignOut = async () => {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push("/auth/login")
  }

  const handleClose = () => {
    if (setIsMobileMenuOpen) {
      setIsMobileMenuOpen(false)
    }
  }

  const SidebarContent = (
    <div className="flex flex-col h-full" style={{ background: "var(--admin-bg-secondary)" }}>
      {/* Brand Header */}
      <div
        className="px-5 py-[22px] flex items-center gap-3"
        style={{ borderBottom: "1px solid var(--admin-border)" }}
      >
        <div
          className="w-[38px] h-[38px] rounded-[10px] flex items-center justify-center font-bold text-base"
          style={{
            background: "linear-gradient(135deg, var(--admin-gold-400), var(--admin-gold-600))",
            color: "var(--admin-bg-primary)"
          }}
        >
          A
        </div>
        <div className="min-w-0">
          <span className="text-lg font-semibold text-foreground truncate block">
            Altea Pay
          </span>
          <span className="text-xs text-altea-gold font-medium">
            {companyName}
          </span>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-4 overflow-y-auto">
        {navigation.map((section) => (
          <div key={section.label} className="mb-2">
            <div
              className="text-[10px] uppercase tracking-[2px] font-semibold px-3 py-3"
              style={{ color: "var(--admin-text-muted)" }}
            >
              {section.label}
            </div>
            {section.items.map((item) => {
              const isActive = pathname === item.href
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={handleClose}
                  className={cn(
                    "flex items-center gap-[11px] px-3 py-[10px] rounded-lg text-sm font-medium mb-0.5 transition-all duration-200",
                    isActive
                      ? "font-semibold"
                      : "hover:bg-[var(--admin-bg-tertiary)]"
                  )}
                  style={{
                    color: isActive ? "var(--admin-gold-400)" : "var(--admin-text-secondary)",
                    background: isActive
                      ? "linear-gradient(135deg, rgba(245, 166, 35, 0.15), rgba(245, 166, 35, 0.05))"
                      : undefined,
                    border: isActive ? "1px solid rgba(245, 166, 35, 0.2)" : "1px solid transparent"
                  }}
                >
                  <item.icon className="w-5 h-5" />
                  <span>{item.name}</span>
                </Link>
              )
            })}
          </div>
        ))}
      </nav>

      {/* User Footer */}
      <div
        className="p-4 flex items-center gap-3"
        style={{ borderTop: "1px solid var(--admin-border)" }}
      >
        <div
          className="w-9 h-9 rounded-full flex items-center justify-center font-bold text-[13px]"
          style={{
            background: "linear-gradient(135deg, var(--admin-gold-400), var(--admin-gold-600))",
            color: "var(--admin-bg-primary)"
          }}
        >
          {userInitials}
        </div>
        <div className="flex-1 min-w-0">
          <div
            className="text-[13px] font-semibold truncate"
            style={{ color: "var(--admin-text-primary)" }}
          >
            {displayName}
          </div>
          <div
            className="text-[11px] truncate"
            style={{ color: "var(--admin-text-muted)" }}
          >
            {user?.email}
          </div>
        </div>
        <button
          onClick={handleSignOut}
          className="p-2 rounded-lg transition-colors hover:bg-[var(--admin-bg-tertiary)]"
          style={{ color: "var(--admin-text-muted)" }}
          title="Sair"
        >
          <LogOut className="w-4 h-4" />
        </button>
      </div>
    </div>
  )

  return (
    <>
      {/* Desktop Sidebar */}
      <aside
        className="hidden lg:flex w-[250px] flex-col h-full fixed top-0 left-0 bottom-0 z-40"
        style={{
          background: "var(--admin-bg-secondary)",
          borderRight: "1px solid var(--admin-border)"
        }}
      >
        {SidebarContent}
      </aside>

      {/* Mobile Sidebar Overlay */}
      {isMobileMenuOpen && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm lg:hidden"
            onClick={handleClose}
          />
          <aside
            className="fixed left-0 top-0 bottom-0 z-50 w-[280px] max-w-[85vw] lg:hidden shadow-2xl"
            style={{ background: "var(--admin-bg-secondary)" }}
          >
            {SidebarContent}
          </aside>
        </>
      )}
    </>
  )
}
