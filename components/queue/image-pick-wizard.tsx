"use client";
import { useState } from "react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { pickRegeneratedImage } from "@/lib/actions/regen-actions";
import type { ImageCandidate } from "@/db";

export type PendingPick = {
  articleId: string; title: string; currentImageUrl: string | null; candidates: ImageCandidate[];
};

/**
 * PUR — index du prochain article encore à traiter, en repartant de `from` et en BOUCLANT sur le
 * début : c'est ce qui rattrape les articles « Passés » plus tôt dans la session, plutôt que de
 * terminer l'assistant en les laissant silencieusement de côté. Renvoie null quand tout est traité.
 */
export function nextPendingIndex(picks: PendingPick[], done: Set<string>, from: number): number | null {
  for (let k = 0; k < picks.length; k += 1) {
    const i = (from + k) % picks.length;
    if (!done.has(picks[i].articleId)) return i;
  }
  return null;
}

/**
 * Parcourt un par un les articles dont une régénération en mode manuel a garé des candidats.
 * Le fermer ne perd RIEN : la source de vérité est articles.pending_image_candidates (le bac), pas
 * l'état de ce composant — un article « Passé » réapparaîtra au prochain lancement.
 */
export function ImagePickWizard({ picks, open, onOpenChange, onAllDone }: {
  picks: PendingPick[]; open: boolean; onOpenChange: (v: boolean) => void; onAllDone: () => void;
}) {
  const [index, setIndex] = useState(0);
  const [done, setDone] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const current = picks[index];
  const remaining = picks.length - done.size;

  function advance(articleId: string, markDone: boolean) {
    const nextDone = markDone ? new Set(done).add(articleId) : done;
    setDone(nextDone);
    const next = nextPendingIndex(picks, nextDone, index + 1);
    if (next === null) { onOpenChange(false); onAllDone(); return; }
    setIndex(next);
  }

  async function choose(candidate: ImageCandidate | null) {
    if (!current || busy) return;
    setBusy(true);
    try {
      const r = await pickRegeneratedImage(current.articleId, candidate === null ? null : {
        url: candidate.url, credit: candidate.mediaName, sourceUrl: candidate.sourceUrl,
      });
      if (!r.ok) { toast.error(r.message); return; }
      advance(current.articleId, true);
    } finally { setBusy(false); }
  }

  if (!current) return <></>;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Choisir l&apos;image à la une</DialogTitle>
          <DialogDescription>
            {current.title} — {picks.length - remaining + 1}/{picks.length}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 sm:grid-cols-[200px_1fr]">
          <div className="space-y-1">
            <p className="text-sm font-medium">Image actuelle</p>
            {current.currentImageUrl
              // eslint-disable-next-line @next/next/no-img-element -- URLs distantes arbitraires, non optimisables
              ? <img src={current.currentImageUrl} alt="" className="w-full rounded border object-cover" />
              : <p className="text-sm text-muted-foreground">Aucune</p>}
          </div>
          <div className="grid max-h-96 grid-cols-2 gap-2 overflow-y-auto lg:grid-cols-3">
            {current.candidates.map((c) => (
              <button
                key={c.url} type="button" disabled={busy} onClick={() => void choose(c)}
                className="group overflow-hidden rounded border text-left hover:ring-2 hover:ring-primary disabled:opacity-50"
                title={`${c.mediaName} — ${c.url}`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- idem */}
                <img src={c.url} alt="" className="aspect-video w-full object-cover" />
                <span className="block truncate px-1 py-0.5 text-xs text-muted-foreground">{c.mediaName}</span>
              </button>
            ))}
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" disabled={busy} onClick={() => advance(current.articleId, false)}>Passer</Button>
          <Button type="button" variant="ghost" disabled={busy} onClick={() => void choose(null)}>Aucune image</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
