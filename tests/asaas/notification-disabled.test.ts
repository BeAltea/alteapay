// Frente C (trava anti-regressão, PR #91): TODA criação/atualização de customer
// ASAAS TEM que ir com notificationDisabled:true — o ASAAS não comunica o devedor
// (§0). Este teste FALHA O BUILD se createAsaasCustomer/updateAsaasCustomer
// deixarem de forçar a supressão, mesmo que o caller passe false/undefined.
//
// Mocamos a fronteira de transporte (mockAsaasRequest) para capturar o corpo
// EXATO enviado ao ASAAS — nunca toca produção. ASAAS_MODE=mock roteia por lá.
import { beforeEach, describe, expect, it, vi } from "vitest"

process.env.ASAAS_MODE = "mock"

// Captura o corpo de CADA request ao ASAAS.
const sent: Array<{ endpoint: string; method: string; body: any }> = []
vi.mock("@/lib/integrations/asaas-mock", () => ({
  mockAsaasRequest: async (endpoint: string, method: string, body: any) => {
    sent.push({ endpoint, method, body })
    // resposta mínima realista para create/update de customer
    return { id: "cus_mock_1", name: body?.name ?? "x", cpfCnpj: body?.cpfCnpj ?? "" }
  },
}))

beforeEach(() => {
  sent.length = 0
})

describe("ASAAS notificationDisabled — trava anti-regressão", () => {
  it("createAsaasCustomer SEMPRE envia notificationDisabled:true (mesmo com false)", async () => {
    const { createAsaasCustomer } = await import("@/lib/asaas")
    await createAsaasCustomer({
      name: "Fulano",
      cpfCnpj: "11144477735",
      email: "x@y.com",
      // caller tenta reativar as notificações — DEVE ser ignorado.
      notificationDisabled: false,
    })
    const call = sent.find((s) => s.endpoint === "/customers" && s.method === "POST")
    expect(call, "createAsaasCustomer deve chamar POST /customers").toBeTruthy()
    expect(call!.body.notificationDisabled).toBe(true)
  })

  it("createAsaasCustomer força notificationDisabled:true mesmo SEM o campo", async () => {
    const { createAsaasCustomer } = await import("@/lib/asaas")
    await createAsaasCustomer({ name: "Fulano", cpfCnpj: "11144477735" })
    const call = sent.find((s) => s.endpoint === "/customers" && s.method === "POST")
    expect(call!.body.notificationDisabled).toBe(true)
  })

  it("updateAsaasCustomer SEMPRE reforça notificationDisabled:true (mesmo com false)", async () => {
    const { updateAsaasCustomer } = await import("@/lib/asaas")
    await updateAsaasCustomer("cus_1", { name: "Novo Nome", notificationDisabled: false })
    const call = sent.find((s) => s.endpoint === "/customers/cus_1" && s.method === "PUT")
    expect(call, "updateAsaasCustomer deve chamar PUT /customers/{id}").toBeTruthy()
    expect(call!.body.notificationDisabled).toBe(true)
  })

  it("updateAsaasCustomer força notificationDisabled:true mesmo SEM o campo", async () => {
    const { updateAsaasCustomer } = await import("@/lib/asaas")
    await updateAsaasCustomer("cus_2", { mobilePhone: "11999998888" })
    const call = sent.find((s) => s.endpoint === "/customers/cus_2" && s.method === "PUT")
    expect(call!.body.notificationDisabled).toBe(true)
  })
})
