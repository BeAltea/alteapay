// Variante EMBED do chat (white-label): mesma lógica/backend, sem header
// AlteaPay — o branding é 100% do tenant; footer discreto "tecnologia AlteaPay".
// Carregada dentro do iframe injetado por packages/chat-widget/alteapay-chat.js.

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

export default function NegociarEmbedPage({ params }: { params: { token: string } }) {
  return <NegotiationChat token={params.token} embed />
}
