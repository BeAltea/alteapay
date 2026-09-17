// Enums oficiais da Voxuy (Apêndice A.2 do PROMPT_VOXUY_2026-09-17).
// A AlteaPay SÓ usa os valores "99" (evento personalizado). As demais tabelas
// (venda/pedido/logística) ficam aqui como constantes tipadas para o dia em que
// um tenant quiser outro fluxo — NÃO SÃO USADAS na jornada de cobrança.

/** Tipos de Pagamento (Voxuy). Só usamos `NENHUM` (99). */
export const VOXUY_PAYMENT_TYPE = {
  GRATUITO: 0,
  BOLETO: 1,
  CARTAO_CREDITO: 2,
  PAYPAL: 3,
  BOLETO_PARCELADO: 4,
  DEPOSITO_BANCARIO: 5,
  DEPOSITO_EM_CONTA: 6,
  PIX: 7,
  CARTEIRA_DIGITAL: 8,
  // Único usado pela AlteaPay: carrinho abandonado / mensagem externa / evento
  // personalizado. Ver §1.3.
  NENHUM: 99,
} as const

/** Status do Pedido (Voxuy). Só usamos `NENHUM_DESCONHECIDO` (99). */
export const VOXUY_ORDER_STATUS = {
  PENDENTE: 0,
  PAGAMENTO_APROVADO: 1,
  CANCELADO: 2,
  CHARGEBACK: 3,
  ESTORNADO: 4,
  EM_ANALISE: 5,
  AGUARDANDO_ESTORNO: 6,
  PROCESSANDO_CARTAO: 7,
  PARCIALMENTE_PAGO: 8,
  BLOQUEADO: 9,
  REJEITADO: 10,
  DUPLICADO: 11,
  ASSINATURA_CRIADA: 20,
  ASSINATURA_ATRASADA: 21,
  ASSINATURA_CANCELADA: 22,
  ASSINATURA_RENOVADA: 23,
  ASSINATURA_PAGA: 24,
  ASSINATURA_ESTORNADA: 25,
  CARRINHO_ABANDONADO_ASSINATURA: 26,
  CARRINHO_ABANDONADO: 80,
  // Único usado pela AlteaPay: evento personalizado. Ver §1.3.
  NENHUM_DESCONHECIDO: 99,
} as const

/** Status de Logística (Voxuy). NÃO usado — domínio de e-commerce. */
export const VOXUY_LOGISTICS_STATUS = {
  NENHUM: 0,
  ETIQUETA_EMITIDA: 8,
  POSTADO: 1,
  EM_TRANSITO: 2,
  RETIRADA: 3,
  SAIU_PARA_ENTREGA: 5,
  ENTREGUE: 6,
} as const

// Valores fixos que a AlteaPay envia em TODA transação de cobrança (V6/§1.3).
export const ALTEAPAY_PAYMENT_TYPE = VOXUY_PAYMENT_TYPE.NENHUM // 99
export const ALTEAPAY_ORDER_STATUS = VOXUY_ORDER_STATUS.NENHUM_DESCONHECIDO // 99

// Lembrete de contrato (§1.3): valores monetários na Voxuy são Integer em
// centavos, sem vírgula (R$ 69,90 => 6990). A AlteaPay envia SEMPRE `null` em
// value/totalValue/freight — a mensagem não leva valor. Este comentário existe
// para ninguém mandar reais por engano no futuro.
export const VOXUY_MONEY_IS_CENTS_INTEGER = true
