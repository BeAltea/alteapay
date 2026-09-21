import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
      // `server-only` só existe no build do Next (guard de client bundle). No
      // node dos testes não há esse pacote — stub no-op para permitir importar
      // módulos server-only (query.ts, selection.ts, etc.) sem alterar runtime.
      "server-only": fileURLToPath(new URL("./tests/stubs/server-only.ts", import.meta.url)),
    },
  },
  test: {
    include: ["tests/**/*.test.ts", "lib/**/*.test.ts"],
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
  },
})
