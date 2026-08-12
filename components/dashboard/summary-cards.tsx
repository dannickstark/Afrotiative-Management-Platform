import { StatCard } from "@/components/ui/stat-card";
import { formatDate, pipelineStatusLabel } from "@/lib/format";
import { Inbox, AlertTriangle, Newspaper, Clock } from "lucide-react";

export function SummaryCards({ d }: { d: Awaited<ReturnType<typeof import("@/lib/queries/dashboard").getDashboardData>> }) {
  const cards = [
    {
      label: "En attente de revue",
      value: d.pendingCount,
      icon: <Inbox className="size-4" />,
      tone: d.pendingCount > 0 ? ("accent" as const) : ("default" as const),
      emphasis: d.pendingCount > 0,
    },
    {
      label: "Exécutions en échec (24 h)",
      value: d.failedRuns24h,
      icon: <AlertTriangle className="size-4" />,
      tone: d.failedRuns24h > 0 ? ("alert" as const) : ("default" as const),
    },
    {
      label: "Publiés cette semaine",
      value: d.publishedWeek,
      sub: `dont ${d.publishedToday} aujourd'hui`,
      icon: <Newspaper className="size-4" />,
    },
    {
      label: "Dernière exécution",
      value: d.lastRun ? formatDate(d.lastRun.startedAt) : "—",
      sub: pipelineStatusLabel(d.lastRun?.status),
      icon: <Clock className="size-4" />,
    },
  ];
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {cards.map((c) => (
        <StatCard key={c.label} {...c} />
      ))}
    </div>
  );
}
