# PROMPT - Integração WhatsApp via Voxuy (atualiza a onda da jornada)

**Para:** Claude Code (executor) · **Dono:** Fabio (aprova gates) · **Data:** 2026-09-17
**Sistema-alvo:** PRODUÇÃO `altea-pay` · **Branch:** a mesma da onda da jornada (`feature/chatbot-journey`)
**Fonte desta atualização:** documentação oficial da Voxuy, `https://manual.voxuy.com/configuracoes/integracoes/api-voxuy` (lida em 17/09/2026; conteúdo transcrito nos Apêndices A e C).

> **O que este documento faz:** substitui a parte "Voxuy" do prompt `claude/PROMPT_JORNADA_CHATBOT_2026-09-16.md` - especificamente o `VoxuyProvider` em **F3.1**, o contrato do **Apêndice A.3** e as perguntas **C.8** - por um contrato **real e verificado**. Todo o resto daquele prompt continua valendo sem alteração (fases, gates, tabelas, matriz de condições, chat, ASAAS, conciliação, jornada). Leia os dois juntos; onde houver conflito, **este vale**.

> **Leia antes de começar:** `CLAUDE.md` (decisões D1–D14), `claude/PROMPT_JORNADA_CHATBOT_2026-09-16.md` (a onda inteira), `claude/CHATBOT_N8N_BASELINE_2026-09-16.md`.

---

## 0. Modo de operação

Mesmas regras do prompt da jornada: fases sequenciais, **🛑 GATE** exige OK explícito do Fabio, artefatos em `ops/chatbot-journey-2026-09/reports/`, conventional commits sem referência a IA, TypeScript strict, **nada de PII em log/commit/URL**, produção intocada até o gate. Se algo na Voxuy não se comportar como a doc diz, **pare e registre** em `reports/incidentes.md`.

As fases aqui são **V0 → V9** e encaixam assim no prompt anterior: V0–V2 dentro de **F3.1**, V3 dentro de **F2** (migration adicional), V4 dentro de **F3/F4**, V5–V7 dentro de **F5**, V8 no **F8** (canário) e V9 no **F9** (handover).

---

## 1. O que a documentação oficial confirma

### 1.1 Natureza da integração (isto muda o desenho)

A API da Voxuy é **só de entrada**: nós fazemos `POST` de uma **transação** e a Voxuy **agenda um funil de mensagens** que foi cadastrado dentro dela. Ou seja:

- **A plataforma não controla o texto nem o horário das mensagens.** O funil (quantas mensagens, com que texto, em que intervalo) vive na Voxuy e é configurado na interface pela operação (Apêndice C). O que a plataforma controla é **quando disparar, para quem, e quais variáveis** vão para o texto.
- Cada disparo referencia um **evento** (`customEvent`) e um **plano** (`planId`) previamente criados na conta Voxuy. Dá para ter vários eventos (um funil por finalidade: abordagem, encerramento, 2ª via) e trocar de funil mudando `customEvent`.
- A doc é explícita: *"Esse tipo de integração não é feita pela Voxuy, por isso, indicamos que você tenha a ajuda de algum desenvolvedor."* Não há SDK: é um POST JSON.

### 1.2 Request

```
POST https://sistema.voxuy.com/api/<codigo>/webhooks/voxuy/transaction
Headers: Content-Type: application/json
```

O `<codigo>` **já vem embutido** na "URL para webhook" que a conta Voxuy fornece em Integrações → API VOXUY. Trate a URL inteira como um segredo de configuração (`VOXUY_WEBHOOK_URL`) e **não** monte a URL concatenando pedaços.

Autenticação: campo **`apiToken`** no corpo (não em header). Token em Integrações → API VOXUY → Token API (botão **Novo Token** se estiver vazio).

### 1.3 Campos - o que usamos e o que não usamos

Tabela oficial completa no Apêndice A.1. O que importa para a nossa jornada:

