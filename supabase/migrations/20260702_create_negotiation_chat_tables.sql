-- Chatbot de negociação (Fase 1): sessões, auditoria de conversas,
-- redirecionamentos (cenário 2), eventos brutos do WhatsApp e config por tenant.
-- Escritas apenas via service role (BFF); leitura por company_id.

-- ============================================================
-- 2.5 tenant_chat_config (criada antes por ser referenciada logicamente)
-- ============================================================
create table if not exists public.tenant_chat_config (
  company_id uuid primary key references public.companies(id) on delete cascade,
  fulfillment_mode text not null default 'A' check (fulfillment_mode in ('A','B','C')),
  official_channel_url text,
  official_channel_label text,
  branding jsonb not null default '{}',
  allowed_origins text[] not null default '{}',
  widget_enabled boolean not null default false,
  privacy_policy_url text,
  dpo_contact text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tenant_chat_config_mode_b_requires_url
    check (fulfillment_mode <> 'B' or official_channel_url is not null)
);

-- ============================================================
-- 2.1 negotiation_sessions
-- ============================================================
create table if not exists public.negotiation_sessions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  customer_id uuid references public.customers(id),
  debt_id uuid references public.debts(id),
  document_hash text not null,
  channel_origin text not null check (channel_origin in ('whatsapp','direct','mock')),
  frontend_mode text not null default 'alteapay' check (frontend_mode in ('alteapay','whitelabel')),
  handoff_token_hash text unique,
  token_expires_at timestamptz not null,
  token_used_at timestamptz,
  identity_verified_at timestamptz,
  debt_acknowledged_at timestamptz,
  consent_lgpd_at timestamptz,
  consent_lgpd_version text,
  fulfillment_mode text check (fulfillment_mode in ('A','B','C')),
  outcome text not null default 'in_progress' check (outcome in
    ('in_progress','agreement_closed','redirected_official','handoff_human',
     'abandoned','identity_failed','expired')),
  agreement_id uuid references public.agreements(id),
  thread_id text unique,
  user_agent text,
  ip_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_neg_sessions_company on public.negotiation_sessions(company_id);
create index if not exists idx_neg_sessions_customer on public.negotiation_sessions(customer_id);
create index if not exists idx_neg_sessions_debt on public.negotiation_sessions(debt_id);
create index if not exists idx_neg_sessions_agreement on public.negotiation_sessions(agreement_id);
create index if not exists idx_neg_sessions_outcome on public.negotiation_sessions(outcome);
create index if not exists idx_neg_sessions_created on public.negotiation_sessions(created_at);
create index if not exists idx_neg_sessions_document on public.negotiation_sessions(document_hash);

-- ============================================================
-- 2.2 conversation_messages (imutável — auditoria)
-- ============================================================
create table if not exists public.conversation_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.negotiation_sessions(id),
  company_id uuid not null references public.companies(id),
  channel text not null check (channel in ('whatsapp','webchat')),
  direction text not null check (direction in ('inbound','outbound','system')),
  sender text not null check (sender in ('debtor','agent','system','human_operator')),
  content text not null,
  content_redacted text,
  tool_calls jsonb,
  llm_model text,
  prompt_version text,
  provider_message_id text,
  created_at timestamptz not null default now()
);

create index if not exists idx_conv_messages_session on public.conversation_messages(session_id);
create index if not exists idx_conv_messages_company on public.conversation_messages(company_id);
create index if not exists idx_conv_messages_created on public.conversation_messages(created_at);

-- Imutabilidade: UPDATE/DELETE bloqueados até para service role, exceto pelo
-- caminho de anonimização LGPD (art. 18), que arma o GUC de sessão abaixo.
create or replace function public.block_conversation_message_mutation()
returns trigger language plpgsql as $$
begin
  if coalesce(current_setting('alteapay.allow_redaction', true), '') = 'on' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  raise exception 'conversation_messages é imutável (use o fluxo de anonimização LGPD)';
end;
$$;

