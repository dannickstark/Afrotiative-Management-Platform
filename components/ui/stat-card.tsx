import { Card, CardContent } from "@/components/ui/card";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// Plan 010 — shared stat-tile primitive used by both the dashboard summary cards
// (components/dashboard/summary-cards.tsx) and the pipeline run-trends tiles
// (components/pipeline/run-trends.tsx), so KPI presentation stays consistent app-wide.
export function StatCard({
  label,
  value,
  sub,
  tone = "default",
  icon,
  emphasis = false,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "default" | "accent" | "alert";
  icon?: ReactNode;
  emphasis?: boolean;
}) {
  const valueTone =
    tone === "alert" ? "text-[var(--status-error)]" : tone === "accent" ? "text-accent-brand" : "";
  return (
    <Card className={cn(emphasis && "ring-1 ring-accent-brand/30")}>
      <CardContent className="pt-6">
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">{label}</p>
          {icon && <span className="text-muted-foreground">{icon}</span>}
        </div>
        <div className={cn("mt-2 font-semibold tabular-nums", emphasis ? "text-3xl" : "text-2xl", valueTone)}>
          {value}
        </div>
        {sub && <p className="mt-1 text-xs text-muted-foreground">{sub}</p>}
      </CardContent>
    </Card>
  );
}
