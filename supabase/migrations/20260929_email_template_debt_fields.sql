-- E-mail de COBRANÇA VMAX — libera dados do débito no canal e-mail (onda D1).
--
-- 100% ADITIVA e IDEMPOTENTE: só ALTER ... ADD COLUMN IF NOT EXISTS. Nada de
-- DROP, nada de NOT NULL em coluna existente, nada de rename. Todas as colunas
-- novas têm DEFAULT seguro (o comportamento de produção não muda até um template
-- OPTAR por allow_debt_fields=true).
--
-- ⚠️ NÃO aplicar em produção nesta onda (gate G4). O orquestrador aplica com
-- backup após a revisão (mesmo padrão de 20260925_email_templates.sql /
-- 20260924_session_reuse.sql).

-- ============================================================
-- 1. email_templates.allow_debt_fields
--    Liga as 5 variáveis de débito (nome_cliente, documento_mascarado,
--    valor_divida, vencimento_original, qtd_faturas) SOMENTE no e-mail de
--    cobrança (o gate de render exige, além disso, purpose='negotiation' e
--    canal=email). Default FALSE → nenhum template existente muda de
--    comportamento.
-- ============================================================
alter table public.email_templates
  add column if not exists allow_debt_fields boolean not null default false;

comment on column public.email_templates.allow_debt_fields is
  'Quando true (e purpose=negotiation, canal=email), libera as variáveis de débito no corpo do e-mail de cobrança. Default false = convite neutro sem dados do débito.';

-- Índice parcial: acha rápido os templates que optaram por dados do débito
-- (universo pequeno — só os de cobrança). Não obrigatório, mas barato.
create index if not exists idx_email_templates_allow_debt_fields
  on public.email_templates (allow_debt_fields)
  where allow_debt_fields = true;

-- ============================================================
-- 2. whatsapp_messages.variable_groups (C12 — auditoria sem PII)
--    Registra QUAIS GRUPOS de variáveis foram injetados no envio de e-mail
--    (["basic"] ou ["basic","debt"]). NUNCA guarda o valor da variável (nada de
--    nome/documento/valor/vencimento) — só o NOME do grupo, para auditar quando
--    um envio carregou dados do débito. JSONB aditivo, default '[]'.
-- ============================================================
alter table public.whatsapp_messages
  add column if not exists variable_groups jsonb not null default '[]'::jsonb;

comment on column public.whatsapp_messages.variable_groups is
  'Grupos de variáveis usados no render do e-mail: ["basic"] ou ["basic","debt"]. Auditoria C12 — sem PII (só o nome do grupo, nunca o valor).';
