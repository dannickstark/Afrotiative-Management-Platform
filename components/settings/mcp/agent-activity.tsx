// components/settings/mcp/agent-activity.tsx — Task 7: « Activité récente », le quatrième panneau
// de /settings/mcp (spec §6). Lecture seule, PAS "use client" : ce panneau surveille — il ne permet
// PAS d'annuler une écriture (voir tool-catalog.tsx et scriptJournal.reviewedAt dans
// db/schema.ts) ; une correction se fait dans le projet, avec son contexte (journal-history.tsx),
// pas depuis les réglages.
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/shell/empty-state";
import { formatDate } from "@/lib/format";
import type { ActivityRow } from "@/lib/queries/mcp";

const OUTCOME_LABEL: Record<string, string> = {
  rejete: "Rejeté",
  en_attente: "En attente",
  applique: "Appliqué",
  annule: "Annulé",
};

export function AgentActivity({ activity }: { activity: ActivityRow[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Activité récente</CardTitle>
        <CardDescription>
          Les dernières écritures d&#39;agents connectés au serveur MCP. « Non relue » signale une
          écriture que personne n&#39;a encore ouverte depuis le projet.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {activity.length === 0 ? (
          <EmptyState title="Aucune activité d'agent" hint="Rien qu'un agent MCP ait écrit pour l'instant." />
        ) : (
          activity.map((row) => (
            <div key={row.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <code className="text-sm font-medium">{row.toolName ?? "—"}</code>
                  <Badge variant="outline">{OUTCOME_LABEL[row.outcome] ?? row.outcome}</Badge>
                  {row.reviewedAt === null && (
                    <Badge variant="outline" className="bg-[var(--status-pending)]/15 text-[var(--status-pending)] border-[var(--status-pending)]/30">
                      Non relue
                    </Badge>
                  )}
                </div>
                <p className="truncate text-xs text-muted-foreground">
                  {formatDate(row.createdAt)}
                  {row.actorName && ` · ${row.actorName}`}
                </p>
              </div>
              <Link
                href={`/video/${row.projectId}`}
                className="flex shrink-0 items-center gap-1 text-sm text-primary hover:underline"
              >
                {row.projectTitle}
                <ArrowRight className="size-3.5" aria-hidden />
              </Link>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
