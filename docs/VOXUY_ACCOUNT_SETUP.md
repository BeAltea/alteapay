# Voxuy — configuração da conta (operação, por tenant)

Sequência da documentação oficial da Voxuy (Apêndice C do prompt). Faça isto
**antes** do smoke test (`VOXUY_SMOKE_TEST.md`). Repita por tenant que for usar Voxuy.

> **Nunca** cole URL, token, `planId` ou IDs de evento em chat, commit ou issue.
> Eles vão **direto** para as variáveis do Netlify/ECS e para `tenant_chat_config`.

## Passos

1. **Produto.** Menu → **API** → listagem de produtos → **Adicionar produto** → nome
   (ex.: `AlteaPay Cobranca`) → Salvar.
2. **Categoria e eventos.** Selecionar o produto → **+ Nova categoria** (ex.: `Jornada`)
   → criar os eventos: `Abordagem`, `Encerramento` e (opcional) `Recibo`.
   **Copiar o ID de cada evento** (é o `customEvent`, um **inteiro**).
3. **Funil de mensagens.** Cadastrar as mensagens de cada evento. Texto de referência
   (sem valor, sem número de contrato, sem menção a dívida/atraso/negativação, um único
   domínio `alteapay.com`):
   > Olá, {{primeiro nome}}. Aqui é a {{marca}}, parceira oficial de cobrança da {{credor}}.
   > Há uma atualização sobre um contrato registrado em seu nome. Você pode consultar com
   > segurança neste link: {{link}} — se não quiser mais receber estas mensagens, o próprio
   > link tem a opção de cancelar.
   - As variáveis vêm de `metadata`: **Inserir variável → Venda → Campo metadata (API)**,
     com os nomes **exatamente** `first_name`, `brand_name`, `creditor_name`, `consult_url`
     (e, se usar botões, `optout_url`/`block_url`).
   - O funil de **Encerramento** fica **vazio ou com uma única mensagem de confirmação**.
4. **URL e token.** Menu → **Integrações** → **API VOXUY** → copiar **URL para webhook**
   (contém o `<codigo>`) e **Token API** (se vazio, **Novo Token**).
5. **Plano.** Menu → **Produtos** → o produto criado → **Adicionar plano** → nome →
   Salvar → **Copiar código do plano** (é o `planId`).
6. **Chat do atendente.** Marcar o produto criado **e** o evento **API/Customizado** no
   chat do atendente. **Sem isso a Voxuy NÃO envia** as mensagens do funil de API.
7. (Opcional) Se um dia usarmos `fileUrl`: habilitar a opção **Avançado** do funil de API.

## O que entregar / onde colocar

| Valor da Voxuy | Onde vai |
|---|---|
| URL para webhook | env `VOXUY_WEBHOOK_URL` (ECS) |
| Token API | env `VOXUY_API_TOKEN` (ECS) |
| `planId` | `tenant_chat_config.voxuy_plan_id` |
| ID do evento Abordagem | `tenant_chat_config.voxuy_events.approach` |
| ID do evento Encerramento | `tenant_chat_config.voxuy_events.stop` |
| ID do evento Recibo (opcional) | `tenant_chat_config.voxuy_events.receipt` |

Exemplo de `voxuy_events`:
```json
{ "approach": 63, "stop": 64, "receipt": null }
```

Além disso: `VOXUY_INBOUND_SECRET` (Netlify) para a rota de captura, e
`tenant_chat_config.whatsapp_provider='voxuy'` **só** no tenant liberado.

## Minimização de dados (LGPD / V6)
A AlteaPay envia à Voxuy **apenas**: primeiro nome, telefone, o link tokenizado (em
`metadata`) e a marca. **Nunca** CPF, valor, nº de faturas, e-mail ou endereço.
`metadata` aparece no relatório da Voxuy — mantê-lo mínimo é parte do contrato.
