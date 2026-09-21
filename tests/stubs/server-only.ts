// Stub de `server-only` para o ambiente de testes (node). Em produção o Next
// injeta o pacote real (que apenas guarda contra import no client bundle). No
// vitest não há client bundle, então um no-op é correto e não altera runtime.
export {}
