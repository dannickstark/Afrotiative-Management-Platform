"use client";
import { useState } from "react";
import Link from "next/link";
import { AlertTriangle, WifiOff, X } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type { Alert } from "@/lib/queries/alerts";
import type { AlertType } from "@/lib/alerts/notify";

const ALERT_ICON: Record<AlertType, typeof AlertTriangle> = {
  run_failed: AlertTriangle,
  feed_dark: WifiOff,
};
const ALERT_HREF: Record<AlertType, string> = {
  run_failed: "/runs",
  feed_dark: "/settings/feeds",
};

/**
 * SP9b — dismissible summary of unread alerts on /dashboard. `alerts` is server-fetched (page.tsx
 * calls getRecentAlerts and filters to unread) and passed straight down; dismissing is a local,
 * session-only "hide" (mirrors a lot of banner patterns — it does NOT call markAllAlertsRead, so
 * the alerts stay unread/still show in the bell until actually opened or explicitly cleared there).
 */
export function AlertBanner({ alerts }: { alerts: Alert[] }) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed || alerts.length === 0) return null;

  return (
    <Card className="border-[var(--status-error)]/30 bg-[var(--status-error)]/5">
      <CardContent className="flex items-start gap-3 py-3">
        <AlertTriangle className="mt-0.5 size-5 shrink-0 text-[var(--status-error)]" aria-hidden />
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="text-sm font-medium">
            {alerts.length} alerte{alerts.length > 1 ? "s" : ""} non lue{alerts.length > 1 ? "s" : ""}
          </p>
          <ul className="space-y-1">
            {alerts.slice(0, 3).map((alert) => {
              const Icon = ALERT_ICON[alert.type as AlertType] ?? AlertTriangle;
              return (
                <li key={alert.id}>
                  <Link
                    href={ALERT_HREF[alert.type as AlertType] ?? "/dashboard"}
                    className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground hover:underline"
                  >
                    <Icon className="size-3.5 shrink-0" aria-hidden />
                    <span className="truncate">{alert.title} — {alert.detail}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
        <Button
          type="button" variant="ghost" size="icon-sm" aria-label="Ignorer"
          onClick={() => setDismissed(true)}
        >
          <X className="size-4" />
        </Button>
      </CardContent>
    </Card>
  );
}
