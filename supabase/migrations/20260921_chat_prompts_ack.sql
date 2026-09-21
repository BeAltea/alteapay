-- Onda R — Reconhecimento da dívida com botões + prompts do chat.
-- 100% ADITIVA: só CREATE TABLE/INDEX/VIEW, ALTER ... ADD COLUMN e RLS. Nada
-- altera dados nem remove/renomeia. Convenções do repo (mesmo padrão de
-- 20260916_chat_journey_core.sql / 20260918_chat_n8n_prep.sql):
--   company_id NOT NULL + FK; created_at default now();
--   RLS = service_role_all (escrita BFF/workers) + sem select p/ authenticated em
--   tabelas com dado de conversa sensível (painel lê via service role). O
--   catálogo de botões é validado NO CÓDIGO (ids únicos e reservados 1/0).
--
-- NÃO aplicar em produção nesta onda — o orquestrador aplica com backup no GATE R1.

-- ============================================================
-- 1. chat_prompts (NOVO): perguntas com botões numéricos, uma por interação.
--    kind: debt_acknowledgement | offer_choice | payment_method_choice |
--          payment_confirmation | generic_yes_no  (+ kinds novos do n8n aceitos).
--    status: active → answered | expired | superseded.
--    buttons jsonb: [{id:int, label:text, value?:text}]; validado no código.
-- ============================================================
create table if not exists public.chat_prompts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  session_id uuid not null references public.negotiation_sessions(id),
  kind text not null,
  question text not null,
  buttons jsonb not null default '[]',
  context jsonb,
  status text not null default 'active'
    check (status in ('active','answered','expired','superseded')),
  answered_button_id int,
  answered_value text,
  answered_at timestamptz,
  created_by text not null default 'platform' check (created_by in ('platform','n8n')),
  n8n_execution_id text,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);
-- Uma única pergunta ativa por sessão é garantida no código (as anteriores viram
-- 'superseded'); os índices otimizam essa busca e o polling.
create index if not exists idx_chat_prompts_session_status
  on public.chat_prompts (session_id, status, created_at);
create index if not exists idx_chat_prompts_company
  on public.chat_prompts (company_id, created_at);
-- Índice parcial: no máximo uma linha 'active' por sessão é a expectativa; o
-- índice acelera a checagem sem impor unicidade rígida (o supersede é no código).
create index if not exists idx_chat_prompts_active
  on public.chat_prompts (session_id) where status = 'active';

-- ============================================================
-- 2. debt_acknowledgements (NOVO, APPEND-ONLY): log auditável do reconhecimento.
--    button_id in (0,1) — 1=Sim/reconhece, 0=Não reconhece. Nunca UPDATE/DELETE
--    (fonte da verdade histórica; a view devolve a última resposta). Documento
--    NUNCA em claro: só ip_hash + user_agent.
-- ============================================================
create table if not exists public.debt_acknowledgements (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  session_id uuid not null references public.negotiation_sessions(id),
  customer_id uuid not null references public.customers(id),
  debt_id uuid not null references public.debts(id),
  prompt_id uuid references public.chat_prompts(id),
  acknowledged boolean not null,
  button_id int not null check (button_id in (0,1)),
  source text not null default 'chat_button',
  ip_hash text,
  user_agent text,
  created_at timestamptz not null default now()
);
create index if not exists idx_debt_ack_session_debt
  on public.debt_acknowledgements (session_id, debt_id, created_at desc);
create index if not exists idx_debt_ack_company
  on public.debt_acknowledgements (company_id, created_at);

-- ============================================================
-- 3. chat_messages: rastreio de botão + prompt (clique vira mensagem do cliente)
--    e dedupe de chat.send do n8n por event_id (janela 24h no código).
-- ============================================================
alter table public.chat_messages add column if not exists button_id int;
alter table public.chat_messages add column if not exists prompt_id uuid references public.chat_prompts(id);
alter table public.chat_messages add column if not exists n8n_event_id text;
create index if not exists idx_chat_messages_n8n_event
  on public.chat_messages (session_id, n8n_event_id) where n8n_event_id is not null;

-- ============================================================
-- 4. tenant_chat_config: flags de reconhecimento (defaults do GATE R0).
--    on_debt_not_recognized default 'continue' (não bloqueia navegação);
--    allow_payment_without_acknowledgement default false (bloqueia payment.create
--    sem reconhecimento); acknowledgement_enabled default true;
--    show_handoff_button default false ([99] no prompt de reconhecimento).
-- ============================================================
alter table public.tenant_chat_config add column if not exists on_debt_not_recognized text not null default 'continue'
  check (on_debt_not_recognized in ('continue','dispute','human'));
alter table public.tenant_chat_config add column if not exists allow_payment_without_acknowledgement boolean not null default false;
alter table public.tenant_chat_config add column if not exists acknowledgement_enabled boolean not null default true;
alter table public.tenant_chat_config add column if not exists show_handoff_button boolean not null default false;

-- ============================================================
-- 5. View debt_acknowledgement_latest: última resposta por (session_id, debt_id).
--    DISTINCT ON garante 1 linha por par, a mais recente (append-only → ordenar
--    por created_at desc). Usada por assertAcknowledgedForPayment e pelo painel.
-- ============================================================
create or replace view public.debt_acknowledgement_latest as
select distinct on (session_id, debt_id)
  id, company_id, session_id, customer_id, debt_id, prompt_id,
  acknowledged, button_id, source, created_at
from public.debt_acknowledgements
order by session_id, debt_id, created_at desc;

-- ============================================================
-- 6. RLS (padrão do repo): service_role escreve/lê tudo. chat_prompts /
--    debt_acknowledgements carregam dado de conversa/reconhecimento — o painel lê
--    via service role, então NÃO abrimos select para authenticated (mesmo padrão
--    de chat_messages em 20260918_chat_n8n_prep.sql).
-- ============================================================
alter table public.chat_prompts enable row level security;
alter table public.debt_acknowledgements enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'chat_prompts' and policyname = 'service_role_all') then
    create policy service_role_all on public.chat_prompts for all to service_role using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'debt_acknowledgements' and policyname = 'service_role_all') then
    create policy service_role_all on public.debt_acknowledgements for all to service_role using (true) with check (true);
  end if;
end $$;
