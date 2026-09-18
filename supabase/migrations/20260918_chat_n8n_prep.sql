-- Chat genérico + contratos n8n (fase preparatória, N2). 100% ADITIVA:
-- só ADD COLUMN IF NOT EXISTS, CREATE TABLE/INDEX IF NOT EXISTS e RLS.
-- Nada altera dados nem remove/renomeia. Convenções do repo (mesmo padrão de
-- 20260916_chat_journey_core.sql): company_id NOT NULL + FK, RLS = service_role
-- (escrita BFF/workers) + select por company para authenticated.
--
-- NÃO aplicar em produção nesta onda — o orquestrador aplica com backup no GATE N1.

-- ============================================================
-- 1. negotiation_sessions: colunas da onda (consolidado + engine + funil)
-- ============================================================
alter table public.negotiation_sessions add column if not exists debt_ids uuid[] not null default '{}';
alter table public.negotiation_sessions add column if not exists primary_debt_id uuid references public.debts(id);
alter table public.negotiation_sessions add column if not exists engine text;
alter table public.negotiation_sessions add column if not exists status text not null default 'open';
alter table public.negotiation_sessions add column if not exists last_activity_at timestamptz;
alter table public.negotiation_sessions add column if not exists closed_at timestamptz;
alter table public.negotiation_sessions add column if not exists consent_at timestamptz;
alter table public.negotiation_sessions add column if not exists channel text;

-- status ('open','closed') e channel ('web_campaign','web_generic','admin_preview').
-- Constraints por NOT VALID + validate para não travar linhas legadas (todas ficam
-- 'open' pelo default; channel legado fica null e é aceito).
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'negotiation_sessions_status_check'
  ) then
    alter table public.negotiation_sessions
      add constraint negotiation_sessions_status_check
      check (status in ('open','closed')) not valid;
    alter table public.negotiation_sessions validate constraint negotiation_sessions_status_check;
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'negotiation_sessions_channel_check'
  ) then
    alter table public.negotiation_sessions
      add constraint negotiation_sessions_channel_check
      check (channel is null or channel in ('web_campaign','web_generic','admin_preview')) not valid;
    alter table public.negotiation_sessions validate constraint negotiation_sessions_channel_check;
  end if;
end $$;

create index if not exists idx_neg_sessions_company_customer_status
  on public.negotiation_sessions (company_id, customer_id, status);

-- ============================================================
-- 2. chat_messages (NOVO): turno-a-turno do chat com rastreio n8n
-- ============================================================
create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  session_id uuid not null references public.negotiation_sessions(id),
  role text not null check (role in ('customer','assistant','system')),
  text text not null,
  offers_snapshot jsonb,
  n8n_execution_id text,
  engine text,
  latency_ms int,
  created_at timestamptz not null default now()
);
create index if not exists idx_chat_messages_session_created
  on public.chat_messages (session_id, created_at);
create index if not exists idx_chat_messages_company
  on public.chat_messages (company_id, created_at);

-- ============================================================
-- 3. tenant_chat_config: políticas da onda
-- ============================================================
alter table public.tenant_chat_config add column if not exists payment_origin text not null default 'platform'
  check (payment_origin in ('platform','n8n'));
alter table public.tenant_chat_config add column if not exists auth_require_otp boolean not null default false;
alter table public.tenant_chat_config add column if not exists send_document_to_engine boolean not null default false;
alter table public.tenant_chat_config add column if not exists n8n_chat_flow_url text;
alter table public.tenant_chat_config add column if not exists debt_selection text not null default 'consolidated'
  check (debt_selection in ('consolidated','choice'));

-- ============================================================
-- 4. Auth genérico (endpoint /t/{slug}/negociar): tentativas + locks duráveis
--    por IP e por documento, INDEPENDENTES (mitigação §3.4). Sem token — por
--    isso não reutiliza chat_auth_attempts/locks (que exigem access_token_id).
--    NUNCA guarda o documento: só doc_hash + ip_hash.
-- ============================================================
create table if not exists public.chat_auth_generic_attempts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  doc_hash text not null,
  ip_hash text,
  success boolean not null,
  failure_reason text, -- interno; nunca exposto ao cliente
  created_at timestamptz not null default now()
);
create index if not exists idx_generic_attempts_doc
  on public.chat_auth_generic_attempts (company_id, doc_hash, created_at);
create index if not exists idx_generic_attempts_ip
  on public.chat_auth_generic_attempts (company_id, ip_hash, created_at);

create table if not exists public.chat_auth_generic_locks (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  scope text not null check (scope in ('ip','document')),
  key_hash text not null, -- ip_hash ou doc_hash conforme scope
  locked_until timestamptz not null,
  reason text not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_generic_locks_lookup
  on public.chat_auth_generic_locks (company_id, scope, key_hash, locked_until);

-- ============================================================
-- 5. RLS (padrão do repo): service_role escreve; sem select p/ authenticated
--    em chat_messages/attempts/locks (dados sensíveis; painel lê via service).
-- ============================================================
alter table public.chat_messages enable row level security;
alter table public.chat_auth_generic_attempts enable row level security;
alter table public.chat_auth_generic_locks enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'chat_messages' and policyname = 'service_role_all') then
    create policy service_role_all on public.chat_messages for all to service_role using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'chat_auth_generic_attempts' and policyname = 'service_role_all') then
    create policy service_role_all on public.chat_auth_generic_attempts for all to service_role using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'chat_auth_generic_locks' and policyname = 'service_role_all') then
    create policy service_role_all on public.chat_auth_generic_locks for all to service_role using (true) with check (true);
  end if;
end $$;
