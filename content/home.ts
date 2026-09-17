/**
 * Copy final da home (fonte: ops/home-seo-2026-09/reports/F1_copy.md).
 * Config institucional (URLs, contatos, dados legais) vive em content/site.ts;
 * campos opcionais ausentes la NAO renderizam nada (nem placeholder).
 */

import { CONTACT_EMAIL, LOGIN_URL, PORTAL_URL, PRIVACY_URL, REGISTER_URL, TERMS_URL, site } from "./site"

export const hero = {
  h1: "Cobrança inteligente e recuperação de crédito para empresas e para o setor público",
  subtitle:
    "A AlteaPay contata, negocia e concilia por você. Régua de cobrança por WhatsApp, SMS e e-mail, pagamento por Pix, boleto ou cartão na própria conversa e painel com cada real recuperado. Remuneração por resultado, LGPD e contratação pública desde o desenho.",
  ctaPrimary: { label: "Agendar demonstração", href: "#contato" },
  ctaWhatsAppLabel: "Falar no WhatsApp",
  // Fallback do CTA secundario sem WhatsApp configurado (C.2): e-mail direto
  ctaFallback: { label: "Enviar e-mail", href: `mailto:${CONTACT_EMAIL}` },
  loginLink: { label: "Já é cliente? Entrar", href: LOGIN_URL },
  trustBand: [
    "Pix, boleto e cartão",
    "LGPD em todo contato",
    "Modelo por resultado",
    "Pronto para a Lei 14.133/2021",
  ],
}

export const audiences = {
  h2: "Para quem é",
  items: [
    {
      title: "Empresas privadas.",
      description:
        "Provedores de internet e telecom, concessionárias, educação, saúde, condomínios e serviços recorrentes. Carteiras de mil a um milhão de clientes.",
      link: { label: "Ver solução para empresas", href: "#empresas" },
    },
    {
      title: "Setor público.",
      description:
        "Prefeituras, secretarias de fazenda, procuradorias e autarquias. Dívida ativa de IPTU, ISS, taxas e multas, na fase administrativa.",
      link: { label: "Ver solução para o setor público", href: "#setor-publico" },
    },
    {
      title: "Pequenos negócios.",
      description: "Fale com a gente e receba uma proposta simples, sem mensalidade obrigatória.",
      link: { label: "Falar com a gente", href: "#contato" },
    },
  ],
}

export const howItWorks = {
  h2: "Como funciona",
  steps: [
    {
      title: "Carteira.",
      description:
        "Você envia a carteira por planilha ou integração. Nós higienizamos e enriquecemos os dados de contato.",
    },
    {
      title: "Priorização.",
      description:
        "Classificação por tempo de atraso e perfil da carteira define quem contatar, quando e com qual condição.",
    },
    {
      title: "Contato e negociação.",
      description:
        "Régua multicanal por WhatsApp, SMS e e-mail, com cancelamento a pedido e ofertas dentro das regras que você define.",
    },
    {
      title: "Pagamento e conciliação.",
      description:
        "Pix, boleto ou cartão gerados na hora. Baixa automática, acordo registrado e relatório por cliente.",
    },
  ],
}

export const features = {
  h2: "Tudo o que a operação de cobrança precisa, em uma plataforma",
  items: [
    {
      icon: "clock" as const,
      title: "Régua de cobrança automatizada",
      description:
        "Sequências por canal e faixa de atraso, com pausa automática após o pagamento.",
    },
    {
      icon: "handshake" as const,
      title: "Negociação e acordos",
      description:
        "Descontos por faixa de atraso, entrada e parcelamento definidos por você. Acordo registrado com data, condições e aceite. Negociação assistida em implantação.",
    },
    {
      icon: "layout" as const,
      title: "Portal do cliente",
      description: "A pessoa consulta o débito, emite segunda via e acompanha o acordo.",
    },
    {
      icon: "credit-card" as const,
      title: "Pagamentos integrados",
      description:
        "Pix, boleto e cartão emitidos por instituição de pagamento parceira, com conciliação automática.",
    },
    {
      icon: "database" as const,
      title: "Inteligência de dados",
      description:
        "Enriquecimento cadastral e localização de contatos para priorizar a carteira.",
    },
    {
      icon: "bar-chart" as const,
      title: "Painéis e relatórios",
      description:
        "Visão por carteira, canal e período; exportação para prestação de contas; trilha de auditoria de cada ação.",
    },
    {
      icon: "code" as const,
      title: "Integrações e API",
      description:
        "Importação por planilha e API sob demanda para automatizar a troca de dados.",
    },
  ],
}

