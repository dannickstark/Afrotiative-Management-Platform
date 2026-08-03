import { getDashboardData } from "@/lib/queries/dashboard";
import { SummaryCards } from "@/components/dashboard/summary-cards";
import { PendingList } from "@/components/dashboard/pending-list";
import { ErrorList } from "@/components/dashboard/error-list";

export default async function DashboardPage() {
  const d = await getDashboardData();
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Tableau de bord</h1>
      <SummaryCards d={d} />
      <div className="grid gap-6 lg:grid-cols-2">
        <PendingList items={d.latestPending} />
        <ErrorList items={d.latestErrors} />
      </div>
    </div>
  );
}
