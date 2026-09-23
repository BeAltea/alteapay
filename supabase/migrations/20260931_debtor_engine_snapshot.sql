-- Frente B (onda D1) — normalização aditiva + snapshot por devedor p/ o
-- session.start. 100% ADITIVA e IDEMPOTENTE: só ADD COLUMN IF NOT EXISTS,
-- CREATE TABLE/INDEX/FUNCTION IF NOT EXISTS/OR REPLACE, DROP TRIGGER IF EXISTS +
-- CREATE, RLS. NADA reescreve coluna de origem, NADA vira NOT NULL em existente,
-- NADA aperta CHECK. Convenções do repo (mesmo padrão de 20260922_hub_link_status).
--
-- NÃO aplicar em produção nesta onda (G4 é gate) — o orquestrador aplica com
-- backup. O backfill do snapshot roda pelo script (scripts/ops/backfill-...).

-- pgcrypto para digest(...,'sha256') no document_hash (idempotente; no Supabase
-- a extensão vive em `extensions`, já no search_path do service role).
create extension if not exists pgcrypto;

-- ============================================================
-- 1. customers.name_display (NOVO): nome em Title Case (preposições minúsculas),
--    DERIVADO sem destruir o original (customers.name segue intacto). Trigger
--    recomputa em INSERT/UPDATE OF name; o backfill em lote fecha o histórico.
-- ============================================================
alter table public.customers add column if not exists name_display text;

-- ---------- Title Case pt-BR (preposições/artigos minúsculos) ----------
-- Espelha a regra de exibição: cada token vira Xxxx, EXCETO as preposições/
-- artigos comuns (de, da, do, das, dos, e, di, du) que ficam minúsculos, salvo
-- quando são o PRIMEIRO token. Não toca acentuação; usa initcap por token.
create or replace function public.altea_name_display(name_raw text)
returns text
language plpgsql
immutable
as $$
declare
  cleaned text;
  parts text[];
  out_parts text[] := '{}';
  tok text;
  low text;
  i int := 0;
  minusculas constant text[] := array['de','da','do','das','dos','e','di','du'];
begin
  cleaned := btrim(regexp_replace(coalesce(name_raw, ''), '\s+', ' ', 'g'));
  if cleaned = '' then
    return null;
  end if;
  parts := regexp_split_to_array(cleaned, ' ');
  foreach tok in array parts loop
    i := i + 1;
    low := lower(tok);
    if i > 1 and low = any (minusculas) then
      out_parts := out_parts || low;
    else
      -- initcap por token (primeira letra maiúscula, resto minúsculo)
      out_parts := out_parts || (upper(left(low, 1)) || substr(low, 2));
    end if;
  end loop;
  return array_to_string(out_parts, ' ');
end;
$$;

-- ---------- trigger: recomputa name_display na própria linha ----------
create or replace function public.customers_name_display_trigger()
returns trigger
language plpgsql
as $$
begin
  new.name_display := public.altea_name_display(new.name);
  return new;
end;
$$;

drop trigger if exists trg_customers_name_display on public.customers;
create trigger trg_customers_name_display
  before insert or update of name on public.customers
  for each row execute function public.customers_name_display_trigger();

