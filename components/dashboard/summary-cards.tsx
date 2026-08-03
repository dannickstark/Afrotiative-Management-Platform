import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDate, pipelineStatusLabel } from "@/lib/format";

export function SummaryCards({ d }: { d: Awaited<ReturnType<typeof import("@/lib/queries/dashboard").getDashboardData>> }) {
  const cards = [
    { label: "En attente de revue", value: d.pendingCount, accent: d.pendingCount > 0 },
    { label: "Exécutions en échec (24 h)", value: d.failedRuns24h, alert: d.failedRuns24h > 0 },
    { label: "Publiés cette semaine", value: d.publishedWeek, sub: `dont ${d.publishedToday} aujourd'hui` },
    { label: "Dernière exécution", value: d.lastRun ? formatDate(d.lastRun.startedAt) : "—", sub: pipelineStatusLabel(d.lastRun?.status) },
  ];
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {cards.map((c) => (
        <Card key={c.label}>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">{c.label}</CardTitle></CardHeader>
          <CardContent>
            <div className={`text-2xl font-semibold ${c.alert ? "text-[var(--status-error)]" : c.accent ? "text-[var(--accent-brand)]" : ""}`}>{c.value}</div>
            {c.sub && <p className="text-xs text-muted-foreground mt-1">{c.sub}</p>}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
