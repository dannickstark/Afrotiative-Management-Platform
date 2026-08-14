"use client";
import { useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DataTable } from "@/components/ui/data-table";
import { DataTableToolbar } from "@/components/ui/data-table-toolbar";
import type { ColumnFiltersState } from "@tanstack/react-table";
import { PageHeader } from "@/components/shell/page-header";
import { EmptyState } from "@/components/shell/empty-state";
import { FeedSheet } from "./feed-sheet";
import { cn } from "@/lib/utils";
import type { Feed } from "@/lib/queries/settings";
// Type-only: erased at compile time, so this never pulls lib/pipeline/feed-health.ts's DB-touching
// runtime code (updateFeedHealth) into this "use client" bundle. The actual health VALUE per feed
// is computed server-side by getFeeds() (lib/queries/settings.ts) — this component only renders it.
import type { FeedHealth } from "@/lib/pipeline/feed-health";
import {
  feedsColumns, HEALTH_STYLE, STATUS_LABEL, STATUS_OPTIONS, ACTIVE_LABEL, ACTIVE_OPTIONS,
} from "./feeds-columns";

const HEALTH_LABEL_PLURAL: Record<FeedHealth, string> = {
  healthy: "sains", degraded: "dégradés", failing: "en échec", idle: "inactifs",
};
const HEALTH_ORDER: FeedHealth[] = ["healthy", "degraded", "failing", "idle"];

// Page-level table for the RSS sources admin (SP2 Task 2). Owns the "Ajouter une source" entry
// point and the shared add/edit FeedSheet — the page.tsx wrapper stays a plain server component
// (its own requireUser/requirePermission gate), all interactivity lives here, mirroring how
// components/pipeline/runs-view.tsx owns its header action + table + detail sheet together.
export function FeedsTable({ feeds }: { feeds: Feed[] }) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editingFeed, setEditingFeed] = useState<Feed | null>(null);
  // B5: status/active facet filters are TanStack column filters (matched by feeds-columns.tsx's
  // `equalsFilter`) instead of per-row conditionals — DataTable (client mode,
  // components/ui/data-table.tsx) runs getFilteredRowModel()/getSortedRowModel() over `feeds`
  // directly. A column only carries an entry here while its Select is off "Tous les …".
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [globalFilter, setGlobalFilter] = useState("");
  const statusFilter = (columnFilters.find((f) => f.id === "status")?.value as string | undefined) ?? "all";
  const activeFilter = (columnFilters.find((f) => f.id === "active")?.value as string | undefined) ?? "all";
  function setFacetFilter(id: "status" | "active", value: string) {
    setColumnFilters((prev) => {
      const rest = prev.filter((f) => f.id !== id);
      return value === "all" ? rest : [...rest, { id, value }];
    });
  }

  function openCreate() {
    setEditingFeed(null);
    setSheetOpen(true);
  }
  function openEdit(feed: Feed) {
    setEditingFeed(feed);
    setSheetOpen(true);
  }

  // Threads `openEdit` into the actions column's "Modifier" button (feeds-columns.tsx's
  // FeedActionsCell) — recomputed only when the callback identity changes since it's stable
  // across renders (openEdit doesn't close over feeds/columnFilters).
  const columns = useMemo(() => feedsColumns(openEdit), []);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Sources RSS"
        actions={
          <Button onClick={openCreate}>
            <Plus aria-hidden /> Ajouter une source
          </Button>
        }
      />

      {feeds.length > 0 && <HealthSummary feeds={feeds} />}

      {feeds.length === 0 ? (
        <EmptyState
          title="Aucune source configurée"
          hint="Ajoutez un flux RSS pour commencer à alimenter le pipeline."
          action={
            <Button onClick={openCreate} variant="outline" size="sm">
              <Plus aria-hidden /> Ajouter une source
            </Button>
          }
        />
      ) : (
        <DataTable
          columns={columns}
          data={feeds}
          globalFilter={globalFilter}
          onGlobalFilterChange={setGlobalFilter}
          columnFilters={columnFilters}
          onColumnFiltersChange={setColumnFilters}
          emptyMessage="Aucune source ne correspond à ces filtres. Essayez d'élargir vos filtres de statut ou d'activation."
          toolbar={
            <DataTableToolbar
              globalValue={globalFilter}
              onGlobalChange={setGlobalFilter}
              searchPlaceholder="Rechercher une source…"
            >
              <Select value={statusFilter} onValueChange={(v) => setFacetFilter("status", v ?? "all")}>
                <SelectTrigger className="w-40" size="sm">
                  <SelectValue placeholder="Statut">
                    {(v: string) => (v && v !== "all" ? STATUS_LABEL[v as Feed["lastFetchStatus"]] : "Tous les statuts")}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Tous les statuts</SelectItem>
                  {STATUS_OPTIONS.map((s) => (
                    <SelectItem key={s} value={s}>{STATUS_LABEL[s]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={activeFilter} onValueChange={(v) => setFacetFilter("active", v ?? "all")}>
                <SelectTrigger className="w-32" size="sm">
                  <SelectValue placeholder="Actif">
                    {(v: string) => (v && v !== "all" ? ACTIVE_LABEL[v as "true" | "false"] : "Toutes")}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Toutes</SelectItem>
                  {ACTIVE_OPTIONS.map((a) => (
                    <SelectItem key={a} value={a}>{ACTIVE_LABEL[a]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </DataTableToolbar>
          }
        />
      )}

      <FeedSheet open={sheetOpen} onOpenChange={setSheetOpen} feed={editingFeed} />
    </div>
  );
}

// SP8 — compact "matrix" summary strip above the table: how many feeds sit in each of
// deriveFeedHealth's 4 states, at a glance, before scanning the per-row detail below.
function HealthSummary({ feeds }: { feeds: Feed[] }) {
  const counts: Record<FeedHealth, number> = { healthy: 0, degraded: 0, failing: 0, idle: 0 };
  for (const feed of feeds) counts[feed.health]++;

  return (
    <div className="flex flex-wrap gap-2" role="status" aria-label="Résumé de la santé des sources">
      {HEALTH_ORDER.map((health) => (
        <span
          key={health}
          className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-sm", HEALTH_STYLE[health])}
        >
          <span className="font-semibold">{counts[health]}</span> {HEALTH_LABEL_PLURAL[health]}
        </span>
      ))}
    </div>
  );
}

