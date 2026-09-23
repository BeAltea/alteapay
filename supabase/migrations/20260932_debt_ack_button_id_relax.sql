-- Relaxa o CHECK de debt_acknowledgements.button_id para aceitar o fluxo
-- Consultar/Negociar. 100% ADITIVA em efeito (só troca uma constraint por outra
-- mais permissiva; nenhum dado é alterado/removido) e IDEMPOTENTE.
--
-- CONTEXTO (bug corrigido): a tabela nasceu em 20260921_chat_prompts_ack.sql com
--   button_id int not null check (button_id in (0,1))
-- assumindo só o reconhecimento booleano legado (1=Sim, 0=Não). Mas o fluxo
-- Consultar/Negociar (buttons.ts) grava reconhecimento a partir dos botões de
-- LISTA 2=Consultar e 3=Negociar (persistDebtRecognition com button_id=3 no
-- "Negociar Dívida"). Como o supabase-js NÃO lança em violação de CHECK (retorna
-- {error} e o código antigo o ignorava), a linha de reconhecimento do Negociar
-- era DESCARTADA silenciosamente — debt_acknowledgement_latest nunca registrava
-- acknowledged=true e assertAcknowledgedForPayment bloqueava o pagamento depois.
--
-- FIX: a constraint passa a aceitar button_id in (0,1,2,3) — 0/1 booleano legado
-- + 2 (Consultar) / 3 (Negociar) do menu Consultar/Negociar. O SIGNIFICADO
-- (acknowledged true/false) continua na coluna booleana `acknowledged`, que é a
-- fonte da view; o button_id é só a rastreabilidade de QUAL botão originou o
-- registro. O código também passa a checar o {error} do insert (defesa em
-- profundidade), então uma futura violação nunca mais será silenciosa.
--
-- NÃO aplicar em produção por este arquivo: o orquestrador aplica com backup no
-- gate correspondente.

do $$
begin
  -- Remove o CHECK antigo (nome padrão do Postgres para o CHECK inline da coluna).
  -- IF EXISTS torna a migration segura para reexecutar e tolerante a bancos onde
  -- a tabela nasceu sem a constraint inline.
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.debt_acknowledgements'::regclass
      and conname = 'debt_acknowledgements_button_id_check'
  ) then
    alter table public.debt_acknowledgements
      drop constraint debt_acknowledgements_button_id_check;
  end if;

  -- (Re)cria o CHECK relaxado. NOT VALID não é necessário: os dados existentes
  -- (0/1) já satisfazem o novo predicado, então a validação é barata.
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.debt_acknowledgements'::regclass
      and conname = 'debt_acknowledgements_button_id_check'
  ) then
    alter table public.debt_acknowledgements
      add constraint debt_acknowledgements_button_id_check
      check (button_id in (0, 1, 2, 3));
  end if;
end $$;

comment on column public.debt_acknowledgements.button_id is
  'Botão que originou o registro de reconhecimento: 0=Não reconhece, 1=Sim '
  '(reconhecimento booleano legado), 2=Consultar Dívida, 3=Negociar Dívida '
  '(fluxo Consultar/Negociar). O SIGNIFICADO (reconhecido ou não) vive na coluna '
  'booleana `acknowledged`, que alimenta debt_acknowledgement_latest — button_id '
  'é só rastreabilidade da origem do clique.';
