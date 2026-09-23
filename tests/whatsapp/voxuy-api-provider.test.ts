// VoxuyApiProvider — disparo por API (Hub de negociações / link único).
// Cobre o dialeto DEFAULT enterprise_v1 (contrato REAL: {flowId, contact}, SEM
// transaction/document/email; E.164 exigido; success minúsculo; message
// truncada no 400; URL NUNCA logada), os legados transaction_v1/custom, a trava
// final de PII/valor e a classificação de resposta. Nada sai do processo real.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  VoxuyApiProvider,
  VoxuyTemplateError,
  assertFinalPayloadSafe,
  buildEnterprisePayload,
  classifyEnterpriseResponse,
  resolveTemplate,
} from "@/lib/whatsapp/voxuy/api-provider"
import type { VoxuyApiConfig } from "@/lib/whatsapp/voxuy/config"
import type { SendCampaignMessageInput } from "@/lib/whatsapp/provider"

const MSG_ID = "11111111-2222-3333-4444-555555555555"

const baseInput: SendCampaignMessageInput = {
  companyId: "co1",
  messageId: MSG_ID,
  to: "+5511912341234",
  customerName: "Fabio Silva Santos",
  document: "12345678901",
  templateKey: "default",
  variables: {
    consult_url: "https://alteapay.com/n/AbC123",
    optout_url: "https://alteapay.com/n/AbC123/cancelar",
    block_url: "https://alteapay.com/n/AbC123/bloquear",
    brand_name: "AlteaPay",
    sender_label: "AlteaPay",
    creditor_name: "VMAX",
    first_name: "Fabio",
  },
  voxuyPlanId: "plan_x",
  voxuyEvent: 63,
}

// URL-credencial (formato CANÔNICO: webhooks.voxuy.com/voxuyapi/<uuid>). O uuid
// É O SEGREDO (identifica a conta) — nunca deve vazar em log. O uuid abaixo usa
// só chars hex válidos ([0-9a-f-]) e embute "deadbeef" p/ caçá-lo nos logs.
const SECRET_TOKEN = "deadbeef-cafe-babe-f00d-9f3a1b2c3d4e"
const SECRET_URL = `https://webhooks.voxuy.com/voxuyapi/${SECRET_TOKEN}`

const enterpriseConfig: VoxuyApiConfig = {
  dialect: "enterprise_v1",
  webhookUrl: SECRET_URL,
  timeoutMs: 10_000,
  flowId: 42,
}

const transactionConfig: VoxuyApiConfig = {
  dialect: "transaction_v1",
  webhookUrl: "https://sistema.voxuy.com/api/abc/webhooks/voxuy/transaction",
  apiToken: "tok",
  timeoutMs: 10_000,
  planId: "plan_x",
}

const customConfig: VoxuyApiConfig = {
  dialect: "custom",
  apiToken: "tok",
  timeoutMs: 10_000,
  planId: "plan_x",
  custom: {
    request: {
      method: "POST",
      url: "https://enterprise.voxuy.com/v2/dispatch",
      headers: { Authorization: "Bearer {{apiToken}}" },
    },
    flowId: "flow_42",
    payloadTemplate: {
      flow: "{{flowId}}",
      plan: "{{planId}}",
      to: "{{phone}}",
      externalId: "{{messageId}}",
      params: { name: "{{firstName}}", url: "{{link}}", brand: "{{brandName}}", creditor: "{{creditorName}}" },
    },
  },
}

// fetch fake: captura a última chamada e devolve a resposta programada.
function fakeFetch(status: number, body: string, opts?: { delayMs?: number }) {
  const calls: Array<{ url: string; method?: string; headers?: Record<string, string>; body?: string }> = []
  const fn = vi.fn(async (url: string, init: RequestInit & { signal?: AbortSignal }) => {
    calls.push({
      url,
      method: init.method,
      headers: init.headers as Record<string, string>,
      body: init.body as string,
    })
    if (opts?.delayMs) {
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, opts.delayMs)
        init.signal?.addEventListener("abort", () => {
          clearTimeout(t)
          const e = new Error("aborted")
          e.name = "AbortError"
          reject(e)
        })
      })
    }
    return {
      status,
      text: async () => body,
    } as unknown as Response
  })
  return { fn, calls }
}

