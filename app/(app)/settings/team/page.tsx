import { requireUser } from "@/lib/session";
import { requirePermission, ROLE_LABEL } from "@/lib/rbac";
import { getMembers } from "@/lib/queries/settings";

export default async function Page() {
  const user = await requireUser();
  requirePermission(user.role, "team", "manage");
  const members = await getMembers();
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Équipe</h1>
      {/* MembersTable arrive en Task 4 */}
      <ul className="text-sm text-muted-foreground">
        {members.map((m) => (
          <li key={m.id}>{m.name} ({m.email}) — {ROLE_LABEL[m.role]}{m.banned ? " — suspendu" : ""}</li>
        ))}
      </ul>
      <pre className="text-xs text-muted-foreground">{members.length} membre(s)</pre>
    </div>
  );
}
