-- Gerenciamento de E-mails — CRUD de templates com versionamento (Frente F3).
--
-- 100% ADITIVA e IDEMPOTENTE: só CREATE TABLE/INDEX IF NOT EXISTS, ALTER ... ADD
-- COLUMN IF NOT EXISTS e RLS (drop+create das policies deste arquivo). Nada
-- remove/renomeia dados existentes.
--
-- ⚠️ NÃO aplicar em produção nesta onda. O orquestrador aplica com backup após a
-- revisão (mesmo padrão de 20260924_session_reuse.sql / 20260918_chat_n8n_prep.sql).
--
-- Modelo:
--   email_templates          → 1 template (metadados: nome, escopo, propósito, status).
--   email_template_versions  → N versões imutáveis por template (append-only).
--   email_template_defaults  → 1 template padrão por (cedente, propósito).
--   + colunas de referência em whatsapp_messages (a tabela real de mensagens de
--     campanha; o prompt cita "campaign_messages", que não existe neste schema —
--     a mensagem de campanha vive em public.whatsapp_messages).
--
-- RLS (§2): templates GLOBAIS (company_id IS NULL) são VISÍVEIS a todos os
-- authenticated; templates de cedente só à própria empresa ou ao super_admin.
-- ESCRITA por authenticated é restrita a super_admin (globais e de cedente);
-- os workers/BFF continuam escrevendo via service_role.

-- ============================================================
-- 1. Templates (metadados)
-- ============================================================
create table if not exists public.email_templates (
  id uuid primary key default gen_random_uuid(),
  -- null = GLOBAL (visível a todos; editável só super_admin).
  company_id uuid references public.companies(id),
  name text not null,
  purpose text not null default 'communication'
    check (purpose in ('negotiation','communication')),
  status text not null default 'draft'
    check (status in ('draft','active','archived')),
  -- versão corrente resolvida (FK adicionada depois de criar email_template_versions).
  current_version_id uuid,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Nome único por escopo. Índices parciais cobrem os dois casos (global x cedente),
-- porque UNIQUE(company_id, name) trataria cada NULL como distinto (não bloquearia
-- dois globais com o mesmo nome).
create unique index if not exists uq_email_templates_company_name
  on public.email_templates (company_id, name)
  where company_id is not null;
create unique index if not exists uq_email_templates_global_name
  on public.email_templates (name)
  where company_id is null;

create index if not exists idx_email_templates_company_status
  on public.email_templates (company_id, status);
create index if not exists idx_email_templates_purpose
  on public.email_templates (purpose, status);

-- ============================================================
-- 2. Versões (append-only, imutáveis)
-- ============================================================
create table if not exists public.email_template_versions (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.email_templates(id) on delete cascade,
  version int not null,
  subject text not null,
  preheader text,
  html text not null,
  text_fallback text,
  variables_used text[] not null default '{}',
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  constraint uq_email_template_versions_version unique (template_id, version)
);
create index if not exists idx_email_template_versions_template
  on public.email_template_versions (template_id, version desc);

-- FK de current_version_id → versions (agora que a tabela existe). Idempotente.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'fk_email_templates_current_version'
  ) then
    alter table public.email_templates
      add constraint fk_email_templates_current_version
      foreign key (current_version_id)
      references public.email_template_versions(id)
      on delete set null;
  end if;
end $$;

-- ============================================================
-- 3. Padrão por (cedente, propósito) — 1 padrão por cedente+propósito
-- ============================================================
create table if not exists public.email_template_defaults (
  company_id uuid not null references public.companies(id),
  template_id uuid not null references public.email_templates(id) on delete cascade,
  purpose text not null check (purpose in ('negotiation','communication')),
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(),
  primary key (company_id, purpose)
);
create index if not exists idx_email_template_defaults_template
  on public.email_template_defaults (template_id);

-- ============================================================
-- 4. Referência da mensagem de campanha ao template usado (aditivo)
--    (o prompt fala de "campaign_messages"; a tabela real é whatsapp_messages)
-- ============================================================
alter table public.whatsapp_messages
  add column if not exists email_template_id uuid references public.email_templates(id);
alter table public.whatsapp_messages
  add column if not exists email_template_version_id uuid references public.email_template_versions(id);

-- ============================================================
-- 5. RLS
-- ============================================================
alter table public.email_templates enable row level security;
alter table public.email_template_versions enable row level security;
alter table public.email_template_defaults enable row level security;

-- service_role: escrita/leitura total (workers/BFF).
drop policy if exists service_role_all on public.email_templates;
create policy service_role_all on public.email_templates
  for all to service_role using (true) with check (true);
