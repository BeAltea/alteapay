import type { MetadataRoute } from "next"

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "AlteaPay",
    short_name: "AlteaPay",
    description:
      "Plataforma de cobrança e recuperação de crédito para empresas e dívida ativa municipal.",
    start_url: "/",
    display: "standalone",
    background_color: "#0A0F1E",
    theme_color: "#0A0F1E",
    icons: [
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
      },
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
    ],
  }
}
