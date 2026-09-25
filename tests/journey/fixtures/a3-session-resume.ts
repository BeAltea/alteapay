// A3 — fixture SINTÉTICA da retomada. NÃO é cópia do banco: espelha a ESTRUTURA
// da sessão de teste VMAX observada na descoberta (01-descoberta-D4.md §3) —
// três gerações do fluxo na MESMA época (Sim/Não reconheço → Consultar/Negociar
// → menu de 3 opções), respostas sem prompt_id entre prompts, mensagens do
// motor (n8n), cliques repetidos, bolhas antigas com valor, outcomes marcados
// por stage (A1), um link antigo persistido como texto (pré-A1) e um prompt
// pós-link que o login supersede por um menu novo (o "menu corrente" da
// retomada). Nomes, ids, datas e URLs são fictícios: sem PII, sem dado de
// produção.

export interface FixturePrompt {
  id: string
  kind: string
  status: string
  created_at: string
  question: string
}

export interface FixtureMessage {
  id: string
  role: "customer" | "assistant"
  text: string
  button_id: number | null
  prompt_id: string | null
  engine: string | null
  offers_snapshot: Record<string, unknown> | null
  created_at: string
}

const Q_LEGACY_ACK =
  "Olá, Ana! Temos uma dívida em seu nome da empresa VMAX. Valor atualizado R$ 250,00, vencimento mais antigo em 15/08/2026. Você reconhece esta cobrança em seu nome?"
const Q_LEGACY_CONSULT = "Olá, Ana! Temos uma dívida em seu nome da empresa VMAX. O que você deseja fazer?"
const Q_OLD_THREE = "Olá, Ana. Você tem uma pendência de R$ 250,00 com a VMAX. Como prefere seguir?"
const Q_THREE = "Olá, Ana. Encontramos um valor em aberto em seu nome com a VMAX."
const Q_REOPEN = "Como prefere seguir?"
const Q_BACK = "Se preferir, você pode voltar às opções."
const LEGACY_INFO =
  "Aqui estão os dados da sua dívida com a VMAX: valor atualizado R$ 250,00, vencimento mais antigo em 15/08/2026."
const DETAIL = "Este valor tem vencimento original em 15/08/2026 e refere-se a um serviço da VMAX."
const LINK_TEXT = (n: number, due: string) =>
  `Aqui está o seu link para pagar R$ 250,00, com vencimento em ${due}. É só abrir e escolher entre Pix, boleto ou cartão. O link é pessoal e seguro.\nhttps://pay.example.test/c/${n}`
const linkAction = (n: number) => ({
  type: "open_payment_link",
  label: "Abrir link de pagamento",
  href: `https://pay.example.test/c/${n}`,
})

export const RESUME_PROMPTS: FixturePrompt[] = [
  { id: "p01", kind: "debt_acknowledgement", status: "answered", created_at: "2026-09-01T10:00:00Z", question: Q_LEGACY_ACK },
  { id: "p02", kind: "debt_consult", status: "answered", created_at: "2026-09-01T10:05:00Z", question: Q_LEGACY_CONSULT },
  { id: "p03", kind: "debt_consult", status: "answered", created_at: "2026-09-01T10:05:10Z", question: "Como deseja seguir?" },
  { id: "p04", kind: "debt_consult", status: "answered", created_at: "2026-09-02T09:00:00Z", question: Q_LEGACY_CONSULT },
  { id: "p05", kind: "debt_three_options", status: "answered", created_at: "2026-09-03T09:00:00Z", question: Q_OLD_THREE },
  { id: "p06", kind: "debt_three_options", status: "answered", created_at: "2026-09-03T09:10:00Z", question: Q_OLD_THREE },
  { id: "p07", kind: "offer_choice", status: "answered", created_at: "2026-09-04T09:01:00Z", question: "Estas são as condições disponíveis para você. Escolha a que preferir." },
  { id: "p08", kind: "debt_three_options", status: "answered", created_at: "2026-09-04T09:02:00Z", question: Q_THREE },
  { id: "p09", kind: "debt_three_options", status: "answered", created_at: "2026-09-04T10:00:10Z", question: "" },
  { id: "p10", kind: "debt_three_options", status: "answered", created_at: "2026-09-04T10:00:21Z", question: Q_REOPEN },
  { id: "p11", kind: "debt_three_options", status: "answered", created_at: "2026-09-04T10:00:26Z", question: Q_REOPEN },
  { id: "p12", kind: "debt_three_options", status: "answered", created_at: "2026-09-04T10:00:41Z", question: Q_BACK },
  { id: "p13", kind: "debt_three_options", status: "answered", created_at: "2026-09-04T10:01:00Z", question: Q_REOPEN },
  { id: "p14", kind: "post_payment_link", status: "answered", created_at: "2026-09-04T10:01:30Z", question: Q_REOPEN },
  { id: "p15", kind: "debt_three_options", status: "answered", created_at: "2026-09-04T10:02:00Z", question: Q_REOPEN },
  { id: "p16", kind: "debt_three_options", status: "answered", created_at: "2026-09-04T10:02:21Z", question: Q_REOPEN },
  { id: "p17", kind: "post_payment_link", status: "superseded", created_at: "2026-09-04T10:02:30Z", question: Q_REOPEN },
  // login do dia seguinte (retomada): o bootstrap supersede o pós-link e cria o
  // menu de 3 opções em modo inicial (pergunta vazia) — o MENU CORRENTE.
  { id: "p18", kind: "debt_three_options", status: "active", created_at: "2026-09-05T08:00:00Z", question: "" },
]

