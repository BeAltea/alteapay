-- Lote vmax-2026-09-02 — tabelas aditivas de rastreio (decisão 10 do G1).
-- Nada aqui altera dados ou tabelas existentes.

-- Auditoria append-only de toda escrita do lote (campo a campo, antigo → novo)
create table if not exists vmax_import_audit (
  id bigint generated always as identity primary key,
  lote text not null,
  tabela text not null,
  registro_id text not null,
  doc_mascarado text,
  campo text not null,
  valor_antigo text,
  valor_novo text,
  regra text,
  created_at timestamptz not null default now()
);
create index if not exists idx_vmax_import_audit_lote on vmax_import_audit (lote);
create index if not exists idx_vmax_import_audit_registro on vmax_import_audit (tabela, registro_id);

-- Faturas individuais do lote (a VMAX é por cliente; aqui fica a granularidade
-- por fatura — chave natural para lotes futuros e para as decisões 4 e 13)
create table if not exists vmax_invoices (
  id uuid primary key default gen_random_uuid(),
  id_company uuid not null references companies(id),
  doc text not null,
  fatura text not null unique,
  saldo numeric(10,2) not null check (saldo > 0),
  vencimento date not null,
  unidade text,
  segmento text,
  banco_emissor text,
  situacao text,
  suspeita_dup boolean not null default false,
  lote text not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_vmax_invoices_doc on vmax_invoices (id_company, doc);
create index if not exists idx_vmax_invoices_lote on vmax_invoices (lote);

-- Tabelas novas ficam invisíveis para anon/authenticated (service_role bypassa RLS)
alter table vmax_import_audit enable row level security;
alter table vmax_invoices enable row level security;

-- Trava contra duplicidade futura de cliente na VMAX (aprovado no G2 em 2026-09-02).
-- Hoje há 0 duplicados; o índice impede que um lote futuro crie o segundo.
create unique index if not exists uq_vmax_doc_company
  on "VMAX" (regexp_replace("CPF/CNPJ", '\D', '', 'g'), id_company);