| Campo | Tipo | Uso na AlteaPay | Observação da doc |
|---|---|---|---|
| `apiToken` | String | `VOXUY_API_TOKEN` | Token da API |
| `id` | String | **`whatsapp_messages.id`** | *"identificador de uma venda/pedido/item para que seja adicionado ou atualizado"* → **reenviar o mesmo `id` atualiza, não duplica**. É a nossa idempotência de envio. Se vazio, a Voxuy gera um código |
| `planId` | String | `tenant_chat_config.voxuy_plan_id` | ID do plano (copiado em Produtos → plano → Copiar código do plano) |
| `customEvent` | Integer | evento do funil (por finalidade) | **ID do evento** (Inteiro). Ver §3 V4 |
| `clientPhoneNumber` | String | telefone E.164 | *"Telefone completo do cliente/lead, incluindo código do país. Exemplo: +5511912341234"* |
| `clientName` | String | **primeiro nome** do cliente | Usado como variável na mensagem |
| `clientEmail` | String | `null` | Não precisamos; menos PII na Voxuy |
| `clientDocument` | String | **`null`** | A doc aceita CPF/CNPJ, mas **não enviamos** (ver §3 V6) |
| `metadata` | Object | **link de consulta + marca** | *"Campos adicionais que queira usar futuramente como variáveis nas mensagens"*. **É por aqui que o link tokenizado chega na mensagem** |
| `dontCancelPrevious` | Boolean | ver §3 V3 | *"Como padrão, a Voxuy irá cancelar e remover do funil todas as mensagens anteriores ao entrar uma nova transação para o mesmo número"* |
| `agentEmail` | String | `null` na campanha; usado no handoff | *"especifica o atendente responsável pelas próximas mensagens desta transação"* |
| `paymentType` | Integer | **`99`** | Valor 99 = "Nenhum": *"Use este valor caso seja um Carrinho Abandonado, Mensagem Externa ou algum Evento Personalizado"* |
| `status` | Integer | **`99`** | Valor 99 = "Nenhum / Desconhecido": *"Use este valor caso esteja usando um evento personalizado"* |
| `value`, `freight`, `totalValue`, `freightType` | Integer/String | **`null`** | Regra do produto: a mensagem **não leva valor** |
| `date` | DateTime | **`null`** | ISO 8601 UTC. Nulo = data de recebimento. Cuidado documentado: *"caso esta data seja anterior à data de criação da licença da Voxuy, não serão agendadas mensagens"* → **sempre nulo** |
| `checkoutUrl`, `boletoUrl`, `pixQrCode`, `pixUrl`, `paymentLine` | String | `null` nesta onda | Campos nativos de pagamento; reservados para um funil futuro de 2ª via (§3 V9) |
| `fileUrl` | String | `null` | *"não esqueça de habilitar a opção Avançado do funil de API"* |
| endereço (`clientAddress*`, `clientZipCode`) | String | `null` | Não enviamos |
| logística (`currentShippingEvent`, `shipping`, `trackingCode`...) | - | não usado | Domínio de e-commerce |

**Valores monetários:** *"Todos os campos de valores são em Integer, sem vírgulas. Por exemplo, o valor R$ 69,90 deve ser enviado como 6990."* Registre isso no código como comentário mesmo enviando `null`, para ninguém mandar reais por engano depois.

### 1.4 Enums que usamos

Só precisamos de dois valores, ambos explicitamente destinados a evento personalizado: `paymentType = 99` ("Nenhum") e `status = 99` ("Nenhum / Desconhecido"). As tabelas completas (0–11, 20–26, 80, 99 para status; 0–8, 99 para pagamento) estão no Apêndice A.2 - copie-as como constantes tipadas em `lib/whatsapp/voxuy/enums.ts` **com comentário de que não usamos as de venda**, para o dia em que um tenant quiser outro fluxo.

### 1.5 Respostas

- `200` → `{ "Success": true }` (note o **S maiúsculo**; trate case-insensitive ao validar).
- `400` → objeto RFC 7231 com `errors` por campo, `title`, `status`, `traceId`. Exemplo real da doc no Apêndice A.3. **Guarde `traceId`** em `whatsapp_messages.provider_payload` - é o que a Voxuy vai pedir em suporte.
- A doc **não documenta** 401/403/429/5xx. Trate defensivamente: 401/403 → erro de configuração, falha a mensagem e **pausa a campanha** (não fique batendo com token errado); 429/5xx/timeout → retry com backoff do BullMQ; corpo inesperado com HTTP 200 → considerar sucesso mas logar `unexpected_body`.

### 1.6 Variáveis na mensagem

Para o funil usar o que mandamos: *"na mensagem que deseja, clicar em Inserir variável → Venda → Campo metadata (API)"*. A doc também avisa: *"Essa informação também vai aparecer nas Informações adicionais do evento do cliente no relatório da sua Voxuy"* → **metadata é visível na interface e nos relatórios da Voxuy**, logo entra na regra de minimização de dados (§3 V6).

---

## 2. O que a documentação NÃO cobre - e o que isso obriga no desenho

Cinco achados. Cada um vira decisão na §3. **Não invente contrato para nenhum deles.**

| # | Lacuna | Consequência |
|---|---|---|
| L1 | **Nenhum webhook de saída** (entregue / lido / clique / resposta / opt-out). A doc é 100% de entrada | Não podemos prometer métricas de entrega e leitura. `whatsapp_messages` precisa distinguir "aceito pela Voxuy" de "entregue ao cliente" |
| L2 | **Nenhuma API de blacklist / descadastro** | O opt-out **não pode** depender da Voxuy. Tem que ser capturado por nós (§3 V5) |
| L3 | **Nada sobre botões interativos** (URL ou resposta rápida) no payload | Não dá para garantir os três botões pela API. O desenho precisa funcionar com **um único link** e degradar bem |
| L4 | **Nada sobre cancelar um funil em andamento** por endpoint próprio | Mas a doc dá o mecanismo: uma **nova transação para o mesmo número cancela as mensagens anteriores** (comportamento padrão de `dontCancelPrevious`). É assim que "interromper novos contatos" será implementado (§3 V3) |
| L5 | **Nada sobre rate limit, nem se o canal é a API oficial da Meta** | Limiter conservador e configurável; risco de canal não-oficial registrado como pergunta (Apêndice E) |

