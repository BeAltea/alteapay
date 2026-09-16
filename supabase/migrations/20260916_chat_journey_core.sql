-- Jornada de negociação (WhatsApp → link seguro → chat → acordo → conciliação).
-- 100% aditiva: só CREATE TABLE/INDEX/VIEW, ALTER ... ADD COLUMN e RLS.
-- Convenções do repo: company_id NOT NULL + FK, created_at default now(),
-- RLS = service_role_all (escrita workers/BFF) + select por company p/ authenticated
-- (mesmo padrão de 20260702_create_negotiation_chat_tables.sql).

-- ============================================================
-- 1. Campanhas de WhatsApp (lista explícita, nunca filtro vivo)
-- ============================================================
create table if not exists public.whatsapp_campaigns (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  name text not null,
  provider text not null default 'mock' check (provider in ('voxuy','mock')),
  template_key text not null,
  status text not null default 'draft'
    check (status in ('draft','scheduled','running','paused','completed','cancelled')),
  scheduled_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  selection_snapshot jsonb not null default '{}'::jsonb,
  counts jsonb not null default '{}'::jsonb,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_wa_campaigns_company on public.whatsapp_campaigns (company_id, status);

-- ============================================================
-- 2. Tokens de acesso ao chat (token NUNCA em claro; só hash)
--    (criada antes de whatsapp_messages, que a referencia)
-- ============================================================
create table if not exists public.chat_access_tokens (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  customer_id uuid not null references public.customers(id),
  debt_ids uuid[] not null default '{}',
  campaign_id uuid references public.whatsapp_campaigns(id),
  message_id uuid, -- FK circular com whatsapp_messages; mantido sem constraint (documentado)
  token_hash text not null unique,
  expires_at timestamptz not null,
  max_uses int not null default 20,
  use_count int not null default 0,
  first_opened_at timestamptz,
  last_opened_at timestamptz,
  revoked_at timestamptz,
  revoke_reason text,
  created_by text not null default 'campaign' check (created_by in ('campaign','admin','system')),
  created_at timestamptz not null default now()
);
create index if not exists idx_chat_tokens_customer on public.chat_access_tokens (company_id, customer_id);
create index if not exists idx_chat_tokens_campaign on public.chat_access_tokens (campaign_id);

-- ============================================================
-- 3. Mensagens de campanha
-- ============================================================
create table if not exists public.whatsapp_messages (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  campaign_id uuid not null references public.whatsapp_campaigns(id),
  customer_id uuid not null references public.customers(id),
  debt_id uuid references public.debts(id),
  access_token_id uuid references public.chat_access_tokens(id),
  phone_e164 text not null,
  provider text not null,
  provider_message_id text,
  provider_payload jsonb,
  status text not null default 'queued'
    check (status in ('queued','sent','delivered','read','failed','suppressed')),
  status_history jsonb not null default '[]'::jsonb,
  error text,
  queued_at timestamptz not null default now(),
  sent_at timestamptz,
  delivered_at timestamptz,
  read_at timestamptz,
  clicked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint whatsapp_messages_campaign_customer_unique unique (campaign_id, customer_id)
);
create index if not exists idx_wa_messages_campaign_status on public.whatsapp_messages (campaign_id, status);
create index if not exists idx_wa_messages_provider_mid on public.whatsapp_messages (provider_message_id);

-- ============================================================
-- 4. Eventos brutos do provider (append-only; formato desconhecido nunca se perde)
-- ============================================================
create table if not exists public.whatsapp_provider_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  company_id uuid references public.companies(id),
  received_at timestamptz not null default now(),
  event_hash text not null unique,
  raw jsonb not null,
  normalized jsonb,
  processed boolean not null default false,
  error text,
  created_at timestamptz not null default now()
);
create index if not exists idx_wa_provider_events_processed on public.whatsapp_provider_events (processed, received_at);

