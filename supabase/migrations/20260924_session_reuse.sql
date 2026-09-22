-- Reuso de sessão (A1.1): consolida os vários registros do MESMO devedor numa
-- sessão canônica reaberta dentro do TTL, em vez de criar uma sessão nova a cada
-- autenticação. 100% ADITIVA e IDEMPOTENTE: só ADD COLUMN IF NOT EXISTS, CREATE
-- INDEX IF NOT EXISTS. Nada altera dados nem remove/renomeia.
--
-- NÃO aplicar em produção nesta onda — o orquestrador aplica com backup após a
-- revisão. Mesmo padrão de 20260918_chat_n8n_prep.sql.
--
-- Introspecção read-only (2026-09-22) confirmou que em negotiation_sessions:
--   - last_activity_at  já EXISTE (criada em 20260918_chat_n8n_prep.sql) → NÃO
--     é recriada aqui (o ADD ... IF NOT EXISTS seria no-op de qualquer forma).
--   - reopen_count / first_opened_at / previous_session_id /
--     merged_into_session_id: AUSENTES → criadas abaixo.
-- O índice (company_id, customer_id, status) já existe; aqui adicionamos a
-- variante ...last_activity_at desc para a busca do candidato de reuso ser index-only.

-- ============================================================
-- 1. Colunas de reuso/consolidação (aditivas)
-- ============================================================

-- Quantas vezes esta sessão foi reaberta dentro do TTL (auditoria + métrica).
alter table public.negotiation_sessions
  add column if not exists reopen_count int not null default 0;

-- Primeira abertura desta sessão (a "linha do tempo" começa aqui). Preenchida no
-- create; o backfill preenche onde faltar. last_activity_at reflete a atividade.
alter table public.negotiation_sessions
  add column if not exists first_opened_at timestamptz;

-- Encadeamento: sessão nova criada a partir de uma sessão FECHADA aponta para a
-- anterior (a linha do tempo não se perde quando o TTL estourou).
alter table public.negotiation_sessions
  add column if not exists previous_session_id uuid references public.negotiation_sessions(id);

-- Consolidação (backfill): sessões duplicadas do mesmo devedor apontam para a
-- sessão CANÔNICA (a mais recente). NUNCA apaga nada — só marca a fusão lógica.
alter table public.negotiation_sessions
  add column if not exists merged_into_session_id uuid references public.negotiation_sessions(id);

-- ============================================================
-- 2. Índice do candidato de reuso
--    Busca: (company_id, customer_id, status='open') ordenada por
--    last_activity_at desc, pega a mais recente e checa o TTL.
-- ============================================================
create index if not exists idx_neg_sessions_reuse_lookup
  on public.negotiation_sessions (company_id, customer_id, status, last_activity_at desc);

-- Índices auxiliares para o encadeamento/consolidação (leituras da timeline).
create index if not exists idx_neg_sessions_previous
  on public.negotiation_sessions (previous_session_id);
create index if not exists idx_neg_sessions_merged_into
  on public.negotiation_sessions (merged_into_session_id);
