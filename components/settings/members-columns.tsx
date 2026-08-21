"use client";
import { useTransition } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import type { ColumnDef, FilterFn } from "@tanstack/react-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DataTableColumnHeader } from "@/components/ui/data-table-column-header";
import { setMemberRole, disableMember, enableMember } from "@/lib/actions/team-actions";
import { ROLE_LABEL } from "@/lib/rbac";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Member } from "@/lib/queries/settings";
import type { Role } from "@/lib/auth";

// Task 5 (conducteur de montage) : "monteur" existe désormais au niveau RBAC (lib/auth's Role) mais
// n'est pas assignable depuis /settings/team — ROLES ci-dessous (et donc ce Select) le retient
// intentionnellement en dehors. `as const satisfies readonly Role[]` keeps the literal union (so
// AssignableRole stays the 3-way subset, matching setMemberRole's roleEnum-typed param) while still
// checking every entry is a valid Role.
export const ROLES = ["journalist", "editor", "admin"] as const satisfies readonly Role[];
type AssignableRole = (typeof ROLES)[number];

// "Statut" is derived from the raw `banned` boolean (member.banned → "disabled" | "active"), not a
// DB column of its own — moved verbatim from the old hand-rolled members-table.tsx, same
// green/red outline-badge convention as components/settings/feeds-columns.tsx's status badge.
export type MemberStatus = "active" | "disabled";
export const STATUS_LABEL: Record<MemberStatus, string> = { active: "Actif", disabled: "Désactivé" };
export const STATUS_STYLE: Record<MemberStatus, string> = {
  active: "bg-[var(--status-approved)]/15 text-[var(--status-approved)] border-[var(--status-approved)]/30",
  disabled: "bg-[var(--status-error)]/15 text-[var(--status-error)] border-[var(--status-error)]/30",
};
export const STATUS_OPTIONS: MemberStatus[] = ["active", "disabled"];

function memberStatus(member: Member): MemberStatus {
  return member.banned ? "disabled" : "active";
}

// B6: null-safe sort key for the "Dernière connexion" column — a member who has never logged in
// (lastLoginAt === null) has no real timestamp yet; sort it to Number.NEGATIVE_INFINITY so it
// consistently groups at the "oldest" end regardless of sort direction, instead of comparing as
// 0/NaN against members with a real login timestamp. The cell itself still DISPLAYS lib/format.ts's
// existing formatDate string, unchanged from the old hand-rolled table. Exported + unit-tested
// (tests/members-columns.test.ts) per this task's TDD note.
export function memberLastLoginSortValue(d: Date | string | null): number {
  return d ? new Date(d).getTime() : Number.NEGATIVE_INFINITY;
}

// Exact-match facet filter shared by the role/status columns.
const equalsFilter: FilterFn<Member> = (row, columnId, filterValue) => String(row.getValue(columnId)) === filterValue;

