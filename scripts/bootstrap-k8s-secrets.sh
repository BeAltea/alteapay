#!/usr/bin/env bash
# Restaura os valores REAIS de alteapay-app-secrets no cluster local.
#
# ATENÇÃO: `kubectl apply -k k8s/base/` inclui secret.template.yaml e SOBRESCREVE
# o secret com placeholders. Rode este script sempre depois de um apply -k.
#
# Fontes: Supabase local (supabase status) + token compartilhado do agente
# (platform-secrets no namespace alteapay-negotiation, se existir).

set -euo pipefail

eval "$(supabase status -o json 2>/dev/null | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(f'ANON={d[\"ANON_KEY\"]}')
print(f'SRK={d[\"SERVICE_ROLE_KEY\"]}')
print(f'JWT={d[\"JWT_SECRET\"]}')
")"

AGTOK=$(kubectl get secret platform-secrets -n alteapay-negotiation \
  -o jsonpath='{.data.ALTEAPAY_AGENT_TOKEN}' 2>/dev/null | base64 -d || true)
if [ "${#AGTOK}" -lt 32 ]; then
  echo "platform-secrets sem token válido — gerando novo token compartilhado"
  AGTOK=$(openssl rand -hex 32)
  kubectl patch secret platform-secrets -n alteapay-negotiation \
    -p "{\"stringData\":{\"ALTEAPAY_AGENT_TOKEN\":\"$AGTOK\"}}"
fi

# HMAC dos fluxos n8n (/api/webhooks/n8n) — preserva o valor em uso para não
# quebrar fluxos já configurados; gera um novo apenas na primeira vez.
N8NSEC=$(kubectl get secret alteapay-app-secrets -n alteapay-app \
  -o jsonpath='{.data.N8N_WEBHOOK_SECRET}' 2>/dev/null | base64 -d || true)
if [ "${#N8NSEC}" -lt 32 ] || [ "$N8NSEC" = "PLACEHOLDER" ]; then
  echo "gerando novo N8N_WEBHOOK_SECRET"
  N8NSEC=$(openssl rand -hex 32)
fi

kubectl patch secret alteapay-app-secrets -n alteapay-app -p "{\"stringData\":{
  \"NEXT_PUBLIC_SUPABASE_URL\":\"http://host.orb.internal:54321\",
  \"NEXT_PUBLIC_SUPABASE_ANON_KEY\":\"$ANON\",
  \"SUPABASE_SERVICE_ROLE_KEY\":\"$SRK\",
  \"SUPABASE_JWT_SECRET\":\"$JWT\",
  \"AGENT_APP_TOKEN\":\"$AGTOK\",
  \"CRON_SECRET\":\"local-dev-cron-secret\",
  \"ASAAS_WEBHOOK_TOKEN\":\"local-dev-webhook-token\",
  \"N8N_WEBHOOK_SECRET\":\"$N8NSEC\"
}}"

echo "Secrets restaurados. Reinicie os deployments:"
echo "  kubectl rollout restart deploy/alteapay-web deploy/alteapay-workers -n alteapay-app"
echo "  kubectl rollout restart deploy/negotiation-agent -n alteapay-negotiation"