drop trigger if exists trg_conv_messages_immutable on public.conversation_messages;
create trigger trg_conv_messages_immutable
  before update or delete on public.conversation_messages
  for each row execute function public.block_conversation_message_mutation();

-- ============================================================
-- 2.3 redirect_events (cenário 2 — evidência de disposição a pagar)
-- ============================================================
create table if not exists public.redirect_events (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.negotiation_sessions(id),
  company_id uuid not null references public.companies(id),
  debt_id uuid references public.debts(id),
  customer_id uuid references public.customers(id),
  debt_amount_at_redirect numeric(12,2) not null,
  offer_presented jsonb,
  official_channel_url text not null,
  clicked_at timestamptz not null default now(),
  confirmed_intent boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists idx_redirect_events_session on public.redirect_events(session_id);
create index if not exists idx_redirect_events_company on public.redirect_events(company_id);
create index if not exists idx_redirect_events_debt on public.redirect_events(debt_id);
create index if not exists idx_redirect_events_customer on public.redirect_events(customer_id);
create index if not exists idx_redirect_events_clicked on public.redirect_events(clicked_at);

-- ============================================================
-- 2.4 whatsapp_inbound_events (payload bruto, retenção 90 dias)
-- ============================================================
create table if not exists public.whatsapp_inbound_events (
  id uuid primary key default gen_random_uuid(),
  wamid text unique,
  phone_hash text,
  payload jsonb not null,
  session_id uuid references public.negotiation_sessions(id),
  processed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_wa_inbound_phone on public.whatsapp_inbound_events(phone_hash);
create index if not exists idx_wa_inbound_created on public.whatsapp_inbound_events(created_at);
create index if not exists idx_wa_inbound_session on public.whatsapp_inbound_events(session_id);

-- ============================================================
-- RLS
-- ============================================================
alter table public.tenant_chat_config enable row level security;
alter table public.negotiation_sessions enable row level security;
alter table public.conversation_messages enable row level security;
alter table public.redirect_events enable row level security;
alter table public.whatsapp_inbound_events enable row level security;

-- service role: acesso total (escritas do BFF/workers)
create policy service_role_all on public.tenant_chat_config
  for all to service_role using (true) with check (true);
create policy service_role_all on public.negotiation_sessions
  for all to service_role using (true) with check (true);
create policy service_role_all on public.conversation_messages
  for all to service_role using (true) with check (true);
create policy service_role_all on public.redirect_events
  for all to service_role using (true) with check (true);
create policy service_role_all on public.whatsapp_inbound_events
  for all to service_role using (true) with check (true);

-- leitura: usuários da company ou super_admin; nenhuma policy de escrita p/ authenticated
create policy tenant_chat_config_select on public.tenant_chat_config
  for select to authenticated using (
    company_id in (select p.company_id from public.profiles p where p.id = auth.uid())
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'super_admin')
  );
create policy negotiation_sessions_select on public.negotiation_sessions
  for select to authenticated using (
    company_id in (select p.company_id from public.profiles p where p.id = auth.uid())
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'super_admin')
  );
create policy conversation_messages_select on public.conversation_messages
  for select to authenticated using (
    company_id in (select p.company_id from public.profiles p where p.id = auth.uid())
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'super_admin')
  );
create policy redirect_events_select on public.redirect_events
  for select to authenticated using (
    company_id in (select p.company_id from public.profiles p where p.id = auth.uid())
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'super_admin')
  );
-- whatsapp_inbound_events: payload bruto com PII — apenas super_admin lê
create policy whatsapp_inbound_events_select on public.whatsapp_inbound_events
  for select to authenticated using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'super_admin')
  );

-- updated_at automático
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

drop trigger if exists trg_neg_sessions_updated on public.negotiation_sessions;
create trigger trg_neg_sessions_updated
  before update on public.negotiation_sessions
  for each row execute function public.set_updated_at();

drop trigger if exists trg_tenant_chat_config_updated on public.tenant_chat_config;
create trigger trg_tenant_chat_config_updated
  before update on public.tenant_chat_config
  for each row execute function public.set_updated_at();