describe("buildEnterprisePayload (contrato REAL)", () => {
  it("emite { flowId, contact:{ name, phoneNumber, variables } } com as 3 chaves", () => {
    const p = buildEnterprisePayload({
      flowId: 7,
      firstName: "Fabio",
      phoneE164: "+5511912341234",
      link: "https://alteapay.com/n/AbC",
      creditorName: "VMAX",
    })
    expect(p).toEqual({
      flowId: 7,
      contact: {
        name: "Fabio",
        phoneNumber: "+5511912341234",
        variables: {
          link_negociacao: "https://alteapay.com/n/AbC",
          primeiro_nome: "Fabio",
          credor: "VMAX",
        },
      },
    })
    // Nunca leva document/email/transaction/valores.
    const json = JSON.stringify(p)
    expect(json).not.toMatch(/document|cpf|email|transaction|value/i)
  })
})

describe("resolveTemplate", () => {
  it("resolve placeholders conhecidos (string, objeto, array)", () => {
    const { resolved, unknownKeys } = resolveTemplate(
      { a: "{{phone}}", b: ["{{firstName}}", { c: "{{link}}" }] },
      { phone: "+5511912341234", firstName: "Fabio", link: "https://x/n/A" },
    )
    expect(unknownKeys).toEqual([])
    expect(resolved).toEqual({ a: "+5511912341234", b: ["Fabio", { c: "https://x/n/A" }] })
  })

  it("placeholder DESCONHECIDO é reportado (erro de config)", () => {
    const { unknownKeys } = resolveTemplate({ x: "{{cpf}}", y: "{{valor}}" }, { phone: "+55" })
    expect(unknownKeys.sort()).toEqual(["cpf", "valor"])
  })
})

describe("assertFinalPayloadSafe (trava de PII/valor)", () => {
  it("aceita corpo enterprise com contact.phoneNumber E.164 e sem PII", () => {
    const body = buildEnterprisePayload({
      flowId: 1, firstName: "F", phoneE164: "+5511912341234", link: "https://x/n/A", creditorName: "V",
    })
    expect(() => assertFinalPayloadSafe(body)).not.toThrow()
  })

  it("barra document no contato aninhado do enterprise", () => {
    expect(() =>
      assertFinalPayloadSafe({ flowId: 1, contact: { phoneNumber: "+5511912341234", document: "123" } }),
    ).toThrow(/document/)
  })

  it("barra contact.phoneNumber fora de E.164", () => {
    expect(() =>
      assertFinalPayloadSafe({ flowId: 1, contact: { phoneNumber: "11912341234" } }),
    ).toThrow(/E\.164/)
  })

  it("barra transaction não-nula (enterprise não leva transação)", () => {
    expect(() =>
      assertFinalPayloadSafe({ flowId: 1, contact: { phoneNumber: "+5511912341234" }, transaction: { value: 1 } }),
    ).toThrow(/transaction/)
  })

  it("barra clientDocument com valor (legado)", () => {
    expect(() => assertFinalPayloadSafe({ clientPhoneNumber: "+5511912341234", clientDocument: "123" })).toThrow(
      /clientDocument/,
    )
  })

  it("barra valor monetário não-nulo", () => {
    expect(() => assertFinalPayloadSafe({ value: 6990 })).toThrow(/value/)
    expect(() => assertFinalPayloadSafe({ totalValue: 100 })).toThrow(/totalValue/)
    expect(() => assertFinalPayloadSafe({ amount: 1 })).toThrow(/amount/)
  })

  it("barra telefone fora de E.164 (legado)", () => {
    expect(() => assertFinalPayloadSafe({ phone: "11912341234" })).toThrow(/E\.164/)
  })

  // W1.2 — variables estrito: SÓ as 3 chaves previstas.
  it("aceita contact.variables com EXATAMENTE as 3 chaves", () => {
    expect(() =>
      assertFinalPayloadSafe({
        flowId: 1,
        contact: {
          phoneNumber: "+5511912341234",
          variables: { link_negociacao: "https://x/n/A", primeiro_nome: "F", credor: "V" },
        },
      }),
    ).not.toThrow()
  })

  it("W1.2 — barra QUALQUER chave extra em contact.variables (ex.: cpf/valor)", () => {
    expect(() =>
      assertFinalPayloadSafe({
        flowId: 1,
        contact: {
          phoneNumber: "+5511912341234",
          variables: { link_negociacao: "https://x/n/A", primeiro_nome: "F", credor: "V", cpf: "123" },
        },
      }),
    ).toThrow()
    expect(() =>
      assertFinalPayloadSafe({
        flowId: 1,
        contact: {
          phoneNumber: "+5511912341234",
          variables: { link_negociacao: "https://x/n/A", primeiro_nome: "F", credor: "V", valor: "6990" },
        },
      }),
    ).toThrow()
  })
})

