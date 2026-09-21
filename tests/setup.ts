// Setup global do vitest.
//
// Silencia console.* durante os testes por dois motivos:
//  1. Remove ruído de logs esperados (ex.: os console.warn de fallback do engine
//     n8n, do bootstrap de reconhecimento, etc., que os testes exercitam de
//     propósito).
//  2. Elimina o race de teardown do worker ("Closing rpc while onUserConsoleLog
//     was pending"): sem chamada real de console, não há log em voo no fechamento
//     do rpc do worker sob execução paralela.
//
// As chamadas continuam sendo REGISTRADAS (mockImplementation vazio) — testes que
// fazem `vi.spyOn(console, "warn")` e asseguram contagem seguem funcionando. Não
// restauramos globalmente para não clobberar mocks próprios dos testes; em vez
// disso re-silenciamos antes de cada teste (cobre suites que dão restoreAllMocks).
import { beforeEach, vi } from "vitest"

function silenceConsole() {
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation(() => {})
  }
}

silenceConsole()
beforeEach(silenceConsole)
