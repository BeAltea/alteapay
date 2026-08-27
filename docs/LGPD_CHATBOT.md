# LGPD — Chatbot de Negociação AlteaPay (Fase 1)

Como os requisitos da LGPD estão implementados no chatbot de negociação
(WhatsApp + chat web), com os pontos de código correspondentes.

## 1. Base legal e transparência (arts. 7º e 9º)

- A base legal primária da cobrança é **execução de contrato / exercício regular
  de direitos** do credor. O consentimento colhido no canal cobre o tratamento
  na conversa e é registrado como evidência de transparência.
- Tela de consentimento obrigatória antes do chat
  (`components/negotiation/negotiation-chat.tsx`, fase `consent`), com:
  controlador (tenant), operador (AlteaPay), finalidade, dados tratados,
  link à política de privacidade e contato do DPO (`tenant_chat_config`).
- Aceite registrado com versão + timestamp: `negotiation_sessions.consent_lgpd_at`
  / `consent_lgpd_version` (rota `POST /api/negotiation/consent`; versão em
  `lib/negotiation/config.ts` → `CONSENT_VERSION`). O chat recusa mensagens
  antes do consentimento (403).

## 2. Minimização (art. 6º, III)

- Identificação usa apenas **CPF + data de nascimento**. O prompt v5 proíbe o
  agente de pedir qualquer outro dado (seção "LGPD (v5)" em
  `alteapay-agents/agents/negotiation/app/prompts/negotiator_v5.md`).
- CPF nunca em claro nas tabelas novas: `negotiation_sessions.document_hash`
  (sha256 digits-only), `whatsapp_inbound_events.phone_hash`.
- Mascaramento em toda UI e em `conversation_messages.content_redacted`
  (`lib/negotiation/pii.ts`: `maskCpf`, `maskName`, `redactPii`).
- Nenhum PII em logs (regra 7 do projeto).

## 3. Segurança (art. 46)

- Token de handoff opaco (32 bytes), single-use, TTL 24h, só o hash persiste
  (`lib/negotiation/crypto.ts`).
- Cookie de sessão httpOnly, JWT HS256 com expiração de 2h.
- CORS e `frame-ancestors` restritos a `tenant_chat_config.allowed_origins`.
- Rate limiting por IP e por sessão (`lib/negotiation/rate-limit.ts`).
- `conversation_messages` é imutável por trigger de banco; a única exceção é o
  fluxo de anonimização (GUC `alteapay.allow_redaction`).
- Transcript integral atrás de permissão elevada (apenas `super_admin`, com
  `?full=1`) e **trilha de acesso** em `security_events`
  (action `lgpd_read_full_transcript`) — rota
  `app/api/negotiation/session/[id]/transcript/route.ts`.

## 4. Direitos do titular (art. 18)

- Pedidos de acesso/correção/exclusão na conversa: o prompt v5 aciona
  `request_handoff(reason="lgpd_data_request")` — evento auditável no store do
  agente e na sessão (`outcome=handoff_human`).
- **Anonimização de sessão** (execução manual pelo encarregado):
  `npx tsx scripts/anonymize-session.ts <session_id>` — substitui o conteúdo por
  `[removido a pedido do titular]`, apaga hashes de documento/contato/token,
  desvincula o customer e preserva métricas agregadas (outcome, valores de
  redirect). O ato fica auditado em `security_events`
  (action `lgpd_anonymize_session`).

## 5. Decisão automatizada (art. 20)

- Toda decisão do agente é rastreável: `conversation_messages.prompt_version`,
  `tool_calls` e `llm_model` por turno; as regras de desconto/parcela são
  determinísticas (`charge_rules.yaml` — o LLM não pode criar condições).
- Revisão humana sempre disponível: botão fixo "Falar com atendente" na UI do
  chat; o aviso de consentimento informa o direito de revisão.

## 6. Retenção

| Dado | Prazo | Config |
|---|---|---|
| `whatsapp_inbound_events` (payload bruto) | 90 dias | `WHATSAPP_EVENTS_RETENTION_DAYS` |
| `conversation_messages` | 5 anos (auditoria/prescrição) | `CONVERSATION_RETENTION_DAYS` |

- Execução: `npx tsx scripts/retention-cleanup.ts [--dry-run]` — em produção,
  agendar como cron (fica fora da Fase 1); cada execução é auditada em
  `security_events` (action `lgpd_retention_cleanup`).

## 7. Menores de idade

- As identidades locais usam DOB sintética (treino). Em produção, se a data de
  nascimento validada indicar menor de 18 anos, a negociação deve ser encerrada
  e roteada ao canal oficial (modo C). **Ponto de implementação:** o gate de
  identidade do fluxo WhatsApp (`lib/negotiation/whatsapp-flow.ts`) e o
  `verify_identity` do agente — pendente de dado real de nascimento, documentado
  como requisito de go-live.

## Inventário de dados pessoais tratados

| Dado | Onde | Forma |
|---|---|---|
| CPF/CNPJ | `negotiation_sessions.document_hash` | hash sha256 |
| CPF/CNPJ | `customers.document` (pré-existente) | claro (sistema legado) |
| Telefone | `whatsapp_inbound_events.phone_hash` | hash sha256 |
| Nome | `conversation_messages.content` | claro (imutável, acesso controlado) |
| Nome | `content_redacted` / telas | mascarado |
| Conteúdo da conversa | `conversation_messages` | claro + versão redigida |
| IP | `negotiation_sessions.ip_hash` | hash sha256 |