function msg(
  id: string,
  role: FixtureMessage["role"],
  text: string,
  created_at: string,
  extra: Partial<Omit<FixtureMessage, "id" | "role" | "text" | "created_at">> = {},
): FixtureMessage {
  return {
    id,
    role,
    text,
    created_at,
    button_id: extra.button_id ?? null,
    prompt_id: extra.prompt_id ?? null,
    engine: extra.engine ?? (role === "assistant" ? "platform" : null),
    offers_snapshot: extra.offers_snapshot ?? null,
  }
}

export const RESUME_MESSAGES: FixtureMessage[] = [
  // ---- G0: reconhecimento Sim/Não ----
  msg("m01", "customer", "Sim, reconheço", "2026-09-01T10:00:10Z", { button_id: 1, prompt_id: "p01" }),
  // ---- G1: Consultar/Negociar (3 rodadas em dias diferentes) ----
  msg("m02", "assistant", Q_LEGACY_CONSULT, "2026-09-01T10:05:00Z", { prompt_id: "p02" }),
  msg("m03", "customer", "Consultar Dívida", "2026-09-01T10:05:05Z", { button_id: 2, prompt_id: "p02" }),
  msg("m04", "assistant", LEGACY_INFO, "2026-09-01T10:05:06Z"),
  msg("m05", "assistant", "Como deseja seguir?", "2026-09-01T10:05:10Z", { prompt_id: "p03" }),
  msg("m06", "assistant", "Muito obrigado pela confirmação, **Ana**!", "2026-09-01T10:06:00Z", { engine: "n8n" }),
  msg("m07", "customer", "Negociar Dívida", "2026-09-01T10:07:00Z", { button_id: 3, prompt_id: "p03" }),
  msg("m08", "assistant", LEGACY_INFO, "2026-09-01T10:07:01Z"),
  msg("m09", "assistant", "Perfeito! Então vamos trabalhar juntos para sanar o seu débito.", "2026-09-01T10:07:03Z"),
  msg("m10", "assistant", Q_LEGACY_CONSULT, "2026-09-02T09:00:00Z", { prompt_id: "p04" }),
  msg("m11", "customer", "Consultar Dívida", "2026-09-02T09:00:05Z", { button_id: 2, prompt_id: "p04" }),
  msg("m12", "assistant", LEGACY_INFO.replace("dívida", "pendência"), "2026-09-02T09:00:06Z"),
  msg("m13", "assistant", "Olá! Este é o canal de atendimento automático da **AlteaPay**. Por favor, selecione uma das **opções válidas**.", "2026-09-02T09:00:10Z", { engine: "n8n" }),
  // ---- G2 (copy antiga do menu de 3 opções, com valor na pergunta) ----
  msg("m14", "assistant", Q_OLD_THREE, "2026-09-03T09:00:00Z", { prompt_id: "p05" }),
  msg("m15", "customer", "Consultar dívida", "2026-09-03T09:00:30Z", { button_id: 2, prompt_id: "p05" }),
  msg("m16", "assistant", "Vencimento original: 15/08/2026. Trata-se de um serviço oferecido pela VMAX.", "2026-09-03T09:00:31Z"),
  msg("m17", "assistant", Q_OLD_THREE, "2026-09-03T09:10:00Z", { prompt_id: "p06" }),
  msg("m18", "customer", "Consultar dívida", "2026-09-03T09:10:30Z", { button_id: 2, prompt_id: "p06" }),
  msg("m19", "assistant", "Vencimento original: 15/08/2026. Trata-se de um serviço oferecido pela VMAX.", "2026-09-03T09:10:31Z"),
  // ---- G2: negociar (offer_choice) → voltar → pagar (link pré-A1 como texto) ----
  msg("m20", "assistant", "Estas são as condições disponíveis para você. Escolha a que preferir.", "2026-09-04T09:01:00Z", { prompt_id: "p07" }),
  msg("m21", "assistant", "Muito obrigado pela confirmação, **Ana**!", "2026-09-04T09:01:05Z", { engine: "n8n" }),
  msg("m22", "customer", "Voltar às opções", "2026-09-04T09:01:30Z", { button_id: 98, prompt_id: "p07" }),
  msg("m23", "assistant", Q_THREE, "2026-09-04T09:02:00Z", { prompt_id: "p08" }),
  msg("m24", "customer", "Quero pagar — R$ 250,00", "2026-09-04T09:02:30Z", { button_id: 4, prompt_id: "p08" }),
  msg("m25", "assistant", LINK_TEXT(1, "07/09/2026"), "2026-09-04T09:02:40Z"),
  msg("m26", "assistant", "Você já tem uma cobrança ativa de R$ 250,00. Use o mesmo link abaixo — não é preciso gerar outro.\nhttps://pay.example.test/c/1", "2026-09-04T09:03:00Z"),
  // ---- G2 pós-A1: saudação única, Detalhes (outcome stage=detail) ×2, Não reconheço, Voltar, Pagar (link com ação) ----
  msg("m27", "assistant", "Olá, Ana. Encontramos um valor em aberto em seu nome com a VMAX. Dá para resolver agora mesmo por aqui.", "2026-09-04T10:00:00Z", { offers_snapshot: { stage: "greeting" } }),
  msg("m28", "customer", "Consultar dívida", "2026-09-04T10:00:20Z", { button_id: 2, prompt_id: "p09" }),
  msg("m29", "assistant", DETAIL, "2026-09-04T10:00:20Z", { prompt_id: "p09", offers_snapshot: { stage: "detail" } }),
  msg("m30", "assistant", Q_REOPEN, "2026-09-04T10:00:21Z", { prompt_id: "p10" }),
  msg("m31", "customer", "Consultar dívida", "2026-09-04T10:00:25Z", { button_id: 2, prompt_id: "p10" }),
  msg("m32", "assistant", DETAIL, "2026-09-04T10:00:25Z", { prompt_id: "p10", offers_snapshot: { stage: "detail" } }),
  msg("m33", "assistant", Q_REOPEN, "2026-09-04T10:00:26Z", { prompt_id: "p11" }),
  msg("m34", "customer", "Não reconheço esta dívida", "2026-09-04T10:00:40Z", { button_id: 0, prompt_id: "p11" }),
  msg("m35", "assistant", "Registramos que você não reconhece esta cobrança e não vamos gerar nenhum pagamento agora. Para entender a origem e contestar, fale com a VMAX.", "2026-09-04T10:00:40Z", { prompt_id: "p11", offers_snapshot: { stage: "not_recognized" } }),
  msg("m36", "assistant", Q_BACK, "2026-09-04T10:00:41Z", { prompt_id: "p12" }),
  msg("m37", "customer", "Na verdade, quero ver as opções", "2026-09-04T10:00:59Z", { button_id: 98, prompt_id: "p12" }),
  msg("m38", "assistant", Q_REOPEN, "2026-09-04T10:01:00Z", { prompt_id: "p13" }),
  msg("m39", "customer", "Quero pagar — R$ 250,00", "2026-09-04T10:01:20Z", { button_id: 4, prompt_id: "p13" }),
  msg("m40", "assistant", LINK_TEXT(2, "07/09/2026"), "2026-09-04T10:01:29Z", { offers_snapshot: { stage: "payment_link", valor: 250, message_action: linkAction(2) } }),
  msg("m41", "assistant", Q_REOPEN, "2026-09-04T10:01:30Z", { prompt_id: "p14" }),
  msg("m42", "customer", "Voltar às opções", "2026-09-04T10:01:59Z", { button_id: 98, prompt_id: "p14" }),
  msg("m43", "assistant", Q_REOPEN, "2026-09-04T10:02:00Z", { prompt_id: "p15" }),
  // dois cliques consecutivos em Pagar SEM outcome entre eles (o 1º falhou no
  // transporte) → colapsam em um; o 2º produz o link vivo.
  msg("m44", "customer", "Quero pagar — R$ 250,00", "2026-09-04T10:02:20Z", { button_id: 4, prompt_id: "p15" }),
  msg("m45", "customer", "Quero pagar — R$ 250,00", "2026-09-04T10:02:25Z", { button_id: 4, prompt_id: "p16" }),
  msg("m46", "assistant", LINK_TEXT(3, "08/09/2026"), "2026-09-04T10:02:29Z", { offers_snapshot: { stage: "payment_link", valor: 250, message_action: linkAction(3) } }),
  msg("m47", "assistant", Q_REOPEN, "2026-09-04T10:02:30Z", { prompt_id: "p17" }),
]

/** O menu corrente da retomada (shape do active_prompt do GET, com created_at). */
export const RESUME_ACTIVE_PROMPT = {
  id: "p18",
  kind: "debt_three_options",
  question: "",
  buttons: [
    { id: 4, label: "Pagar R$ 250,00", order: 0 },
    { id: 1, label: "Negociar", order: 1 },
    { id: 2, label: "Detalhes da dívida", order: 2 },
    { id: 0, label: "Não reconheço", order: 3 },
  ],
  created_at: "2026-09-05T08:00:00Z",
}