export const companies = {
  h2: "Reduza a inadimplência sem aumentar a equipe",
  intro:
    "A AlteaPay assume a operação de cobrança da sua carteira ou dá à sua equipe a plataforma para operar. Você define as regras de desconto e parcelamento; a plataforma contata, negocia, cobra e concilia.",
  bullets: [
    "Início da operação em poucos dias, por planilha ou integração",
    "Régua respeitosa, com cancelamento a pedido",
    "Pix, boleto e cartão sem sair da conversa",
    "Relatório de recuperação por carteira e por canal",
  ],
  cta: { label: "Agendar demonstração", href: "#contato" },
}

export const publicSector = {
  h2: "Recuperação de dívida ativa sem custo fixo para o município",
  intro:
    "A AlteaPay atua na fase administrativa da cobrança, antes do protesto e da execução fiscal, em linha com a Resolução CNJ 547/2024 e com o Tema 1184 do STF. O contribuinte é contatado com respeito, negocia pelo WhatsApp e paga por Pix ou boleto. A prefeitura acompanha tudo em painel próprio.",
  bullets: [
    "Contratação pela Lei 14.133/2021, com remuneração vinculada ao resultado (art. 144), valor por cobrança ou modelo híbrido.",
    "Sigilo fiscal (CTN, art. 198) e LGPD: dados tratados sob contrato, com finalidade definida, acesso por papel e trilha de auditoria.",
    "Relatórios prontos para prestação de contas e controle externo.",
    "Operação em nuvem, sem infraestrutura nova para o município.",
  ],
  cta: { label: "Solicitar proposta para o município", href: "/?tipo=publico#contato" },
  note: "Também atendemos por adesão via parceiros públicos de tecnologia.",
}

export const pricingModels = {
  h2: "Você escolhe como pagar",
  items: [
    {
      title: "Por resultado",
      description: "Percentual sobre o valor recuperado. Sem custo fixo.",
    },
    {
      title: "Por cobrança",
      description: "Valor fixo por acionamento, com previsibilidade orçamentária.",
    },
    {
      title: "Híbrido",
      description: "Plataforma a custo reduzido mais percentual menor sobre o recuperado.",
    },
  ],
  note: "Para equipes que operam a própria cobrança, a plataforma também é oferecida como assinatura. Condições definidas em proposta.",
}

export const compliance = {
  h2: "Conformidade e segurança em cada contato",
  items: [
    {
      title: "LGPD",
      description:
        "Finalidade e base legal definidas em contrato e direitos do titular atendidos.",
      link: { label: "Política de privacidade", href: PRIVACY_URL },
    },
    {
      title: "Cobrança respeitosa",
      description:
        "Sem constrangimento e com cancelamento a pedido, conforme o Código de Defesa do Consumidor (art. 42).",
    },
    {
      title: "Segurança",
      description:
        "Criptografia em trânsito, isolamento de dados por cliente, controle de acesso por papel e registro de auditoria.",
    },
    {
      title: "Pagamentos",
      description:
        "Pix, boleto e cartão emitidos por instituição de pagamento parceira; a AlteaPay não armazena dados de cartão.",
    },
    {
      title: "Contratação pública",
      description: "Modelo de contrato administrativo compatível com a Lei 14.133/2021.",
    },
  ],
}

export const citizenNotice = {
  h2: "Recebeu uma mensagem da AlteaPay?",
  intro:
    "A AlteaPay é a parceira oficial de cobrança de empresas e órgãos públicos. Se você recebeu um contato nosso, existe um débito em seu nome com um dos nossos clientes. Você pode consultar, negociar e pagar com segurança, no seu tempo.",
  verifyTitle: "Como saber se é verdadeiro",
  verifyItems: [
    "Nossos links levam sempre para um endereço que termina em alteapay.com.",
    "Nunca pedimos senha, código de verificação ou dados de cartão por mensagem.",
    "Pix e boletos são emitidos em nome de Altea. Confira o beneficiário antes de pagar.",
    "Você pode cancelar o recebimento de mensagens a qualquer momento pelos nossos canais de atendimento.",
  ],
  actionsTitle: "O que você pode fazer",
  actionsItems: [
    "Consultar o débito e as condições no Portal do Cliente.",
    "Negociar desconto ou parcelamento e pagar por Pix, boleto ou cartão.",
    "Falar com nosso atendimento se não reconhecer o débito.",
  ],
  ctaPortal: { label: "Acessar o Portal do Cliente", href: PORTAL_URL },
  ctaSupport: { label: "Falar com atendimento", href: "#contato" },
}

