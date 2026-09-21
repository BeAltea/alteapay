-- Onda "campanha por cedente + status" — trilha T1 (dados, perfil de contato,
-- projeção de status) + colunas do Hub/link único (§7).
-- 100% ADITIVA e IDEMPOTENTE: só ADD COLUMN IF NOT EXISTS, CREATE TABLE/INDEX
-- IF NOT EXISTS, CREATE FUNCTION OR REPLACE, DROP TRIGGER IF EXISTS + CREATE, RLS.
-- Nada remove/renomeia; nada destrutivo. Convenções do repo (mesmo padrão de
-- 20260916_chat_journey_core.sql / 20260918_chat_n8n_prep.sql):
--   company_id NOT NULL + FK; RLS = service_role_all (escrita BFF/workers) +
--   select por company p/ authenticated (ou sem select p/ dado sensível).
--
-- NÃO aplicar em produção nesta onda — o orquestrador aplica com backup no GATE B.

-- ============================================================
-- 1. customers: perfil de contato materializado
-- ============================================================
-- Escolha COLUNAS COMUNS + função recompute + trigger (NÃO generated column):
-- a normalização E.164 replica EXATAMENTE lib/journey/campaigns.ts::toE164Mobile
-- (remoção de +55/55, inserção do 9º dígito em fixos-celular antigos de 10 díg.,
-- validação de DDD 11-99 e 9 na 3ª posição). Essa lógica é imperativa e não cabe
-- numa expressão IMMUTABLE trivial de generated column STORED sem risco de
-- divergir da fonte JS. Mantendo em PL/pgSQL + trigger, a linha se recalcula em
-- INSERT/UPDATE e o backfill em lote roda via recompute_contact_profile().
-- O fallback de telefone (VMAX."Telefone 1"/"Telefone 2", isolado por id_company)
-- é aplicado APENAS no backfill em lote (recompute_contact_profile), pois a tabela
-- VMAX não é atualizada pelo trigger de customers.
alter table public.customers add column if not exists mobile_e164 text;
alter table public.customers add column if not exists email_valid boolean;
alter table public.customers add column if not exists contact_profile text
  check (contact_profile is null or contact_profile in ('mobile','email_only','both','none'));

create index if not exists idx_customers_company_contact_profile
  on public.customers (company_id, contact_profile);
create index if not exists idx_customers_company_mobile_e164
  on public.customers (company_id, mobile_e164);

-- ---------- normalização E.164 (espelho fiel de toE164Mobile) ----------
create or replace function public.altea_to_e164_mobile(phone_raw text)
returns text
language plpgsql
immutable
as $$
declare
  d text;
  ddd int;
begin
  d := regexp_replace(coalesce(phone_raw, ''), '\D', '', 'g');
  -- remove prefixo país (+55 / 55) quando 12 ou 13 dígitos
  if left(d, 2) = '55' and (length(d) = 12 or length(d) = 13) then
    d := substr(d, 3);
  end if;
  -- fixo-celular antigo: 10 dígitos com 3º dígito 6-9 ganha o 9
  if length(d) = 10 and substr(d, 3, 1) in ('6','7','8','9') then
    d := substr(d, 1, 2) || '9' || substr(d, 3);
  end if;
  if length(d) <> 11 or substr(d, 3, 1) <> '9' then
    return null;
  end if;
  ddd := substr(d, 1, 2)::int;
  if ddd < 11 or ddd > 99 then
    return null;
  end if;
  return '+55' || d;
end;
$$;

-- ---------- e-mail válido (regex conservador + placeholders/interno) ----------
create or replace function public.altea_is_email_valid(email_raw text)
returns boolean
language plpgsql
immutable
as $$
declare
  e text;
begin
  e := lower(btrim(coalesce(email_raw, '')));
  if e = '' then return false; end if;
  -- placeholders conhecidos do cedente (naotem*, sememail, sem@, etc.)
  if e ~ '^naotem' or e ~ '^sememail' or e ~ '^sem@' or e ~ '^nao@' then
    return false;
  end if;
  -- domínio interno do cedente / placeholders de importação
  if e ~ '@(vmax|alteapay|placeholder|example|invalid|local|localhost)\.' then
    return false;
  end if;
  if e like '%@vmax' or e like '%@alteapay' then
    return false;
  end if;
  -- regex conservador: local@dominio.tld
  return e ~ '^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$';
end;
$$;

-- ---------- derivação do perfil ----------
create or replace function public.altea_derive_contact_profile(has_mobile boolean, has_email boolean)
returns text
language sql
immutable
as $$
  select case
    when has_mobile and has_email then 'both'
    when has_mobile then 'mobile'
    when has_email then 'email_only'
    else 'none'
  end;
$$;

