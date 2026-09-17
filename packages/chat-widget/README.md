# AlteaPay Chat Widget (white-label)

Widget embeddable do chatbot de negociação. O cliente (prefeitura/empresa)
hospeda apenas a **casca visual**; toda conversa, decisão, oferta e evento
passa pela API da AlteaPay e fica auditável no banco da plataforma.

## Instalação no site do cliente

```html
<!-- inline: renderiza dentro de <div id="alteapay-chat"> -->
<div id="alteapay-chat" style="height:600px"></div>
<script src="https://app.alteapay.com/widget/alteapay-chat.js"
        data-token-param="t"
        data-mode="inline"></script>
```

```html
<!-- float (default): botão flutuante no canto da página -->
<script src="https://app.alteapay.com/widget/alteapay-chat.js"
        data-token-param="t"
        data-color="#14532D"></script>
```

## Parâmetros

| Atributo | Default | Função |
|---|---|---|
| `data-token-param` | `t` | Nome do query param da página do cliente que carrega o token |
| `data-app-url` | origem do script | Origem do app AlteaPay (para ambientes de teste) |
| `data-mode` | `float` | `inline` (em `#alteapay-chat`) ou `float` (botão flutuante) |
| `data-color` | `#0A0F1E` | Cor do botão flutuante |

## Como o link do WhatsApp chega ao widget

O handoff do WhatsApp gera um deep link apontando para a **página do cliente**
com o token no query param — ex.:

```
https://prefeitura.gov.br/negocie?t={token}
```

O widget extrai o token (`data-token-param`) e injeta um iframe para
`{appUrl}/negociar/embed/{token}`. O token é opaco, de uso único, com TTL de
24h; somente o hash é persistido.

## Requisitos de domínio (por tenant)

1. A origem do site do cliente deve estar em `tenant_chat_config.allowed_origins`
   (CORS das rotas de chat **e** `frame-ancestors` da página embed — sem isso o
   iframe é bloqueado pelo navegador).
2. `widget_enabled = true` no `tenant_chat_config`.
3. Em produção (https), o cookie de sessão do chat usa `SameSite=None; Secure`
   para funcionar dentro do iframe cross-site. Em http local, o demo funciona
   apenas same-origin (`/demo/prefeitura`).

## Demonstração local

`http://localhost:3000/demo/prefeitura` simula um site de prefeitura com o
widget embedado, consumindo o mesmo backend (tenant VMAX em modo B white-label).

## Branding

Cores, logotipo, nome exibido e mensagem de boas-vindas vêm de
`tenant_chat_config.branding` — o iframe carrega o layout "embed" (sem header
AlteaPay, footer discreto "tecnologia AlteaPay").
