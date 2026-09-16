import { ImageResponse } from "next/og"

export const alt = "AlteaPay | Cobrança inteligente e recuperação de crédito"

export const size = {
  width: 1200,
  height: 630,
}

export const contentType = "image/png"

export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          backgroundColor: "#0A0F1E",
          padding: "80px",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "24px",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: "88px",
              height: "88px",
              borderRadius: "16px",
              backgroundColor: "#EAB308",
              color: "#0A0F1E",
              fontSize: "56px",
              fontWeight: 700,
            }}
          >
            A
          </div>
          <div
            style={{
              display: "flex",
              color: "#FFFFFF",
              fontSize: "72px",
              fontWeight: 700,
            }}
          >
            AlteaPay
          </div>
        </div>
        <div
          style={{
            display: "flex",
            marginTop: "48px",
            color: "#E5E7EB",
            fontSize: "44px",
            lineHeight: 1.3,
            maxWidth: "980px",
          }}
        >
          Cobrança inteligente e recuperação de crédito para empresas e para o setor público
        </div>
        <div
          style={{
            display: "flex",
            marginTop: "56px",
            width: "280px",
            height: "12px",
            borderRadius: "6px",
            backgroundColor: "#EAB308",
          }}
        />
      </div>
    ),
    {
      ...size,
    },
  )
}
