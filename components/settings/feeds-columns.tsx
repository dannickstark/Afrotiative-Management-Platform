"use client";
import { useTransition } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import type { ColumnDef, FilterFn } from "@tanstack/react-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DataTableColumnHeader } from "@/components/ui/data-table-column-header";
import { toggleFeed, deleteFeed, testFeed } from "@/lib/actions/feed-actions";
import { relativeDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Feed } from "@/lib/queries/settings";
import type { FeedHealth } from "@/lib/pipeline/feed-health";

// Moved verbatim from the old hand-rolled feeds-table.tsx so the column cells and the toolbar's
// facet Selects (feeds-table.tsx) read the exact same labels/styles/order from one place.
export const STATUS_LABEL: Record<Feed["lastFetchStatus"], string> = {
  ok: "OK", error: "Erreur", never: "Jamais récupéré",
};
export const STATUS_STYLE: Record<Feed["lastFetchStatus"], string> = {
  ok: "bg-[var(--status-approved)]/15 text-[var(--status-approved)] border-[var(--status-approved)]/30",
  error: "bg-[var(--status-error)]/15 text-[var(--status-error)] border-[var(--status-error)]/30",
  never: "bg-[var(--status-draft)]/15 text-[var(--status-draft)] border-[var(--status-draft)]/30",
};
export const STATUS_OPTIONS: Feed["lastFetchStatus"][] = ["ok", "error", "never"];

export const HEALTH_LABEL: Record<FeedHealth, string> = {
  healthy: "Sain", degraded: "Dégradé", failing: "En échec", idle: "Inactif",
};
export const HEALTH_STYLE: Record<FeedHealth, string> = {
  healthy: "bg-[var(--status-approved)]/15 text-[var(--status-approved)] border-[var(--status-approved)]/30",
  degraded: "bg-[var(--status-pending)]/15 text-[var(--status-pending)] border-[var(--status-pending)]/30",
  failing: "bg-[var(--status-error)]/15 text-[var(--status-error)] border-[var(--status-error)]/30",
  idle: "bg-[var(--status-draft)]/15 text-[var(--status-draft)] border-[var(--status-draft)]/30",
};

// French labels for the "Actif" facet filter (feed.active is a plain boolean; the toolbar Select
// (feeds-table.tsx) only ever pushes the string "true"/"false" into columnFilters, matched below
// via equalsFilter's String() coercion).
export const ACTIVE_LABEL: Record<"true" | "false", string> = { true: "Active", false: "Inactive" };
export const ACTIVE_OPTIONS: ("true" | "false")[] = ["true", "false"];

// B5: null-safe sort key for the "Dernière lecture" column — a feed that has never been fetched
// (lastFetchAt === null) has no real timestamp yet; sort it to Number.NEGATIVE_INFINITY so it
// consistently groups at the "oldest" end regardless of sort direction, instead of comparing as
// 0/NaN against feeds with a real fetch timestamp. The cell itself still DISPLAYS lib/format.ts's
// existing relativeDate string, unchanged from the old hand-rolled table. Exported + unit-tested
// (tests/feeds-columns.test.ts) per this task's TDD note.
export function feedLastFetchSortValue(d: Date | string | null): number {
  return d ? new Date(d).getTime() : Number.NEGATIVE_INFINITY;
}

// Exact-match facet filter shared by the status/active columns. String()-coerces both sides so it
// works uniformly whether the underlying value is a string enum (lastFetchStatus) or a boolean
// (active) against the toolbar Select's string filterValue.
const equalsFilter: FilterFn<Feed> = (row, columnId, filterValue) => String(row.getValue(columnId)) === filterValue;

// Row-scoped active/inactive Switch — unchanged from the old FeedRow's handleToggle, just lifted
// into its own cell component so each row keeps its own independent useTransition busy state.
function ActiveToggleCell({ feed }: { feed: Feed }) {
  const [isToggling, startToggle] = useTransition();

  function handleToggle(active: boolean) {
    startToggle(async () => {
      try {
        await toggleFeed(feed.id, active);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Échec de la mise à jour.");
      }
    });
  }

  return (
    <Switch
      checked={feed.active}
      onCheckedChange={handleToggle}
      disabled={isToggling}
      aria-label={`Activer ou désactiver « ${feed.name} »`}
    />
  );
}

