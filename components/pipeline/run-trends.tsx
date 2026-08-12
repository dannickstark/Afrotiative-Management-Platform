import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatCard } from "@/components/ui/stat-card";
import { formatSecondsDuration } from "@/lib/format";
import type { RunTrendsSummary, TrendDay } from "@/lib/queries/runs";

// SP7 Task 3 — trends strip above the runs table. Purely presentational (no state/interactivity),
// fed by getRunTrends() (lib/queries/runs.ts) from the server page (app/(app)/runs/page.tsx). No
// chart library: 4 stat tiles + a lightweight per-day CSS bar row (height/width % only), themed via
// the same --status-* CSS vars already used across the pipeline UI (live-run-panel.tsx,
// run-detail-sheet.tsx, runs-view.tsx) so it stays consistent light/dark without extra work here.
export function RunTrends({ perDay, summary }: { perDay: TrendDay[]; summary: RunTrendsSummary }) {
  const maxRuns = Math.max(1, ...perDay.map((d) => d.runs));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Tendances ({perDay.length} derniers jours)</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard label="Exécutions (7 j)" value={summary.runs7d} />
          <StatCard label="Articles produits (7 j)" value={summary.articles7d} />
          <StatCard label="Taux d'échec" value={`${summary.failureRatePct.toLocaleString("fr-FR")} %`} />
          <StatCard
            label="Durée moyenne"
            value={summary.avgDurationSec != null ? formatSecondsDuration(summary.avgDurationSec) : "—"}
          />
        </div>

        {perDay.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <div
              className="flex h-20 items-end gap-1"
              role="img"
              aria-label={`Nombre d'exécutions par jour sur les ${perDay.length} derniers jours ; la portion rouge indique les échecs et succès partiels`}
            >
              {perDay.map((d) => {
                const totalPct = d.runs > 0 ? Math.max((d.runs / maxRuns) * 100, 6) : 0;
                const failPct = d.runs > 0 ? (d.failures / d.runs) * 100 : 0;
                return (
                  <div
                    key={d.day}
                    className="flex h-full flex-1 flex-col justify-end"
                    title={`${d.day} — ${d.runs} exécution${d.runs > 1 ? "s" : ""}, ${d.failures} échec${d.failures > 1 ? "s" : ""}, ${d.produced} article${d.produced > 1 ? "s" : ""} produit${d.produced > 1 ? "s" : ""}`}
                  >
                    <div
                      className="relative w-full overflow-hidden rounded-[2px] bg-[var(--status-approved)]/40"
                      style={{ height: `${totalPct}%` }}
                    >
                      {failPct > 0 && (
                        <div
                          className="absolute inset-x-0 bottom-0 bg-[var(--status-error)]"
                          style={{ height: `${failPct}%` }}
                        />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>{perDay[0].day}</span>
              <span>{perDay[perDay.length - 1].day}</span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