---

## 3. Decisões desta integração (V1–V10)

| # | Decisão | Por quê |
|---|---|---|
| **V1** | **Um único link por mensagem**, apontando para `{NEXT_PUBLIC_APP_URL}/c/{token}`, entregue via `metadata.consult_url`. A página `/c/{token}` mostra, **antes de qualquer autenticação e sem nenhum dado da dívida**, as três ações: **Consultar atualização**, **Cancelar inscrição**, **Bloquear número** | Resolve L3 e L2 de uma vez: as três opções existem sempre, o clique e o opt-out ficam sob nosso controle e são auditáveis, e funciona com ou sem botões nativos |
| **V2** | Se a operação conseguir botões no funil da Voxuy, usar **botões de URL** com três tokens de ação distintos: `/c/{token}` , `/c/{token}/cancelar?k={optoutToken}` , `/c/{token}/bloquear?k={blockToken}`. Cada um é um token próprio, de uso único, **sem PII** | Mantém a UX pedida sem depender de webhook da Voxuy. Botão de resposta rápida **não** é aceitável para opt-out enquanto a Voxuy não confirmar um callback |
| **V3** | **`dontCancelPrevious` não é enviado** (fica no default: a Voxuy cancela as mensagens anteriores daquele número). E **"parar de contatar" é implementado disparando uma transação para um evento dedicado `journey_stop`** cujo funil é vazio (ou uma única mensagem de confirmação) | Sem endpoint de cancelamento (L4), este é o mecanismo que a própria doc descreve. Consequência obrigatória: a supressão por pagamento/opt-out **também** dispara esse evento |
| **V4** | **Três eventos (`customEvent`) na conta Voxuy**, configuráveis por tenant: `approach` (abordagem), `stop` (encerramento), `receipt` (confirmação de pagamento, opcional). Guardados em `tenant_chat_config.voxuy_events jsonb` | Um funil por finalidade; trocar de funil é só trocar o inteiro |
| **V5** | **Opt-out e bloqueio são registrados pela plataforma** (páginas/tokens de ação), gravam `contact_suppressions` + `journey_events` (`optout.received` / `block.received`), revogam os tokens de acesso do cliente e disparam o evento `stop` na Voxuy. "Bloquear número" suprime **o telefone** (`scope='phone'`, `channel='all'`); "Cancelar inscrição" suprime **o cliente no canal WhatsApp** (`scope='customer'`, `channel='whatsapp'`) | Requisito legal e do produto: supressão não pode ficar refém de um webhook que não existe |
| **V6** | **Minimização de dados na Voxuy:** enviamos apenas `clientName` (primeiro nome), `clientPhoneNumber`, o link em `metadata` e a marca. **Nunca** CPF (`clientDocument`), valor, número de faturas, e-mail ou endereço | `metadata` e os campos do cliente aparecem no relatório da Voxuy (§1.6). Menos dado lá, menos superfície de vazamento |
| **V7** | **Status honesto:** `whatsapp_messages.status` usa `accepted` quando a Voxuy responde 200 (a mensagem foi **aceita para agendamento**, não entregue). `delivered`/`read` só existem se um dia a Voxuy confirmar callbacks. A coluna `provider_status_source` registra a procedência (`none`, `voxuy_webhook`, `manual`) | Não inventar métrica. O painel mostra "aceitas pelo provedor" e usa **cliques** (nossos, confiáveis) como sinal de alcance real |
| **V8** | **Idempotência dupla:** `id = whatsapp_messages.id` (a Voxuy atualiza em vez de criar) **e** `jobId = wa_{campaignId}_{customerId}` no BullMQ (sem `:`). Retry nunca gera segunda mensagem | Derivado direto da semântica de `id` na doc |
| **V9** | Campos nativos de pagamento (`pixQrCode`, `pixUrl`, `boletoUrl`, `paymentLine`, `checkoutUrl`) ficam **implementados no adapter mas não usados** nesta onda, atrás de um evento `receipt`/2ª via | Quando quisermos mandar PIX pelo WhatsApp, o adapter já sabe; a decisão de produto fica para depois |
| **V10** | **Dedupe e cooldown por telefone**, não só por cliente: uma campanha nunca tem dois destinos com o mesmo `clientPhoneNumber`, e o cooldown (`contact_cooldown_days`) é avaliado por telefone **e** por cliente | Por causa de V3/L4: uma segunda transação para o mesmo número **cancela** o funil anterior. Dois clientes no mesmo telefone (temos 8 casos na carteira VMAX) se anulariam |

---

## 4. Fases

### V0 - Diagnóstico (read-only) · 🛑 GATE GV0

