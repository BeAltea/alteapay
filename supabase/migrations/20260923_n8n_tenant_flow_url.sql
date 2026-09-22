-- URL do fluxo-cérebro n8n POR TENANT (papel A). 100% ADITIVA e IDEMPOTENTE:
-- só ADD COLUMN IF NOT EXISTS + COMMENT. Nada altera dados nem remove/renomeia.
-- Reafirma a coluna já introduzida em 20260918_chat_n8n_prep.sql (linha 74) —
-- segura para reexecutar; o COMMENT documenta a semântica.
--
-- Precedência da resolução da URL (feita NO CÓDIGO, lib/negotiation/engine.ts
-- → resolveChatFlowUrl): tenant_chat_config.n8n_chat_flow_url  →  env
-- N8N_CHAT_FLOW_URL  →  vazio (engine degrada para o assistido, sem erro ao
-- cliente). Esta migration NÃO decide precedência; só disponibiliza a coluna.
--
-- NÃO aplicar em produção por este arquivo: o orquestrador aplica com backup no
-- gate correspondente. A coluna é um SEGREDO OPERACIONAL quando preenchida
-- (URL-credencial do webhook trigger) — nunca logar/expor o valor.

alter table public.tenant_chat_config
  add column if not exists n8n_chat_flow_url text;

comment on column public.tenant_chat_config.n8n_chat_flow_url is
  'Papel A: URL do Webhook trigger do fluxo-cérebro n8n para este tenant. '
  'NULO = usa a env global N8N_CHAT_FLOW_URL; sem tenant nem env => engine '
  'degrada para o chat assistido (disabled). Precedência tenant->env->disabled '
  'é resolvida no código (lib/negotiation/engine.ts). Segredo operacional: '
  'quando preenchido contém credencial no path — nunca logar/expor.';