-- ---------- trigger: recomputa a própria linha em INSERT/UPDATE ----------
-- Só considera customers.phone/email (o fallback VMAX é tratado no lote).
create or replace function public.customers_contact_profile_trigger()
returns trigger
language plpgsql
as $$
declare
  m text;
  ev boolean;
begin
  m := public.altea_to_e164_mobile(new.phone);
  ev := public.altea_is_email_valid(new.email);
  new.mobile_e164 := m;
  new.email_valid := ev;
  new.contact_profile := public.altea_derive_contact_profile(m is not null, ev);
  return new;
end;
$$;

drop trigger if exists trg_customers_contact_profile on public.customers;
create trigger trg_customers_contact_profile
  before insert or update of phone, email on public.customers
  for each row execute function public.customers_contact_profile_trigger();

-- ---------- recompute em lote (idempotente, com fallback VMAX) ----------
-- Recalcula contact_profile de todas as linhas da empresa. O fallback usa
-- VMAX."Telefone 1"/"Telefone 2" (isolamento por id_company) casando por
-- documento normalizado quando customers.phone não gera celular válido.
-- Retorna a contagem de linhas afetadas. Não loga PII.
create or replace function public.recompute_contact_profile(p_company_id uuid)
returns integer
language plpgsql
as $$
declare
  n integer;
begin
  with vmax_norm as (
    select
      regexp_replace(coalesce(v."CPF/CNPJ", ''), '\D', '', 'g') as doc,
      coalesce(
        public.altea_to_e164_mobile(v."Telefone 1"),
        public.altea_to_e164_mobile(v."Telefone 2")
      ) as vmax_mobile
    from public."VMAX" v
    where v.id_company = p_company_id
  ),
  computed as (
    select
      c.id,
      coalesce(
        public.altea_to_e164_mobile(c.phone),
        (
          select vn.vmax_mobile from vmax_norm vn
          where vn.doc = regexp_replace(coalesce(c.document, ''), '\D', '', 'g')
            and vn.vmax_mobile is not null
          limit 1
        )
      ) as m,
      public.altea_is_email_valid(c.email) as ev
    from public.customers c
    where c.company_id = p_company_id
  )
  update public.customers c
  set
    mobile_e164 = comp.m,
    email_valid = comp.ev,
    contact_profile = public.altea_derive_contact_profile(comp.m is not null, comp.ev)
  from computed comp
  where c.id = comp.id
    and (
      c.mobile_e164 is distinct from comp.m
      or c.email_valid is distinct from comp.ev
      or c.contact_profile is distinct from public.altea_derive_contact_profile(comp.m is not null, comp.ev)
    );
  get diagnostics n = row_count;
  return n;
end;
$$;

-- ============================================================
-- 2. tenant_chat_config: link público único + modos de envio/dispatch + Voxuy
-- ============================================================
-- public_link_*: link único opaco por cedente (Hub §7). Não revela o nome.
alter table public.tenant_chat_config add column if not exists public_link_code text;
alter table public.tenant_chat_config add column if not exists public_link_enabled boolean not null default false;
alter table public.tenant_chat_config add column if not exists public_link_valid_until timestamptz;

-- modo de envio da negociação (canal do resultado da negociação)
alter table public.tenant_chat_config add column if not exists negotiation_send_mode text not null default 'whatsapp_chat';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tenant_chat_config_negotiation_send_mode_check') then
    alter table public.tenant_chat_config
      add constraint tenant_chat_config_negotiation_send_mode_check
      check (negotiation_send_mode in ('whatsapp_chat','charge_email','both')) not valid;
    alter table public.tenant_chat_config validate constraint tenant_chat_config_negotiation_send_mode_check;
  end if;
end $$;

-- modo de DISPATCH do WhatsApp. whatsapp_provider (20260916, 'mock' por default)
-- JÁ EXISTE e classifica QUAL provider ('voxuy'|'mock'); whatsapp_dispatch_mode é
-- ORTOGONAL e diz COMO despachar ('voxuy_api' = chama a API real | 'mock' = stub).
-- Reconciliação: default 'mock' alinhado ao whatsapp_provider default 'mock';
-- ninguém sobrescreve o outro.
alter table public.tenant_chat_config add column if not exists whatsapp_dispatch_mode text not null default 'mock';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tenant_chat_config_whatsapp_dispatch_mode_check') then
    alter table public.tenant_chat_config
      add constraint tenant_chat_config_whatsapp_dispatch_mode_check
      check (whatsapp_dispatch_mode in ('voxuy_api','mock')) not valid;
    alter table public.tenant_chat_config validate constraint tenant_chat_config_whatsapp_dispatch_mode_check;
  end if;
end $$;