Nada é alterado. Saída: `reports/V0_voxuy_diagnostico.md`.

1. Estado do que a onda da jornada já criou: existe `lib/whatsapp/` com a interface `WhatsAppProvider`, o `MockWhatsAppProvider`, o worker `whatsapp-campaign.worker.ts`, a fila `alteapay-whatsapp`, as tabelas `whatsapp_campaigns`/`whatsapp_messages`/`whatsapp_provider_events`/`contact_suppressions`/`chat_access_tokens`? Liste o que está pronto e o que falta. **Se a onda da jornada ainda não foi executada, pare e diga: este prompt depende de F1–F3 daquele.**
2. Confronte a interface `WhatsAppProvider` existente com o contrato real: `sendCampaignMessage` precisa de mudança de assinatura? (esperado: sim, para `metadata` e `customEvent`). `parseInboundEvent` continua existindo mas **sem contrato conhecido** (L1) - vira captura pura.
3. Confirme na carteira: quantos clientes elegíveis têm celular E.164 válido, e **quantos telefones aparecem em mais de um cliente** (`select phone, count(distinct customer_id) ... having count(*) > 1`) - isso dimensiona o risco de V10.
4. Liste o que **falta na conta Voxuy** (Apêndice C) e o que falta de credencial. Não invente valores.

**🛑 GATE GV0:** Fabio confirma as decisões V1–V10 e responde o Apêndice E (ou autoriza seguir com os defaults).

### V1 - Configuração e segredos

1. Envs (Apêndice D): `VOXUY_WEBHOOK_URL`, `VOXUY_API_TOKEN` (ECS, onde o worker roda), `VOXUY_INBOUND_SECRET` (Netlify, para a rota de captura), `WHATSAPP_PROVIDER` (`mock` por padrão), `WHATSAPP_RATE_LIMIT_PER_SEC` (default `5`).
2. Por tenant, em `tenant_chat_config`: `voxuy_plan_id text`, `voxuy_events jsonb` (`{"approach": 63, "stop": 64, "receipt": null}`), `whatsapp_provider text default 'mock'`. Migration aditiva; defaults nulos.
3. `lib/whatsapp/voxuy/config.ts`: leitura validada com `zod`, mensagem de erro clara quando falta credencial, **sem nunca logar valor**. Provider `voxuy` sem credencial completa → o adapter recusa na construção e a campanha nem inicia (erro visível no painel, não silencioso).

### V2 - Adapter Voxuy

`lib/whatsapp/voxuy/provider.ts` implementando a interface, com:

1. **Montagem do payload** exatamente como o Apêndice A.4, com `zod` de saída (garante `paymentType: 99`, `status: 99`, `date: null`, `value/totalValue: null`, ausência de `clientDocument`).
2. **`metadata`** montado por `buildMetadata()` (Apêndice B.2): `consult_url`, `brand_name`, `creditor_name`, `first_name`, `optout_url`, `block_url`. Uma função só, testada, que **rejeita** qualquer chave não prevista (evita PII acidental).
3. **HTTP:** `fetch` com timeout (10 s), 1 tentativa por job (o retry é do BullMQ), `Content-Type: application/json`. Tratamento por classe de resposta conforme §1.5. Nunca logar o corpo com telefone: log estruturado com `messageId`, `httpStatus`, `traceId`, `errorFields` (nomes dos campos, não valores).
4. **`sendStopSignal({companyId, phone, customerId})`**: dispara transação para `voxuy_events.stop` com o mesmo `clientPhoneNumber`, `id = stop_{customerId}_{timestamp}` e metadata mínimo. É o mecanismo de V3. Registra `journey_events('contact.stopped')`.
5. **`syncSuppression`** (da interface original) passa a ser implementado **como `sendStopSignal`**, e documentado: a Voxuy não tem blacklist (L2) - a supressão autoritativa é a nossa.
6. **Rate limit:** limiter na fila (`WHATSAPP_RATE_LIMIT_PER_SEC`), não `sleep` no worker.
7. Fixtures em `tests/fixtures/voxuy/`: `success_200.json`, `error_400_phone.json` (o exemplo real da doc), `error_401.json`, `error_500.html` (corpo não-JSON), `success_unexpected_body.json`.

### V3 - Ajustes de modelo de dados (migration aditiva)

1. `whatsapp_messages`: `status` passa a aceitar `accepted` (novo) além dos existentes; `provider_transaction_id text` (o `id` que mandamos, para cruzar com o relatório da Voxuy), `provider_status_source text default 'none'`, `provider_trace_id text`, `stop_signal_sent_at timestamptz`.
2. `chat_access_tokens`: `purpose text default 'consult'` (`consult` | `optout` | `block`), para os tokens de ação de V2; `consumed_at timestamptz`.
3. `whatsapp_campaigns.counts`: incluir `accepted` e **remover a promessa** de `delivered`/`read` do cálculo padrão (mantidos como 0 quando não há fonte).
4. `tenant_chat_config`: colunas de V1.
5. Índice `whatsapp_messages(company_id, phone_e164, created_at desc)` para o cooldown por telefone (V10).

