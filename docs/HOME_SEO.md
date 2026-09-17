# Home / SEO — guia de manutenção

Guia da home pública (`/`), estática e SEO-first. Cobre onde editar copy e
dados institucionais, como regenerar assets e o que conferir antes de um
release.

## Onde vive cada coisa

| O quê | Arquivo |
| --- | --- |
| Copy da home (hero, seções, FAQ, contato, footer) | `content/home.ts` |
| Config institucional (URLs, CNPJ, e-mail, WhatsApp, endereço, DPO) | `content/site.ts` |
| Componentes da landing | `components/landing/*` |
| Schema do formulário de contato (zod, compartilhado) | `lib/contact/schema.ts` |
| Server action do formulário | `app/actions/contact-lead.ts` |
| JSON-LD (Organization, WebSite, SoftwareApplication, FAQPage) | `lib/seo/jsonld.ts` (injetado em `app/page.tsx`) |
| robots.txt | `app/robots.ts` |
| sitemap.xml | `app/sitemap.ts` |
| Manifest PWA | `app/manifest.ts` |
| Imagens OG/Twitter (geradas em runtime via `ImageResponse`) | `app/opengraph-image.tsx`, `app/twitter-image.tsx` |
| Ícones estáticos | `public/favicon.ico`, `public/icons/*`, `public/icon.svg` |
| Estilos exclusivos da landing (classes `lp-*`) | final de `app/globals.css` |

## Editando a copy (`content/home.ts`)

Todo texto visível da home vem de `content/home.ts` (fonte aprovada:
`ops/home-seo-2026-09/reports/F1_copy.md`). Edite as strings e pronto — os
componentes só renderizam o conteúdo. As 10 perguntas do FAQ alimentam
também o JSON-LD `FAQPage`; mantenha texto visível e JSON-LD idênticos
(é automático, pois ambos leem `faq.items`).

## Editando dados institucionais (`content/site.ts`)

Constantes fixas: `SITE_URL`, `SITE_NAME`, `CNPJ`, `CONTACT_EMAIL`,
`LOGIN_URL`, `REGISTER_URL`, `PORTAL_URL`, `PRIVACY_URL`, `TERMS_URL`.

O objeto `site: SiteConfig` guarda os campos opcionais (pendências C.x):

- `legalName` — razão social (linha legal do footer + `legalName` no JSON-LD)
- `whatsapp: { number, presetText }` — número E.164 sem `+`; habilita os CTAs
  de WhatsApp (hero, contato, bloco do cidadão, footer) e o
  `contactPoint.telephone` do JSON-LD
- `address: { street, city, region, postalCode? }` — footer + `PostalAddress`
- `linkedinUrl` — link no footer + `sameAs`
- `dpo: { name, email }` — menção a "encarregado nomeado" no card LGPD
- `onboardingDays` — prazo de implantação (copy usa "poucos dias" sem ele)
- `responseTime` — obrigatório; usado nos textos de contato

**Regra de omissão:** campo opcional ausente NUNCA renderiza nada — nem
placeholder, nem rótulo vazio. Ex.: sem `whatsapp`, o CTA secundário do hero
vira "Enviar e-mail" (`mailto:` para `CONTACT_EMAIL`) e os demais botões de
WhatsApp simplesmente não existem no HTML.

## Formulário de contato

- Validação client e server usam o MESMO schema (`lib/contact/schema.ts`):
  nome 2–80, e-mail válido, telefone opcional (só dígitos, 10–13),
  organização 2–120, mensagem 10–2000, consentimento obrigatório.
- Honeypot `campo_site`: escondido por CSS, verificado na action DEPOIS do
  parse; se preenchido, responde sucesso falso sem enviar nada.
- Tipo "Recebi uma cobrança" não envia: mostra orientação (`role="status"`)
  com links para o Portal do Cliente e atendimento.
- Pré-seleção via `/?tipo=publico#contato` (lida de `window.location.search`
  em `useEffect`; não usar `useSearchParams`, que quebraria o `○ Static`).

### Dry-run (testar sem enviar e-mail)

```bash
CONTACT_FORM_DRY_RUN=true pnpm dev
```

Com a variável setada, a action valida tudo, loga `[contact-lead] dry-run`
e retorna sucesso sem chamar o SendGrid.

### Limitação do rate limit

O rate limit (5 envios/min por IP) usa um `Map` em memória. No Netlify cada
instância de função tem contador próprio e o estado zera em cold start —
serve como barreira leve contra rajadas, não como proteção definitiva. Se
precisar de algo robusto, mover para um contador no Redis/Upstash.

## Regenerando OG e ícones

- **OG/Twitter:** não há arquivo estático — `app/opengraph-image.tsx` e
  `app/twitter-image.tsx` geram a imagem via `ImageResponse`. Edite o JSX
  desses arquivos e confira em `/opengraph-image`.
- **Ícones:** gerados a partir de `public/icon.svg` (o SVG usa
  `prefers-color-scheme`; inline os fills antes de rasterizar) e do PNG 32px:

```bash
sed -e 's/class="background"/fill="black"/' -e 's/class="foreground"/fill="white"/' \
  public/icon.svg > /tmp/icon-light.svg
rsvg-convert -w 180 -h 180 /tmp/icon-light.svg -o public/icons/apple-touch-icon.png
rsvg-convert -w 192 -h 192 /tmp/icon-light.svg -o public/icons/icon-192.png
rsvg-convert -w 512 -h 512 /tmp/icon-light.svg -o public/icons/icon-512.png
python3 -c "from PIL import Image; Image.open('public/icon-light-32x32.png').convert('RGBA').save('public/favicon.ico', format='ICO', sizes=[(16,16),(32,32)])"
```

Referências: `app/manifest.ts` (192/512 + SVG) e `metadata.icons` em
`app/layout.tsx` (favicon.ico + apple-touch-icon).

> Pendência: a arte atual dos ícones é o placeholder do v0, não a marca
> AlteaPay. Ao receber a arte oficial, substituir `public/icon.svg` e o PNG
> 32px e rodar os comandos acima.

## Dark mode

A landing é invariante ao tema: só usa tokens estáticos (`altea-*` e paleta
neutra) e `.lp-root` re-fixa `--border`/`--ring`/`color-scheme` nos valores
light (ver bloco `lp-*` no fim de `app/globals.css`). Não usar classes
semânticas do tema (`bg-background`, `text-foreground`, `bg-card`, ...) em
`components/landing/*`.

## Checklist de release

1. `pnpm build` verde e rota `/` como `○ (Static)` com First Load ≈ 103 kB
   ou menor
2. `npx tsc --noEmit` sem erros novos
3. `pnpm vitest run` verde
4. `git diff --stat origin/main` sem tocar arquivos congelados (middleware,
   `lib/supabase`, `app/auth`, `components/auth`, dashboards, `app/api`,
   `lib/queue`, `supabase/`, `netlify.toml`, `package.json`)
5. Conferir no Deploy Preview: hero + CTAs, `?tipo=publico#contato`
   pré-selecionando "Órgão público", fluxo "Recebi uma cobrança", FAQ
   (primeira aberta), footer (linha legal só com campos preenchidos),
   `<html class="dark">` sem mudança visual
6. Validar `/robots.txt`, `/sitemap.xml`, `/manifest.webmanifest` e o
   JSON-LD (Rich Results Test) em produção
