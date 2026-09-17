// Página pública do chat de negociação. Autenticação é pelo token de handoff
// (validado no BFF, que troca por cookie httpOnly) — fora do auth de usuário.

import type { Metadata, Viewport } from "next"

import { NegotiationChat } from "@/components/negotiation/negotiation-chat"

export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "Negociação de débito",
  robots: { index: false, follow: false },
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
}

export default function NegociarPage({ params }: { params: { token: string } }) {
  return <NegotiationChat token={params.token} />
}
