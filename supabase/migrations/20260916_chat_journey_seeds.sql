-- Seeds idempotentes da jornada (decisão C1 do G0 em ops/chatbot-journey-2026-09):
-- matriz VMAX por aging (5/15/25/35% à vista; parcelado até 3x com metade do
-- desconto, entrada 20%, parcela mínima R$30; validade 7d; mín. R$20; retry 10d x2)
-- + tenant_chat_config da VMAX e do tenant canário Altea-Test (já existente).

-- ---------- matriz VMAX ----------
insert into public.negotiation_condition_matrix
  (company_id, name, priority, active, aging_min_days, aging_max_days, aging_basis,
   max_discount_pct, installment_discount_pct, min_entry_pct, max_installments,
   min_installment_value, allowed_billing_types, proposal_validity_days,
   retry_after_days, max_retries, min_debt_value)
select v.* from (values
  ('1f7729ee-a537-43fc-a27f-5747c177988d'::uuid, 'VMAX 0-89 dias',    10, true,   0,  89,  'oldest_due',  5.00,  2.50, 20.00, 3, 30.00, array['PIX','BOLETO','CREDIT_CARD'], 7, 10, 2, 20.00),
  ('1f7729ee-a537-43fc-a27f-5747c177988d'::uuid, 'VMAX 90-180 dias',  10, true,  90, 180,  'oldest_due', 15.00,  7.50, 20.00, 3, 30.00, array['PIX','BOLETO','CREDIT_CARD'], 7, 10, 2, 20.00),
  ('1f7729ee-a537-43fc-a27f-5747c177988d'::uuid, 'VMAX 181-365 dias', 10, true, 181, 365,  'oldest_due', 25.00, 12.50, 20.00, 3, 30.00, array['PIX','BOLETO','CREDIT_CARD'], 7, 10, 2, 20.00),
  ('1f7729ee-a537-43fc-a27f-5747c177988d'::uuid, 'VMAX 366+ dias',    10, true, 366, null, 'oldest_due', 35.00, 17.50, 20.00, 3, 30.00, array['PIX','BOLETO','CREDIT_CARD'], 7, 10, 2, 20.00)
) as v(company_id, name, priority, active, aging_min_days, aging_max_days, aging_basis,
       max_discount_pct, installment_discount_pct, min_entry_pct, max_installments,
       min_installment_value, allowed_billing_types, proposal_validity_days,
       retry_after_days, max_retries, min_debt_value)
where not exists (
  select 1 from public.negotiation_condition_matrix m
  where m.company_id = v.company_id and m.name = v.name
);

-- ---------- matriz do tenant canário (valores baixos p/ teste) ----------
insert into public.negotiation_condition_matrix
  (company_id, name, priority, active, aging_min_days, aging_max_days, aging_basis,
   max_discount_pct, installment_discount_pct, min_entry_pct, max_installments,
   min_installment_value, allowed_billing_types, proposal_validity_days,
   retry_after_days, max_retries, min_debt_value)
select 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, 'Canario todas as faixas', 10, true,
       0, null, 'oldest_due', 10.00, 5.00, 20.00, 3, 5.00,
       array['PIX','BOLETO','CREDIT_CARD'], 7, 10, 2, 1.00
where not exists (
  select 1 from public.negotiation_condition_matrix m
  where m.company_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and m.name = 'Canario todas as faixas'
);

-- ---------- tenant_chat_config ----------
-- VMAX: jornada FECHADA ao público; branding com placeholders (assets pendentes C9)
insert into public.tenant_chat_config (company_id, fulfillment_mode, branding)
values ('1f7729ee-a537-43fc-a27f-5747c177988d', 'A',
        '{"brand_name":"VMAX","brand_primary_color":"#0A0F1E","brand_secondary_color":"#EAB308","placeholders":true}'::jsonb)
on conflict (company_id) do nothing;

update public.tenant_chat_config set
  journey_public_enabled = false,
  auth_require_birth_date = false,
  whatsapp_provider = 'mock',
  whatsapp_sender_label = 'AlteaPay, parceira oficial de cobrança da VMAX'
where company_id = '1f7729ee-a537-43fc-a27f-5747c177988d'
  and (whatsapp_sender_label is null or whatsapp_sender_label = '');

-- Canário Altea-Test
insert into public.tenant_chat_config (company_id, fulfillment_mode, branding)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'A',
        '{"brand_name":"Altea Testes","brand_primary_color":"#0A0F1E","brand_secondary_color":"#EAB308","placeholders":true}'::jsonb)
on conflict (company_id) do nothing;

update public.tenant_chat_config set
  journey_public_enabled = false,
  auth_require_birth_date = false,
  whatsapp_provider = 'mock',
  whatsapp_sender_label = 'AlteaPay (ambiente de teste)'
where company_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  and (whatsapp_sender_label is null or whatsapp_sender_label = '');
