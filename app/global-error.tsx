"use client"

// Global error boundary: substitui o root layout quando o erro ocorre nele.
// Precisa renderizar <html>/<body> próprios (o layout não está disponível aqui).
// Sem dependências de layout/estilos externos, para funcionar mesmo se a falha
// for na fundação da página. Mensagem amigável de manutenção.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <html lang="pt-BR">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily:
            "system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
          background: "#ffffff",
          color: "#0b1f3a",
          padding: "2rem",
          textAlign: "center",
        }}
      >
        <div style={{ maxWidth: "36rem" }}>
          <p
            style={{
              fontSize: "0.875rem",
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              color: "#3a5a8a",
              margin: 0,
            }}
          >
            Estamos em manutenção
          </p>
          <h1 style={{ fontSize: "2rem", fontWeight: 700, marginTop: "0.5rem" }}>
            Voltamos já
          </h1>
          <p style={{ fontSize: "1.125rem", color: "#4b5563", marginTop: "1rem" }}>
            Estamos resolvendo uma instabilidade momentânea. Tente novamente em
            instantes.
          </p>
          <div style={{ marginTop: "2rem" }}>
            <button
              onClick={() => reset()}
              style={{
                borderRadius: "0.5rem",
                background: "#0b1f3a",
                color: "#ffffff",
                padding: "0.75rem 1.5rem",
                fontWeight: 600,
                border: "none",
                cursor: "pointer",
              }}
            >
              Tentar novamente
            </button>
          </div>
          {error?.digest ? (
            <p style={{ marginTop: "1.5rem", fontSize: "0.75rem", color: "#9ca3af" }}>
              Código de referência: {error.digest}
            </p>
          ) : null}
        </div>
      </body>
    </html>
  )
}
