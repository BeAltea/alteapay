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
import { secureSignOut } from "@/lib/auth-utils"

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
        console.error("[AlteaPay] Error fetching notifications:", error)
        return
      }

      setNotifications(data || [])
      setUnreadCount(data?.filter((n) => !n.read).length || 0)
    } catch (error) {
      console.error("[AlteaPay] Exception fetching notifications:", error)
    }
  }

  const handleSignOut = async () => {
    console.log("[AlteaPay] SuperAdminHeader - Sign out initiated")
    toast({
      title: "Logout realizado",
      description: "Voce foi desconectado com sucesso.",
    })
    await secureSignOut({ reason: "user_initiated" })
  }

  const handleThemeToggle = () => {
    console.log("[AlteaPay] SuperAdminHeader - Theme toggle clicked, current theme:", theme)
    setTheme(theme === "dark" ? "light" : "dark")
    toast({
      title: "Tema alterado",
      description: `Tema alterado para ${theme === "dark" ? "claro" : "escuro"}`,
    })
  }

  const handleNotificationClick = async (notificationId: string) => {
    console.log("[AlteaPay] SuperAdminHeader - Notification clicked:", notificationId)

    try {
      const supabase = createClient()
      await supabase.from("notifications").update({ read: true }).eq("id", notificationId)

      await fetchNotifications()
    } catch (error) {
      console.error("[AlteaPay] Error marking notification as read:", error)
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
      <header className="h-16 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-altea-navy">
        <div className="flex h-full items-center justify-between px-4 sm:px-6">
          <div className="flex items-center space-x-4">
            <div className="lg:hidden h-10 w-10 bg-gray-200 dark:bg-gray-700 rounded animate-pulse" />
            <div className="flex items-center space-x-4 flex-1 max-w-md">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
                <Input
                  placeholder="Buscar empresas, usuários..."
                  className="pl-10 bg-gray-50 dark:bg-gray-800 border-0"
                />
              </div>
            </div>
          </div>
          <div className="flex items-center space-x-2 sm:space-x-4">
            <div className="h-9 w-9 bg-gray-200 dark:bg-gray-700 rounded animate-pulse" />
            <div className="h-9 w-9 bg-gray-200 dark:bg-gray-700 rounded animate-pulse" />
            <div className="h-10 w-32 bg-gray-200 dark:bg-gray-700 rounded animate-pulse" />
          </div>
        </div>
      </header>
    )
  }

  return (
    <header className="h-16 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-altea-navy flex-shrink-0">
      <div className="flex h-full items-center justify-between px-4 sm:px-6">
        <div className="flex items-center space-x-4">
          <Button
            variant="ghost"
            size="sm"
            className="lg:hidden h-10 w-10 p-0 bg-white dark:bg-altea-navy border border-gray-200 dark:border-gray-700 shadow-sm"
            onClick={() => {
              console.log("[AlteaPay] Mobile menu button clicked, current state:", isMobileMenuOpen)
              setIsMobileMenuOpen(!isMobileMenuOpen)
            }}
          >
            {isMobileMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            <span className="sr-only">{isMobileMenuOpen ? "Fechar menu" : "Abrir menu"}</span>
          </Button>

          <div className="flex items-center space-x-4 flex-1 max-w-md">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
              <Input
                placeholder="Buscar empresas, usuários..."
                className="pl-10 bg-gray-50 dark:bg-gray-800 border-0 text-sm sm:text-base h-9"
              />
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center space-x-1 sm:space-x-3">
          {/* Theme Toggle */}
          <Button variant="ghost" size="sm" onClick={handleThemeToggle} className="h-9 w-9 p-0">
            {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            <span className="sr-only">Alternar tema</span>
          </Button>

          {/* Notifications */}
          <div className="relative" data-dropdown>
            <Button
              variant="ghost"
              size="sm"
              className="h-9 w-9 p-0 relative"
              onClick={(e) => {
                e.stopPropagation()
                setShowNotifications(!showNotifications)
                setShowUserMenu(false)
              }}
            >
              <Bell className="h-4 w-4" />
              {unreadCount > 0 && (
                <Badge className="absolute -top-1 -right-1 h-5 w-5 p-0 text-xs bg-altea-gold text-altea-navy hover:bg-altea-gold">
                  {unreadCount}
                </Badge>
              )}
              <span className="sr-only">Notificações</span>
            </Button>

            {showNotifications && (
              <div className="absolute right-0 top-full mt-2 w-80 sm:w-96 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-md shadow-lg z-50 max-h-96 overflow-y-auto">
                <div className="p-3 border-b border-gray-200 dark:border-gray-700">
                  <h3 className="font-medium text-sm">Notificações do Sistema</h3>
                </div>
                {notifications.length === 0 ? (
                  <div className="py-8 text-center">
                    <Bell className="h-12 w-12 mx-auto text-gray-300 dark:text-gray-600 mb-2" />
                    <p className="text-sm text-gray-500 dark:text-gray-400">Nenhuma notificação</p>
                  </div>
                ) : (
                  <div className="py-1">
                    {notifications.map((notification) => (
                      <button
                        key={notification.id}
                        onClick={() => handleNotificationClick(notification.id)}
                        className={`w-full px-3 py-3 text-left hover:bg-gray-50 dark:hover:bg-gray-700 text-sm border-b border-gray-100 dark:border-gray-700 ${
                          !notification.read ? "bg-blue-50 dark:bg-blue-900/10" : ""
                        }`}
                      >
                        <div className="flex items-start justify-between">
                          <div className="flex-1">
                            <p className="font-medium">{notification.title}</p>
                            <p className="text-xs text-gray-500 mt-1">{notification.description}</p>
                            <p className="text-xs text-gray-400 mt-1">
                              {new Date(notification.created_at).toLocaleDateString("pt-BR")}
                            </p>
                          </div>
                          {!notification.read && (
                            <div className="w-2 h-2 bg-blue-500 rounded-full mt-1 ml-2 flex-shrink-0" />
                          )}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
                {notifications.length > 0 && (
                  <div className="border-t border-gray-200 dark:border-gray-700 p-2">
                    <Link
                      href="/super-admin/notifications"
                      className="block w-full px-2 py-2 text-sm text-center text-altea-navy dark:text-altea-gold hover:bg-gray-50 dark:hover:bg-gray-700 rounded"
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
              <Button
                variant="ghost"
                className="flex items-center space-x-2 p-1 sm:p-2 h-10"
                onClick={(e) => {
                  e.stopPropagation()
                  setShowUserMenu(!showUserMenu)
                  setShowNotifications(false)
                }}
              >
                <Avatar className="h-8 w-8">
                  <AvatarImage src="/placeholder.svg" />
                  <AvatarFallback className="bg-altea-navy text-altea-gold text-sm">{userInitials}</AvatarFallback>
                </Avatar>
                <div className="hidden md:block text-left">
                  <p className="text-sm font-medium text-gray-900 dark:text-white truncate max-w-32">
                    {user.user_metadata?.full_name || "Super Admin"}
                  </p>
                  <div className="flex items-center space-x-1">
                    <Shield className="h-3 w-3 text-altea-gold" />
                    <p className="text-xs text-altea-gold truncate max-w-24">Altea Pay</p>
                  </div>
                </div>
                <ChevronDown className="h-4 w-4 text-gray-400 hidden sm:block" />
              </Button>

              {showUserMenu && (
                <div className="absolute right-0 top-full mt-2 w-56 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-md shadow-lg z-50">
                  <div className="p-3 border-b border-gray-200 dark:border-gray-700">
                    <h3 className="font-medium text-sm">Super Administrador</h3>
                    <div className="md:hidden mt-2">
                      <p className="text-sm font-medium text-gray-900 dark:text-white">
                        {user.user_metadata?.full_name || "Super Admin"}
                      </p>
                      <div className="flex items-center space-x-1">
                        <Shield className="h-3 w-3 text-altea-gold" />
                        <p className="text-xs text-altea-gold">Altea Pay</p>
                      </div>
                    </div>
                  </div>
                  <div className="py-1">
                    <Link
                      href="/super-admin/profile"
                      className="flex items-center w-full px-3 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-700 text-sm"
                      onClick={() => setShowUserMenu(false)}
                    >
                      <User className="mr-2 h-4 w-4" />
                      Ver perfil
                    </Link>
                    <Link
                      href="/super-admin/settings"
                      className="flex items-center w-full px-3 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-700 text-sm"
                      onClick={() => setShowUserMenu(false)}
                    >
                      <Settings className="mr-2 h-4 w-4" />
                      Configurações
                    </Link>
                  </div>
                  <div className="border-t border-gray-200 dark:border-gray-700 py-1">
                    <button
                      onClick={handleSignOut}
                      className="flex items-center w-full px-3 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-700 text-sm text-red-600 dark:text-red-400"
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

          <div className="fixed left-0 top-0 bottom-0 z-50 w-80 max-w-[85vw] bg-white dark:bg-altea-navy border-r border-gray-200 dark:border-gray-700 flex flex-col lg:hidden shadow-xl">
            {/* Mobile Sidebar Content */}
            <div className="flex h-16 items-center px-4 sm:px-6 border-b border-gray-200 dark:border-gray-700">
              <div className="flex items-center justify-between w-full">
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
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 p-0 flex-shrink-0"
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
                  { name: "Analytics", href: "/super-admin/analytics", icon: TrendingUp },
                  { name: "Auditoria", href: "/super-admin/audit", icon: FileText },
                  { name: "Sistema", href: "/super-admin/system", icon: Database },
                  { name: "Configurações", href: "/super-admin/settings", icon: Settings },
                ].map((item) => {
                  const pathname = window.location.pathname
                  const isActive =
                    pathname === item.href || (item.href !== "/super-admin" && pathname.startsWith(item.href))
                  return (
                    <Link key={item.name} href={item.href} onClick={() => setIsMobileMenuOpen(false)} className="block">
                      <Button
                        variant={isActive ? "secondary" : "ghost"}
                        className={cn(
                          "w-full justify-start text-left h-10 px-3",
                          isActive && "bg-altea-gold/10 text-altea-navy dark:bg-altea-gold/20 dark:text-altea-gold",
                        )}
                      >
                        <item.icon className="mr-3 h-4 w-4 flex-shrink-0" />
                        <span className="truncate">{item.name}</span>
                      </Button>
                    </Link>
                  )
                })}
              </nav>
            </div>

            {/* User Menu */}
            {user && (
              <div className="border-t border-gray-200 dark:border-gray-700 p-4">
                <div className="flex items-center space-x-3 w-full min-w-0">
                  <div className="bg-altea-gold/10 dark:bg-altea-gold/20 p-2 rounded-full flex-shrink-0">
                    <Shield className="h-4 w-4 text-altea-navy dark:text-altea-gold" />
                  </div>
                  <div className="flex-1 text-left min-w-0">
                    <p className="text-sm font-medium text-gray-900 dark:text-white truncate">
                      {user.user_metadata?.full_name || "Super Admin"}
                    </p>
                    <p className="text-xs text-altea-gold truncate">Altea Pay</p>
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