// Row-scoped actions menu (Modifier / Vérifier / Supprimer) — unchanged from the old FeedRow's
// handleTest/handleDelete. `onEdit` is threaded in from feeds-table.tsx (opens the shared
// add/edit FeedSheet, which lives at the FeedsTable level, not per-row).
function FeedActionsCell({ feed, onEdit }: { feed: Feed; onEdit: () => void }) {
  const [isTesting, startTest] = useTransition();
  const [isDeleting, startDelete] = useTransition();
  const busy = isTesting || isDeleting;

  function handleTest() {
    startTest(async () => {
      try {
        const res = await testFeed(feed.feedUrl);
        if (res.ok) toast.success(res.message);
        else toast.error(res.message);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Impossible de vérifier ce flux.");
      }
    });
  }

  function handleDelete() {
    startDelete(async () => {
      try {
        await deleteFeed(feed.id);
        toast.success(`« ${feed.name} » supprimée.`);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Échec de la suppression.");
      }
    });
  }

  return (
    <div className="flex items-center justify-end gap-1">
      <Button variant="ghost" size="sm" onClick={onEdit} disabled={busy}>
        Modifier
      </Button>
      <Button variant="ghost" size="sm" onClick={handleTest} disabled={busy}>
        {isTesting && <Loader2 className="animate-spin" aria-hidden />}
        Vérifier
      </Button>
      <ConfirmDialog
        trigger={
          <Button
            variant="ghost" size="sm" disabled={busy}
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          >
            Supprimer
          </Button>
        }
        title="Supprimer cette source ?"
        description={`« ${feed.name} » ne sera plus surveillée et son historique de récupération sera supprimé. Les articles déjà générés à partir de ce flux restent inchangés.`}
        confirmLabel="Supprimer"
        destructive
        onConfirm={handleDelete}
      />
    </div>
  );
}

// Factory (not a static array like runs-columns.tsx's `runsColumns`) because the actions column
// needs `onEdit`, a closure owned by FeedsTable's own state (setEditingFeed/setSheetOpen) — there's
// no DataTable-level hook for a per-row "edit" trigger the way `onRowClick` covers row navigation.
export function feedsColumns(onEdit: (feed: Feed) => void): ColumnDef<Feed>[] {
  return [
    {
      accessorKey: "name", id: "name",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Nom" />,
      cell: ({ getValue }) => <span className="font-medium">{getValue() as string}</span>,
    },
    {
      accessorKey: "feedUrl", id: "feedUrl", enableSorting: false,
      header: ({ column }) => <DataTableColumnHeader column={column} title="URL du flux" />,
      cell: ({ getValue }) => (
        <span className="block max-w-[280px] truncate text-muted-foreground">{getValue() as string}</span>
      ),
    },
    {
      accessorKey: "health", id: "health", enableSorting: false, enableGlobalFilter: false,
      header: ({ column }) => <DataTableColumnHeader column={column} title="Santé" />,
      cell: ({ row }) => {
        const feed = row.original;
        return (
          <div className="flex flex-col gap-0.5">
            <Badge variant="outline" className={HEALTH_STYLE[feed.health]}>
              {HEALTH_LABEL[feed.health]}
            </Badge>
            {feed.consecutiveFailures > 0 && (
              <span className="text-xs text-muted-foreground">
                {feed.consecutiveFailures} échec{feed.consecutiveFailures > 1 ? "s" : ""} consécutif
                {feed.consecutiveFailures > 1 ? "s" : ""}
              </span>
            )}
          </div>
        );
      },
    },
    {
      id: "lastFetchAt", enableGlobalFilter: false,
      accessorFn: (row) => feedLastFetchSortValue(row.lastFetchAt),
      header: ({ column }) => <DataTableColumnHeader column={column} title="Dernière lecture" />,
      cell: ({ row }) => (
        <span className="text-muted-foreground">{relativeDate(row.original.lastFetchAt)}</span>
      ),
    },
    {
      accessorKey: "lastFetchStatus", id: "status", enableGlobalFilter: false,
      header: ({ column }) => <DataTableColumnHeader column={column} title="Statut" />,
      cell: ({ getValue }) => {
        const v = getValue() as Feed["lastFetchStatus"];
        return (
          <Badge variant="outline" className={STATUS_STYLE[v]}>
            {STATUS_LABEL[v]}
          </Badge>
        );
      },
      filterFn: equalsFilter,
    },
    {
      accessorKey: "itemsCaptured7d", id: "itemsCaptured7d", enableGlobalFilter: false,
      header: ({ column }) => <DataTableColumnHeader column={column} title="Articles (7 j)" />,
      cell: ({ getValue }) => <span className="block text-right">{getValue() as number}</span>,
    },
    {
      accessorKey: "active", id: "active", enableSorting: false, enableGlobalFilter: false,
      header: ({ column }) => <DataTableColumnHeader column={column} title="Actif" />,
      cell: ({ row }) => <ActiveToggleCell feed={row.original} />,
      filterFn: equalsFilter,
    },
    {
      id: "actions", enableSorting: false, enableGlobalFilter: false,
      header: ({ column }) => (
        <div className={cn("text-right")}>
          <DataTableColumnHeader column={column} title="Actions" />
        </div>
      ),
      cell: ({ row }) => <FeedActionsCell feed={row.original} onEdit={() => onEdit(row.original)} />,
    },
  ];
}
