"use client";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Loader2, Plus } from "lucide-react";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { FeedSheet } from "./feed-sheet";
import { toggleFeed, deleteFeed, testFeed } from "@/lib/actions/feed-actions";
import { relativeDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Feed } from "@/lib/queries/settings";
// Type-only: erased at compile time, so this never pulls lib/pipeline/feed-health.ts's DB-touching
// runtime code (updateFeedHealth) into this "use client" bundle. The actual health VALUE per feed
// is computed server-side by getFeeds() (lib/queries/settings.ts) — this component only renders it.
import type { FeedHealth } from "@/lib/pipeline/feed-health";

const STATUS_LABEL: Record<Feed["lastFetchStatus"], string> = {
  ok: "OK", error: "Erreur", never: "Jamais récupéré",
};
// Per brief: ok→green(--status-approved), error→red(--status-error), never→slate(--status-draft).
const STATUS_STYLE: Record<Feed["lastFetchStatus"], string> = {
  ok: "bg-[var(--status-approved)]/15 text-[var(--status-approved)] border-[var(--status-approved)]/30",
  error: "bg-[var(--status-error)]/15 text-[var(--status-error)] border-[var(--status-error)]/30",
  never: "bg-[var(--status-draft)]/15 text-[var(--status-draft)] border-[var(--status-draft)]/30",
};

// SP8 — deriveFeedHealth's 4-state matrix indicator (French, distinct from the raw ok/error/never
// STATUS_* above: "santé" folds in the failure streak + active flag + the "0 items while active"
// signal, "statut" is just the last read's raw outcome). Same green/amber/red/slate palette as the
// rest of the pipeline UI (--status-approved/pending/error/draft — see run-trends.tsx, runs-view.tsx).
const HEALTH_LABEL: Record<FeedHealth, string> = {
  healthy: "Sain", degraded: "Dégradé", failing: "En échec", idle: "Inactif",
};
const HEALTH_LABEL_PLURAL: Record<FeedHealth, string> = {
  healthy: "sains", degraded: "dégradés", failing: "en échec", idle: "inactifs",
};
const HEALTH_STYLE: Record<FeedHealth, string> = {
  healthy: "bg-[var(--status-approved)]/15 text-[var(--status-approved)] border-[var(--status-approved)]/30",
  degraded: "bg-[var(--status-pending)]/15 text-[var(--status-pending)] border-[var(--status-pending)]/30",
  failing: "bg-[var(--status-error)]/15 text-[var(--status-error)] border-[var(--status-error)]/30",
  idle: "bg-[var(--status-draft)]/15 text-[var(--status-draft)] border-[var(--status-draft)]/30",
};
const HEALTH_ORDER: FeedHealth[] = ["healthy", "degraded", "failing", "idle"];

// Page-level table for the RSS sources admin (SP2 Task 2). Owns the "Ajouter une source" entry
// point and the shared add/edit FeedSheet — the page.tsx wrapper stays a plain server component
// (its own requireUser/requirePermission gate), all interactivity lives here, mirroring how
// components/pipeline/runs-view.tsx owns its header action + table + detail sheet together.
export function FeedsTable({ feeds }: { feeds: Feed[] }) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editingFeed, setEditingFeed] = useState<Feed | null>(null);

  function openCreate() {
    setEditingFeed(null);
    setSheetOpen(true);
  }
  function openEdit(feed: Feed) {
    setEditingFeed(feed);
    setSheetOpen(true);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Sources RSS</h1>
        <Button onClick={openCreate}>
          <Plus aria-hidden /> Ajouter une source
        </Button>
      </div>

      {feeds.length > 0 && <HealthSummary feeds={feeds} />}

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Nom</TableHead>
              <TableHead>URL du flux</TableHead>
              <TableHead>Santé</TableHead>
              <TableHead>Dernière lecture</TableHead>
              <TableHead>Statut</TableHead>
              <TableHead className="text-right">Articles (7 j)</TableHead>
              <TableHead>Actif</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {feeds.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="h-24 text-center text-muted-foreground">
                  Aucune source configurée.
                </TableCell>
              </TableRow>
            ) : (
              feeds.map((feed) => <FeedRow key={feed.id} feed={feed} onEdit={() => openEdit(feed)} />)
            )}
          </TableBody>
        </Table>
      </div>

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

function FeedRow({ feed, onEdit }: { feed: Feed; onEdit: () => void }) {
  const [isToggling, startToggle] = useTransition();
  const [isTesting, startTest] = useTransition();
  const [isDeleting, startDelete] = useTransition();

  function handleToggle(active: boolean) {
    startToggle(async () => {
      try {
        await toggleFeed(feed.id, active);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Échec de la mise à jour.");
      }
    });
  }

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

  const busy = isToggling || isTesting || isDeleting;

  return (
    <TableRow>
      <TableCell className="font-medium">{feed.name}</TableCell>
      <TableCell className="max-w-[280px] truncate text-muted-foreground">{feed.feedUrl}</TableCell>
      <TableCell>
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
      </TableCell>
      <TableCell className="text-muted-foreground">{relativeDate(feed.lastFetchAt)}</TableCell>
      <TableCell>
        <Badge variant="outline" className={STATUS_STYLE[feed.lastFetchStatus]}>
          {STATUS_LABEL[feed.lastFetchStatus]}
        </Badge>
      </TableCell>
      <TableCell className="text-right">{feed.itemsCaptured7d}</TableCell>
      <TableCell>
        <Switch
          checked={feed.active}
          onCheckedChange={handleToggle}
          disabled={busy}
          aria-label={`Activer ou désactiver « ${feed.name} »`}
        />
      </TableCell>
      <TableCell>
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
      </TableCell>
    </TableRow>
  );
}