### V4 - Tokens de ação, páginas e supressão

1. `lib/journey/tokens.ts`: `issueActionTokens({customerId, debtIds, campaignId, messageId})` → três tokens (`consult`, `optout`, `block`), hash na tabela, TTL = `link_ttl_hours`, `max_uses` 1 para as ações de opt-out/bloqueio.
2. Páginas:
   - `/c/{token}` → **tela de escolha** (V1): marca do credor, texto neutro ("há uma atualização sobre um contrato em seu nome"), três botões. Nenhum dado da dívida. Grava `link.clicked` na primeira abertura.
   - `/c/{token}/cancelar` e `/c/{token}/bloquear` → confirmação em **um clique + confirmar** (evita opt-out por prefetch de link), aplica a supressão, revoga tokens, dispara `sendStopSignal`, mostra confirmação ("você não receberá mais mensagens neste número") e um caminho de volta ("se foi sem querer, fale com o atendimento").
   - Autenticação por CPF só acontece depois de "Consultar atualização" (fluxo já definido na onda da jornada).
3. **Rota de prefetch-safe:** as ações destrutivas nunca são executadas em `GET` sem confirmação; use `POST` com CSRF de sessão curta. Clientes de WhatsApp/antivírus fazem preview de link.
4. `lib/journey/suppressions.ts`: ao inserir supressão por `optout`/`block`/`paid`, **sempre** chamar `sendStopSignal` (try/catch: falha não desfaz a supressão local, gera `contact.stop_failed` para a operação reprocessar).

### V5 - Captura de inbound (sem contrato)

1. `POST /api/webhooks/whatsapp/voxuy`: valida `VOXUY_INBOUND_SECRET` (header `x-alteapay-webhook-secret` **ou** query `?s=`, porque não sabemos o que a Voxuy suporta), grava **tudo** em `whatsapp_provider_events` (`raw`, `event_hash` para dedupe, `processed=false`), responde `200` sempre que o segredo estiver correto. **Nunca 500** (um provedor que recebe 5xx pode desativar o webhook).
2. Mapeador `lib/whatsapp/voxuy/inbound.ts`: reconhece o contrato normalizado do Apêndice A.5 (útil para o mock e para um passo intermediário no n8n) e **nada mais**. Formato desconhecido fica `processed=false` para análise. Quando a Voxuy confirmar o formato real, só este arquivo muda.
3. Painel: contador de `whatsapp_provider_events` não processados, para ninguém descobrir tarde que chegou algo.

### V6 - Painel

1. Campanha: colunas **Aceitas pelo provedor**, **Cliques**, **Autenticações**, **Acordos**, **Suprimidas**, **Falhas**. Entregue/Lido só aparecem se `provider_status_source != 'none'`; caso contrário, um rótulo "não informado pelo provedor" (não zero).
2. Ação **Reenviar** por mensagem: usa o mesmo `id` (a Voxuy atualiza) e deixa claro na UI que **reenviar cancela o funil anterior daquele número** (V3).
3. Aviso na tela de criação: "a Voxuy cancela mensagens anteriores para o mesmo número" + a contagem de telefones duplicados na seleção (V10), bloqueando o início até a duplicidade ser resolvida.

### V7 - Testes

- **Unitários:** payload canônico (todos os campos fixos), `buildMetadata` rejeitando chave não prevista, ausência de `clientDocument`/valores, `paymentType`/`status` = 99, `date` nulo, tratamento de 200/400/401/429/5xx/corpo inesperado, `traceId` persistido, idempotência (`id` estável e `jobId` sem `:`), `sendStopSignal`, supressão disparando stop e sobrevivendo a falha dele, tokens de ação (uso único, TTL, revogação), cooldown e dedupe por telefone, `accepted` nunca virando `delivered`.
- **Laboratório** (`MOCK_ALL_INTEGRATIONS=1`): a jornada completa do prompt anterior, agora com as três ações da tela de escolha; opt-out e bloqueio excluindo o cliente de uma nova campanha; reenvio não duplicando.
- **Contra a API real: só no V8**, e só para um número interno.

### V8 - Smoke test real · 🛑 GATE GV1

Pré-requisito: Apêndice C concluído pela operação (produto, categoria, evento, plano, funil, token, URL) e credenciais no ECS/Netlify.