-- Voxuy: request/payload configuráveis por tenant. voxuy_plan_id e voxuy_events
-- JÁ EXISTEM (20260916 / 20260917) — guardados com IF NOT EXISTS para idempotência.
-- NOTA: voxuy_plan_id/voxuy_events são conceitos do produto ANTIGO (contrato
-- /webhooks/voxuy/transaction). O Voxuy ENTERPRISE usa `flowId` (inteiro) → coluna
-- voxuy_flow_id abaixo é a que vale para o disparo por API (dialeto enterprise_v1).
alter table public.tenant_chat_config add column if not exists voxuy_request_config jsonb;
alter table public.tenant_chat_config add column if not exists voxuy_payload_template jsonb;
alter table public.tenant_chat_config add column if not exists voxuy_plan_id text;
alter table public.tenant_chat_config add column if not exists voxuy_events jsonb;
alter table public.tenant_chat_config add column if not exists voxuy_flow_id integer;

-- Unicidade do link opaco quando presente (índice único parcial).
create unique index if not exists idx_tenant_chat_config_public_link_code
  on public.tenant_chat_config (public_link_code) where public_link_code is not null;

-- ============================================================
-- 3. negotiation_sessions: dono do engine (plataforma vs n8n)
-- ============================================================
alter table public.negotiation_sessions add column if not exists engine_owner text not null default 'platform';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'negotiation_sessions_engine_owner_check') then
    alter table public.negotiation_sessions
      add constraint negotiation_sessions_engine_owner_check
      check (engine_owner in ('platform','n8n')) not valid;
    alter table public.negotiation_sessions validate constraint negotiation_sessions_engine_owner_check;
  end if;
end $$;

-- ============================================================
-- 3b. whatsapp_messages: canal multi-canal do hub (WhatsApp | e-mail).
-- Resolve o request T2-2 (o disparo por e-mail do hub grava `channel`).
-- Aditiva; o valor default reflete o comportamento legado (só WhatsApp).
-- ============================================================
alter table public.whatsapp_messages add column if not exists channel text not null default 'whatsapp';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'whatsapp_messages_channel_check') then
    alter table public.whatsapp_messages
      add constraint whatsapp_messages_channel_check
      check (channel in ('whatsapp','email')) not valid;
    alter table public.whatsapp_messages validate constraint whatsapp_messages_channel_check;
  end if;
end $$;

-- ============================================================
-- 4. negotiation_state (NOVO): projeção de status por (company_id, customer_id)
--    Alimentada por lib/journey/negotiation-state.ts (incremental + rebuild).
-- ============================================================
create table if not exists public.negotiation_state (
  company_id uuid not null references public.companies(id),
  customer_id uuid not null references public.customers(id),
  stage text not null default 'not_started',
  stage_rank int not null default 0,
  stage_at timestamptz,
  marks jsonb not null default '{}'::jsonb,
  channel text,
  campaign_id uuid references public.whatsapp_campaigns(id),
  session_id uuid references public.negotiation_sessions(id),
  agreement_id uuid references public.agreements(id),
  has_live_charge boolean not null default false,
  provider_status_source text not null default 'none',
  updated_at timestamptz not null default now(),
  primary key (company_id, customer_id)
);
create index if not exists idx_neg_state_company_stage
  on public.negotiation_state (company_id, stage);
create index if not exists idx_neg_state_company_rank
  on public.negotiation_state (company_id, stage_rank desc);
create index if not exists idx_neg_state_company_updated
  on public.negotiation_state (company_id, updated_at desc);
create index if not exists idx_neg_state_campaign
  on public.negotiation_state (campaign_id);

-- ============================================================
-- 5. RLS (padrão do repo)
--    negotiation_state carrega estágio de negociação por devedor — leitura por
--    usuários da empresa / super_admin (mesmo padrão de journey_events).
-- ============================================================
alter table public.negotiation_state enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'negotiation_state' and policyname = 'service_role_all') then
    create policy service_role_all on public.negotiation_state for all to service_role using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'negotiation_state' and policyname = 'company_select') then
    create policy company_select on public.negotiation_state for select to authenticated using (
      company_id in (select p.company_id from public.profiles p where p.id = auth.uid())
      or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'super_admin'));
  end if;
end $$;

-- ============================================================
-- 6. SEED (separado; só PRODUZIDO, não aplicado por este dev) — link opaco do VMAX
--    public_link_code OPACO de 10 chars alfanuméricos, SEM o nome da empresa.
--    Idempotente: só grava se ainda não houver code. Não habilita o link
--    (public_link_enabled fica no default false; ligar é decisão de operação).
-- ============================================================
update public.tenant_chat_config
set public_link_code = 'k7Qm3Xb9Rt'
where company_id = '1f7729ee-a537-43fc-a27f-5747c177988d'
  and (public_link_code is null or public_link_code = '');
