"use client"

import { useState, useEffect } from "react"
import { useParams, useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { useToast } from "@/hooks/use-toast"
import { ArrowLeft, Shield, User, Settings, BarChart3, Users, Building2 } from "lucide-react"
import { createClient } from "@/lib/supabase/client"

interface Permission {
  id: string
  name: string
  description: string
  category: string
  enabled: boolean
}

interface UserProfile {
  id: string
  full_name: string
  email: string
  role: string
  company_name: string
}

export default function UserPermissionsPage() {
  const params = useParams()
  const router = useRouter()
  const { toast } = useToast()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [user, setUser] = useState<UserProfile | null>(null)
  const [permissions, setPermissions] = useState<Permission[]>([])

  const userId = params.id as string

  useEffect(() => {
    fetchUserAndPermissions()
  }, [userId])

  const fetchUserAndPermissions = async () => {
    try {
      setLoading(true)
      const supabase = createClient()

      // Fetch user profile
      const { data: userData, error: userError } = await supabase.from("profiles").select("*").eq("id", userId).single()

      if (userError) {
        console.error("Error fetching user:", userError)
        toast({
          title: "Erro",
          description: "Erro ao carregar dados do usuário.",
          variant: "destructive",
        })
        return
      }

      setUser(userData)

      // Mock permissions data - in real app, this would come from database
      const mockPermissions: Permission[] = [
        {
          id: "dashboard_view",
          name: "Visualizar Dashboard",
          description: "Permite visualizar o dashboard principal",
          category: "Dashboard",
          enabled: true,
        },
        {
          id: "users_manage",
          name: "Gerenciar Usuários",
          description: "Criar, editar e excluir usuários",
          category: "Usuários",
          enabled: userData.role === "admin",
        },
        {
          id: "companies_manage",
          name: "Gerenciar Empresas",
          description: "Criar, editar e excluir empresas",
          category: "Empresas",
          enabled: userData.role === "super_admin",
        },
        {
          id: "reports_view",
          name: "Visualizar Relatórios",
          description: "Acessar relatórios e analytics",
          category: "Relatórios",
          enabled: true,
        },
        {
          id: "system_settings",
          name: "Configurações do Sistema",
          description: "Alterar configurações globais do sistema",
          category: "Sistema",
          enabled: userData.role === "super_admin",
        },
        {
          id: "audit_logs",
          name: "Logs de Auditoria",
          description: "Visualizar logs de auditoria do sistema",
          category: "Sistema",
          enabled: userData.role === "super_admin",
        },
      ]

      setPermissions(mockPermissions)
    } catch (error) {
      console.error("Error fetching data:", error)
      toast({
        title: "Erro",
        description: "Erro inesperado ao carregar dados.",
        variant: "destructive",
      })
    } finally {
      setLoading(false)
    }
  }

  const handlePermissionToggle = (permissionId: string) => {
    setPermissions((prev) =>
      prev.map((permission) =>
        permission.id === permissionId ? { ...permission, enabled: !permission.enabled } : permission,
      ),
    )
  }

  const handleSavePermissions = async () => {
    try {
      setSaving(true)

      // In a real app, you would save permissions to database
      await new Promise((resolve) => setTimeout(resolve, 1000))

      toast({
        title: "Sucesso",
        description: "Permissões atualizadas com sucesso.",
      })
    } catch (error) {
      console.error("Error saving permissions:", error)
      toast({
        title: "Erro",
        description: "Erro ao salvar permissões.",
        variant: "destructive",
      })
    } finally {
      setSaving(false)
    }
  }

  const getPermissionsByCategory = () => {
    const categories = permissions.reduce(
      (acc, permission) => {
        if (!acc[permission.category]) {
          acc[permission.category] = []
        }
        acc[permission.category].push(permission)
        return acc
      },
      {} as Record<string, Permission[]>,
    )

    return categories
  }

  const getCategoryIcon = (category: string) => {
    switch (category) {
      case "Dashboard":
        return BarChart3
      case "Usuários":
        return Users
      case "Empresas":
        return Building2
      case "Relatórios":
        return BarChart3
      case "Sistema":
        return Settings
      default:
        return Shield
    }
  }

  if (loading) {
    return (
      <div className="w-full max-w-4xl space-y-6">
        <div className="space-y-6">
          <div className="h-8 bg-gray-200 dark:bg-gray-700 rounded animate-pulse" />
          <div className="h-32 bg-gray-200 dark:bg-gray-700 rounded animate-pulse" />
          <div className="h-64 bg-gray-200 dark:bg-gray-700 rounded animate-pulse" />
        </div>
      </div>
    )
  }

  if (!user) {
    return (
      <div className="w-full max-w-4xl space-y-6">
        <Card>
          <CardContent className="p-6 text-center">
            <p className="text-gray-500">Usuário não encontrado.</p>
            <Button onClick={() => router.back()} className="mt-4">
              Voltar
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="w-full max-w-4xl space-y-6">
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-4">
            <Button variant="ghost" size="sm" onClick={() => router.back()} className="flex items-center space-x-2">
              <ArrowLeft className="h-4 w-4" />
              <span>Voltar</span>
            </Button>
            <div>
              <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Permissões do Usuário</h1>
              <p className="text-gray-500 dark:text-gray-400">Gerencie as permissões de acesso do usuário</p>
            </div>
          </div>
          <Button onClick={handleSavePermissions} disabled={saving}>
            {saving ? "Salvando..." : "Salvar Alterações"}
          </Button>
        </div>

        {/* User Info */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center space-x-2">
              <User className="h-5 w-5" />
              <span>Informações do Usuário</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <Label className="text-sm font-medium text-gray-500">Nome</Label>
                <p className="text-sm font-medium">{user.full_name}</p>
              </div>
              <div>
                <Label className="text-sm font-medium text-gray-500">Email</Label>
                <p className="text-sm">{user.email}</p>
              </div>
              <div>
                <Label className="text-sm font-medium text-gray-500">Função</Label>
                <Badge variant={user.role === "super_admin" ? "default" : "secondary"}>
                  {user.role === "super_admin" ? "Super Admin" : user.role === "admin" ? "Admin" : "Usuário"}
                </Badge>
              </div>
              <div>
                <Label className="text-sm font-medium text-gray-500">Empresa</Label>
                <p className="text-sm">{user.company_name || "N/A"}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Permissions */}
        <div className="space-y-4">
          {Object.entries(getPermissionsByCategory()).map(([category, categoryPermissions]) => {
            const IconComponent = getCategoryIcon(category)
            return (
              <Card key={category}>
                <CardHeader>
                  <CardTitle className="flex items-center space-x-2">
                    <IconComponent className="h-5 w-5" />
                    <span>{category}</span>
                  </CardTitle>
                  <CardDescription>Permissões relacionadas a {category.toLowerCase()}</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-4">
                    {categoryPermissions.map((permission, index) => (
                      <div key={permission.id}>
                        <div className="flex items-center justify-between">
                          <div className="space-y-1">
                            <Label htmlFor={permission.id} className="text-sm font-medium">
                              {permission.name}
                            </Label>
                            <p className="text-xs text-gray-500">{permission.description}</p>
                          </div>
                          <Switch
                            id={permission.id}
                            checked={permission.enabled}
                            onCheckedChange={() => handlePermissionToggle(permission.id)}
                          />
                        </div>
                        {index < categoryPermissions.length - 1 && <Separator className="mt-4" />}
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      </div>
    </div>
  )
}