drop policy if exists service_role_all on public.email_template_versions;
create policy service_role_all on public.email_template_versions
  for all to service_role using (true) with check (true);
drop policy if exists service_role_all on public.email_template_defaults;
create policy service_role_all on public.email_template_defaults
  for all to service_role using (true) with check (true);

-- SELECT (authenticated): globais p/ todos; de cedente p/ a empresa ou super_admin.
drop policy if exists company_select on public.email_templates;
create policy company_select on public.email_templates
  for select to authenticated using (
    company_id is null
    or company_id in (select p.company_id from public.profiles p where p.id = auth.uid())
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'super_admin')
  );

drop policy if exists version_select on public.email_template_versions;
create policy version_select on public.email_template_versions
  for select to authenticated using (
    exists (
      select 1 from public.email_templates t
      where t.id = email_template_versions.template_id
        and (
          t.company_id is null
          or t.company_id in (select p.company_id from public.profiles p where p.id = auth.uid())
          or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'super_admin')
        )
    )
  );

drop policy if exists default_select on public.email_template_defaults;
create policy default_select on public.email_template_defaults
  for select to authenticated using (
    company_id in (select p.company_id from public.profiles p where p.id = auth.uid())
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'super_admin')
  );

-- WRITE (authenticated): SOMENTE super_admin (globais e de cedente). Os workers
-- seguem via service_role. Admin/user comuns NÃO editam templates por RLS.
drop policy if exists super_admin_write on public.email_templates;
create policy super_admin_write on public.email_templates
  for all to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'super_admin'))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'super_admin'));

drop policy if exists super_admin_write on public.email_template_versions;
create policy super_admin_write on public.email_template_versions
  for all to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'super_admin'))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'super_admin'));

drop policy if exists super_admin_write on public.email_template_defaults;
create policy super_admin_write on public.email_template_defaults
  for all to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'super_admin'))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'super_admin'));

-- ============================================================
-- 6. Seed OPCIONAL: template inicial de negociação do VMAX (Apêndice A).
--    SEM valor/dado do débito — só variáveis da allowlist. Idempotente por nome
--    global. Cria o template + a versão 1 + aponta current_version_id.
-- ============================================================
do $$
declare
  v_template_id uuid;
  v_version_id uuid;
begin
  -- só cria se ainda não existir um global com este nome.
  if not exists (
    select 1 from public.email_templates where company_id is null and name = 'Negociação — Convite (padrão)'
  ) then
    insert into public.email_templates (company_id, name, purpose, status, created_by)
    values (null, 'Negociação — Convite (padrão)', 'negotiation', 'active', null)
    returning id into v_template_id;

    insert into public.email_template_versions
      (template_id, version, subject, preheader, html, text_fallback, variables_used, created_by)
    values (
      v_template_id,
      1,
      'Olá {{primeiro_nome}}, temos uma condição especial para você',
      'Resolva sua pendência com a {{credor}} de forma simples e segura.',
      '<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;margin:0;padding:0;background:#f5f5f5}.wrap{max-width:600px;margin:0 auto;background:#ffffff}.pad{padding:32px}.btn{display:inline-block;background:#c8a94b;color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:6px;font-weight:bold}.muted{color:#888888;font-size:12px}</style></head>'
        || '<body><div class="wrap"><div class="pad">'
        || '<p>Olá, <strong>{{primeiro_nome}}</strong>!</p>'
        || '<p>Identificamos uma pendência em seu nome com a <strong>{{credor}}</strong> e preparamos uma condição especial para você regularizar de forma rápida, simples e segura.</p>'
        || '<p style="text-align:center;margin:28px 0"><a class="btn" href="{{link_negociacao}}" target="_blank">Negociar agora</a></p>'
        || '<p>O atendimento é 100% online e sigiloso. Se precisar de ajuda, fale com a gente em {{contato_suporte}}.</p>'
        || '<hr>'
        || '<p class="muted">Você recebeu este e-mail porque consta uma pendência em seu nome. Para não receber mais comunicações, <a href="{{link_descadastro}}">clique aqui para se descadastrar</a>.<br>{{marca}} — {{ano}}.</p>'
        || '</div></div></body></html>',
      'Olá, {{primeiro_nome}}! Identificamos uma pendência em seu nome com a {{credor}} e preparamos uma condição especial. Negocie agora: {{link_negociacao}} — Suporte: {{contato_suporte}}. Para se descadastrar: {{link_descadastro}}. {{marca}} — {{ano}}.',
      array['primeiro_nome','credor','link_negociacao','contato_suporte','link_descadastro','marca','ano'],
      null
    )
    returning id into v_version_id;

    update public.email_templates
      set current_version_id = v_version_id
      where id = v_template_id;
  end if;
end $$;
