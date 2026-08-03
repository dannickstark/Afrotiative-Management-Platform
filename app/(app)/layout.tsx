import { requireUser } from "@/lib/session";
import { db, articles } from "@/db";
import { eq } from "drizzle-orm";
import { Sidebar } from "@/components/shell/sidebar";
import { Topbar } from "@/components/shell/topbar";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const pending = await db.$count(articles, eq(articles.status, "pending"));
  return (
    <div className="flex h-screen">
      <Sidebar role={user.role} pendingCount={pending} />
      <div className="flex-1 flex flex-col min-w-0">
        <Topbar user={user} />
        <main className="flex-1 overflow-auto p-6">{children}</main>
      </div>
    </div>
  );
}
