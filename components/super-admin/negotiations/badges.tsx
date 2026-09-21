// Badges/ícones presentacionais da página de negociações (T5). Puro visual.
"use client"

import { Smartphone, Mail, Contact, Ban, HelpCircle } from "lucide-react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { stageMeta, CONTACT_PROFILE_META, type ContactProfile } from "./stages"

const TONE_CLASS: Record<string, string> = {
  neutral: "bg-neutral-100 text-neutral-700 border-neutral-200",
  muted: "bg-neutral-50 text-neutral-500 border-neutral-200",
  info: "bg-blue-50 text-blue-700 border-blue-200",
  warn: "bg-amber-50 text-amber-700 border-amber-200",
  danger: "bg-red-50 text-red-700 border-red-200",
  success: "bg-green-50 text-green-700 border-green-200",
}

export function StageBadge({ stage, at }: { stage: string; at?: string | null }) {
  const meta = stageMeta(stage)
  return (
    <span className="inline-flex flex-col gap-0.5">
      <span
        className={`inline-flex w-fit items-center rounded-md border px-2 py-0.5 text-xs font-medium ${
          TONE_CLASS[meta.tone] ?? TONE_CLASS.neutral
        }`}
      >
        {meta.label}
      </span>
      {at ? (
        <span className="text-[10px] text-muted-foreground">
          {new Date(at).toLocaleDateString("pt-BR")}
        </span>
      ) : null}
    </span>
  )
}

const PROFILE_ICON = {
  smartphone: Smartphone,
  mail: Mail,
  contact: Contact,
  ban: Ban,
} as const

export function ContactProfileIcon({ profile }: { profile: ContactProfile | null }) {
  if (!profile) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex text-muted-foreground">
            <HelpCircle className="h-4 w-4" />
          </span>
        </TooltipTrigger>
        <TooltipContent>Perfil de contato não calculado</TooltipContent>
      </Tooltip>
    )
  }
  const meta = CONTACT_PROFILE_META[profile]
  const Icon = PROFILE_ICON[meta.icon]
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={`inline-flex ${
            profile === "none" ? "text-red-500" : "text-neutral-600"
          }`}
        >
          <Icon className="h-4 w-4" />
        </span>
      </TooltipTrigger>
      <TooltipContent>{meta.label}</TooltipContent>
    </Tooltip>
  )
}

export function LiveChargeCell({ live }: { live: boolean }) {
  return live ? (
    <span className="inline-flex w-fit items-center rounded-md border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
      Sim
    </span>
  ) : (
    <span className="text-xs text-muted-foreground">Não</span>
  )
}

/**
 * Honestidade de dados (E4): entrega/leitura só são afirmadas quando o provedor
 * as informou (provider_status_source != 'none'). Caso contrário mostramos
 * explicitamente "não informado pelo provedor" com tooltip — nunca inventamos.
 */
export function ProviderHonesty({
  stage,
  providerStatusSource,
}: {
  stage: string
  providerStatusSource: string
}) {
  const isDeliveryStage = stage === "delivered" || stage === "read"
  if (providerStatusSource === "none") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="text-[11px] italic text-muted-foreground underline decoration-dotted">
            não informado pelo provedor
          </span>
        </TooltipTrigger>
        <TooltipContent>
          O provedor de mensageria não retornou status de entrega/leitura para este
          contato. O estágio reflete apenas o que foi confirmado.
        </TooltipContent>
      </Tooltip>
    )
  }
  return (
    <span className="text-[11px] text-muted-foreground">
      {isDeliveryStage ? "confirmado pelo provedor" : `fonte: ${providerStatusSource}`}
    </span>
  )
}