-- ============================================================
-- 5. Supressões de contato (opt-out, bloqueio, pago, disputa, humano)
-- ============================================================
create table if not exists public.contact_suppressions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references public.companies(id), -- null = global
  scope text not null check (scope in ('phone','customer','debt')),
  phone_e164 text,
  customer_id uuid references public.customers(id),
  debt_id uuid references public.debts(id),
  doc_hash text,
  channel text not null default 'all' check (channel in ('whatsapp','sms','email','all')),
  reason text not null check (reason in ('optout','blocked','paid','dispute','human','manual','legal')),
  source text not null check (source in ('voxuy','chat','webhook','admin','system')),
  active boolean not null default true,
  expires_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint contact_suppressions_scope_target check (
    (scope = 'phone' and phone_e164 is not null)
    or (scope = 'customer' and customer_id is not null)
    or (scope = 'debt' and debt_id is not null)
  )
);
create index if not exists idx_suppressions_phone on public.contact_suppressions (company_id, phone_e164) where active;
create index if not exists idx_suppressions_customer on public.contact_suppressions (company_id, customer_id) where active;
create index if not exists idx_suppressions_doc on public.contact_suppressions (doc_hash) where active;

-- ============================================================
-- 6. Tentativas e locks de autenticação do devedor
-- ============================================================
create table if not exists public.chat_auth_attempts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  access_token_id uuid not null references public.chat_access_tokens(id),
  doc_hash text not null,
  ip_hash text,
  success boolean not null,
  failure_reason text, -- interno; nunca exposto ao cliente
  created_at timestamptz not null default now()
);
create index if not exists idx_auth_attempts_token on public.chat_auth_attempts (access_token_id, created_at);

create table if not exists public.chat_auth_locks (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  access_token_id uuid not null references public.chat_access_tokens(id),
  doc_hash text, -- null = lock do token inteiro
  locked_until timestamptz not null,
  reason text not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_auth_locks_token on public.chat_auth_locks (access_token_id, locked_until);

-- ============================================================
-- 7. Matriz de condições de negociação (o SERVIDOR decide desconto)
-- ============================================================
create table if not exists public.negotiation_condition_matrix (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  name text not null,
  priority int not null default 0,
  active boolean not null default true,
  valid_from timestamptz,
  valid_to timestamptz,
  aging_min_days int not null default 0,
  aging_max_days int, -- null = infinito
  aging_basis text not null default 'oldest_due' check (aging_basis in ('oldest_due','weighted')),
  max_discount_pct numeric(5,2) not null default 0,
  installment_discount_pct numeric(5,2) not null default 0,
  min_entry_pct numeric(5,2) not null default 0,
  max_installments int not null default 1,
  min_installment_value numeric(10,2) not null default 0,
  allowed_billing_types text[] not null default array['PIX','BOLETO'],
  proposal_validity_days int not null default 7,
  retry_after_days int,
  max_retries int,
  min_debt_value numeric(10,2) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id)
);
create index if not exists idx_matrix_company_active on public.negotiation_condition_matrix (company_id, active, priority desc);

-- ============================================================
-- 8. Ofertas (TODAS: apresentadas, aceitas, recusadas, expiradas, inválidas)
-- ============================================================
create table if not exists public.negotiation_offers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  session_id uuid not null references public.negotiation_sessions(id),
  customer_id uuid not null references public.customers(id),
  debt_id uuid not null references public.debts(id),
  matrix_id uuid references public.negotiation_condition_matrix(id),
  source text not null default 'system' check (source in ('system','ai','customer','admin')),
  status text not null default 'presented'
    check (status in ('presented','accepted','rejected','expired','invalid','superseded')),
  terms jsonb not null,
  valid_until timestamptz,
  presented_at timestamptz not null default now(),
  responded_at timestamptz,
  rejection_reason text,
  validation_error text,
  created_at timestamptz not null default now()
);
create index if not exists idx_offers_session on public.negotiation_offers (session_id, status);

