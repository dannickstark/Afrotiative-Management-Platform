// components/settings/social-channels.tsx — Task 7 (D1 §6): the /settings/social LIST. PURE
// presentational component (no data fetching, no "use client" — a plain Server Component works
// fine since it's just Links + read-only summaries), fed already-loaded settings from
// app/(app)/settings/social/page.tsx, same split as components/settings/integration-cards.tsx.
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { Card, CardHeader, CardTitle, CardDescription, CardAction } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/shell/page-header";
import type { Channel } from "@/lib/studio";

const ENABLED_STYLE = "bg-[var(--status-approved)]/15 text-[var(--status-approved)] border-[var(--status-approved)]/30";
const DISABLED_STYLE = "bg-[var(--status-draft)]/15 text-[var(--status-draft)] border-[var(--status-draft)]/30";

export type SocialChannelSummary = {
  channel: Channel;
  label: string;
  enabled: boolean;
  autoEnabled: boolean;
  autoIntervalHours: number;
  autoMaxBacklogDays: number;
  autoWindowStartHour: number;
  autoWindowEndHour: number;
};

// Two-digit hour, e.g. "8h" / "20h" — matches the détail form's own hour labels (social-channel-form.tsx).
function h(hour: number): string {
  return `${hour}h`;
}

// Exported (not just used inline) so a future summary line elsewhere can reuse the exact same
// wording — and so this specific sentence, not just "some text appears", is what the UI test pins.
export function formatAutoSummary(s: Pick<SocialChannelSummary, "autoEnabled" | "autoIntervalHours" | "autoMaxBacklogDays" | "autoWindowStartHour" | "autoWindowEndHour">): string {
  if (!s.autoEnabled) return "Publication automatique désactivée.";
  return `Toutes les ${s.autoIntervalHours} h, ${h(s.autoWindowStartHour)}–${h(s.autoWindowEndHour)}, rattrapage ${s.autoMaxBacklogDays} j.`;
}

export function SocialChannelsList({ items }: { items: SocialChannelSummary[] }) {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Réseaux sociaux"
        description="Un canal par réseau. Chacun a sa propre limite de légende, son prompt éventuel et son bloc de publication automatique — configurez-le en ouvrant le canal."
      />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((item) => (
          <Link key={item.channel} href={`/settings/social/${item.channel}`} className="block">
            <Card className="transition-colors hover:border-accent-brand">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  {item.label}
                  <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
                </CardTitle>
                <CardDescription>{formatAutoSummary(item)}</CardDescription>
                <CardAction>
                  <Badge variant="outline" className={item.enabled ? ENABLED_STYLE : DISABLED_STYLE}>
                    {item.enabled ? "Activé" : "Désactivé"}
                  </Badge>
                </CardAction>
              </CardHeader>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
