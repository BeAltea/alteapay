"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { MessageSquarePlus, Loader2 } from "lucide-react"
import { toast } from "sonner"
import {
  NEGOTIATION_REQUEST_TYPES,
  MAX_DISCOUNT_PERCENTAGE,
  MAX_INSTALLMENTS,
  calculateInstallmentAmount,
  type NegotiationRequestType,
} from "@/lib/constants/negotiation-request"

interface Customer {
  id: string
  name: string
  // Documento mascarado para exibição (o claro nunca trafega no cliente; o
  // servidor resolve o CPF/CNPJ por vmax_id ao persistir a solicitação — A5).
  documentMasked: string
  email?: string | null
  phone?: string | null
  totalDebt: number
  agreementId?: string | null
  asaasPaymentId?: string | null
  companyId?: string
}

interface Props {
  customer: Customer
  companyId: string
  onSuccess?: () => void
  trigger?: React.ReactNode
}

export function CreateNegotiationRequestDialog({ customer, companyId, onSuccess, trigger }: Props) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [requestType, setRequestType] = useState<NegotiationRequestType>("both")
  const [discountPercentage, setDiscountPercentage] = useState<string>("")
  const [installments, setInstallments] = useState<string>("")
  const [justification, setJustification] = useState<string>("")

  const discountValue = parseFloat(discountPercentage) || 0
  const installmentsValue = parseInt(installments) || 1

  const discountedAmount = customer.totalDebt * (1 - discountValue / 100)
  const installmentAmount = calculateInstallmentAmount(customer.totalDebt, discountValue, installmentsValue)

  const handleSubmit = async () => {
    setLoading(true)
    try {
      const payload = {
        company_id: companyId,
        agreement_id: customer.agreementId || null,
        vmax_id: customer.id,
        customer_name: customer.name,
        // documento em claro NÃO é enviado: o servidor resolve por vmax_id (A5).
        customer_email: customer.email || null,
        customer_phone: customer.phone || null,
        original_amount: customer.totalDebt,
        original_asaas_payment_id: customer.asaasPaymentId || null,
        request_type: requestType,
        requested_discount_percentage: requestType !== "installment" ? discountValue : null,
        requested_installments: requestType !== "discount" ? installmentsValue : null,
        customer_justification: justification || `Solicitação criada pelo super admin em nome do cliente ${customer.name}`,
      }

      const response = await fetch("/api/negotiation-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || "Erro ao criar solicitação")
      }

      toast.success("Solicitação de negociação criada com sucesso!")
      setOpen(false)
      resetForm()
      onSuccess?.()
    } catch (error: any) {
      console.error("Error creating request:", error)
      toast.error(error.message || "Erro ao criar solicitação")
    } finally {
      setLoading(false)
    }
  }

  const resetForm = () => {
    setRequestType("both")
    setDiscountPercentage("")
    setInstallments("")
    setJustification("")
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger || (
          <Button variant="outline" size="sm" className="h-6 px-2 text-xs">
            <MessageSquarePlus className="h-3 w-3 mr-1" />
            Solicitar
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Criar Solicitação de Negociação</DialogTitle>
          <DialogDescription>
            Crie uma solicitação de desconto/parcelamento em nome do cliente{" "}
            <span className="font-semibold">{customer.name}</span>.
            O administrador da empresa precisará aprovar esta solicitação.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Customer Info */}
          <div className="bg-muted/50 rounded-lg p-3 space-y-1">
            <p className="text-sm font-medium">{customer.name}</p>
            <p className="text-xs text-muted-foreground">{customer.documentMasked}</p>
            <p className="text-sm font-semibold text-red-600">
              Dívida: R$ {customer.totalDebt.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}
            </p>
          </div>

          {/* Request Type */}
          <div className="space-y-2">
            <Label>Tipo de Solicitação</Label>
            <Select value={requestType} onValueChange={(v: NegotiationRequestType) => setRequestType(v)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="discount">Apenas Desconto</SelectItem>
                <SelectItem value="installment">Apenas Parcelamento</SelectItem>
                <SelectItem value="both">Desconto e Parcelamento</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Discount */}
          {requestType !== "installment" && (
            <div className="space-y-2">
              <Label>Desconto Solicitado (%)</Label>
              <Input
                type="number"
                min={0}
                max={MAX_DISCOUNT_PERCENTAGE}
                placeholder={`0 a ${MAX_DISCOUNT_PERCENTAGE}`}
                value={discountPercentage}
                onChange={(e) => setDiscountPercentage(e.target.value)}
              />
              {discountValue > 0 && (
                <p className="text-xs text-muted-foreground">
                  Valor com desconto: R$ {discountedAmount.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}
                </p>
              )}
            </div>
          )}

          {/* Installments */}
          {requestType !== "discount" && (
            <div className="space-y-2">
              <Label>Número de Parcelas</Label>
              <Input
                type="number"
                min={1}
                max={MAX_INSTALLMENTS}
                placeholder={`1 a ${MAX_INSTALLMENTS}`}
                value={installments}
                onChange={(e) => setInstallments(e.target.value)}
              />
              {installmentsValue > 1 && (
                <p className="text-xs text-muted-foreground">
                  {installmentsValue}x de R$ {installmentAmount.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}
                </p>
              )}
            </div>
          )}

          {/* Justification */}
          <div className="space-y-2">
            <Label>Justificativa / Observações</Label>
            <Textarea
              placeholder="Motivo da solicitação..."
              value={justification}
              onChange={(e) => setJustification(e.target.value)}
              rows={3}
            />
          </div>

          {/* Summary */}
          <div className="bg-blue-50 dark:bg-blue-950/30 rounded-lg p-3 space-y-2">
            <p className="text-sm font-medium text-blue-900 dark:text-blue-100">Resumo da Solicitação</p>
            <div className="text-xs text-blue-700 dark:text-blue-300 space-y-1">
              {requestType !== "installment" && discountValue > 0 && (
                <p>Desconto: {discountValue}%</p>
              )}
              {requestType !== "discount" && installmentsValue > 1 && (
                <p>Parcelas: {installmentsValue}x</p>
              )}
              <p className="font-semibold">
                Valor Final: R$ {(requestType !== "discount" && installmentsValue > 1
                  ? installmentAmount * installmentsValue
                  : discountedAmount
                ).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}
              </p>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={loading}>
            Cancelar
          </Button>
          <Button onClick={handleSubmit} disabled={loading}>
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Criando...
              </>
            ) : (
              "Criar Solicitação"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
