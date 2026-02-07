"use client"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import {
  Bell,
  Search,
  Sun,
  Moon,
  User,
  Settings,
  LogOut,
  ChevronDown,
  Menu,
  X,
  Shield,
  LayoutDashboard,
} from "lucide-react"
import { useTheme } from "next-themes"
import { useState, useEffect } from "react"
import { createClient } from "@/lib/supabase/client"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { useToast } from "@/hooks/use-toast"
import { useMobileSuperAdminSidebar } from "./super-admin-sidebar"
import { cn } from "@/lib/utils"
import { Building2, Users, BarChart3, FileText, TrendingUp, Database } from "lucide-react"

interface Notification {
  id: string
  title: string
  description: string
  created_at: string
  read: boolean
  type: string
}

interface SuperAdminHeaderProps {
  user?: {
    id: string
    email?: string
    user_metadata?: {
      full_name?: string
    }
  }
}

export function SuperAdminHeader({ user }: SuperAdminHeaderProps) {
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  const [showNotifications, setShowNotifications] = useState(false)
  const [showUserMenu, setShowUserMenu] = useState(false)
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const router = useRouter()
  const { toast } = useToast()
  const { isMobileMenuOpen, setIsMobileMenuOpen } = useMobileSuperAdminSidebar()

  useEffect(() => {
    setMounted(true)
    fetchNotifications()
  }, [])

  async function fetchNotifications() {
    try {
      const supabase = createClient()
      const { data, error } = await supabase
        .from("notifications")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(10)

      if (error) {
        console.error("[v0] Error fetching notifications:", error)
        return
      }

      setNotifications(data || [])
      setUnreadCount(data?.filter((n) => !n.read).length || 0)
    } catch (error) {
      console.error("[v0] Exception fetching notifications:", error)
    }
  }

  const handleSignOut = async () => {
    console.log("[v0] SuperAdminHeader - Sign out initiated")
    try {
      const supabase = createClient()

      await supabase.auth.signOut({ scope: "local" })

      console.log("[v0] SuperAdminHeader - Sign out successful, redirecting...")

      toast({
        title: "Logout realizado",
        description: "Você foi desconectado com sucesso.",
      })

      // Clear any local storage
      if (typeof window !== "undefined") {
        localStorage.clear()
        sessionStorage.clear()
      }

      // Force hard redirect to login page
      window.location.href = "/auth/login"
    } catch (error) {
      console.error("[v0] SuperAdminHeader - Sign out exception:", error)
      toast({
        title: "Erro",
        description: "Erro inesperado ao fazer logout.",
        variant: "destructive",
      })

      // Force redirect even on error
      window.location.href = "/auth/login"
    }
  }

  const handleThemeToggle = () => {
    console.log("[v0] SuperAdminHeader - Theme toggle clicked, current theme:", theme)
    setTheme(theme === "dark" ? "light" : "dark")
    toast({
      title: "Tema alterado",
      description: `Tema alterado para ${theme === "dark" ? "claro" : "escuro"}`,
    })
  }

  const handleNotificationClick = async (notificationId: string) => {
    console.log("[v0] SuperAdminHeader - Notification clicked:", notificationId)

    try {
      const supabase = createClient()
      await supabase.from("notifications").update({ read: true }).eq("id", notificationId)

      await fetchNotifications()
    } catch (error) {
      console.error("[v0] Error marking notification as read:", error)
    }

    setShowNotifications(false)
  }

  const userInitials =
    user?.user_metadata?.full_name
      ?.split(" ")
      .map((n) => n[0])
      .join("")
      .toUpperCase() ||
    user?.email?.[0].toUpperCase() ||
    "SA"

  if (!mounted) {
    return (
      <header className="h-16 border-b border-[#252836] bg-[rgba(15,17,23,0.8)] backdrop-blur-xl sticky top-0 z-50">
        <div className="flex h-full items-center justify-between px-4 sm:px-8">
          <div className="flex items-center space-x-4">
            <div className="lg:hidden h-10 w-10 bg-[#252836] rounded-[10px] animate-pulse" />
            <div className="flex items-center space-x-4 flex-1 max-w-md">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-[#6B7188]" />
                <Input
                  placeholder="Buscar empresas, usuários, análises..."
                  className="pl-10 bg-[#252836] border-[#323647] text-[#F0F1F5] placeholder:text-[#6B7188] rounded-[10px] h-10"
                />
              </div>
            </div>
          </div>
          <div className="flex items-center space-x-3">
            <div className="h-[38px] w-[38px] bg-[#252836] rounded-[10px] animate-pulse" />
            <div className="h-[38px] w-[38px] bg-[#252836] rounded-[10px] animate-pulse" />
            <div className="h-[38px] w-[38px] bg-[#252836] rounded-full animate-pulse" />
          </div>
        </div>
      </header>
    )
  }

  return (
    <header className="h-16 border-b border-[#252836] bg-[rgba(15,17,23,0.8)] backdrop-blur-xl flex-shrink-0 sticky top-0 z-50">
      <div className="flex h-full items-center justify-between px-4 sm:px-8">
        <div className="flex items-center space-x-4">
          <Button
            variant="ghost"
            size="sm"
            className="lg:hidden h-10 w-10 p-0 bg-[#252836] border border-[#323647] rounded-[10px] text-[#9DA3B7] hover:bg-[#323647] hover:text-[#F0F1F5]"
            onClick={() => {
              console.log("[v0] Mobile menu button clicked, current state:", isMobileMenuOpen)
              setIsMobileMenuOpen(!isMobileMenuOpen)
            }}
          >
            {isMobileMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            <span className="sr-only">{isMobileMenuOpen ? "Fechar menu" : "Abrir menu"}</span>
          </Button>

          <div className="flex items-center gap-2 flex-1 w-[360px]">
            <div className="relative flex-1">
              <Search className="absolute left-4 top-1/2 transform -translate-y-1/2 h-4 w-4 text-[#6B7188]" />
              <Input
                placeholder="Buscar empresas, usuários, análises..."
                className="pl-10 bg-[#252836] border-[#323647] text-[#F0F1F5] placeholder:text-[#6B7188] rounded-[10px] h-10 text-[13px] focus:border-[#F5A623] focus:ring-[#F5A623]"
              />
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center space-x-3">
          {/* Theme Toggle */}
          <Button
            variant="ghost"
            size="sm"
            onClick={handleThemeToggle}
            className="h-[38px] w-[38px] p-0 bg-[#252836] border border-[#323647] rounded-[10px] text-[#9DA3B7] hover:bg-[#323647] hover:text-[#F0F1F5]"
          >
            {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            <span className="sr-only">Alternar tema</span>
          </Button>

          {/* Notifications */}
          <div className="relative" data-dropdown>
            <Button
              variant="ghost"
              size="sm"
              className="h-[38px] w-[38px] p-0 relative bg-[#252836] border border-[#323647] rounded-[10px] text-[#9DA3B7] hover:bg-[#323647] hover:text-[#F0F1F5]"
              onClick={(e) => {
                e.stopPropagation()
                setShowNotifications(!showNotifications)
                setShowUserMenu(false)
              }}
            >
              <Bell className="h-4 w-4" />
              {unreadCount > 0 && (
                <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-[#F06868] rounded-full border-2 border-[#1A1D27]" />
              )}
              <span className="sr-only">Notificações</span>
            </Button>

            {showNotifications && (
              <div className="absolute right-0 top-full mt-2 w-80 sm:w-96 bg-[#1A1D27] border border-[#323647] rounded-[14px] shadow-lg z-50 max-h-96 overflow-y-auto">
                <div className="p-3 border-b border-[#252836]">
                  <h3 className="font-semibold text-sm text-[#F0F1F5]">Notificações do Sistema</h3>
                </div>
                {notifications.length === 0 ? (
                  <div className="py-8 text-center">
                    <Bell className="h-12 w-12 mx-auto text-[#464B5F] mb-2" />
                    <p className="text-sm text-[#6B7188]">Nenhuma notificação</p>
                  </div>
                ) : (
                  <div className="py-1">
                    {notifications.map((notification) => (
                      <button
                        key={notification.id}
                        onClick={() => handleNotificationClick(notification.id)}
                        className={`w-full px-3 py-3 text-left hover:bg-[#252836] text-sm border-b border-[#252836] ${
                          !notification.read ? "bg-[rgba(91,141,239,0.1)]" : ""
                        }`}
                      >
                        <div className="flex items-start justify-between">
                          <div className="flex-1">
                            <p className="font-medium text-[#F0F1F5]">{notification.title}</p>
                            <p className="text-xs text-[#6B7188] mt-1">{notification.description}</p>
                            <p className="text-xs text-[#464B5F] mt-1">
                              {new Date(notification.created_at).toLocaleDateString("pt-BR")}
                            </p>
                          </div>
                          {!notification.read && (
                            <div className="w-2 h-2 bg-[#5B8DEF] rounded-full mt-1 ml-2 flex-shrink-0" />
                          )}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
                {notifications.length > 0 && (
                  <div className="border-t border-[#252836] p-2">
                    <Link
                      href="/super-admin/notifications"
                      className="block w-full px-2 py-2 text-sm text-center text-[#F5A623] hover:bg-[#252836] rounded-lg font-medium"
                      onClick={() => setShowNotifications(false)}
                    >
                      Ver todas as notificações
                    </Link>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* User Menu */}
          {user && (
            <div className="relative" data-dropdown>
              <div
                className="w-[38px] h-[38px] rounded-full bg-gradient-to-br from-[#F5A623] to-[#C77A00] flex items-center justify-center cursor-pointer font-bold text-[14px] text-[#0F1117]"
                onClick={(e) => {
                  e.stopPropagation()
                  setShowUserMenu(!showUserMenu)
                  setShowNotifications(false)
                }}
              >
                {userInitials}
              </div>

              {showUserMenu && (
                <div className="absolute right-0 top-full mt-2 w-56 bg-[#1A1D27] border border-[#323647] rounded-[14px] shadow-lg z-50 overflow-hidden">
                  <div className="p-3 border-b border-[#252836]">
                    <h3 className="font-semibold text-sm text-[#F0F1F5]">Super Administrador</h3>
                    <div className="mt-2">
                      <p className="text-sm font-medium text-[#F0F1F5]">
                        {user.user_metadata?.full_name || "Super Admin"}
                      </p>
                      <p className="text-xs text-[#6B7188]">{user.email}</p>
                    </div>
                  </div>
                  <div className="py-1">
                    <Link
                      href="/super-admin/profile"
                      className="flex items-center w-full px-3 py-2 text-left hover:bg-[#252836] text-sm text-[#9DA3B7] hover:text-[#F0F1F5]"
                      onClick={() => setShowUserMenu(false)}
                    >
                      <User className="mr-2 h-4 w-4" />
                      Ver perfil
                    </Link>
                    <Link
                      href="/super-admin/settings"
                      className="flex items-center w-full px-3 py-2 text-left hover:bg-[#252836] text-sm text-[#9DA3B7] hover:text-[#F0F1F5]"
                      onClick={() => setShowUserMenu(false)}
                    >
                      <Settings className="mr-2 h-4 w-4" />
                      Configurações
                    </Link>
                  </div>
                  <div className="border-t border-[#252836] py-1">
                    <button
                      onClick={handleSignOut}
                      className="flex items-center w-full px-3 py-2 text-left hover:bg-[#252836] text-sm text-[#F06868]"
                    >
                      <LogOut className="mr-2 h-4 w-4" />
                      Sair da conta
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Mobile Sidebar */}
      {isMobileMenuOpen && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm lg:hidden"
            onClick={() => setIsMobileMenuOpen(false)}
            aria-hidden="true"
          />

          <div className="fixed left-0 top-0 bottom-0 z-50 w-80 max-w-[85vw] bg-[#1A1D27] border-r border-[#323647] flex flex-col lg:hidden shadow-xl">
            {/* Mobile Sidebar Content */}
            <div className="flex h-16 items-center px-5 border-b border-[#323647]">
              <div className="flex items-center justify-between w-full">
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
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 p-0 flex-shrink-0 text-[#9DA3B7] hover:text-[#F0F1F5] hover:bg-[#252836]"
                  onClick={() => setIsMobileMenuOpen(false)}
                >
                  <X className="h-4 w-4" />
                  <span className="sr-only">Fechar menu</span>
                </Button>
              </div>
            </div>

            {/* Navigation */}
            <div className="flex-1 px-3 py-4 overflow-y-auto">
              <nav className="space-y-1">
                {[
                  { name: "Dashboard", href: "/super-admin", icon: LayoutDashboard },
                  { name: "Empresas", href: "/super-admin/companies", icon: Building2 },
                  { name: "Usuários", href: "/super-admin/users", icon: Users },
                  { name: "Relatórios", href: "/super-admin/reports", icon: BarChart3 },
                  { name: "Configurações", href: "/super-admin/settings", icon: Settings },
                ].map((item) => {
                  const pathname = window.location.pathname
                  const isActive =
                    pathname === item.href || (item.href !== "/super-admin" && pathname.startsWith(item.href))
                  return (
                    <Link key={item.name} href={item.href} onClick={() => setIsMobileMenuOpen(false)} className="block">
                      <div
                        className={cn(
                          "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200 cursor-pointer mb-0.5",
                          isActive
                            ? "bg-gradient-to-r from-[rgba(245,166,35,0.15)] to-[rgba(245,166,35,0.05)] text-[#F5A623] border border-[rgba(245,166,35,0.2)]"
                            : "text-[#9DA3B7] hover:bg-[#252836] hover:text-[#F0F1F5]"
                        )}
                      >
                        <item.icon className="h-5 w-5 flex-shrink-0" />
                        <span className="truncate">{item.name}</span>
                      </div>
                    </Link>
                  )
                })}
              </nav>
            </div>

            {/* User Menu */}
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
                    <p className="text-[11px] text-[#6B7188] truncate">{user.email}</p>
                  </div>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </header>
  )
}
