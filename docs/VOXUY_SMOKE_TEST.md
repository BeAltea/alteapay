# Voxuy — roteiro do smoke test real (V8 / GATE GV1)

**Quando:** só depois de `VOXUY_ACCOUNT_SETUP.md` concluído pela operação e das
credenciais no ECS/Netlify. **Nunca** contra cliente real antes do gate GV1 do Fabio.

**Trilho:** um único número interno da Altea. `WHATSAPP_PROVIDER=voxuy` **só** no
tenant de teste ("Altea - Testes"), `mock` em todos os demais.

## Pré-requisitos
- [ ] Conta Voxuy pronta (produto, categoria, eventos `approach`/`stop`, funil, plano, token, URL).
- [ ] Envs no ECS: `VOXUY_WEBHOOK_URL`, `VOXUY_API_TOKEN`, `VOXUY_TIMEOUT_MS`, `WHATSAPP_RATE_LIMIT_PER_SEC`.
- [ ] Env no Netlify: `VOXUY_INBOUND_SECRET`.
- [ ] Tenant de teste com `whatsapp_provider='voxuy'`, `voxuy_plan_id`, `voxuy_events` (`approach`,`stop`).
- [ ] Worker Fargate **reconstruído** com a imagem desta onda (não a de março).

## Passos

1. **Envio (1 mensagem).** Criar campanha de 1 destinatário (o número interno) no
   painel `super-admin/negociacao-ia/campanhas`. Iniciar.
   - Esperado: resposta `200 {"Success": true}`, `whatsapp_messages.status='accepted'`,
     `provider_transaction_id = whatsapp_messages.id` salvo.
2. **No celular:** a mensagem chegou **sem valor e sem dado da dívida**? O link abre a
   **tela de escolha** com a marca certa? A variável de `metadata` foi substituída (não
   apareceu literal `{{...}}`)?
3. **Consultar.** Clicar **Consultar atualização** → `link.clicked` registrado →
   autenticação por CPF → chat abre (engine `disabled`, menu da matriz) → oferta →
   aceite → PIX de valor baixo → pagamento → webhook ASAAS → sessão encerrada →
   supressão criada → **`sendStopSignal` disparado**. Confirmar no celular que o **funil parou**.
4. **Cancelar inscrição (segundo número).** Repetir e clicar **Cancelar inscrição** →
   supressão + stop → nova campanha **exclui** o número.
5. **Bloquear (opcional).** Clicar **Bloquear número** → supressão de telefone (`all`) +
   stop → nova campanha exclui o número.
6. **Relatório Voxuy.** Verificar que os eventos aparecem e que `metadata` **não** contém
   PII (sem CPF, sem valor, sem e-mail).
7. **Captura inbound.** Se a Voxuy tiver webhook de saída, registrar a URL
   `/api/webhooks/whatsapp/voxuy?s=<VOXUY_INBOUND_SECRET>` (ou header). Conferir
   `whatsapp_provider_events` sem `processed=false` inesperado.

## Evidências (sem número completo)
- Prints do celular mascarando o telefone.
- Linha do `whatsapp_messages` (status, provider_transaction_id, provider_trace_id se houve 400).
- Eventos de jornada (`link.clicked`, `auth.success`, `agreement.created`, `contact.stopped`).
- `reports/V8_smoke_voxuy.md`.

## GATE GV1
Fabio aprova antes de qualquer campanha com cliente real. Depois do gate, voltar
`WHATSAPP_PROVIDER` do tenant de teste para `mock` (ou manter conforme decisão).

## Erros comuns
- `401/403`: token/URL errados → a campanha é **pausada** (por desenho). Corrigir env e retomar.
- `400` com `traceId`: campo inválido → checar `provider_trace_id` e o relatório Voxuy.
- Mensagem não chega: confirmar no **Chat do atendente** que o produto **e** o evento
  API/Customizado estão marcados (sem isso a Voxuy não envia — ver `VOXUY_ACCOUNT_SETUP.md` passo 6).