export const faq = {
  h2: "Perguntas frequentes",
  items: [
    {
      question: "O que é a AlteaPay?",
      answer:
        "Uma plataforma de cobrança e recuperação de crédito para empresas e para o setor público. Contatamos, negociamos e conciliamos pagamentos, com remuneração ligada ao resultado.",
    },
    {
      question: "Recebi uma cobrança da AlteaPay. É verdadeira?",
      answer:
        "Se a mensagem leva a um endereço alteapay.com e não pede senha nem dados de cartão, é nossa. Em dúvida, acesse o Portal do Cliente diretamente ou fale com o atendimento.",
    },
    {
      question: "Quanto custa?",
      answer:
        "Depende do modelo: por resultado (sem custo fixo), por cobrança ou híbrido. As condições são definidas em proposta.",
    },
    {
      question: "Como uma prefeitura contrata a AlteaPay?",
      answer:
        "Pela Lei 14.133/2021, com remuneração por resultado, por cobrança ou híbrida, em contrato administrativo com cláusulas de LGPD e sigilo fiscal. Também por adesão via parceiros públicos de tecnologia.",
    },
    {
      question: "Quais canais são usados?",
      answer: "WhatsApp, SMS e e-mail, com cancelamento a pedido.",
    },
    {
      question: "Quais formas de pagamento?",
      answer: "Pix, boleto e cartão, com conciliação automática.",
    },
    {
      question: "Como os dados pessoais são tratados?",
      answer:
        "Conforme a LGPD, com finalidade definida em contrato, acesso por papel e registro de auditoria. Veja a política de privacidade.",
    },
    {
      question: "Preciso trocar meu sistema?",
      answer:
        "Não. A carteira entra por planilha ou integração e a plataforma devolve os resultados em relatório.",
    },
    {
      question: "Posso parar de receber mensagens?",
      answer:
        "Sim. Fale com o atendimento pelo canal que preferir; o cancelamento vale para todos os canais.",
    },
    {
      question: "Em quanto tempo a operação começa?",
      answer:
        "Depois da assinatura e do envio da carteira, a primeira régua costuma sair em poucos dias.",
    },
  ],
}

export const contact = {
  h2: "Fale com a AlteaPay",
  intro: `Conte em poucas linhas sobre a sua carteira ou o seu município. Respondemos em até ${site.responseTime}.`,
  typeOptions: [
    { value: "empresa", label: "Empresa" },
    { value: "orgao_publico", label: "Órgão público" },
    { value: "recebi_cobranca", label: "Recebi uma cobrança" },
  ],
  lgpdLabel: "Li e concordo com a Política de Privacidade.",
  submitLabel: "Enviar",
  whatsappLabel: "Falar no WhatsApp",
  successMessage: `Mensagem enviada. Respondemos em até ${site.responseTime}.`,
  errorMessage: `Não foi possível enviar sua mensagem. Tente novamente ou escreva para ${CONTACT_EMAIL}.`,
  citizenGuidance:
    "Se você recebeu uma cobrança, não precisa preencher o formulário. Consulte o débito e negocie direto no Portal do Cliente, ou fale com nosso atendimento pelos canais abaixo.",
}

export const footer = {
  description:
    "Plataforma de cobrança e recuperação de crédito para empresas e para o setor público.",
  nav: {
    title: "Navegação",
    links: [
      { label: "Soluções", href: "/#solucoes" },
      { label: "Empresas", href: "/#empresas" },
      { label: "Setor público", href: "/#setor-publico" },
      { label: "Conformidade", href: "/#conformidade" },
      { label: "FAQ", href: "/#faq" },
      { label: "Contato", href: "/#contato" },
    ],
  },
  access: {
    title: "Acesso",
    links: [
      { label: "Entrar", href: LOGIN_URL },
      { label: "Criar conta", href: REGISTER_URL },
      { label: "Portal do Cliente", href: PORTAL_URL },
    ],
  },
  legal: {
    title: "Legal",
    links: [
      { label: "Política de Privacidade", href: PRIVACY_URL },
      { label: "Termos de Uso", href: TERMS_URL },
    ],
  },
  contactTitle: "Contato",
}

export const seo = {
  title: "AlteaPay | Cobrança inteligente e recuperação de crédito",
  description:
    "Plataforma de cobrança e recuperação de crédito para empresas e dívida ativa municipal. WhatsApp, Pix e boleto, remuneração por resultado e LGPD.",
}

export const homeNav = [
  { label: "Soluções", href: "/#solucoes" },
  { label: "Empresas", href: "/#empresas" },
  { label: "Setor público", href: "/#setor-publico" },
  { label: "Conformidade", href: "/#conformidade" },
  { label: "FAQ", href: "/#faq" },
  { label: "Contato", href: "/#contato" },
]