describe("classifyEnterpriseResponse (success minúsculo + message truncada)", () => {
  it("200 + success:true (minúsculo) => accepted", () => {
    expect(classifyEnterpriseResponse(200, { success: true }, true).accepted).toBe(true)
  })

  it("200 + Success:true (maiúsculo, case-insensitive) => accepted", () => {
    expect(classifyEnterpriseResponse(200, { Success: true }, true).accepted).toBe(true)
  })

  it("200 + success:false => failed validation com message", () => {
    const r = classifyEnterpriseResponse(200, { success: false, message: "flow inexistente" }, true)
    expect(r.accepted).toBe(false)
    expect(r.errorClass).toBe("validation")
    expect(r.note).toBe("flow inexistente")
  })

  it("400 + { success:false, message } => failed validation, message truncada", () => {
    const long = "x".repeat(500)
    const r = classifyEnterpriseResponse(400, { success: false, message: long }, true)
    expect(r.accepted).toBe(false)
    expect(r.errorClass).toBe("validation")
    expect((r.note ?? "").length).toBeLessThan(long.length)
  })

  it("401/403 => config; 429/5xx => retryable", () => {
    expect(classifyEnterpriseResponse(401, {}, true).errorClass).toBe("config")
    expect(classifyEnterpriseResponse(403, {}, true).errorClass).toBe("config")
    expect(classifyEnterpriseResponse(429, {}, true).errorClass).toBe("retryable")
    expect(classifyEnterpriseResponse(503, "<html>", false).errorClass).toBe("retryable")
  })

  // W1.4 — 5xx (500/502/503) sempre retryável, independente do corpo.
  it("W1.4 — 500/502/503 => retryable", () => {
    expect(classifyEnterpriseResponse(500, {}, true).errorClass).toBe("retryable")
    expect(classifyEnterpriseResponse(502, "<html>bad gateway</html>", false).errorClass).toBe("retryable")
    expect(classifyEnterpriseResponse(503, { success: false }, true).errorClass).toBe("retryable")
  })
})

