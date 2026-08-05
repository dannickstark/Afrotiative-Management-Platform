"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Bell, AlertTriangle, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { markAlertRead, markAllAlertsRead } from "@/lib/actions/alert-actions";
import { relativeDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Alert } from "@/lib/queries/alerts";
// AlertType lives in lib/alerts/notify.ts (SP9a) — a type-only import here, erased at build time,
// so this Client Component never pulls in that module's runtime deps (db, getPipelineSettings,
// sendEmail).
import type { AlertType } from "@/lib/alerts/notify";

const ALERT_ICON: Record<AlertType, typeof AlertTriangle> = {
  run_failed: AlertTriangle,
  feed_dark: WifiOff,
};

// run_failed -> the runs history (/runs); feed_dark -> the feed that went quiet (/settings/feeds).
const ALERT_HREF: Record<AlertType, string> = {
  run_failed: "/runs",
  feed_dark: "/settings/feeds",
};

/**
 * SP9b — bell icon + unread badge in the (app) layout header, fed initial data server-side
 * (app/(app)/layout.tsx calls getUnreadAlertCount/getRecentAlerts). No live polling — per the plan,
 * an RSC refresh on navigation/action is enough for a small back-office team. Clicking an alert (or
 * "Tout marquer comme lu") calls the matching action; the resulting revalidatePath re-renders the
 * CURRENT route server-side in the same round-trip (Next.js 16 Server Actions — see
 * node_modules/next/dist/docs/01-app/02-guides/server-actions.md), which re-executes this layout
 * and hands this component fresh props — no manual state sync needed here.
 */
export function NotificationsBell({ unreadCount, alerts }: { unreadCount: number; alerts: Alert[] }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  // Best-effort client side too, mirroring the actions themselves (lib/actions/alert-actions.ts):
  // a failed mark-as-read is, at worst, a badge that doesn't clear — never worth an error toast.
  function handleMarkAll() {
    startTransition(async () => {
      try {
        await markAllAlertsRead();
      } catch {
        /* best-effort — see comment above */
      }
      router.refresh();
    });
  }

  function handleOpenAlert(alert: Alert) {
    if (alert.read) return;
    startTransition(async () => {
      try {
        await markAlertRead(alert.id);
      } catch {
        /* best-effort — see comment above */
      }
      router.refresh();
    });
  }

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button type="button" variant="ghost" size="icon" className="relative" aria-label="Notifications">
            <Bell />
            {unreadCount > 0 && (
              <span
                className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-medium text-destructive-foreground"
                aria-hidden
              >
                {unreadCount > 9 ? "9+" : unreadCount}
              </span>
            )}
          </Button>
        }
      />
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-sm font-medium">Notifications</span>
          {unreadCount > 0 && (
            <button
              type="button"
              disabled={isPending}
              onClick={handleMarkAll}
              className="text-xs text-muted-foreground hover:text-foreground hover:underline disabled:opacity-50"
            >
              Tout marquer comme lu
            </button>
          )}
        </div>
        {alerts.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">Aucune alerte pour le moment.</p>
        ) : (
          <ul className="max-h-80 divide-y overflow-y-auto">
            {alerts.map((alert) => {
              const Icon = ALERT_ICON[alert.type as AlertType] ?? AlertTriangle;
              return (
                <li key={alert.id}>
                  <Link
                    href={ALERT_HREF[alert.type as AlertType] ?? "/dashboard"}
                    onClick={() => handleOpenAlert(alert)}
                    className={cn(
                      "flex items-start gap-2 px-3 py-2 text-sm transition-colors hover:bg-accent",
                      !alert.read && "bg-accent/40",
                    )}
                  >
                    <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{alert.title}</p>
                      <p className="truncate text-xs text-muted-foreground">{alert.detail}</p>
                      <p className="text-[11px] text-muted-foreground">{relativeDate(alert.createdAt)}</p>
                    </div>
                    {!alert.read && (
                      <span className="mt-1.5 size-2 shrink-0 rounded-full bg-[var(--accent-brand)]" aria-hidden />
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
