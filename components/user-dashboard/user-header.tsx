"use client"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Bell, Search, Sun, Moon, User, Settings, LogOut, ChevronDown, Menu, X } from "lucide-react"
import { useTheme } from "next-themes"
import { useState, useEffect } from "react"
import { createClient } from "@/lib/supabase/client"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { useToast } from "@/hooks/use-toast"
import { useMobileUserSidebar } from "./user-sidebar"
import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"
import { Home, CreditCard, History, MessageSquare, BarChart3 } from "lucide-react"
import { secureSignOut } from "@/lib/auth-utils"

interface UserHeaderProps {
  user?: {
    id: string
    email?: string
    user_metadata?: {
      full_name?: string
      company_name?: string
    }
  }
}

interface Notification {
  id: string
  title: string
  message: string
  type: "info" | "success" | "warning" | "error"
  timestamp: string
  read: boolean
}

export function UserHeader({ user }: UserHeaderProps) {
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  const [showNotifications, setShowNotifications] = useState(false)
  const [showUserMenu, setShowUserMenu] = useState(false)
  const router = useRouter()
  const { toast } = useToast()
  const { isMobileMenuOpen, setIsMobileMenuOpen } = useMobileUserSidebar()

  const [notifications, setNotifications] = useState<Notification[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setMounted(true)
    if (user?.id) {
      fetchNotifications()
    }
  }, [user?.id])

  const fetchNotifications = async () => {
    if (!user?.id) return

    try {
      const supabase = createClient()
      const { data, error } = await supabase
        .from("notifications")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(10)

      if (error) {
        console.error("Error fetching notifications:", error)
        return
      }

      const formattedNotifications: Notification[] = (data || []).map((notif) => ({
        id: notif.id,
        title: notif.title || "Nova notificação",
        message: notif.description || "",
        type: notif.type || "info",
        timestamp: notif.created_at,
        read: notif.read || false,
      }))

      setNotifications(formattedNotifications)
    } catch (error) {
      console.error("Exception fetching notifications:", error)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Element
      if (!target.closest("[data-dropdown]")) {
        setShowNotifications(false)
        setShowUserMenu(false)
      }
    }

    document.addEventListener("click", handleClickOutside)
    return () => document.removeEventListener("click", handleClickOutside)
  }, [])

  const handleSignOut = async () => {
    console.log("[AlteaPay] UserHeader - Sign out initiated")
    toast({
      title: "Logout realizado",
      description: "Voce foi desconectado com sucesso.",
    })
    await secureSignOut({ reason: "user_initiated" })
  }

  const handleThemeToggle = () => {
    console.log("[AlteaPay] UserHeader - Theme toggle clicked, current theme:", theme)
    setTheme(theme === "dark" ? "light" : "dark")
    toast({
      title: "Tema alterado",
      description: `Tema alterado para ${theme === "dark" ? "claro" : "escuro"}`,
    })
  }

  const handleNotificationClick = (notification: Notification) => {
    console.log("[AlteaPay] UserHeader - Notification clicked:", notification.id)

    // Mark as read
    setNotifications((prev) => prev.map((n) => (n.id === notification.id ? { ...n, read: true } : n)))

    toast({
      title: notification.title,
      description: notification.message,
    })
    setShowNotifications(false)
  }

  const unreadCount = notifications.filter((n) => !n.read).length

  const userInitials =
    user?.user_metadata?.full_name
      ?.split(" ")
      .map((n) => n[0])
      .join("")
      .toUpperCase() ||
    user?.email?.[0].toUpperCase() ||
    "U"

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
                  placeholder="Buscar dívidas, clientes..."
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
      <div className="flex h-full items-center justify-between px-2 sm:px-4 lg:px-6">
        <div className="flex items-center space-x-2 sm:space-x-4 flex-1 min-w-0">
          <Button
            variant="ghost"
            size="sm"
            className="lg:hidden h-8 w-8 sm:h-10 sm:w-10 p-0 bg-white dark:bg-altea-navy border border-gray-200 dark:border-gray-700 shadow-sm flex-shrink-0"
            onClick={() => setIsMobileMenuOpen(true)}
          >
            <Menu className="h-4 w-4 sm:h-5 sm:w-5" />
            <span className="sr-only">Abrir menu</span>
          </Button>

          <div className="flex items-center flex-1 max-w-xs sm:max-w-md lg:max-w-lg">
            <div className="relative flex-1">
              <Search className="absolute left-2 sm:left-3 top-1/2 transform -translate-y-1/2 h-3 w-3 sm:h-4 sm:w-4 text-gray-400" />
              <Input
                placeholder="Buscar dívidas..."
                className="pl-7 sm:pl-10 bg-gray-50 dark:bg-gray-800 border-0 text-xs sm:text-sm h-8 sm:h-9 w-full"
              />
            </div>
          </div>
        </div>

        <div className="flex items-center space-x-1 sm:space-x-2 lg:space-x-3 flex-shrink-0">
          {/* Theme Toggle */}
          <Button variant="ghost" size="sm" onClick={handleThemeToggle} className="h-8 w-8 sm:h-9 sm:w-9 p-0">
            {theme === "dark" ? <Sun className="h-3 w-3 sm:h-4 sm:w-4" /> : <Moon className="h-3 w-3 sm:h-4 sm:w-4" />}
            <span className="sr-only">Alternar tema</span>
          </Button>

          {/* Notifications */}
          <div className="relative" data-dropdown>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 sm:h-9 sm:w-9 p-0 relative"
              onClick={(e) => {
                e.stopPropagation()
                setShowNotifications(!showNotifications)
                setShowUserMenu(false)
              }}
            >
              <Bell className="h-3 w-3 sm:h-4 sm:w-4" />
              <Badge className="absolute -top-1 -right-1 h-4 w-4 sm:h-5 sm:w-5 p-0 text-xs bg-altea-gold text-altea-navy hover:bg-altea-gold/90">
                {unreadCount}
              </Badge>
              <span className="sr-only">Notificações</span>
            </Button>

            {showNotifications && (
              <div className="absolute right-0 top-full mt-2 w-72 sm:w-80 lg:w-96 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-md shadow-lg z-50 max-h-80 sm:max-h-96 overflow-y-auto">
                <div className="p-3 border-b border-gray-200 dark:border-gray-700">
                  <h3 className="font-medium text-sm">Notificações</h3>
                </div>
                <div className="py-1">
                  {notifications.map((notification) => (
                    <button
                      key={notification.id}
                      onClick={() => handleNotificationClick(notification)}
                      className="w-full px-3 py-3 text-left hover:bg-gray-50 dark:hover:bg-gray-700 text-sm border-b border-gray-100 dark:border-gray-700"
                    >
                      <p className="font-medium">{notification.title}</p>
                      <p className="text-xs text-gray-500 mt-1">{notification.message}</p>
                    </button>
                  ))}
                </div>
                <div className="border-t border-gray-200 dark:border-gray-700 p-2">
                  <button
                    onClick={() =>
                      handleNotificationClick({
                        id: "all",
                        title: "Ver todas",
                        message: "Ver todas as notificações",
                        type: "info",
                        timestamp: "",
                        read: false,
                      })
                    }
                    className="w-full px-2 py-2 text-sm text-altea-navy dark:text-altea-gold hover:bg-gray-50 dark:hover:bg-gray-700 rounded"
                  >
                    Ver todas as notificações
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* User Menu */}
          {user && (
            <div className="relative" data-dropdown>
              <Button
                variant="ghost"
                className="flex items-center space-x-1 sm:space-x-2 p-1 sm:p-2 h-8 sm:h-10 min-w-0"
                onClick={(e) => {
                  e.stopPropagation()
                  setShowUserMenu(!showUserMenu)
                  setShowNotifications(false)
                }}
              >
                <Avatar className="h-6 w-6 sm:h-8 sm:w-8 flex-shrink-0">
                  <AvatarImage src="/placeholder.svg" />
                  <AvatarFallback className="bg-altea-navy text-altea-gold text-xs sm:text-sm">
                    {userInitials}
                  </AvatarFallback>
                </Avatar>
                <div className="hidden md:block text-left min-w-0">
                  <p className="text-xs sm:text-sm font-medium text-gray-900 dark:text-white truncate max-w-24 lg:max-w-32">
                    {user.user_metadata?.full_name || "Usuário"}
                  </p>
                  <p className="text-xs text-gray-500 dark:text-gray-400 truncate max-w-24 lg:max-w-32">
                    {user.user_metadata?.company_name || user.email}
                  </p>
                </div>
                <ChevronDown className="h-3 w-3 sm:h-4 sm:w-4 text-gray-400 hidden sm:block flex-shrink-0" />
              </Button>

              {showUserMenu && (
                <div className="absolute right-0 top-full mt-2 w-56 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-md shadow-lg z-50">
                  <div className="p-3 border-b border-gray-200 dark:border-gray-700">
                    <h3 className="font-medium text-sm">Minha conta</h3>
                    <div className="md:hidden mt-2">
                      <p className="text-sm font-medium text-gray-900 dark:text-white">
                        {user.user_metadata?.full_name || "Usuário"}
                      </p>
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        {user.user_metadata?.company_name || user.email}
                      </p>
                    </div>
                  </div>
                  <div className="py-1">
                    <Link
                      href="/user-dashboard/profile"
                      className="flex items-center w-full px-3 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-700 text-sm"
                      onClick={() => setShowUserMenu(false)}
                    >
                      <User className="mr-2 h-4 w-4" />
                      Ver perfil
                    </Link>
                    <button
                      className="flex items-center w-full px-3 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-700 text-sm"
                      onClick={() => {
                        setShowUserMenu(false)
                        toast({
                          title: "Configurações",
                          description: "Funcionalidade em desenvolvimento.",
                        })
                      }}
                    >
                      <Settings className="mr-2 h-4 w-4" />
                      Configurações
                    </button>
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

      {isMobileMenuOpen && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm lg:hidden"
            onClick={() => setIsMobileMenuOpen(false)}
            aria-hidden="true"
          />

          <div className="fixed left-0 top-0 bottom-0 z-50 w-72 sm:w-80 max-w-[85vw] bg-white dark:bg-altea-navy border-r border-gray-200 dark:border-gray-700 flex flex-col lg:hidden shadow-xl">
            <div className="flex h-16 items-center px-4 sm:px-6 border-b border-gray-200 dark:border-gray-700">
              <div className="flex items-center justify-between w-full">
                <div className="flex items-center space-x-3">
                  <div className="bg-altea-gold p-2 rounded-lg flex-shrink-0">
                    <div className="h-5 w-5 bg-altea-navy rounded-sm flex items-center justify-center">
                      <span className="text-altea-gold font-bold text-xs">A</span>
                    </div>
                  </div>
                  <span className="text-lg font-semibold text-gray-900 dark:text-white truncate">Altea Pay</span>
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
                  { name: "Início", href: "/user-dashboard", icon: Home },
                  { name: "Minhas Dívidas", href: "/user-dashboard/debts", icon: CreditCard },
                  { name: "Histórico", href: "/user-dashboard/history", icon: History },
                  { name: "Negociação", href: "/user-dashboard/negotiation", icon: MessageSquare },
                  { name: "Análise de Propensão", href: "/user-dashboard/propensity", icon: BarChart3 },
                  { name: "Perfil", href: "/user-dashboard/profile", icon: User },
                ].map((item) => {
                  const pathname = typeof window !== "undefined" ? window.location.pathname : ""
                  const isActive = pathname === item.href
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
                  <Avatar className="h-8 w-8 flex-shrink-0">
                    <AvatarImage src="/placeholder.svg" />
                    <AvatarFallback className="bg-altea-navy text-altea-gold text-sm">{userInitials}</AvatarFallback>
                  </Avatar>
                  <div className="flex-1 text-left min-w-0">
                    <p className="text-sm font-medium text-gray-900 dark:text-white truncate">
                      {user.user_metadata?.full_name || "Usuário"}
                    </p>
                    <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
                      {user.user_metadata?.company_name || user.email}
                    </p>
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