describe("VoxuyApiProvider — dialeto enterprise_v1 (DEFAULT)", () => {
  let ffetch: ReturnType<typeof fakeFetch>
  beforeEach(() => {
    ffetch = fakeFetch(200, JSON.stringify({ success: true }))
    vi.stubGlobal("fetch", ffetch.fn)
  })
  afterEach(() => vi.unstubAllGlobals())

  it("POSTa { flowId, contact } — SEM apiToken/Bearer/transaction/document/email", async () => {
    const p = new VoxuyApiProvider(enterpriseConfig)
    expect(p.dialect).toBe("enterprise_v1")
    const r = await p.sendCampaignMessage(baseInput)
    expect(r.accepted).toBe(true)
    expect(r.providerMessageId).toBe(MSG_ID)
    expect(ffetch.calls).toHaveLength(1)
    expect(ffetch.calls[0].url).toBe(SECRET_URL)
    // Sem Authorization/Bearer/apiToken: a conta é identificada pela URL.
    expect(ffetch.calls[0].headers?.Authorization).toBeUndefined()
    const sent = JSON.parse(ffetch.calls[0].body!)
    expect(sent).toEqual({
      flowId: 42,
      contact: {
        name: "Fabio",
        phoneNumber: "+5511912341234",
        variables: {
          link_negociacao: baseInput.variables.consult_url,
          primeiro_nome: "Fabio",
          credor: "VMAX",
        },
      },
    })
    // Nunca vaza document/apiToken/transaction/valores no corpo.
    const bodyStr = ffetch.calls[0].body!
    expect(bodyStr).not.toContain(baseInput.document)
    expect(bodyStr).not.toMatch(/apiToken|Bearer|transaction|"value"/i)
    // variables tem EXATAMENTE as 3 chaves.
    expect(Object.keys(sent.contact.variables).sort()).toEqual(["credor", "link_negociacao", "primeiro_nome"])
  })

  it("barra telefone não-E.164 antes de sair (nada é enviado)", async () => {
    const p = new VoxuyApiProvider(enterpriseConfig)
    const r = await p.sendCampaignMessage({ ...baseInput, to: "11912341234" })
    expect(r.accepted).toBe(false)
    expect(r.errorClass).toBe("validation")
    expect(ffetch.calls).toHaveLength(0)
  })

  it("sem flowId (fora do mock) => erro de config, nada enviado", async () => {
    const p = new VoxuyApiProvider({ ...enterpriseConfig, flowId: null })
    const r = await p.sendCampaignMessage(baseInput)
    expect(r.accepted).toBe(false)
    expect(r.errorClass).toBe("config")
    expect(ffetch.calls).toHaveLength(0)
  })

  // W1.1 — URL fora do formato canônico (host errado) => erro de config na
  // construção do dispatch; NADA sai e a URL não vaza no resultado/erro.
  it("W1.1 — URL não-canônica (host errado) => config, nada enviado, sem vazar a URL", async () => {
    const WRONG = "https://sistema.voxuy.com/api/COMPANY_SECRET/inbound"
    const p = new VoxuyApiProvider({ ...enterpriseConfig, webhookUrl: WRONG })
    const r = await p.sendCampaignMessage(baseInput)
    expect(r.accepted).toBe(false)
    expect(r.errorClass).toBe("config")
    expect(ffetch.calls).toHaveLength(0)
    expect(r.error ?? "").not.toContain(WRONG)
    expect(r.error ?? "").not.toContain("COMPANY_SECRET")
  })

  it("A URL (segredo) NUNCA aparece em log — sucesso e timeout", async () => {
    const logs: string[] = []
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(" "))
    })
    try {
      // sucesso
      await new VoxuyApiProvider(enterpriseConfig).sendCampaignMessage(baseInput)
      // timeout
      vi.stubGlobal("fetch", fakeFetch(200, "{}", { delayMs: 500 }).fn)
      await new VoxuyApiProvider({ ...enterpriseConfig, timeoutMs: 20 }).sendCampaignMessage(baseInput)
    } finally {
      spy.mockRestore()
    }
    const joined = logs.join("\n")
    expect(joined).not.toContain(SECRET_TOKEN)
    expect(joined).not.toContain("deadbeef")
    expect(joined).not.toContain(SECRET_URL)
  })

  it("400 => failed validation, message truncada em raw.note (potencialmente sensível)", async () => {
    vi.stubGlobal("fetch", fakeFetch(400, JSON.stringify({ success: false, message: "flowId inválido" })).fn)
    const r = await new VoxuyApiProvider(enterpriseConfig).sendCampaignMessage(baseInput)
    expect(r.accepted).toBe(false)
    expect(r.errorClass).toBe("validation")
    expect((r.raw as { note?: string }).note).toBe("flowId inválido")
  })

  it("401 => failed config + pauseCampaign", async () => {
    vi.stubGlobal("fetch", fakeFetch(401, JSON.stringify({ success: false })).fn)
    const r = await new VoxuyApiProvider(enterpriseConfig).sendCampaignMessage(baseInput)
    expect(r.errorClass).toBe("config")
    expect((r.raw as { pauseCampaign?: boolean }).pauseCampaign).toBe(true)
  })

  it("429 => retryable (sem pauseCampaign)", async () => {
    vi.stubGlobal("fetch", fakeFetch(429, "{}").fn)
    const r = await new VoxuyApiProvider(enterpriseConfig).sendCampaignMessage(baseInput)
    expect(r.errorClass).toBe("retryable")
    expect((r.raw as { pauseCampaign?: boolean }).pauseCampaign).toBe(false)
  })

  // W1.4 — resposta 5xx do provider => failed RETRIÁVEL (retriable:true) e NUNCA
  // pausa a campanha (pauseCampaign:false). O BullMQ reprocessa com backoff.
  it("W1.4 — 500 => failed retriável, sem pausar a campanha", async () => {
    vi.stubGlobal("fetch", fakeFetch(500, "Internal Server Error").fn)
    const r = await new VoxuyApiProvider(enterpriseConfig).sendCampaignMessage(baseInput)
    expect(r.accepted).toBe(false)
    expect(r.errorClass).toBe("retryable")
    expect((r.raw as { pauseCampaign?: boolean }).pauseCampaign).toBe(false)
  })

  it("W1.4 — 503 (corpo não-JSON) => failed retriável, sem pausar a campanha", async () => {
    vi.stubGlobal("fetch", fakeFetch(503, "<html>503 Service Unavailable</html>").fn)
    const r = await new VoxuyApiProvider(enterpriseConfig).sendCampaignMessage(baseInput)
    expect(r.accepted).toBe(false)
    expect(r.errorClass).toBe("retryable")
    expect((r.raw as { pauseCampaign?: boolean }).pauseCampaign).toBe(false)
  })

  it("timeout => retryable (1 tentativa)", async () => {
    vi.stubGlobal("fetch", fakeFetch(200, "{}", { delayMs: 500 }).fn)
    const r = await new VoxuyApiProvider({ ...enterpriseConfig, timeoutMs: 20 }).sendCampaignMessage(baseInput)
    expect(r.accepted).toBe(false)
    expect(r.error).toBe("timeout")
    expect(r.errorClass).toBe("retryable")
  })

  it("sendStopSignal é no-op aceito (Enterprise não tem stop; supressão é nossa)", async () => {
    const p = new VoxuyApiProvider(enterpriseConfig)
    const r = await p.sendStopSignal!({ companyId: "co1", phone: "+5511912341234", customerId: "c9" })
    expect(r.accepted).toBe(true)
    expect(ffetch.calls).toHaveLength(0) // nada sai
  })
})

