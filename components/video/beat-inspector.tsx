"use client";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { Loader2, TriangleAlert, X } from "lucide-react";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetFooter,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { RichEditor } from "@/components/article/rich-editor";
import { updateBeat } from "@/lib/actions/video-actions";
import { isBreathRisk } from "@/lib/video/duration";
import type { BeatView } from "./beat-list";

const LINK_STATUS_LABEL: Record<string, string> = {
  non_verifie: "Non vérifié",
  ok: "OK",
  mort: "Mort",
  interdit: "Interdit",
};

type FormState = {
  spokenText: string;
  directionNote: string;
  screenText: string;
  transitionIn: string;
  transitionOut: string;
  durationOverride: string; // champ texte : "" = pas de forçage, "0" = forçage légitime à zéro
  sources: string[];
};

function toForm(beat: BeatView): FormState {
  return {
    spokenText: beat.spokenText,
    directionNote: beat.directionNote ?? "",
    screenText: beat.screenText ?? "",
    transitionIn: beat.transitionIn ?? "",
    transitionOut: beat.transitionOut ?? "",
    durationOverride: beat.durationOverrideSec === null ? "" : String(beat.durationOverrideSec),
    sources: beat.sources ?? [],
  };
}

// Task 12 — panneau latéral d'édition d'un beat. Enregistre via `updateBeat`
// (lib/actions/video-actions.ts), gardée sur video:"manage". Les inserts (beat.inserts) sont
// affichés mais pas éditables ici : aucune action serveur ne couvre encore leur écriture
// (`updateBeat` ne porte que les champs du beat lui-même) — les rendre éditables sans point de
// persistance produirait un formulaire qui ment sur ce qu'il enregistre.
export function BeatInspector({
  beat, open, onOpenChange, onSaved,
}: {
  beat: BeatView | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (patch: Partial<BeatView> & { id: string }) => void;
}) {
  const [form, setForm] = useState<FormState | null>(null);
  const [newSource, setNewSource] = useState("");
  const [isPending, startTransition] = useTransition();

  // Resynchronise à chaque ouverture sur un beat différent — même motif que
  // components/settings/feed-sheet.tsx : la sélection change (BeatList#selectedId), pas seulement
  // l'ouverture, donc la dépendance porte sur beat?.id plutôt que sur `open` seul.
  useEffect(() => {
    if (beat) setForm(toForm(beat));
  }, [beat?.id]);

  if (!beat || !form) {
    return <Sheet open={open} onOpenChange={onOpenChange} />;
  }

  const breathRisk = isBreathRisk(form.spokenText);

  function handleSave() {
    if (!beat || !form) return;
    const durationOverrideSec = form.durationOverride.trim() === "" ? null : Number(form.durationOverride);
    startTransition(async () => {
      const res = await updateBeat({
        beatId: beat.id,
        spokenText: form.spokenText,
        directionNote: form.directionNote.trim() === "" ? null : form.directionNote,
        screenText: form.screenText.trim() === "" ? null : form.screenText,
        transitionIn: form.transitionIn.trim() === "" ? null : form.transitionIn,
        transitionOut: form.transitionOut.trim() === "" ? null : form.transitionOut,
        durationOverrideSec,
        sources: form.sources,
      });
      if (!res.ok) {
        toast.error(res.message);
        return;
      }
      toast.success(`Beat « ${beat.externalId} » enregistré.`);
      onSaved({
        id: beat.id,
        spokenText: form.spokenText,
        directionNote: form.directionNote.trim() === "" ? null : form.directionNote,
        screenText: form.screenText.trim() === "" ? null : form.screenText,
        transitionIn: form.transitionIn.trim() === "" ? null : form.transitionIn,
        transitionOut: form.transitionOut.trim() === "" ? null : form.transitionOut,
        durationOverrideSec,
        sources: form.sources,
      });
    });
  }

  function addSource() {
    const url = newSource.trim();
    if (!url || !form) return;
    setForm({ ...form, sources: [...form.sources, url] });
    setNewSource("");
  }

  function removeSource(url: string) {
    if (!form) return;
    setForm({ ...form, sources: form.sources.filter((s) => s !== url) });
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="sm:max-w-lg data-[side=right]:sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Beat {beat.externalId}</SheetTitle>
          <SheetDescription>
            Position {beat.position + 1} — {beat.kind}
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 pb-4">
          <div className="space-y-1.5">
            <Label>Texte parlé</Label>
            <RichEditor
              value={form.spokenText}
              onChange={(html) => setForm({ ...form, spokenText: html })}
              editable={!isPending}
            />
            {breathRisk && (
              <div className="flex items-center gap-1.5 text-xs text-[var(--status-pending)]">
                <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
                <span>Trop long à dire d&apos;un souffle — un simple avertissement, pas un blocage.</span>
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="beat-direction-note">Note de réalisation</Label>
            <Input
              id="beat-direction-note" value={form.directionNote} disabled={isPending}
              onChange={(e) => setForm({ ...form, directionNote: e.target.value })}
              placeholder="Ex. Plan serré"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="beat-screen-text">Texte à l&apos;écran</Label>
            <Input
              id="beat-screen-text" value={form.screenText} disabled={isPending}
              onChange={(e) => setForm({ ...form, screenText: e.target.value })}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="beat-transition-in">Transition entrante</Label>
              <Input
                id="beat-transition-in" value={form.transitionIn} disabled={isPending}
                onChange={(e) => setForm({ ...form, transitionIn: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="beat-transition-out">Transition sortante</Label>
              <Input
                id="beat-transition-out" value={form.transitionOut} disabled={isPending}
                onChange={(e) => setForm({ ...form, transitionOut: e.target.value })}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="beat-duration-override">Durée forcée (secondes)</Label>
            <Input
              id="beat-duration-override" type="number" min={0} value={form.durationOverride} disabled={isPending}
              onChange={(e) => setForm({ ...form, durationOverride: e.target.value })}
              placeholder="Estimée automatiquement si vide"
            />
            {/* Point de conception : une durée forcée à 0 est un choix humain légitime (un beat
                muet) — le champ vide (pas de forçage) et "0" (forçage à zéro) sont deux états
                distincts, cf. lib/video/duration.ts#beatSeconds (`??`, pas `||`). */}
          </div>

          <div className="space-y-1.5">
            <Label>Sources</Label>
            <ul className="space-y-1">
              {form.sources.map((url) => (
                <li key={url} className="flex items-center gap-2 rounded-md border px-2 py-1 text-xs">
                  <span className="flex-1 truncate font-mono">{url}</span>
                  <Button
                    type="button" variant="ghost" size="icon-sm" disabled={isPending}
                    aria-label="Retirer cette source" onClick={() => removeSource(url)}
                  >
                    <X className="size-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
            <div className="flex gap-2">
              <Input
                value={newSource} disabled={isPending}
                onChange={(e) => setNewSource(e.target.value)}
                placeholder="https://…"
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addSource(); } }}
              />
              <Button type="button" variant="outline" disabled={isPending || !newSource.trim()} onClick={addSource}>
                Ajouter
              </Button>
            </div>
          </div>

          {beat.inserts.length > 0 && (
            <div className="space-y-1.5">
              <Label>Inserts</Label>
              {/* Lecture seule : aucune action serveur ne persiste encore un insert (voir le
                  commentaire en tête de fichier) — cette liste sera rendue éditable quand une telle
                  action existera plutôt que de simuler une sauvegarde qui n'a lieu nulle part. */}
              <ul className="space-y-2">
                {beat.inserts.map((insert) => (
                  <li key={insert.id} className="space-y-1 rounded-md border p-2 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <Badge variant="outline">{insert.kind}</Badge>
                      <Badge variant="secondary">{LINK_STATUS_LABEL[insert.linkStatus] ?? insert.linkStatus}</Badge>
                    </div>
                    {insert.url && <p className="truncate font-mono text-muted-foreground">{insert.url}</p>}
                    <div className="flex flex-wrap gap-x-3 text-muted-foreground">
                      {insert.tcIn && <span>Entrée : {insert.tcIn}</span>}
                      {insert.tcOut && <span>Sortie : {insert.tcOut}</span>}
                      {insert.displayDurationSec !== null && <span>Durée d&apos;affichage : {insert.displayDurationSec} s</span>}
                      {insert.credit && <span>Crédit : {insert.credit}</span>}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <SheetFooter className="flex-row justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isPending}>Fermer</Button>
          <Button onClick={handleSave} disabled={isPending}>
            {isPending && <Loader2 className="animate-spin" aria-hidden />}
            {isPending ? "Enregistrement…" : "Enregistrer"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