// Row-scoped role Select — unchanged from the old MemberRow's handleRoleChange, just lifted into
// its own cell component so each row keeps its own independent useTransition busy state.
function RoleSelectCell({ member }: { member: Member }) {
  const [isChangingRole, startRoleChange] = useTransition();

  function handleRoleChange(role: AssignableRole) {
    if (role === member.role) return;
    startRoleChange(async () => {
      try {
        const res = await setMemberRole(member.id, role);
        if (res.ok) toast.success(`Rôle mis à jour : ${ROLE_LABEL[role]}.`);
        else toast.error(res.message ?? "Échec de la mise à jour du rôle.");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Échec de la mise à jour du rôle.");
      }
    });
  }

  return (
    <div className="flex items-center gap-1.5">
      <Select value={member.role} onValueChange={(v) => handleRoleChange(v as AssignableRole)} disabled={isChangingRole}>
        <SelectTrigger className="w-36" aria-label={`Rôle de ${member.name}`}>
          <SelectValue placeholder="Rôle">{(v: Role) => ROLE_LABEL[v]}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {ROLES.map((r) => (
            <SelectItem key={r} value={r}>{ROLE_LABEL[r]}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      {isChangingRole && <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />}
    </div>
  );
}

// Row-scoped actions (Réactiver / Désactiver, self-disabled) — unchanged from the old MemberRow's
// handleDisable/handleEnable. `isSelf` is threaded in from members-table.tsx (needs currentUserId,
// which is a MembersTable-level prop, not per-row data).
function MemberActionsCell({ member, isSelf }: { member: Member; isSelf: boolean }) {
  const [isTogglingBan, startBanToggle] = useTransition();

  function handleDisable() {
    startBanToggle(async () => {
      try {
        const res = await disableMember(member.id);
        if (res.ok) toast.success(`« ${member.name} » désactivé(e).`);
        else toast.error(res.message ?? "Échec de la désactivation.");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Échec de la désactivation.");
      }
    });
  }

  function handleEnable() {
    startBanToggle(async () => {
      try {
        await enableMember(member.id);
        toast.success(`« ${member.name} » réactivé(e).`);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Échec de la réactivation.");
      }
    });
  }

  return (
    <div className="flex items-center justify-end gap-1">
      {member.banned ? (
        <Button variant="ghost" size="sm" onClick={handleEnable} disabled={isTogglingBan}>
          {isTogglingBan && <Loader2 className="animate-spin" aria-hidden />}
          Réactiver
        </Button>
      ) : isSelf ? (
        <Button
          variant="ghost" size="sm" disabled
          className="text-destructive"
          title="Vous ne pouvez pas désactiver votre propre compte."
        >
          Désactiver
        </Button>
      ) : (
        <ConfirmDialog
          trigger={
            <Button
              variant="ghost" size="sm" disabled={isTogglingBan}
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              Désactiver
            </Button>
          }
          title="Désactiver ce membre ?"
          description={`« ${member.name} » ne pourra plus se connecter et sera immédiatement déconnecté(e) de toute session active. Réactivable à tout moment.`}
          confirmLabel="Désactiver"
          destructive
          onConfirm={handleDisable}
        />
      )}
    </div>
  );
}

// Factory (not a static array like runs-columns.tsx's `runsColumns`) because the "Désactiver"
// button needs `isSelf` (member.id === currentUserId), a MembersTable-level prop — there's no
// DataTable-level hook for per-row context like that.
export function membersColumns(currentUserId: string): ColumnDef<Member>[] {
  return [
    {
      accessorKey: "name", id: "name",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Nom" />,
      cell: ({ row }) => (
        <span className="font-medium">
          {row.original.name}
          {row.original.id === currentUserId && (
            <span className="ml-1.5 text-xs text-muted-foreground">(vous)</span>
          )}
        </span>
      ),
    },
    {
      accessorKey: "email", id: "email",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Email" />,
      cell: ({ getValue }) => <span className="text-muted-foreground">{getValue() as string}</span>,
    },
    {
      accessorKey: "role", id: "role", enableGlobalFilter: false,
      header: ({ column }) => <DataTableColumnHeader column={column} title="Rôle" />,
      cell: ({ row }) => <RoleSelectCell member={row.original} />,
      filterFn: equalsFilter,
    },
    {
      id: "status", enableGlobalFilter: false,
      accessorFn: (row) => memberStatus(row),
      header: ({ column }) => <DataTableColumnHeader column={column} title="Statut" />,
      cell: ({ row }) => {
        const s = memberStatus(row.original);
        return (
          <Badge variant="outline" className={STATUS_STYLE[s]}>
            {STATUS_LABEL[s]}
          </Badge>
        );
      },
      filterFn: equalsFilter,
    },
    {
      id: "lastLoginAt", enableGlobalFilter: false,
      accessorFn: (row) => memberLastLoginSortValue(row.lastLoginAt),
      header: ({ column }) => <DataTableColumnHeader column={column} title="Dernière connexion" />,
      cell: ({ row }) => (
        <span className="text-muted-foreground">{formatDate(row.original.lastLoginAt)}</span>
      ),
    },
    {
      id: "actions", enableSorting: false, enableGlobalFilter: false,
      header: ({ column }) => (
        <div className={cn("text-right")}>
          <DataTableColumnHeader column={column} title="Actions" />
        </div>
      ),
      cell: ({ row }) => (
        <MemberActionsCell member={row.original} isSelf={row.original.id === currentUserId} />
      ),
    },
  ];
}
