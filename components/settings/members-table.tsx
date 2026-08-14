"use client";
import { useMemo, useState } from "react";
import type { ColumnFiltersState } from "@tanstack/react-table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DataTable } from "@/components/ui/data-table";
import { DataTableToolbar } from "@/components/ui/data-table-toolbar";
import { PageHeader } from "@/components/shell/page-header";
import { EmptyState } from "@/components/shell/empty-state";
import { AddMemberDialog } from "./add-member-dialog";
import { ROLE_LABEL } from "@/lib/rbac";
import type { Member } from "@/lib/queries/settings";
import { membersColumns, ROLES, STATUS_LABEL, STATUS_OPTIONS, type MemberStatus } from "./members-columns";

// Page-level table for the team admin (SP2 Task 3). Owns the "Ajouter un membre" entry point,
// mirroring how components/settings/feeds-table.tsx owns "Ajouter une source" — the page.tsx
// wrapper stays a thin server component (its own requireUser/requirePermission gate + data fetch).
export function MembersTable({ members, currentUserId }: { members: Member[]; currentUserId: string }) {
  // B6: role/status facet filters are TanStack column filters (matched by members-columns.tsx's
  // `equalsFilter`) instead of per-row conditionals — DataTable (client mode,
  // components/ui/data-table.tsx) runs getFilteredRowModel()/getSortedRowModel() over `members`
  // directly. A column only carries an entry here while its Select is off "Tous les …".
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [globalFilter, setGlobalFilter] = useState("");
  const roleFilter = (columnFilters.find((f) => f.id === "role")?.value as string | undefined) ?? "all";
  const statusFilter = (columnFilters.find((f) => f.id === "status")?.value as string | undefined) ?? "all";
  function setFacetFilter(id: "role" | "status", value: string) {
    setColumnFilters((prev) => {
      const rest = prev.filter((f) => f.id !== id);
      return value === "all" ? rest : [...rest, { id, value }];
    });
  }

  // `currentUserId` drives the "(vous)" name suffix and the self-disable guard in the actions
  // column (members-columns.tsx's MemberActionsCell) — stable across renders for this table.
  const columns = useMemo(() => membersColumns(currentUserId), [currentUserId]);

  return (
    <div className="space-y-6">
      <PageHeader title="Équipe" actions={<AddMemberDialog />} />

      {members.length === 0 ? (
        <EmptyState
          title="Aucun membre"
          hint="Ajoutez un membre pour lui donner accès à l'équipe."
          action={<AddMemberDialog />}
        />
      ) : (
        <DataTable
          columns={columns}
          data={members}
          globalFilter={globalFilter}
          onGlobalFilterChange={setGlobalFilter}
          columnFilters={columnFilters}
          onColumnFiltersChange={setColumnFilters}
          emptyMessage="Aucun membre ne correspond à ces filtres. Essayez d'élargir vos filtres de rôle ou de statut."
          toolbar={
            <DataTableToolbar
              globalValue={globalFilter}
              onGlobalChange={setGlobalFilter}
              searchPlaceholder="Rechercher un membre…"
            >
              <Select value={roleFilter} onValueChange={(v) => setFacetFilter("role", v ?? "all")}>
                <SelectTrigger className="w-36" size="sm">
                  <SelectValue placeholder="Rôle">
                    {(v: string) => (v && v !== "all" ? ROLE_LABEL[v as Member["role"]] : "Tous les rôles")}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Tous les rôles</SelectItem>
                  {ROLES.map((r) => (
                    <SelectItem key={r} value={r}>{ROLE_LABEL[r]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={statusFilter} onValueChange={(v) => setFacetFilter("status", v ?? "all")}>
                <SelectTrigger className="w-32" size="sm">
                  <SelectValue placeholder="Statut">
                    {(v: string) => (v && v !== "all" ? STATUS_LABEL[v as MemberStatus] : "Tous les statuts")}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Tous les statuts</SelectItem>
                  {STATUS_OPTIONS.map((s) => (
                    <SelectItem key={s} value={s}>{STATUS_LABEL[s]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </DataTableToolbar>
          }
        />
      )}
    </div>
  );
}
