"use client";
import { useTransition } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { PageHeader } from "@/components/shell/page-header";
import { AddMemberDialog } from "./add-member-dialog";
import { setMemberRole, disableMember, enableMember } from "@/lib/actions/team-actions";
import { ROLE_LABEL } from "@/lib/rbac";
import { formatDate } from "@/lib/format";
import type { Member } from "@/lib/queries/settings";
import type { Role } from "@/lib/auth";

const ROLES: Role[] = ["journalist", "editor", "admin"];

// Statut badge: Actif -> green (--status-approved), Désactivé -> red (--status-error), same
// outline-badge convention as components/settings/feeds-table.tsx's health badge.
const STATUS_STYLE = {
  active: "bg-[var(--status-approved)]/15 text-[var(--status-approved)] border-[var(--status-approved)]/30",
  disabled: "bg-[var(--status-error)]/15 text-[var(--status-error)] border-[var(--status-error)]/30",
};

// Page-level table for the team admin (SP2 Task 3). Owns the "Ajouter un membre" entry point,
// mirroring how components/settings/feeds-table.tsx owns "Ajouter une source" — the page.tsx
// wrapper stays a thin server component (its own requireUser/requirePermission gate + data fetch).
export function MembersTable({ members, currentUserId }: { members: Member[]; currentUserId: string }) {
  return (
    <div className="space-y-6">
      <PageHeader title="Équipe" actions={<AddMemberDialog />} />

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Nom</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Rôle</TableHead>
              <TableHead>Statut</TableHead>
              <TableHead>Dernière connexion</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                  Aucun membre.
                </TableCell>
              </TableRow>
            ) : (
              members.map((m) => <MemberRow key={m.id} member={m} isSelf={m.id === currentUserId} />)
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function MemberRow({ member, isSelf }: { member: Member; isSelf: boolean }) {
  const [isChangingRole, startRoleChange] = useTransition();
  const [isTogglingBan, startBanToggle] = useTransition();
  const busy = isChangingRole || isTogglingBan;

  function handleRoleChange(role: Role) {
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
    <TableRow>
      <TableCell className="font-medium">
        {member.name}
        {isSelf && <span className="ml-1.5 text-xs text-muted-foreground">(vous)</span>}
      </TableCell>
      <TableCell className="text-muted-foreground">{member.email}</TableCell>
      <TableCell>
        <Select value={member.role} onValueChange={(v) => handleRoleChange(v as Role)} disabled={busy}>
          <SelectTrigger className="w-36" aria-label={`Rôle de ${member.name}`}>
            <SelectValue placeholder="Rôle">{(v: Role) => ROLE_LABEL[v]}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {ROLES.map((r) => (
              <SelectItem key={r} value={r}>{ROLE_LABEL[r]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </TableCell>
      <TableCell>
        <Badge variant="outline" className={member.banned ? STATUS_STYLE.disabled : STATUS_STYLE.active}>
          {member.banned ? "Désactivé" : "Actif"}
        </Badge>
      </TableCell>
      <TableCell className="text-muted-foreground">{formatDate(member.lastLoginAt)}</TableCell>
      <TableCell>
        <div className="flex items-center justify-end gap-1">
          {isChangingRole && <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />}
          {member.banned ? (
            <Button variant="ghost" size="sm" onClick={handleEnable} disabled={busy}>
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
                  variant="ghost" size="sm" disabled={busy}
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
      </TableCell>
    </TableRow>
  );
}
