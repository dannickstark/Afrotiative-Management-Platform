import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";
import { getFeeds } from "@/lib/queries/settings";
import { FeedsTable } from "@/components/settings/feeds-table";

export default async function Page() {
  const user = await requireUser();
  requirePermission(user.role, "feed", "manage");
  const feeds = await getFeeds();
  return <FeedsTable feeds={feeds} />;
}
