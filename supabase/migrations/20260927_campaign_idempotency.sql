-- A1 — idempotência de campanha do hub de envio (evita e-mail/WhatsApp duplicado
-- em double-click/retry, que criava DUAS campanhas — a UNIQUE por (campaign_id,…)
-- não cobria o caso cross-campanha). Aditiva e idempotente.
--
-- Aplicar em prod junto com o deploy da onda F1–F4. NÃO destrutiva.

alter table public.whatsapp_campaigns
  add column if not exists idempotency_key text;

-- UNIQUE parcial por cedente: dois inserts com a MESMA chave → o 2º falha (23505)
-- e o código recupera a campanha vencedora, em vez de duplicar. NULL não colide
-- (campanhas antigas / criadas sem chave seguem livres).
create unique index if not exists uq_whatsapp_campaigns_idempotency
  on public.whatsapp_campaigns (company_id, idempotency_key)
  where idempotency_key is not null;

notify pgrst, 'reload schema';
