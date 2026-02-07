import { migrateToRecoveryScore } from "@/app/actions/migrate-to-recovery-score"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { AlertTriangle, CheckCircle2 } from "lucide-react"

export default function MigrateScoresPage() {
  async function handleMigration() {
    "use server"
    return await migrateToRecoveryScore()
  }

  return (
    <div className="w-full max-w-4xl space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Migração: Score de Crédito → Score de Recuperação</CardTitle>
          <CardDescription>
            Atualiza todas as classificações de cobrança para usar o Score de Recuperação (Recupere) ao invés do Score
            de Crédito
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Aviso */}
          <div className="flex items-start gap-3 p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
            <AlertTriangle className="h-5 w-5 text-yellow-600 mt-0.5" />
            <div className="space-y-1">
              <p className="text-sm font-medium text-yellow-900">Atenção: Processo de Migração</p>
              <p className="text-sm text-yellow-700">
                Esta ação irá atualizar todos os registros VMAX e tarefas de cobrança pendentes. O processo pode levar
                alguns minutos dependendo da quantidade de dados.
              </p>
            </div>
          </div>

          {/* Novo Critério */}
          <div className="space-y-3">
            <h3 className="font-semibold text-lg">Novo Critério de Classificação</h3>
            <div className="grid gap-3">
              <div className="flex items-center gap-3 p-3 bg-green-50 border border-green-200 rounded-lg">
                <CheckCircle2 className="h-5 w-5 text-green-600" />
                <div>
                  <p className="text-sm font-medium text-green-900">Recovery Score ≥ 294 (Classes C, B, A)</p>
                  <p className="text-xs text-green-700">Cobrança automática via Email/SMS/WhatsApp</p>
                </div>
              </div>

              <div className="flex items-center gap-3 p-3 bg-red-50 border border-red-200 rounded-lg">
                <AlertTriangle className="h-5 w-5 text-red-600" />
                <div>
                  <p className="text-sm font-medium text-red-900">Recovery Score &lt; 294 (Classes D, E, F)</p>
                  <p className="text-xs text-red-700">Cobrança 100% manual - disparos automáticos bloqueados</p>
                </div>
              </div>
            </div>
          </div>

          {/* Tabela de Classes */}
          <div className="space-y-3">
            <h3 className="font-semibold text-lg">Classificação Score Recupere</h3>
            <div className="overflow-hidden border rounded-lg">
              <table className="w-full text-sm">
                <thead className="bg-muted">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium">Classe</th>
                    <th className="px-4 py-2 text-left font-medium">Range</th>
                    <th className="px-4 py-2 text-left font-medium">Descrição</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  <tr className="bg-green-50">
                    <td className="px-4 py-2 font-medium">A</td>
                    <td className="px-4 py-2">Acima de 800</td>
                    <td className="px-4 py-2 text-xs">Baixo risco de não pagamento</td>
                  </tr>
                  <tr className="bg-green-50">
                    <td className="px-4 py-2 font-medium">B</td>
                    <td className="px-4 py-2">491 a 800</td>
                    <td className="px-4 py-2 text-xs">Médio-baixo risco de não pagamento</td>
                  </tr>
                  <tr className="bg-yellow-50">
                    <td className="px-4 py-2 font-medium">C</td>
                    <td className="px-4 py-2">294 a 490</td>
                    <td className="px-4 py-2 text-xs">Médio risco de não pagamento</td>
                  </tr>
                  <tr className="bg-orange-50">
                    <td className="px-4 py-2 font-medium">D</td>
                    <td className="px-4 py-2">131 a 293</td>
                    <td className="px-4 py-2 text-xs">Médio-alto risco de não pagamento</td>
                  </tr>
                  <tr className="bg-red-50">
                    <td className="px-4 py-2 font-medium">E</td>
                    <td className="px-4 py-2">17 a 130</td>
                    <td className="px-4 py-2 text-xs">Alto risco de não pagamento</td>
                  </tr>
                  <tr className="bg-red-100">
                    <td className="px-4 py-2 font-medium">F</td>
                    <td className="px-4 py-2">Até 17</td>
                    <td className="px-4 py-2 text-xs">Altíssimo risco de não pagamento</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          {/* O que será atualizado */}
          <div className="space-y-3">
            <h3 className="font-semibold text-lg">O que será atualizado</h3>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li className="flex items-start gap-2">
                <span className="text-primary">•</span>
                <span>
                  Tabela <code className="bg-muted px-1 rounded">VMAX</code>: Adiciona colunas{" "}
                  <code className="bg-muted px-1 rounded">recovery_score</code>,{" "}
                  <code className="bg-muted px-1 rounded">recovery_class</code> e{" "}
                  <code className="bg-muted px-1 rounded">recovery_description</code>
                </span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-primary">•</span>
                <span>
                  Extrai dados de <code className="bg-muted px-1 rounded">analysis_metadata.recupere</code> salvos pela
                  API Assertiva
                </span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-primary">•</span>
                <span>
                  Atualiza <code className="bg-muted px-1 rounded">auto_collection_enabled</code> baseado no novo
                  critério
                </span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-primary">•</span>
                <span>
                  Tabela <code className="bg-muted px-1 rounded">collection_tasks</code>: Atualiza metadata e bloqueia
                  auto-dispatch para scores baixos
                </span>
              </li>
            </ul>
          </div>

          {/* Botão de Migração */}
          <form action={handleMigration}>
            <Button type="submit" size="lg" className="w-full">
              Executar Migração
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
