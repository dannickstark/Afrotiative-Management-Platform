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
import type { Feed } from "@/lib/queries/settings";

const HEALTH_LABEL: Record<Feed["lastFetchStatus"], string> = {
  ok: "OK", error: "Erreur", never: "Jamais récupéré",
};
// Per brief: ok→green(--status-approved), error→red(--status-error), never→slate(--status-draft).
const HEALTH_STYLE: Record<Feed["lastFetchStatus"], string> = {
  ok: "bg-[var(--status-approved)]/15 text-[var(--status-approved)] border-[var(--status-approved)]/30",
  error: "bg-[var(--status-error)]/15 text-[var(--status-error)] border-[var(--status-error)]/30",
  never: "bg-[var(--status-draft)]/15 text-[var(--status-draft)] border-[var(--status-draft)]/30",
};

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

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Nom</TableHead>
              <TableHead>URL du flux</TableHead>
              <TableHead>Statut</TableHead>
              <TableHead className="text-right">Articles (7 j)</TableHead>
              <TableHead>Actif</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {feeds.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
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
        <Badge variant="outline" className={HEALTH_STYLE[feed.lastFetchStatus]}>
          {HEALTH_LABEL[feed.lastFetchStatus]}
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
