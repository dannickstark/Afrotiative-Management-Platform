import { requireUser } from "@/lib/session";
import { can } from "@/lib/rbac";
import { getDashboardData } from "@/lib/queries/dashboard";
import { getRecentAlerts } from "@/lib/queries/alerts";
import { SummaryCards } from "@/components/dashboard/summary-cards";
import { PendingList } from "@/components/dashboard/pending-list";
import { ErrorList } from "@/components/dashboard/error-list";
import { AlertBanner } from "@/components/dashboard/alert-banner";

export default async function DashboardPage() {
  const user = await requireUser();
  // SP9b — same pipeline:read gate as the notifications bell (app/(app)/layout.tsx): a journalist
  // has no reason to fetch alert history it can't act on anyway.
  const [d, unreadAlerts] = await Promise.all([
    getDashboardData(),
    can(user.role, "pipeline", "read")
      ? getRecentAlerts().then((rows) => rows.filter((a) => !a.read))
      : Promise.resolve([]),
  ]);
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Tableau de bord</h1>
      {unreadAlerts.length > 0 && <AlertBanner alerts={unreadAlerts} />}
      <SummaryCards d={d} />
      <div className="grid gap-6 lg:grid-cols-2">
        <PendingList items={d.latestPending} />
        <ErrorList items={d.latestErrors} />
      </div>
    </div>
  );
}
