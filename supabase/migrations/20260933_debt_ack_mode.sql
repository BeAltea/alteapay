-- Onda "3 opções" — trilha D1 (§6.1/§6.2/M4). Migrations M-1 e M-2 (aditivas).
--
-- M-1: debt_acknowledgements.mode — distingue o reconhecimento IMPLÍCITO (clique
--      em Pagar/Negociar no menu de 3 opções, mode='implicit') do reconhecimento
--      EXPLÍCITO legado ("Sim, reconheço", mode='explicit'). Hoje o append-log só
--      tem `source` (texto livre) e `button_id` — o M4 pede um marcador estável e
--      auditável do modo. DEFAULT 'explicit' preserva o significado das linhas já
--      existentes (todas nasceram do "Sim/Não" ou do fluxo Consultar/Negociar).
--
-- M-2: debt_acknowledgements.button_id — o CHECK relaxado (0,1,2,3) da migration
--      20260932 não inclui o id do botão PAGAR (=4, decisão G1). Sem estender o
--      CHECK, o reconhecimento implícito ao clicar PAGAR (persistDebtRecognition
--      com button_id=4) seria REJEITADO pelo Postgres — e como o supabase-js não
--      lança em violação de CHECK, a linha sumiria e o pagamento ficaria bloqueado
--      pelo guard. FIX: CHECK passa a aceitar (0,1,2,3,4). O SIGNIFICADO
--      (reconhecido ou não) segue na coluna booleana `acknowledged` — o button_id
--      é só rastreabilidade da origem do clique.
--
-- 100% ADITIVA e IDEMPOTENTE: ADD COLUMN IF NOT EXISTS + troca de um CHECK por
-- outro mais permissivo (os dados 0/1/2/3 existentes já satisfazem o novo
-- predicado). Nenhum dado é alterado/removido.
--
-- NÃO aplicar em produção por este arquivo: o orquestrador aplica com backup no
-- gate correspondente (G6).

-- ============================================================
-- M-1: coluna `mode` (implicit | explicit), default 'explicit'.
-- ============================================================
alter table public.debt_acknowledgements
  add column if not exists mode text not null default 'explicit';

do $$
begin
  -- CHECK do domínio de `mode`. Idempotente: só cria se ainda não existir.
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.debt_acknowledgements'::regclass
      and conname = 'debt_acknowledgements_mode_check'
  ) then
    alter table public.debt_acknowledgements
      add constraint debt_acknowledgements_mode_check
      check (mode in ('explicit','implicit'));
  end if;
end $$;

comment on column public.debt_acknowledgements.mode is
  'Modo do reconhecimento: explicit = "Sim, reconheço" clicado no prompt de '
  'reconhecimento; implicit = clique em Pagar/Negociar no menu de 3 opções (o '
  'devedor reconhece a dívida ao escolher pagar/negociar, sem um "Sim" explícito). '
  'Distingue a intenção declarada da inferida — o guard de pagamento aceita ambos.';

-- ============================================================
-- M-2: estende o CHECK de button_id para incluir PAGAR (=4).
--   0=Não reconhece, 1=Sim (booleano legado), 2=Consultar, 3=Negociar, 4=Pagar.
-- ============================================================
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.debt_acknowledgements'::regclass
      and conname = 'debt_acknowledgements_button_id_check'
  ) then
    alter table public.debt_acknowledgements
      drop constraint debt_acknowledgements_button_id_check;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.debt_acknowledgements'::regclass
      and conname = 'debt_acknowledgements_button_id_check'
  ) then
    alter table public.debt_acknowledgements
      add constraint debt_acknowledgements_button_id_check
      check (button_id in (0, 1, 2, 3, 4));
  end if;
end $$;

comment on column public.debt_acknowledgements.button_id is
  'Botão que originou o registro: 0=Não reconhece, 1=Sim (reconhecimento booleano '
  'legado), 2=Consultar Dívida, 3=Negociar Dívida, 4=Pagar (menu de 3 opções da '
  'onda "3 opções"). O SIGNIFICADO (reconhecido ou não) vive em `acknowledged` — '
  'button_id é rastreabilidade da origem; `mode` distingue implícito/explícito.';