1. Tenant **"Altea - Testes"**, `WHATSAPP_PROVIDER=voxuy` **só nele**, 1 destinatário: um número da própria Altea.
2. Campanha de 1 mensagem → confirmar `200 {"Success": true}`, `provider_transaction_id` salvo, `status='accepted'`.
3. No celular: a mensagem chegou **sem valor e sem dado da dívida**? O link abre a tela de escolha com a marca certa? A variável de `metadata` foi substituída (não apareceu literal)?
4. Clicar **Consultar** → `link.clicked`, autenticação por CPF, chat abre (engine `disabled`), oferta da matriz, aceite, PIX de valor baixo, pagamento, webhook ASAAS, sessão encerrada, supressão criada, **`sendStopSignal` disparado** → confirmar no celular que o funil parou.
5. Repetir com um segundo número: clicar **Cancelar inscrição** → supressão + stop + nova campanha exclui o número.
6. Verificar no relatório da Voxuy que os eventos aparecem e que `metadata` **não** contém PII.
7. `reports/V8_smoke_voxuy.md` com evidências (prints sem número completo). **🛑 GATE GV1:** Fabio aprova antes de qualquer campanha com cliente real. Depois do gate, voltar `WHATSAPP_PROVIDER` do tenant de teste para `mock` ou manter conforme decisão.

### V9 - Handover

- `docs/WHATSAPP_VOXUY_INTEGRATION.md`: contrato real (esta doc), mapeamento de campos, enums, tratamento de erro, o que **não** existe (L1–L5) e o que fazer quando existir.
- `docs/VOXUY_SMOKE_TEST.md`: o roteiro do V8, reexecutável.
- `docs/VOXUY_ACCOUNT_SETUP.md`: o Apêndice C, para a operação repetir por tenant.
- Atualizar `altea-pay/CLAUDE.md` (repo) e `docs/CHATBOT_PROD_COMPAT.md`.
- Enviar ao Fabio o Apêndice E preenchido com o que ficou sem resposta, para ele levar à Voxuy.

---

## 5. Checklist de aceite

- [ ] Payload validado por schema; `paymentType=99`, `status=99`, `date=null`, `value/totalValue=null`, **sem `clientDocument`**.
- [ ] `metadata` só com as chaves previstas; nenhuma PII além do primeiro nome; teste que falha se alguém adicionar chave nova sem revisar.
- [ ] `id = whatsapp_messages.id`; retry do worker não cria segunda mensagem na Voxuy.
- [ ] Um único link na mensagem (V1) e tela de escolha com as três ações, sem dado da dívida antes da autenticação.
- [ ] Opt-out e bloqueio funcionam **sem** depender de webhook da Voxuy; supressão respeitada em todos os caminhos de envio; `sendStopSignal` disparado.
- [ ] `accepted` ≠ `delivered`; painel não exibe entrega/leitura inventada.
- [ ] Dedupe e cooldown por telefone; campanha bloqueia telefone duplicado.
- [ ] Rota de captura inbound responde 200 com segredo válido, grava tudo, nunca 500.
- [ ] `WHATSAPP_PROVIDER=mock` em todos os tenants reais ao fim da onda; credenciais Voxuy só no tenant de teste.
- [ ] Erro 401/403 pausa a campanha; 429/5xx faz backoff; `traceId` salvo.
- [ ] Smoke test real executado e aprovado (GV1).

---

## Apêndice A - Contrato (transcrito da doc oficial)

### A.1 Tabela de campos (na ordem da doc)

`apiToken` String (Token da API) · `id` String (Código de venda / ID único dessa transação; identificador para ser **adicionado ou atualizado**; vazio → código único atribuído) · `planId` String (ID do plano desejado) · `agentEmail` String (especifica o atendente responsável pelas próximas mensagens desta transação; se vazio, vai para o atendente configurado para esse evento e produto) · `dontCancelPrevious` Boolean (padrão: a Voxuy cancela e remove do funil todas as mensagens anteriores ao entrar nova transação para o mesmo número; `true` para não cancelar) · `value` Integer (valor líquido) · `freight` Integer (frete) · `freightType` String (ex.: PAC) · `totalValue` Integer (valor total) · `metadata` Object (campos adicionais para usar como variáveis nas mensagens) · `paymentType` Integer · `status` Integer · `customEvent` Integer (ID do evento) · `date` DateTime (ISO 8601 UTC, ex.: `2021-05-01T21:00:00Z`; nulo → data do recebimento; anterior à criação da licença → mensagens não agendadas) · `clientName` String · `clientEmail` String · `clientPhoneNumber` String (completo com código do país, ex.: `+5511912341234`) · `clientDocument` String (CPF ou CNPJ) · `clientAddress`, `clientAddressNumber`, `clientAddressComp`, `clientAddressDistrict`, `clientAddressCity`, `clientAddressState`, `clientZipCode` String · `checkoutUrl` String · `paymentLine` String (linha digitável do boleto) · `boletoUrl` String · `pixQrCode` String (QR Code completo do PIX) · `pixUrl` String · `fileUrl` String (requer opção **Avançado** do funil de API) · `currentShippingEvent` Integer · `shipping` Object (`trackingCode`, `trackingUrl`, `branchName`, `city`, `state`, `country`, `date`).

> A coluna "Requerido?" vem **vazia para todos os campos** na doc. Na prática, o exemplo de erro 400 mostra `clientPhoneNumber` como obrigatório, e `apiToken`/`planId`/`customEvent` são necessários para o roteamento. Trate esses quatro como obrigatórios e **descubra o resto por teste**, não por suposição.

