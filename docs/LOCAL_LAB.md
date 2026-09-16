# Laboratório local (a partir de `altea-pay`)

O ambiente de ensaio roda no cluster OrbStack local **a partir desta base** (a antiga
`alteapay-v2` foi consolidada aqui e arquivada em `_archive/alteapay-v2`).

## Subir

```bash
orb start                                   # OrbStack (k8s + docker)
supabase start                              # stack local (config em supabase/config.toml)

# imagem única (web + workers)
docker build -t alteapay/app:local \
  --build-arg NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 \
  --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon-local> .

kubectl apply -k k8s/base
./scripts/bootstrap-k8s-secrets.sh          # gera/preserva secrets locais
```

- Web: `Service LoadBalancer` (IP externo do OrbStack) ou
  `kubectl -n alteapay-app port-forward svc/alteapay-web 3000:3000`.
- Health: `/api/health` (liveness) e `/api/ready` (readiness, consulta o banco).
- Workers: mesma imagem, `npx tsx lib/queue/start-workers.ts`, health `:3001/health`.

## Seed (read-only da produção)

O schema-base local vem de dump da produção (nunca o contrário):

```bash
pg_dump "$POSTGRES_URL_NON_POOLING" --schema=public --no-owner --no-privileges -Fc -f /tmp/prod.dump
pg_restore -d postgresql://postgres:postgres@127.0.0.1:54322/postgres --no-owner /tmp/prod.dump
# depois aplique as migrations mais novas que ainda não estão no dump
```

## Regras de segurança do laboratório

- `MOCK_ALL_INTEGRATIONS=1` **sempre** no cluster local — ASAAS, SendGrid, Twilio,
  Assertiva, WhatsApp (e Voxuy/n8n, ver `lib/integrations/mock-mode.ts`) são mockados
  na borda HTTP; nenhuma chamada externa real.
- `k8s/base` inclui NetworkPolicy default-deny com egress apenas para CIDRs privados —
  internet pública bloqueada estruturalmente.
- Chaves reais ficam vazias nos secrets locais.

## Avisos operacionais

- `kubectl apply -k k8s/base` **regenera** `N8N_WEBHOOK_SECRET` (o bootstrap preserva
  quando possível; fluxos n8n externos precisam re-sincronizar o valor).
- A API do k8s do OrbStack fica intermitente logo após `orb start` — use retry.
- Agentes LangGraph (rig de treino) são OPCIONAIS e vivem em `../alteapay-agents`
  (`kubectl apply -k deploy/k8s/roadmap-v1`) — nunca em produção; o engine `agent`
  só funciona com `AGENT_URL`/`AGENT_APP_TOKEN` definidos.
