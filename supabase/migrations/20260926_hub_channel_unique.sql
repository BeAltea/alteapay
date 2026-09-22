-- ============================================================
-- F1 (E4) — idempotência do hub POR CANAL.
--
-- Antes: UNIQUE(campaign_id, customer_id) — um único registro por devedor numa
-- campanha (modelo single-canal, precedência WhatsApp→e-mail).
-- Agora: com a seleção de CANAL, um devedor que tem os dois contatos recebe por
-- WhatsApp E por e-mail — logo, 1 registro por (campaign_id, customer_id, channel).
--
-- Esta migration troca a UNIQUE antiga pela nova, incluindo o `channel`. A coluna
-- `channel` já existe (20260922_hub_link_status, default 'whatsapp'), então os
-- registros legados (só WhatsApp) continuam únicos sob a nova chave.
--
-- Idempotente e segura para reexecução. NÃO altera dados; só a constraint.
-- ============================================================

do $$
begin
  -- 1) remove a UNIQUE antiga (campaign_id, customer_id), se ainda existir.
  if exists (
    select 1 from pg_constraint
    where conname = 'whatsapp_messages_campaign_customer_unique'
  ) then
    alter table public.whatsapp_messages
      drop constraint whatsapp_messages_campaign_customer_unique;
  end if;

  -- 2) cria a UNIQUE nova (campaign_id, customer_id, channel), se ainda não existir.
  if not exists (
    select 1 from pg_constraint
    where conname = 'whatsapp_messages_campaign_customer_channel_unique'
  ) then
    alter table public.whatsapp_messages
      add constraint whatsapp_messages_campaign_customer_channel_unique
      unique (campaign_id, customer_id, channel);
  end if;
end $$;