describe("VoxuyApiProvider — dialeto transaction_v1 (LEGADO)", () => {
  let ffetch: ReturnType<typeof fakeFetch>
  beforeEach(() => {
    ffetch = fakeFetch(200, JSON.stringify({ Success: true }))
    vi.stubGlobal("fetch", ffetch.fn)
  })
  afterEach(() => vi.unstubAllGlobals())

  it("POSTa o corpo canônico (paymentType=99, sem clientDocument, telefone E.164)", async () => {
    const p = new VoxuyApiProvider(transactionConfig)
    const r = await p.sendCampaignMessage(baseInput)
    expect(r.accepted).toBe(true)
    expect(ffetch.calls[0].url).toBe(transactionConfig.webhookUrl)
    const sent = JSON.parse(ffetch.calls[0].body!)
    expect(sent.paymentType).toBe(99)
    expect(sent.status).toBe(99)
    expect(sent.id).toBe(MSG_ID)
    expect(sent.clientDocument).toBeNull()
    expect(sent.value).toBeNull()
    expect(sent.clientPhoneNumber).toBe("+5511912341234")
    expect(sent.metadata.consult_url).toBe(baseInput.variables.consult_url)
  })

  it("barra telefone não-E.164 antes de sair (nada é enviado)", async () => {
    const p = new VoxuyApiProvider(transactionConfig)
    const r = await p.sendCampaignMessage({ ...baseInput, to: "11912341234" })
    expect(r.accepted).toBe(false)
    expect(r.errorClass).toBe("validation")
    expect(ffetch.calls).toHaveLength(0)
  })
})

