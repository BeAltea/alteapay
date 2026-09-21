# Achados consolidados — onda campanha + status

Formato de cada achado: §7.4 do prompt. Severidades: **BLOQUEANTE**, **ALTA**, **MÉDIA**, **BAIXA**.
Estado: `aberto` | `corrigido` | `aceito`.

> Preenchido pelos validadores nas Fases D/E. O orquestrador consolida aqui e marca o estado.
> **Regra de subida:** nenhum BLOQUEANTE aberto pode passar para o GATE F/G.

| # | Sev | Título | Trilha/arquivo | Tipo | Dono correção | Estado |
|---|-----|--------|----------------|------|---------------|--------|
| — | —   | (vazio até a Fase D) | — | — | — | — |

## Fase A — achados do diagnóstico (orquestrador)

### [MÉDIA] Docs de contexto referenciados pelo prompt não existem
- **Trilha/arquivo:** — · prompt §"Contexto obrigatório"
- **Tipo:** operação
- **Evidência:** `find` por `claude/PROMPT_JORNADA_CHATBOT*`, `PROMPT_VOXUY_INTEGRACAO*`, `PROMPT_CHAT_N8N_ENDPOINT*`, `PROMPT_CHAT_RECONHECIMENTO*` → nenhum arquivo (repo + meta-repo).
- **Impacto:** subagentes que tentarem ler esses caminhos falham. Risco de suposição.
- **Sugestão:** usar os substitutos reais listados no diagnóstico §4. Todo prompt de subagente cita apenas docs existentes.
- **Estado:** aceito (substitutos mapeados)

### [ALTA] Parte do escopo do prompt já existe — risco de reescrita/duplicação
- **Trilha/arquivo:** T2 · `lib/journey/campaigns.ts` (`createCampaign`/`startCampaign`/`toE164Mobile`); T1 · `journey_events` (~38 tipos)
- **Tipo:** correção
- **Evidência:** diagnóstico §1.
- **Impacto:** reescrever normalização de telefone / campanha duplicaria lógica e divergiria do guard existente.
- **Sugestão:** T1/T2 **estendem** e reusam (`toE164Mobile`, guard de idempotência); mapear eventos existentes → estágios.
- **Estado:** aceito (refletido nos contratos)
