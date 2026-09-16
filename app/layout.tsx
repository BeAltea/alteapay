import type React from "react"
import type { Metadata, Viewport } from "next"
import { Inter, JetBrains_Mono } from "next/font/google"
import { ThemeProvider } from "@/components/theme-provider"
import { Toaster } from "@/components/ui/toaster"
import { Toaster as SonnerToaster } from "sonner"
import { AuthProvider } from "@/hooks/use-auth"
import { SessionMonitor } from "@/components/session-monitor"
import { Suspense } from "react"
import "./globals.css"

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
})

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
})

export const metadata: Metadata = {
  metadataBase: new URL("https://alteapay.com"),
  title: {
    default: "AlteaPay | Cobrança inteligente e recuperação de crédito",
    template: "%s | AlteaPay",
  },
  description:
    "Plataforma de cobrança e recuperação de crédito para empresas e dívida ativa municipal. WhatsApp, Pix e boleto, remuneração por resultado e LGPD.",
  generator: "v0.app",
  keywords: ["cobrança", "pagamentos", "pix", "cartão", "recorrência", "inadimplência", "IA", "altea pay"],
  authors: [{ name: "Altea Pay" }],
  creator: "Altea Pay",
  publisher: "Altea Pay",
  alternates: {
    canonical: "/",
  },
  openGraph: {
    title: "AlteaPay | Cobrança inteligente e recuperação de crédito",
    description:
      "Plataforma de cobrança e recuperação de crédito para empresas e dívida ativa municipal. WhatsApp, Pix e boleto, remuneração por resultado e LGPD.",
    type: "website",
    locale: "pt_BR",
    url: "/",
    siteName: "AlteaPay",
    images: [
      {
        url: "/opengraph-image",
        width: 1200,
        height: 630,
        alt: "AlteaPay | Cobrança inteligente e recuperação de crédito",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "AlteaPay | Cobrança inteligente e recuperação de crédito",
    description:
      "Plataforma de cobrança e recuperação de crédito para empresas e dívida ativa municipal. WhatsApp, Pix e boleto, remuneração por resultado e LGPD.",
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
    },
  },
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/icon-light-32x32.png", sizes: "32x32", type: "image/png" },
    ],
    apple: [{ url: "/apple-icon.png", sizes: "180x180", type: "image/png" }],
  },
  manifest: "/manifest.webmanifest",
  verification: {
    ...(process.env.NEXT_PUBLIC_GSC_VERIFICATION
      ? { google: process.env.NEXT_PUBLIC_GSC_VERIFICATION }
      : {}),
    other: {
      "facebook-domain-verification": "kg3bjx228dgl9nw25er0j6ugor7x7q",
    },
  },
}

export const viewport: Viewport = {
  themeColor: "#0A0F1E",
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="pt-BR" suppressHydrationWarning>
      <body className={`font-sans ${inter.variable} ${jetbrainsMono.variable}`}>
        <Suspense fallback={null}>
          <ThemeProvider attribute="class" defaultTheme="light" enableSystem disableTransitionOnChange>
            <AuthProvider>
              <SessionMonitor />
              {children}
            </AuthProvider>
            <Toaster />
            <SonnerToaster position="top-right" />
          </ThemeProvider>
        </Suspense>
      </body>
    </html>
  )
}
