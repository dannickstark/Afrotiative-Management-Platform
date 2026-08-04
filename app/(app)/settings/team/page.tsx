import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";
import { getMembers } from "@/lib/queries/settings";
import { MembersTable } from "@/components/settings/members-table";

export default async function Page() {
  const user = await requireUser();
  requirePermission(user.role, "team", "manage");
  const members = await getMembers();
  return <MembersTable members={members} currentUserId={user.id} />;
}