-- ============================================================
-- 9. Aceites (prova: quem, quando, de onde, quais termos)
-- ============================================================
create table if not exists public.negotiation_acceptances (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  session_id uuid not null references public.negotiation_sessions(id),
  offer_id uuid not null references public.negotiation_offers(id),
  agreement_id uuid references public.agreements(id),
  accepted_at timestamptz not null default now(),
  ip_hash text,
  user_agent text,
  terms_hash text not null,
  summary_snapshot jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_acceptances_session on public.negotiation_acceptances (session_id);

-- ============================================================
-- 10. Casos (contestação, "já paguei", atendimento humano)
-- ============================================================
create table if not exists public.negotiation_cases (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  session_id uuid references public.negotiation_sessions(id),
  customer_id uuid not null references public.customers(id),
  debt_id uuid references public.debts(id),
  type text not null check (type in ('dispute','payment_claim','human_handoff')),
  status text not null default 'open' check (status in ('open','in_review','resolved','rejected')),
  details jsonb not null default '{}'::jsonb,
  assigned_to uuid references public.profiles(id),
  resolved_at timestamptz,
  resolution text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_cases_company_status on public.negotiation_cases (company_id, status);

-- ============================================================
-- 11. Jornada (append-only; correlação cliente/dívida/sessão/campanha/acordo)
-- ============================================================
create table if not exists public.journey_events (
  id bigserial primary key,
  company_id uuid not null references public.companies(id),
  customer_id uuid references public.customers(id),
  debt_id uuid references public.debts(id),
  session_id uuid references public.negotiation_sessions(id),
  campaign_id uuid references public.whatsapp_campaigns(id),
  message_id uuid references public.whatsapp_messages(id),
  agreement_id uuid references public.agreements(id),
  event_type text not null,
  event_id text not null unique,
  actor text not null check (actor in ('system','customer','ai','n8n','provider','admin')),
  payload jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists idx_journey_customer on public.journey_events (company_id, customer_id, occurred_at);
create index if not exists idx_journey_session on public.journey_events (session_id);
create index if not exists idx_journey_type on public.journey_events (event_type);

-- ============================================================
-- 12. Colunas aditivas em tabelas existentes
-- ============================================================
alter table public.customers add column if not exists birth_date date;

alter table public.agreements add column if not exists negotiation_session_id uuid references public.negotiation_sessions(id);
alter table public.agreements add column if not exists offer_id uuid references public.negotiation_offers(id);
alter table public.agreements add column if not exists proposal_valid_until timestamptz;
alter table public.agreements add column if not exists origin text; -- 'chat_journey' quando vier da jornada
-- installments/installment_amount JÁ EXISTEM (reutilizados; nada de installment_count)

-- tenant_chat_config: políticas e provider da jornada.
-- brand_name/logo/cores/contato: REUTILIZAM a coluna existente `branding jsonb`
-- (equivalente; regra "não duplicar"); privacy usa a existente privacy_policy_url.
alter table public.tenant_chat_config add column if not exists journey_public_enabled boolean not null default false;
alter table public.tenant_chat_config add column if not exists auth_require_birth_date boolean not null default false;
alter table public.tenant_chat_config add column if not exists auth_max_attempts int not null default 3;
alter table public.tenant_chat_config add column if not exists auth_lock_minutes int not null default 30;
alter table public.tenant_chat_config add column if not exists link_ttl_hours int not null default 168;
alter table public.tenant_chat_config add column if not exists session_ttl_minutes int not null default 60;
alter table public.tenant_chat_config add column if not exists contact_cooldown_days int not null default 7;
alter table public.tenant_chat_config add column if not exists creditor_notification_emails text[] not null default '{}';
alter table public.tenant_chat_config add column if not exists receipt_footer_text text;
alter table public.tenant_chat_config add column if not exists whatsapp_provider text not null default 'mock';
alter table public.tenant_chat_config add column if not exists voxuy_plan_id text;
alter table public.tenant_chat_config add column if not exists voxuy_custom_event text;
alter table public.tenant_chat_config add column if not exists whatsapp_sender_label text;

-- ============================================================
-- 13. View para o painel (documento mascarado)
-- ============================================================
create or replace view public.journey_timeline as
select
  je.id, je.company_id, je.customer_id, je.debt_id, je.session_id,
  je.campaign_id, je.message_id, je.agreement_id,
  je.event_type, je.actor, je.payload, je.occurred_at,
  c.name as customer_name,
  case
    when c.document is null then null
    when length(regexp_replace(c.document,'\D','','g')) = 11
      then '***.' || substr(regexp_replace(c.document,'\D','','g'),4,3) || '.' || substr(regexp_replace(c.document,'\D','','g'),7,3) || '-**'
    else '**.' || substr(regexp_replace(c.document,'\D','','g'),3,3) || '.' || substr(regexp_replace(c.document,'\D','','g'),6,3) || '/****-**'
  end as customer_document_masked,
  d.amount as debt_amount
from public.journey_events je
left join public.customers c on c.id = je.customer_id
left join public.debts d on d.id = je.debt_id;

-- ============================================================
-- 14. RLS (padrão do repo)
-- ============================================================
alter table public.whatsapp_campaigns enable row level security;
alter table public.whatsapp_messages enable row level security;
alter table public.whatsapp_provider_events enable row level security;
alter table public.contact_suppressions enable row level security;
alter table public.chat_access_tokens enable row level security;
alter table public.chat_auth_attempts enable row level security;
alter table public.chat_auth_locks enable row level security;
alter table public.negotiation_condition_matrix enable row level security;
alter table public.negotiation_offers enable row level security;
alter table public.negotiation_acceptances enable row level security;
alter table public.negotiation_cases enable row level security;
alter table public.journey_events enable row level security;

create policy service_role_all on public.whatsapp_campaigns for all to service_role using (true) with check (true);
create policy service_role_all on public.whatsapp_messages for all to service_role using (true) with check (true);
create policy service_role_all on public.whatsapp_provider_events for all to service_role using (true) with check (true);
create policy service_role_all on public.contact_suppressions for all to service_role using (true) with check (true);
create policy service_role_all on public.chat_access_tokens for all to service_role using (true) with check (true);
create policy service_role_all on public.chat_auth_attempts for all to service_role using (true) with check (true);
create policy service_role_all on public.chat_auth_locks for all to service_role using (true) with check (true);
create policy service_role_all on public.negotiation_condition_matrix for all to service_role using (true) with check (true);
create policy service_role_all on public.negotiation_offers for all to service_role using (true) with check (true);
create policy service_role_all on public.negotiation_acceptances for all to service_role using (true) with check (true);
create policy service_role_all on public.negotiation_cases for all to service_role using (true) with check (true);
create policy service_role_all on public.journey_events for all to service_role using (true) with check (true);

-- leitura por usuários da empresa ou super_admin (sem policy de escrita p/ authenticated)
create policy company_select on public.whatsapp_campaigns for select to authenticated using (
  company_id in (select p.company_id from public.profiles p where p.id = auth.uid())
  or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'super_admin'));
create policy company_select on public.whatsapp_messages for select to authenticated using (
  company_id in (select p.company_id from public.profiles p where p.id = auth.uid())
  or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'super_admin'));
create policy company_select on public.contact_suppressions for select to authenticated using (
  company_id is null
  or company_id in (select p.company_id from public.profiles p where p.id = auth.uid())
  or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'super_admin'));
create policy company_select on public.negotiation_condition_matrix for select to authenticated using (
  company_id in (select p.company_id from public.profiles p where p.id = auth.uid())
  or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'super_admin'));
create policy company_select on public.negotiation_offers for select to authenticated using (
  company_id in (select p.company_id from public.profiles p where p.id = auth.uid())
  or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'super_admin'));
create policy company_select on public.negotiation_acceptances for select to authenticated using (
  company_id in (select p.company_id from public.profiles p where p.id = auth.uid())
  or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'super_admin'));
create policy company_select on public.negotiation_cases for select to authenticated using (
  company_id in (select p.company_id from public.profiles p where p.id = auth.uid())
  or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'super_admin'));
create policy company_select on public.journey_events for select to authenticated using (
  company_id in (select p.company_id from public.profiles p where p.id = auth.uid())
  or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'super_admin'));
-- tokens/attempts/locks e provider_events: sem select p/ authenticated (dados sensíveis;
-- painel lê via service_role no servidor)
