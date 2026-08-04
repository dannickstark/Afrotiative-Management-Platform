import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";
import { getFeeds } from "@/lib/queries/settings";

export default async function Page() {
  const user = await requireUser();
  requirePermission(user.role, "feed", "manage");
  const feeds = await getFeeds();
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Sources RSS</h1>
      {/* FeedsTable arrive en Task 2 */}
      <ul className="text-sm text-muted-foreground">
        {feeds.map((f) => <li key={f.id}>{f.name} — {f.active ? "actif" : "inactif"}</li>)}
      </ul>
      <pre className="text-xs text-muted-foreground">{feeds.length} source(s)</pre>
    </div>
  );
}
