import { cookies } from "next/headers";
import { requireUser } from "@/lib/session";
import { can } from "@/lib/rbac";
import { db, articles } from "@/db";
import { eq } from "drizzle-orm";
import { AppSidebar } from "@/components/shell/app-sidebar";
import { Breadcrumbs } from "@/components/shell/breadcrumbs";
import { NotificationsBell } from "@/components/shell/notifications-bell";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { getUnreadAlertCount, getRecentAlerts } from "@/lib/queries/alerts";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  // SP9b — the notifications bell is gated on pipeline:read, same permission as /runs and
  // /settings/feeds (see components/shell/nav-items.ts) — only fetch its data for roles that can
  // actually see it (journalist currently has neither).
  const canSeeAlerts = can(user.role, "pipeline", "read");
  const [pending, unreadAlertCount, recentAlerts] = await Promise.all([
    db.$count(articles, eq(articles.status, "pending")),
    canSeeAlerts ? getUnreadAlertCount() : Promise.resolve(0),
    canSeeAlerts ? getRecentAlerts() : Promise.resolve([]),
  ]);
  const cookieStore = await cookies();
  const defaultOpen = cookieStore.get("sidebar_state")?.value !== "false";

  return (
    <SidebarProvider defaultOpen={defaultOpen}>
      <AppSidebar role={user.role} pendingCount={pending} user={user} />
      <SidebarInset>
        <header className="flex h-16 shrink-0 items-center gap-2 border-b px-4 transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 data-vertical:h-4 data-vertical:self-auto" />
          <Breadcrumbs />
          {canSeeAlerts && (
            <div className="ml-auto">
              <NotificationsBell unreadCount={unreadAlertCount} alerts={recentAlerts} />
            </div>
          )}
        </header>
        <main className="flex-1 overflow-auto p-6">{children}</main>
      </SidebarInset>
    </SidebarProvider>
  );
}
