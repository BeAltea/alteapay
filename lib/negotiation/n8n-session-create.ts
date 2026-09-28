// Gate da ação `session.create` do POST /api/webhooks/n8n.
//
// `session.create` não tem evento de origem (a plataforma não pediu nada ao n8n
// antes dela), então a correlação N8N-16 não a cobre. Quem tivesse o segredo
// HMAC conseguia criar uma sessão e um deep link para qualquer devedor achado
// pelo documento, inclusive com `identity_verified:true`.
//
// Nenhum fluxo do n8n chama essa ação (leitura só-GET dos 150 workflows em
// 2026-09-28: zero ocorrências de "session.create", ativos ou arquivados). As
// sessões do chat nascem na plataforma (/n/, /t/, /c/, handoff), nunca pelo
// n8n. Por isso a ação fica atrás de uma flag, desligada por padrão.
//
// Flag: N8N_SESSION_CREATE_ENABLED (default OFF). OFF → 403
// `n8n_session_create_disabled`, antes de qualquer leitura de banco. ON → o
// comportamento anterior (só religar se um fluxo de canal externo realmente
// precisar, e com revisão do `identity_verified` vindo do fluxo).

export const SESSION_CREATE_DISABLED_CODE = "n8n_session_create_disabled"

export function n8nSessionCreateEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = (env.N8N_SESSION_CREATE_ENABLED ?? "").trim().toLowerCase()
  return v === "1" || v === "true" || v === "on" || v === "yes"
}