describe("VoxuyApiProvider — dialeto custom", () => {
  let ffetch: ReturnType<typeof fakeFetch>
  beforeEach(() => {
    ffetch = fakeFetch(200, JSON.stringify({ Success: true }))
    vi.stubGlobal("fetch", ffetch.fn)
  })
  afterEach(() => vi.unstubAllGlobals())

  it("resolve o template + headers e POSTa na URL do request config", async () => {
    const p = new VoxuyApiProvider(customConfig)
    const r = await p.sendCampaignMessage(baseInput)
    expect(r.accepted).toBe(true)
    expect(ffetch.calls[0].url).toBe("https://enterprise.voxuy.com/v2/dispatch")
    expect(ffetch.calls[0].headers?.Authorization).toBe("Bearer tok")
    const sent = JSON.parse(ffetch.calls[0].body!)
    expect(sent).toEqual({
      flow: "flow_42",
      plan: "plan_x",
      to: "+5511912341234",
      externalId: MSG_ID,
      params: { name: "Fabio", url: baseInput.variables.consult_url, brand: "AlteaPay", creditor: "VMAX" },
    })
    expect(JSON.stringify(sent)).not.toContain(baseInput.document)
  })

  it("template com placeholder desconhecido => erro de CONFIG, nada enviado", async () => {
    const badConfig: VoxuyApiConfig = {
      ...customConfig,
      custom: { ...customConfig.custom!, payloadTemplate: { to: "{{phone}}", cpf: "{{cpf}}" } },
    }
    const p = new VoxuyApiProvider(badConfig)
    const r = await p.sendCampaignMessage(baseInput)
    expect(r.accepted).toBe(false)
    expect(r.errorClass).toBe("config")
    expect((r.raw as { pauseCampaign?: boolean }).pauseCampaign).toBe(true)
    expect(ffetch.calls).toHaveLength(0)
  })

  it("template que injeta valor monetário é barrado pela trava final", async () => {
    const badConfig: VoxuyApiConfig = {
      ...customConfig,
      custom: { ...customConfig.custom!, payloadTemplate: { to: "{{phone}}", amount: "{{link}}" } },
    }
    const p = new VoxuyApiProvider(badConfig)
    const r = await p.sendCampaignMessage(baseInput)
    expect(r.accepted).toBe(false)
    expect(r.errorClass).toBe("validation")
    expect(ffetch.calls).toHaveLength(0)
  })
})

describe("VoxuyApiProvider — modo mock (default de produção)", () => {
  it("sem config não sai do processo e aceita, validando o contrato (enterprise default)", async () => {
    const prev = process.env.MOCK_ALL_INTEGRATIONS
    process.env.MOCK_ALL_INTEGRATIONS = "1"
    const spy = vi.spyOn(globalThis, "fetch")
    try {
      const p = new VoxuyApiProvider() // sem config: mock não exige credencial
      expect(p.dialect).toBe("enterprise_v1")
      const r = await p.sendCampaignMessage(baseInput)
      expect(r.accepted).toBe(true)
      expect((r.raw as { mock?: boolean }).mock).toBe(true)
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
      if (prev === undefined) delete process.env.MOCK_ALL_INTEGRATIONS
      else process.env.MOCK_ALL_INTEGRATIONS = prev
    }
  })
})