### A.2 Enums

**Tipos de Pagamento:** Gratuito `0` · Boleto `1` · Cartão de Crédito `2` · PayPal `3` · Boleto Parcelado `4` · Depósito bancário `5` · Depósito em conta `6` · Pix `7` · Carteira Digital `8` · **Nenhum `99`** (carrinho abandonado, mensagem externa ou evento personalizado).

**Status do Pedido:** Pendente/Aguardando Pagamento `0` · Pagamento Aprovado `1` · Cancelado `2` · Chargeback `3` · Estornado `4` · Em Análise `5` · Aguardando Estorno `6` · Processando Cartão `7` · Parcialmente Pago `8` · Bloqueado `9` · Rejeitado `10` · Duplicado `11` · Assinatura criada `20` · atrasada `21` · cancelada `22` · renovada `23` · paga `24` · estornada `25` · Carrinho abandonado de assinatura `26` · Carrinho Abandonado `80` · **Nenhum/Desconhecido `99`** (evento personalizado).

**Status de Logística** (não usado): Nenhum `0` · Etiqueta emitida `8` · Postado `1` · Em Trânsito `2` · Retirada `3` · Saiu para entrega `5` · Entregue `6`.

### A.3 Respostas

```json
// 200
{ "Success": true }
```
```json
// 400 (exemplo da doc)
{
  "errors": { "clientPhoneNumber": ["The clientPhoneNumber field is required."] },
  "type": "https://tools.ietf.org/html/rfc7231#section-6.5.1",
  "title": "One or more validation errors occurred.",
  "status": 400,
  "traceId": "0HM8U2U27H831:00000001"
}
```

### A.4 Payload canônico da AlteaPay (abordagem)

```json
{
  "apiToken": "<VOXUY_API_TOKEN>",
  "id": "<whatsapp_messages.id>",
  "planId": "<tenant_chat_config.voxuy_plan_id>",
  "customEvent": 63,
  "paymentType": 99,
  "status": 99,
  "clientName": "Fabio",
  "clientPhoneNumber": "+5511912341234",
  "clientEmail": null,
  "clientDocument": null,
  "value": null, "freight": null, "freightType": null, "totalValue": null,
  "date": null,
  "checkoutUrl": null, "paymentLine": null, "boletoUrl": null, "pixQrCode": null, "pixUrl": null,
  "metadata": {
    "consult_url": "https://alteapay.com/c/AbC...",
    "optout_url": "https://alteapay.com/c/AbC.../cancelar?k=...",
    "block_url": "https://alteapay.com/c/AbC.../bloquear?k=...",
    "brand_name": "AlteaPay",
    "creditor_name": "VMAX",
    "first_name": "Fabio"
  }
}
```
Encerramento (`stop`): mesmo formato, `customEvent` = evento `stop`, `id = "stop_<customerId>_<epoch>"`, `metadata` = `{ "brand_name": "...", "creditor_name": "..." }`.

### A.5 Contrato inbound **proposto** (não confirmado pela Voxuy)

```json
{ "event": "delivered|read|clicked|optout|block|failed|reply",
  "message_ref": "<o id que enviamos>", "phone": "+55...",
  "button": "consult|optout|block", "occurred_at": "ISO-8601", "raw": {} }
```
Usado pelo mock e aceito pela rota de captura. Qualquer outro formato é armazenado sem processar.

---

## Apêndice B - Mensagem e variáveis

### B.1 Texto de referência (cadastrado **na Voxuy**, pela operação)

> Olá, {{primeiro nome}}. Aqui é a {{marca}}, parceira oficial de cobrança da {{credor}}. Há uma atualização sobre um contrato registrado em seu nome. Você pode consultar com segurança neste link: {{link}} - se não quiser mais receber estas mensagens, o próprio link tem a opção de cancelar.

Regras: **sem valor, sem número de contrato, sem menção a dívida/atraso/negativação**, sem pedir CPF ou qualquer dado na conversa, um único domínio (`alteapay.com`). Se o funil tiver mais de uma mensagem, todas seguem a mesma regra.

### B.2 Variáveis (Inserir variável → Venda → Campo metadata (API))

`consult_url` · `optout_url` · `block_url` · `brand_name` · `creditor_name` · `first_name`. Nomes exatamente iguais aos cadastrados no funil. Nada além disso (V6).

---

## Apêndice C - Configuração na conta Voxuy (operação, antes do V8)

Sequência da doc oficial:

