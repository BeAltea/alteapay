# Requests entre trilhas

Quando uma trilha precisa tocar um arquivo de OUTRA (ownership é exclusivo, §7.2 regra 3),
ela **NÃO edita**: cria aqui um arquivo `<trilha>-<n>.md` e o orquestrador decide.

Formato:
```md
## <trilha> pede: <o quê>
- **Arquivo alvo:** lib/journey/campaigns.ts (dono: T2)
- **Motivo:** T1 precisa compartilhar a normalização de telefone (toE164Mobile).
- **Mudança proposta:** exportar a função sem alterar assinatura.
- **Bloqueia?** sim/não
```

O orquestrador responde no mesmo arquivo (`DECISÃO:`) e, se aprovado, o **dev dono** aplica.
