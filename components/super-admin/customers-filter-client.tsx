"use client"

import { useState, useMemo } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Users, DollarSign, AlertTriangle, MapPin, CheckCircle, Clock, Trash2, Loader2, Pencil, RotateCcw } from "lucide-react"
import { toast } from "sonner"
import { RevealableDocument } from "@/components/super-admin/revealable-document"

type Customer = {
  id: string
  name: string
  // documento mascarado (o claro nunca chega ao cliente; reveal auditado por linha)
  documentMasked: string
  city: string | null
  status: "active" | "overdue" | "negotiating" | "paid"
  totalDebt: number
  overdueDebt: number
  daysOverdue: number
  negotiation_sent?: boolean
  paymentDate?: string | null
  paidAmount?: number
}

export function CustomersFilterClient({ customers, companyId }: { customers: Customer[]; companyId: string }) {
  const router = useRouter()
  const [searchTerm, setSearchTerm] = useState("")
  const [daysSort, setDaysSort] = useState<"none" | "asc" | "desc">("none")
  const [amountSort, setAmountSort] = useState<"none" | "asc" | "desc">("none")
  const [statusFilter, setStatusFilter] = useState<"all" | "overdue" | "paid">("all")
  const [displayLimit, setDisplayLimit] = useState<number>(50)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  // Edit modal state
  const [showEditModal, setShowEditModal] = useState(false)
  const [editingCustomer, setEditingCustomer] = useState<Customer | null>(null)
  const [editData, setEditData] = useState<any>(null)
  const [loadingEdit, setLoadingEdit] = useState(false)
  const [savingEdit, setSavingEdit] = useState(false)

  // Reactivate state
  const [reactivatingId, setReactivatingId] = useState<string | null>(null)

  const handleDeleteClient = async (customer: Customer) => {
    const confirmed = window.confirm(
      `Excluir o cliente "${customer.name}"?\n\nCPF/CNPJ: ${customer.documentMasked}\n\nEsta ação é irreversível. Todas as dívidas e negociações deste cliente serão removidas.`
    )

    if (!confirmed) return

    setDeletingId(customer.id)
    try {
      const response = await fetch(`/api/super-admin/clients/${customer.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId: companyId,
          tableName: "VMAX",
        }),
      })

      if (response.ok) {
        toast.success(`Cliente ${customer.name} excluído com sucesso`)
        // Hard reload to ensure fresh data from server
        window.location.reload()
      } else {
        const error = await response.json()
        toast.error(error.error || "Erro ao excluir cliente")
      }
    } catch (error) {
      toast.error("Erro ao excluir cliente")
    } finally {
      setDeletingId(null)
    }
  }

  const handleEditClient = async (customer: Customer) => {
    setEditingCustomer(customer)
    setLoadingEdit(true)
    setShowEditModal(true)

    try {
      const response = await fetch(
        `/api/super-admin/clients/${customer.id}?tableName=VMAX&companyId=${companyId}`
      )
      if (response.ok) {
        const data = await response.json()
        setEditData(data)
      } else {
        toast.error("Erro ao carregar dados do cliente")
        setShowEditModal(false)
      }
    } catch (error) {
      toast.error("Erro ao carregar dados do cliente")
      setShowEditModal(false)
    } finally {
      setLoadingEdit(false)
    }
  }

  const handleSaveClient = async () => {
    if (!editData || !editingCustomer) return

    setSavingEdit(true)
    try {
      const response = await fetch(`/api/super-admin/clients/${editingCustomer.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...editData,
          tableName: "VMAX",
          companyId: companyId,
        }),
      })

      if (response.ok) {
        toast.success("Cliente atualizado com sucesso")
        setShowEditModal(false)
        setEditingCustomer(null)
        setEditData(null)
        // Hard reload to ensure fresh data from server
        window.location.reload()
      } else {
        const error = await response.json()
        toast.error(error.error || "Erro ao salvar cliente")
      }
    } catch (error) {
      toast.error("Erro ao salvar cliente")
    } finally {
      setSavingEdit(false)
    }
  }

  const handleReactivateClient = async (customer: Customer) => {
    const confirmed = window.confirm(
      `Reativar a dívida de ${customer.name}?\n\nO status será alterado de "Quitado" para "Em aberto" e o cliente voltará a aparecer como devedor.`
    )

    if (!confirmed) return

    setReactivatingId(customer.id)
    try {
      const response = await fetch(`/api/super-admin/clients/${customer.id}/reactivate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId: companyId,
          tableName: "VMAX",
        }),
      })

      if (response.ok) {
        toast.success("Dívida reativada com sucesso")
        // Hard reload to ensure fresh data from server
        window.location.reload()
      } else {
        const error = await response.json()
        toast.error(error.error || "Erro ao reativar dívida")
      }
    } catch (error) {
      toast.error("Erro ao reativar dívida")
    } finally {
      setReactivatingId(null)
    }
  }

  const updateEditField = (field: string, value: any) => {
    setEditData((prev: any) => ({ ...prev, [field]: value }))
  }

  // Stats calculations
  const stats = useMemo(() => {
    const totalClientes = customers.length
    const overdueCustomers = customers.filter((c) => c.status === "overdue")
    const paidCustomers = customers.filter((c) => c.status === "paid")
    const pendingCustomers = customers.filter((c) => c.status !== "paid")

    return {
      totalClientes,
      overdueCount: overdueCustomers.length,
      paidCount: paidCustomers.length,
      // Dívida Pendente = sum of all non-paid customers
      pendingDebt: pendingCustomers.reduce((sum, c) => sum + c.totalDebt, 0),
      // Dívida Recuperada = sum of paid customers (their original debt)
      recoveredDebt: paidCustomers.reduce((sum, c) => sum + c.totalDebt, 0),
      // Em Atraso = sum of overdue debts
      overdueDebt: overdueCustomers.reduce((sum, c) => sum + c.totalDebt, 0),
    }
  }, [customers])

  const filteredAndSortedCustomers = useMemo(() => {
    let result = customers.filter((customer) => {
      // Status filter
      if (statusFilter === "overdue" && customer.status !== "overdue") return false
      if (statusFilter === "paid" && customer.status !== "paid") return false

      if (!searchTerm) return true
      const searchLower = searchTerm.toLowerCase()
      // documento em claro não está no cliente (privacidade A5): busca casa o mascarado
      return customer.name.toLowerCase().includes(searchLower) || customer.documentMasked.toLowerCase().includes(searchLower)
    })

    if (daysSort !== "none") {
      result = [...result].sort((a, b) => {
        return daysSort === "asc" ? a.daysOverdue - b.daysOverdue : b.daysOverdue - a.daysOverdue
      })
    }

    if (amountSort !== "none") {
      result = [...result].sort((a, b) => {
        return amountSort === "asc" ? a.totalDebt - b.totalDebt : b.totalDebt - a.totalDebt
      })
    }

    return result
  }, [customers, searchTerm, daysSort, amountSort, statusFilter])

  const displayedCustomers = useMemo(() => {
    if (displayLimit === 0) return filteredAndSortedCustomers
    return filteredAndSortedCustomers.slice(0, displayLimit)
  }, [filteredAndSortedCustomers, displayLimit])

  const formatCurrency = (value: number) =>
    new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value)

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return null
    try {
      const date = new Date(dateStr)
      return date.toLocaleDateString("pt-BR")
    } catch {
      return null
    }
  }

  const getStatusLabel = (status: string) => {
    const statuses = {
      active: "Ativo",
      overdue: "Em Atraso",
      negotiating: "Negociando",
      paid: "Quitado",
    }
    return statuses[status as keyof typeof statuses] || status
  }

  const getStatusBadgeClass = (status: string) => {
    switch (status) {
      case "paid":
        return "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300"
      case "overdue":
        return "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300"
      default:
        return "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300"
    }
  }

  return (
    <>
      {/* Stats Cards - Updated layout */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="border-l-4 border-l-blue-500">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total de Clientes</CardTitle>
            <Users className="h-4 w-4 text-blue-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.totalClientes}</div>
            <p className="text-xs text-muted-foreground">{stats.overdueCount} em atraso</p>
          </CardContent>
        </Card>

        <Card className="border-l-4 border-l-red-500">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Dívida Pendente</CardTitle>
            <DollarSign className="h-4 w-4 text-red-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-red-600 dark:text-red-400">
              {formatCurrency(stats.pendingDebt)}
            </div>
            <p className="text-xs text-muted-foreground">Em dívidas ativas</p>
          </CardContent>
        </Card>

        <Card className="border-l-4 border-l-green-500">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Dívida Recuperada</CardTitle>
            <CheckCircle className="h-4 w-4 text-green-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600 dark:text-green-400">
              {formatCurrency(stats.recoveredDebt)}
            </div>
            <p className="text-xs text-muted-foreground">{stats.paidCount} cliente(s)</p>
          </CardContent>
        </Card>

        <Card className="border-l-4 border-l-orange-500">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Em Atraso</CardTitle>
            <AlertTriangle className="h-4 w-4 text-orange-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-orange-600 dark:text-orange-400">
              {formatCurrency(stats.overdueDebt)}
            </div>
            <p className="text-xs text-muted-foreground">{stats.overdueCount} cliente(s)</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center space-x-2">
            <Users className="h-5 w-5" />
            <span>Lista de Clientes ({filteredAndSortedCustomers.length})</span>
          </CardTitle>
          <CardDescription>Visualize todos os clientes da empresa</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="mb-6">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
              <div>
                <label className="text-sm font-medium mb-2 block">Buscar Cliente</label>
                <Input
                  placeholder="Nome, CPF/CNPJ..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-full"
                />
              </div>
              <div>
                <label className="text-sm font-medium mb-2 block">Status</label>
                <Select value={statusFilter} onValueChange={(value: any) => setStatusFilter(value)}>
                  <SelectTrigger>
                    <SelectValue placeholder="Todos" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Todos</SelectItem>
                    <SelectItem value="overdue">Em Atraso</SelectItem>
                    <SelectItem value="paid">Quitados</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-sm font-medium mb-2 block">Ordenar por Dias</label>
                <Select value={daysSort} onValueChange={(value: any) => setDaysSort(value)}>
                  <SelectTrigger>
                    <SelectValue placeholder="Sem ordenação" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Sem ordenação</SelectItem>
                    <SelectItem value="asc">Menor para Maior</SelectItem>
                    <SelectItem value="desc">Maior para Menor</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-sm font-medium mb-2 block">Ordenar por Valor</label>
                <Select value={amountSort} onValueChange={(value: any) => setAmountSort(value)}>
                  <SelectTrigger>
                    <SelectValue placeholder="Sem ordenação" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Sem ordenação</SelectItem>
                    <SelectItem value="asc">Menor para Maior</SelectItem>
                    <SelectItem value="desc">Maior para Menor</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-sm font-medium mb-2 block">Exibir</label>
                <Select value={String(displayLimit)} onValueChange={(value) => setDisplayLimit(Number(value))}>
                  <SelectTrigger>
                    <SelectValue placeholder="50" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="50">50</SelectItem>
                    <SelectItem value="100">100</SelectItem>
                    <SelectItem value="250">250</SelectItem>
                    <SelectItem value="500">500</SelectItem>
                    <SelectItem value="1000">1000</SelectItem>
                    <SelectItem value="0">Todos</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          <div className="space-y-3">
            {displayedCustomers.length === 0 ? (
              <div className="text-center py-12">
                <Users className="h-12 w-12 text-gray-400 mx-auto mb-4" />
                <p className="text-gray-500 font-medium">
                  {searchTerm ? "Nenhum cliente encontrado" : "Nenhum cliente cadastrado"}
                </p>
                <p className="text-sm text-gray-400 mt-2">
                  {searchTerm ? "Tente buscar por outro termo" : "Importe uma base de clientes para começar"}
                </p>
              </div>
            ) : (
              displayedCustomers.map((customer) => (
                <div
                  key={customer.id}
                  className="flex items-start sm:items-center justify-between p-4 border border-gray-200 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors gap-4"
                >
                  <div className="flex items-start sm:items-center gap-3 min-w-0 flex-1">
                    <Avatar className="flex-shrink-0">
                      <AvatarFallback className={customer.status === "paid"
                        ? "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300"
                        : "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300"}>
                        {customer.name
                          .split(" ")
                          .map((n) => n[0])
                          .join("")
                          .slice(0, 2)
                          .toUpperCase()}
                      </AvatarFallback>
                    </Avatar>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <p className="font-semibold text-gray-900 dark:text-white">{customer.name}</p>
                        <Badge className={getStatusBadgeClass(customer.status)}>
                          {getStatusLabel(customer.status)}
                        </Badge>
                      </div>

                      <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-3 text-sm text-gray-600 dark:text-gray-400">
                        <span className="text-xs">
                          CPF:{" "}
                          <RevealableDocument
                            masked={customer.documentMasked}
                            id={customer.id}
                            companyId={companyId}
                          />
                        </span>
                        {customer.city && (
                          <>
                            <span className="hidden sm:inline">•</span>
                            <span className="flex items-center gap-1">
                              <MapPin className="h-3 w-3" />
                              {customer.city}
                            </span>
                          </>
                        )}
                      </div>

                      {/* Status indicator based on paid/overdue */}
                      {customer.status === "paid" ? (
                        <div className="mt-2">
                          <span className="inline-flex items-center gap-1.5 text-sm font-medium text-green-600 dark:text-green-400">
                            <CheckCircle className="h-4 w-4" />
                            Pago em {formatDate(customer.paymentDate) || "data não disponível"}
                          </span>
                        </div>
                      ) : customer.daysOverdue > 0 ? (
                        <div className="mt-2 flex flex-col gap-1">
                          <span className="text-sm font-semibold text-red-600 dark:text-red-400">
                            {formatCurrency(customer.overdueDebt)} em atraso
                          </span>
                          <span className="inline-flex items-center gap-1 text-xs font-medium text-orange-600 dark:text-orange-400">
                            <Clock className="h-3 w-3" />
                            {customer.daysOverdue} dias em atraso
                          </span>
                        </div>
                      ) : null}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 flex-shrink-0">
                    <div className="text-right mr-2">
                      <div className={`text-lg font-bold whitespace-nowrap ${
                        customer.status === "paid"
                          ? "text-green-600 dark:text-green-400"
                          : "text-gray-900 dark:text-white"
                      }`}>
                        {formatCurrency(customer.totalDebt)}
                      </div>
                      {customer.status === "paid" && (
                        <p className="text-xs text-green-600 dark:text-green-400 mt-1">Dívida quitada</p>
                      )}
                    </div>

                    {/* Reactivate button - only for paid clients */}
                    {customer.status === "paid" && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleReactivateClient(customer)}
                        disabled={reactivatingId === customer.id}
                        className="h-8 px-2 text-orange-500 border-orange-300 hover:bg-orange-50 dark:hover:bg-orange-950"
                        title="Reativar dívida"
                      >
                        {reactivatingId === customer.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <>
                            <RotateCcw className="h-4 w-4 mr-1" />
                            <span className="hidden sm:inline">Reativar</span>
                          </>
                        )}
                      </Button>
                    )}

                    {/* Edit button */}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleEditClient(customer)}
                      className="h-8 w-8 p-0 text-blue-500 hover:text-blue-700 hover:bg-blue-50 dark:hover:bg-blue-950"
                      title="Editar cliente"
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>

                    {/* Delete button */}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDeleteClient(customer)}
                      disabled={deletingId === customer.id}
                      className="h-8 w-8 p-0 text-red-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950"
                      title="Excluir cliente"
                    >
                      {deletingId === customer.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Trash2 className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                </div>
              ))
            )}
          </div>
        </CardContent>
      </Card>

      {/* Edit Client Modal */}
      <Dialog open={showEditModal} onOpenChange={(open) => {
        if (!open) {
          setShowEditModal(false)
          setEditingCustomer(null)
          setEditData(null)
        }
      }}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Editar Cliente</DialogTitle>
          </DialogHeader>

          {loadingEdit ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
            </div>
          ) : editData ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 py-4">
              {/* Name */}
              <div className="space-y-2">
                <Label htmlFor="edit-name">Nome</Label>
                <Input
                  id="edit-name"
                  value={editData.Cliente || editData.cliente || ""}
                  onChange={(e) => updateEditField("Cliente", e.target.value)}
                />
              </div>

              {/* CPF/CNPJ */}
              <div className="space-y-2">
                <Label htmlFor="edit-document">CPF/CNPJ</Label>
                <Input
                  id="edit-document"
                  value={editData["CPF/CNPJ"] || editData.cpf_cnpj || ""}
                  onChange={(e) => updateEditField("CPF/CNPJ", e.target.value)}
                />
              </div>

              {/* Email */}
              <div className="space-y-2">
                <Label htmlFor="edit-email">Email</Label>
                <Input
                  id="edit-email"
                  type="email"
                  value={editData.Email || editData.email || editData._customer_email || ""}
                  onChange={(e) => updateEditField("Email", e.target.value)}
                  placeholder="email@exemplo.com"
                />
              </div>

              {/* Phone 1 */}
              <div className="space-y-2">
                <Label htmlFor="edit-phone1">Telefone 1</Label>
                <Input
                  id="edit-phone1"
                  value={editData["Telefone 1"] || editData.telefone_1 || editData._customer_phone || ""}
                  onChange={(e) => updateEditField("Telefone 1", e.target.value)}
                  placeholder="(11) 99999-9999"
                />
              </div>

              {/* Phone 2 */}
              <div className="space-y-2">
                <Label htmlFor="edit-phone2">Telefone 2</Label>
                <Input
                  id="edit-phone2"
                  value={editData["Telefone 2"] || editData.telefone_2 || ""}
                  onChange={(e) => updateEditField("Telefone 2", e.target.value)}
                  placeholder="(11) 99999-9999"
                />
              </div>

              {/* City */}
              <div className="space-y-2">
                <Label htmlFor="edit-city">Cidade</Label>
                <Input
                  id="edit-city"
                  value={editData.Cidade || editData.cidade || ""}
                  onChange={(e) => updateEditField("Cidade", e.target.value)}
                />
              </div>

              {/* Address */}
              <div className="space-y-2 md:col-span-2">
                <Label htmlFor="edit-address">Endereço</Label>
                <Input
                  id="edit-address"
                  value={editData.Endereco || editData.endereco || editData.Rua || editData.rua || ""}
                  onChange={(e) => updateEditField("Endereco", e.target.value)}
                />
              </div>

              {/* Bairro */}
              <div className="space-y-2">
                <Label htmlFor="edit-bairro">Bairro</Label>
                <Input
                  id="edit-bairro"
                  value={editData.Bairro || editData.bairro || ""}
                  onChange={(e) => updateEditField("Bairro", e.target.value)}
                />
              </div>

              {/* CEP */}
              <div className="space-y-2">
                <Label htmlFor="edit-cep">CEP</Label>
                <Input
                  id="edit-cep"
                  value={editData.CEP || editData.cep || ""}
                  onChange={(e) => updateEditField("CEP", e.target.value)}
                  placeholder="00000-000"
                />
              </div>

              {/* UF */}
              <div className="space-y-2">
                <Label htmlFor="edit-uf">UF</Label>
                <Input
                  id="edit-uf"
                  value={editData.UF || editData.uf || ""}
                  onChange={(e) => updateEditField("UF", e.target.value)}
                  maxLength={2}
                  placeholder="SP"
                />
              </div>

              {/* Debt Value */}
              <div className="space-y-2">
                <Label htmlFor="edit-debt">Valor da Dívida</Label>
                <Input
                  id="edit-debt"
                  value={editData.Vencido || editData.vencido || editData.valor || ""}
                  onChange={(e) => updateEditField("Vencido", e.target.value)}
                  placeholder="R$ 0,00"
                />
              </div>
            </div>
          ) : null}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setShowEditModal(false)
                setEditingCustomer(null)
                setEditData(null)
              }}
            >
              Cancelar
            </Button>
            <Button
              onClick={handleSaveClient}
              disabled={savingEdit || loadingEdit}
            >
              {savingEdit ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Salvando...
                </>
              ) : (
                "Salvar"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
