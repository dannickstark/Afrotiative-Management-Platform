"use client";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetFooter,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { createFeed, updateFeed, testFeed } from "@/lib/actions/feed-actions";
import { validateFeedInput } from "@/lib/validation";
import type { Feed } from "@/lib/queries/settings";

type FormState = { name: string; feedUrl: string; siteUrl: string; active: boolean };

const EMPTY: FormState = { name: "", feedUrl: "", siteUrl: "", active: true };

// Add/edit form for a single RSS source. Controlled entirely by the parent (FeedsTable): `feed`
// null means "Ajouter une source", a Feed means "Modifier" that row. Mirrors RunDetailSheet's
// pattern of a parent-owned open/selection state rather than an internal SheetTrigger, since two
// different entry points ("Ajouter" button + each row's "Modifier" action) need to open the same
// sheet in different modes.
export function FeedSheet({
  open, onOpenChange, feed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  feed: Feed | null;
}) {
  const [form, setForm] = useState<FormState>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, startSaving] = useTransition();
  const [isTesting, startTesting] = useTransition();

  // Re-sync local state off props every time the sheet opens (not just on mount) — otherwise
  // reopening on a different row (or switching from "Modifier" back to "Ajouter") would keep
  // showing the previously-edited row's stale values.
  useEffect(() => {
    if (!open) return;
    setForm(feed ? { name: feed.name, feedUrl: feed.feedUrl, siteUrl: feed.siteUrl ?? "", active: feed.active } : EMPTY);
    setError(null);
  }, [open, feed]);

  function handleTest() {
    setError(null);
    startTesting(async () => {
      try {
        const res = await testFeed(form.feedUrl);
        if (res.ok) toast.success(res.message);
        else toast.error(res.message);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Impossible de vérifier ce flux.");
      }
    });
  }

  function handleSave() {
    const validated = validateFeedInput({ name: form.name, feedUrl: form.feedUrl, siteUrl: form.siteUrl, active: form.active });
    if (!validated.ok) { setError(validated.message); return; }
    setError(null);
    startSaving(async () => {
      try {
        if (feed) await updateFeed(feed.id, validated.data);
        else await createFeed(validated.data);
        toast.success(feed ? "Source mise à jour." : "Source ajoutée.");
        onOpenChange(false);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Échec de l'enregistrement.";
        setError(message);
        toast.error(message);
      }
    });
  }

  const busy = isSaving || isTesting;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="sm:max-w-md data-[side=right]:sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{feed ? "Modifier la source" : "Ajouter une source"}</SheetTitle>
          <SheetDescription>
            {feed ? `Modifier « ${feed.name} ».` : "Ajouter un nouveau flux RSS à surveiller."}
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 pb-4">
          <div className="space-y-1.5">
            <Label htmlFor="feed-name">Nom</Label>
            <Input
              id="feed-name" value={form.name} disabled={busy}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="Ex. Financial Afrik"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="feed-url">URL du flux RSS</Label>
            <Input
              id="feed-url" value={form.feedUrl} disabled={busy}
              onChange={(e) => setForm((f) => ({ ...f, feedUrl: e.target.value }))}
              placeholder="https://exemple.com/feed"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="feed-site">URL du site (optionnel)</Label>
            <Input
              id="feed-site" value={form.siteUrl} disabled={busy}
              onChange={(e) => setForm((f) => ({ ...f, siteUrl: e.target.value }))}
              placeholder="https://exemple.com"
            />
          </div>
          <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
            <Label htmlFor="feed-active">Source active</Label>
            <Switch
              id="feed-active" checked={form.active} disabled={busy}
              onCheckedChange={(checked) => setForm((f) => ({ ...f, active: checked }))}
            />
          </div>

          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}

          <Button variant="outline" onClick={handleTest} disabled={busy || !form.feedUrl.trim()} className="self-start">
            {isTesting && <Loader2 className="animate-spin" aria-hidden />}
            {isTesting ? "Vérification…" : "Vérifier ce flux"}
          </Button>
        </div>

        <SheetFooter className="flex-row justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Annuler</Button>
          <Button onClick={handleSave} disabled={busy}>
            {isSaving && <Loader2 className="animate-spin" aria-hidden />}
            {isSaving ? "Enregistrement…" : "Enregistrer"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