-- ============================================================
-- 2. debtor_engine_snapshot (NOVO): 1 linha por devedor com o que o session.start
--    precisa. Mantida por trigger nos eventos que a afetam (customers/debts) +
--    backfill idempotente. open_amount_cents/oldest_original_due_date derivam da
--    MESMA função canônica do buildAckContext (soma debts.amount; vencimento de
--    vmax_invoices › debts.due_date). payload_ready = tem doc válido + nome + valor.
-- ============================================================
create table if not exists public.debtor_engine_snapshot (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  customer_id uuid not null references public.customers(id),
  document_digits text not null,
  document_masked text,
  document_hash text,
  name_display text,
  first_name text,
  open_amount_cents bigint not null default 0,
  oldest_original_due_date date,
  open_invoice_count int not null default 0,
  primary_debt_id uuid references public.debts(id),
  has_live_charge boolean not null default false,
  payload_ready boolean not null default false,
  refreshed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- Uma linha por (company_id, document_digits) — a chave de leitura do login.
create unique index if not exists uq_debtor_snapshot_company_doc
  on public.debtor_engine_snapshot (company_id, document_digits);
-- Índice de leitura do login: index scan por (company_id, document_digits) já é o
-- unique acima; este acelera filtros por prontidão (lote/qualidade).
create index if not exists idx_debtor_snapshot_company_ready
  on public.debtor_engine_snapshot (company_id, payload_ready);
-- Amarração ao customer (uma leitura reversa útil no recompute).
create index if not exists idx_debtor_snapshot_customer
  on public.debtor_engine_snapshot (customer_id);

-- ---------- máscara (espelho fiel de lib/journey/document.ts::maskDocument) ----------
-- CPF (11) → ***.456.789-**  ·  CNPJ (14) → **.456.789/****-**  ·  outro → ***.
create or replace function public.altea_mask_document(doc_raw text)
returns text
language plpgsql
immutable
as $$
declare
  d text;
begin
  d := regexp_replace(coalesce(doc_raw, ''), '\D', '', 'g');
  if length(d) = 11 then
    return '***.' || substr(d, 4, 3) || '.' || substr(d, 7, 3) || '-**';
  elsif length(d) = 14 then
    return '**.' || substr(d, 3, 3) || '.' || substr(d, 6, 3) || '/****-**';
  end if;
  return '***';
end;
$$;

-- ---------- recompute em lote (idempotente) do snapshot ----------
-- Recalcula/insere o snapshot de TODOS os clientes da empresa. Consolida as
-- dívidas ABERTAS (status pending|in_negotiation) — mesma definição do resolver —
-- e usa o vencimento ORIGINAL mais antigo (vmax_invoices › debts.due_date).
-- has_live_charge = existe agreement com payment_status pending|overdue nas dívidas.
-- Retorna a contagem de linhas escritas. NÃO loga PII.
create or replace function public.recompute_debtor_engine_snapshot(p_company_id uuid)
returns integer
language plpgsql
as $$
declare
  n integer;
begin
  with agg as (
    select
      c.id as customer_id,
      regexp_replace(coalesce(c.document, ''), '\D', '', 'g') as doc,
      c.name_display,
      -- primeiro nome do original (mesma regra do first_name do código)
      split_part(btrim(regexp_replace(coalesce(c.name, ''), '\s+', ' ', 'g')), ' ', 1) as first_name,
      coalesce(sum(d.amount) filter (
        where d.status in ('pending','in_negotiation')
      ), 0) as open_amount_reais,
      count(d.id) filter (
        where d.status in ('pending','in_negotiation')
      ) as open_debt_count,
      (array_agg(d.id order by d.due_date asc nulls last) filter (
        where d.status in ('pending','in_negotiation')
      ))[1] as primary_debt_id,
      min(d.due_date) filter (
        where d.status in ('pending','in_negotiation')
      ) as oldest_debt_due
    from public.customers c
    left join public.debts d
      on d.customer_id = c.id and d.company_id = c.company_id
    where c.company_id = p_company_id
    group by c.id, c.document, c.name_display, c.name
  ),
  inv as (
    -- vencimento ORIGINAL mais antigo por documento (vmax_invoices) + contagem.
    select
      regexp_replace(coalesce(vi.doc, ''), '\D', '', 'g') as doc,
      min(vi.vencimento) as oldest_invoice_due,
      count(*) as invoice_count
    from public.vmax_invoices vi
    where vi.id_company = p_company_id
    group by regexp_replace(coalesce(vi.doc, ''), '\D', '', 'g')
  ),
  computed as (
    select
      p_company_id as company_id,
      a.customer_id,
      a.doc as document_digits,
      public.altea_mask_document(a.doc) as document_masked,
      encode(digest(a.doc, 'sha256'), 'hex') as document_hash,
      a.name_display,
      a.first_name,
      round(a.open_amount_reais * 100)::bigint as open_amount_cents,
      coalesce(i.oldest_invoice_due, a.oldest_debt_due) as oldest_original_due_date,
      coalesce(i.invoice_count, a.open_debt_count)::int as open_invoice_count,
      a.primary_debt_id,
      exists (
        select 1 from public.agreements ag
        where ag.company_id = p_company_id
          and ag.customer_id = a.customer_id
          and ag.payment_status in ('pending','overdue')
      ) as has_live_charge,
      (length(a.doc) in (11,14)
       and coalesce(a.name_display, '') <> ''
       and round(a.open_amount_reais * 100)::bigint > 0) as payload_ready
    from agg a
    left join inv i on i.doc = a.doc
    where a.doc <> ''
  )
  insert into public.debtor_engine_snapshot as s (
    company_id, customer_id, document_digits, document_masked, document_hash,
    name_display, first_name, open_amount_cents, oldest_original_due_date,
    open_invoice_count, primary_debt_id, has_live_charge, payload_ready, refreshed_at
  )
  select
    company_id, customer_id, document_digits, document_masked, document_hash,
    name_display, first_name, open_amount_cents, oldest_original_due_date,
    open_invoice_count, primary_debt_id, has_live_charge, payload_ready, now()
  from computed
  on conflict (company_id, document_digits) do update set
    customer_id = excluded.customer_id,
    document_masked = excluded.document_masked,
    document_hash = excluded.document_hash,
    name_display = excluded.name_display,
    first_name = excluded.first_name,
    open_amount_cents = excluded.open_amount_cents,
    oldest_original_due_date = excluded.oldest_original_due_date,
    open_invoice_count = excluded.open_invoice_count,
    primary_debt_id = excluded.primary_debt_id,
    has_live_charge = excluded.has_live_charge,
    payload_ready = excluded.payload_ready,
    refreshed_at = now()
  where
    s.open_amount_cents is distinct from excluded.open_amount_cents
    or s.oldest_original_due_date is distinct from excluded.oldest_original_due_date
    or s.open_invoice_count is distinct from excluded.open_invoice_count
    or s.primary_debt_id is distinct from excluded.primary_debt_id
    or s.has_live_charge is distinct from excluded.has_live_charge
    or s.payload_ready is distinct from excluded.payload_ready
    or s.name_display is distinct from excluded.name_display
    or s.document_masked is distinct from excluded.document_masked;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- ============================================================
-- 3. RLS (padrão do repo): service_role escreve/lê tudo. O snapshot carrega
--    dado de dívida consolidado por devedor — o painel/login lê via service role,
--    então NÃO abrimos select para authenticated.
-- ============================================================
alter table public.debtor_engine_snapshot enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies where tablename = 'debtor_engine_snapshot' and policyname = 'service_role_all'
  ) then
    create policy service_role_all on public.debtor_engine_snapshot
      for all to service_role using (true) with check (true);
  end if;
end $$;

notify pgrst, 'reload schema';