1. **Produto:** menu → **API** → listagem de produtos → **Adicionar produto** → nome (ex.: `AlteaPay Cobranca`) → Salvar.
2. **Categoria e evento:** selecionar o produto → **+ Nova categoria** (ex.: `Jornada`) → criar os eventos: `Abordagem`, `Encerramento`, (opcional) `Recibo`. **Copiar o ID de cada evento** (é o `customEvent`, um inteiro).
3. **Funil de mensagens:** cadastrar as mensagens de cada evento. O funil de `Encerramento` fica **vazio ou com uma única mensagem de confirmação** (V3).
4. **URL e token:** menu → **Integrações** → buscar **API VOXUY** → copiar **URL para webhook** (contém o `<codigo>`) e **Token API** (se vazio, **Novo Token**).
5. **Plano:** menu → **Produtos** → o produto criado → **Adicionar plano** → nome → Salvar → **Copiar código do plano** (é o `planId`).
6. **Chat do atendente:** marcar o produto criado **e** o evento **API/Customizado** no chat do atendente - a doc é explícita: sem isso a Voxuy **não envia** as mensagens do funil de API.
7. Se algum dia usarmos `fileUrl`: habilitar a opção **Avançado** do funil de API.

Entregar ao Claude Code: URL para webhook, Token API, `planId`, e os IDs dos eventos. **Nunca** colar esses valores em chat, commit ou issue: vão direto para as variáveis do Netlify/ECS.

---

## Apêndice D - Variáveis de ambiente

| Variável | Onde | Default | Uso |
|---|---|---|---|
| `WHATSAPP_PROVIDER` | Netlify + ECS | `mock` | `mock` \| `voxuy` (por tenant via `tenant_chat_config.whatsapp_provider`) |
| `VOXUY_WEBHOOK_URL` | ECS | vazio | URL completa de Integrações → API VOXUY (contém o `<codigo>`) |
| `VOXUY_API_TOKEN` | ECS | vazio | campo `apiToken` |
| `VOXUY_INBOUND_SECRET` | Netlify | novo | segredo da rota de captura |
| `VOXUY_TIMEOUT_MS` | ECS | `10000` | timeout do POST |
| `WHATSAPP_RATE_LIMIT_PER_SEC` | ECS | `5` | limiter da fila (não documentado pela Voxuy) |

Por tenant: `voxuy_plan_id`, `voxuy_events` (`{"approach":63,"stop":64,"receipt":null}`), `whatsapp_provider`.

---

## Apêndice E - O que ainda falta perguntar à Voxuy

1. **Webhook de saída:** existe callback para **entregue, lido, clique em link/botão, resposta do cliente**? Se sim, qual o formato e como registrar a URL? (Sem isso, nossas métricas param em "aceita".)
2. **Descadastro:** a Voxuy tem lista de bloqueio/opt-out própria? Se um cliente responder "sair" ou bloquear o número no WhatsApp, isso é refletido em algum lugar que possamos consultar? Como evitamos insistir em quem bloqueou?
3. **Botões:** o funil suporta **botões de URL** e **resposta rápida**? Se sim, o clique gera evento consultável?
4. **Canal:** é **API oficial da Meta** (WABA, templates aprovados) ou não-oficial? Se oficial: quem aprova os templates e qual a categoria (utility/marketing)? Se não-oficial: qual o risco de bloqueio do número e qual o plano B.
5. **Limites:** quantas requisições por segundo/minuto a API aceita? Há limite diário de mensagens por número?
6. **Cancelamento explícito:** existe forma documentada de **cancelar o funil** de uma transação (além de enviar nova transação para o mesmo número)?
7. **Campos obrigatórios:** a coluna "Requerido?" está vazia na doc - quais são realmente obrigatórios além de `clientPhoneNumber`, `apiToken`, `planId` e `customEvent`?
8. **`id`:** reenviar o mesmo `id` com outro `customEvent` **move** a transação para o novo funil ou cria outra?
9. **Ambiente de teste:** existe sandbox ou o teste é sempre em produção com número real?
10. **Retenção:** por quanto tempo a Voxuy guarda `metadata` e os dados do cliente? Há processo de exclusão a pedido (LGPD)?

---

## Apêndice F - Ajustes no prompt da jornada (`claude/PROMPT_JORNADA_CHATBOT_2026-09-16.md`)

| Onde | Mudança |
|---|---|
| **F3.1** (`VoxuyProvider`) | Substituído pelas fases V1–V2 e pelo Apêndice A deste documento |
| **F3.1** (botões na mensagem) | Substituído por V1/V2: um link + tela de escolha; botões só como otimização |
| **F3.1** (`syncSuppression`) | Passa a ser `sendStopSignal` (V3/V5): a Voxuy não tem blacklist |
| **F3.2** (elegibilidade) | Acrescentar dedupe e cooldown **por telefone** (V10) |
| **F3.8** (conciliação) | Ao suprimir por pagamento, **disparar `sendStopSignal`** |
| **Apêndice A.3** | Substituído por A.4/A.5 deste documento |
| **Apêndice C.8** | Substituído pelo Apêndice E (perguntas remanescentes) |
| **§2 item 1** (3 botões) | Reinterpretado: as três opções passam a existir na tela de escolha, sempre; a forma na mensagem depende do que a Voxuy suportar |
