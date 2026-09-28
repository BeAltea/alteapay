-- Frente A (onda D1) — outbox transacional dos eventos plataforma → n8n.
-- 100% ADITIVA e IDEMPOTENTE: só CREATE TABLE/INDEX IF NOT EXISTS, ALTER ... ADD
-- COLUMN IF NOT EXISTS, CREATE FUNCTION OR REPLACE e RLS. Nada remove/renomeia;
-- nada destrutivo. Convenções do repo (mesmo padrão de 20260916_chat_journey_core
-- / 20260918_chat_n8n_prep): company_id NOT NULL + FK; RLS = service_role_all
-- (escrita BFF/workers); tabela de dado operacional sem select p/ authenticated.
--
-- N8N-10 (2026-09-27): esta migration NUNCA foi aplicada em produção (PostgREST
-- devolve PGRST205 para engine_outbox e 42703 para tenant_chat_config.
-- n8n_event_names). Sem ela o session.start do login é um no-op explícito e
-- nunca chega ao n8n. Ajustes antes da 1ª aplicação: FK de sessão com ON DELETE
-- CASCADE (limpeza de sessões sintéticas do QA não trava), índice parcial dos
-- pendentes elegíveis e leitura por empresa (RLS company_select). Continua
-- idempotente: pode ser reaplicada sem efeito.
--
-- Aplicação em produção: só com aprovação — ver
-- ops/negociacao-final/11-n8n-kickoff-outbox.md.

-- ============================================================
-- 1. engine_outbox (NOVO): 1 linha por evento a entregar ao n8n.
--    O disparo grava AQUI na MESMA transação da sessão; a entrega ao n8n é
--    best-effort (Promise.allSettled) e NÃO bloqueia a resposta ao devedor.
--    Gated: com NEGOTIATION_ENGINE=disabled a linha nasce
--    status='skipped_engine_disabled' e nunca é enviada.
--
--    event_id UNIQUE + DETERMINÍSTICO (hash de session_id+reopen_count+tipo+seq)
--    garante idempotência: reentrada da mesma abertura não duplica session.start.
-- ============================================================
create table if not exists public.engine_outbox (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.negotiation_sessions(id) on delete cascade,
  company_id uuid not null references public.companies(id),
  event_type text not null,
  event_id text not null,
  payload jsonb not null,
  status text not null default 'pending'
    check (status in ('pending','sent','failed','skipped_engine_disabled')),
  attempts int not null default 0,
  last_error text,
  next_attempt_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Idempotência forte: um event_id só entra uma vez (INSERT ... ON CONFLICT no
-- código não re-dispara).
create unique index if not exists uq_engine_outbox_event_id
  on public.engine_outbox (event_id);

-- Flush ordenado: pega os pendentes/failed elegíveis por (status, next_attempt_at,
-- created_at) preservando a ordem de criação (session.start antes do 1º chat.turn).
create index if not exists idx_engine_outbox_flush
  on public.engine_outbox (status, next_attempt_at, created_at);

-- Dreno (cron/worker/turno): só os 'pending', por vencimento e ordem de criação.
create index if not exists idx_engine_outbox_pending_due
  on public.engine_outbox (next_attempt_at, created_at)
  where status = 'pending';

-- Consulta por sessão (auditoria/painel) e por empresa.
create index if not exists idx_engine_outbox_session
  on public.engine_outbox (session_id, created_at);
create index if not exists idx_engine_outbox_company
  on public.engine_outbox (company_id, created_at);

-- ============================================================
-- 2. tenant_chat_config.n8n_event_names (NOVO, jsonb): rótulos dos eventos por
--    tenant. Chaves esperadas: session_start | chat_turn | negotiation_start.
--    Ausente/NULL → defaults do código (session.start / chat.turn /
--    negotiation.start). Aditiva; não altera dados.
-- ============================================================
alter table public.tenant_chat_config
  add column if not exists n8n_event_names jsonb;

-- ============================================================
-- 3. RLS (padrão do repo, igual a journey_events): service_role escreve/lê tudo
--    (BFF, cron e worker); authenticated só LÊ as linhas da própria empresa
--    (company_id do profile) ou tudo se super_admin. Nenhuma escrita para
--    authenticated/anon. O payload já sai mascarado (documento só máscara+hash).
-- ============================================================
alter table public.engine_outbox enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies where tablename = 'engine_outbox' and policyname = 'service_role_all'
  ) then
    create policy service_role_all on public.engine_outbox
      for all to service_role using (true) with check (true);
  end if;
  if not exists (
    select 1 from pg_policies where tablename = 'engine_outbox' and policyname = 'company_select'
  ) then
    create policy company_select on public.engine_outbox for select to authenticated using (
      company_id in (select p.company_id from public.profiles p where p.id = auth.uid())
      or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'super_admin'));
  end if;
end $$;

notify pgrst, 'reload schema';
