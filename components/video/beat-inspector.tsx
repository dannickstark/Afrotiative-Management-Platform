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
import { updateBeat, updateInsert } from "@/lib/actions/video-actions";
import { isBreathRisk } from "@/lib/video/duration";
import type { BeatView, InsertView } from "./beat-list";

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

// Complément Task 12 (revue) — un insert dont seule l'URL est éditée n'a pas besoin de rejouer le
// bouton « Enregistrer » du beat : `InsertRow` porte sa propre mutation locale et son propre appel
// à `updateInsert`, indépendant du formulaire du beat. `disabled` reflète l'enregistrement en cours
// du BEAT (form.spokenText etc.) : les deux enregistrements ne se recouvrent pas fonctionnellement,
// mais désactiver toute la fiche pendant l'un évite une incohérence visuelle si les deux
// s'enchaînent vite.
function InsertRow({
  insert, disabled, onSaved,
}: {
  insert: InsertView;
  disabled: boolean;
  onSaved: (patch: Partial<InsertView> & { id: string }) => void;
}) {
  const [url, setUrl] = useState(insert.url ?? "");
  const [isPending, startTransition] = useTransition();

  // Resynchronise si l'insert change de source (autre onglet, autre session) — même motif que
  // BeatInspector#toForm.
  useEffect(() => { setUrl(insert.url ?? ""); }, [insert.id, insert.url]);

  const changed = url.trim() !== (insert.url ?? "");

  function handleSave() {
    const next = url.trim() === "" ? null : url.trim();
    startTransition(async () => {
      const res = await updateInsert({ insertId: insert.id, url: next });
      if (!res.ok) {
        toast.error(res.message);
        return;
      }
      toast.success("URL de l'insert enregistrée.");
      // Une URL corrigée à la main n'a jamais été vérifiée — même remise à zéro que
      // updateBeatInsertCore (lib/video/persist.ts) côté serveur, reflétée ici sans aller
      // recharger la ligne.
      onSaved({ id: insert.id, url: next, linkStatus: "non_verifie" });
    });
  }

  return (
    <li className="space-y-1.5 rounded-md border p-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <Badge variant="outline">{insert.kind}</Badge>
        <Badge variant="secondary">{LINK_STATUS_LABEL[insert.linkStatus] ?? insert.linkStatus}</Badge>
      </div>
      <div className="flex gap-2">
        <Input
          value={url} disabled={disabled || isPending}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://…"
          aria-label="URL de l'insert"
          className="font-mono text-xs"
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleSave(); } }}
        />
        <Button type="button" variant="outline" size="sm" disabled={disabled || isPending || !changed} onClick={handleSave}>
          {isPending && <Loader2 className="animate-spin" aria-hidden />}
          Enregistrer
        </Button>
      </div>
      {/* Le reste de l'insert reste en lecture : aucune action serveur ne couvre encore
          l'écriture des timecodes/durée d'affichage/crédit — seule l'URL en a une
          (updateInsert), au motif exact du spec §6. */}
      <div className="flex flex-wrap gap-x-3 text-muted-foreground">
        {insert.tcIn && <span>Entrée : {insert.tcIn}</span>}
        {insert.tcOut && <span>Sortie : {insert.tcOut}</span>}
        {insert.displayDurationSec !== null && <span>Durée d&apos;affichage : {insert.displayDurationSec} s</span>}
        {insert.credit && <span>Crédit : {insert.credit}</span>}
      </div>
    </li>
  );
}

// Task 12 — panneau latéral d'édition d'un beat. Enregistre via `updateBeat`
// (lib/actions/video-actions.ts), gardée sur video:"manage". Les inserts (beat.inserts) sont édités
// URL par URL via `updateInsert` (InsertRow ci-dessus, complément de revue) — les autres champs
// d'un insert (timecodes, durée d'affichage, crédit) restent en lecture, aucune action serveur ne
// couvrant encore leur écriture.
export function BeatInspector({
  beat, open, onOpenChange, onSaved,
}: {
  beat: BeatView | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (patch: Partial<BeatView> & { id: string }) => void;
}) {
  const [form, setForm] = useState<FormState | null>(null);
  const [inserts, setInserts] = useState<InsertView[]>([]);
  const [newSource, setNewSource] = useState("");
  const [isPending, startTransition] = useTransition();

  // Resynchronise à chaque ouverture sur un beat différent — même motif que
  // components/settings/feed-sheet.tsx : la sélection change (BeatList#selectedId), pas seulement
  // l'ouverture, donc la dépendance porte sur beat?.id plutôt que sur `open` seul.
  useEffect(() => {
    if (beat) {
      setForm(toForm(beat));
      setInserts(beat.inserts);
    }
  }, [beat?.id]);

  // Round de correction 1 (Task 12, C1) — CORRUPTION DE CONTENU : `RichEditor` ne lit `value` qu'à
  // la création de l'éditeur Tiptap (`content: value` dans useEditor, jamais resynchronisé) et ne
  // se démonte que si `SheetContent` n'est pas rendu. Avant ce correctif, `form` n'était JAMAIS remis
  // à `null` à la fermeture : ouvrir le beat A, fermer, ouvrir le beat B faisait passer un premier
  // rendu avec `beat` = B mais `form` encore celui de A — la garde `!beat || !form` laissait passer
  // (form restait non-null), et RichEditor se remontait avec le TEXTE DE A sous l'EN-TÊTE DE B. La
  // moindre frappe déclenchait alors un `handleSave` qui écrivait le texte de A dans le beat B.
  // Ce reset (sur `open`, pas sur `beat?.id` — l'effet ci-dessus reste la voie normale de
  // resynchronisation) garantit qu'à la fermeture, plus aucun état de beat ne survit ; combiné au
  // `key={beat.id}` posé sur SheetContent plus bas (qui force un remontage complet, RichEditor
  // compris, à chaque CHANGEMENT direct de beat), les deux mécanismes demandés en revue.
  useEffect(() => {
    if (!open) {
      setForm(null);
      setInserts([]);
    }
  }, [open]);

  if (!beat || !form) {
    return <Sheet open={open} onOpenChange={onOpenChange} />;
  }

  function handleInsertSaved(patch: Partial<InsertView> & { id: string }) {
    const next = inserts.map((ins) => (ins.id === patch.id ? { ...ins, ...patch } : ins));
    setInserts(next);
    // Remonte aussi au parent (BeatList#items) : sans ça, fermer puis rouvrir l'inspecteur sur ce
    // même beat sans changement de variante réafficherait l'ancienne URL, `onSaved` du beat étant
    // le seul canal qui met à jour la liste.
    if (beat) onSaved({ id: beat.id, inserts: next });
  }

  const breathRisk = isBreathRisk(form.spokenText);

  function handleSave() {
    if (!beat || !form) return;
    const directionNote = form.directionNote.trim() === "" ? null : form.directionNote;
    const screenText = form.screenText.trim() === "" ? null : form.screenText;
    const transitionIn = form.transitionIn.trim() === "" ? null : form.transitionIn;
    const transitionOut = form.transitionOut.trim() === "" ? null : form.transitionOut;
    const durationOverrideSec = form.durationOverride.trim() === "" ? null : Number(form.durationOverride);
    startTransition(async () => {
      const res = await updateBeat({
        beatId: beat.id,
        spokenText: form.spokenText,
        directionNote,
        screenText,
        transitionIn,
        transitionOut,
        durationOverrideSec,
        sources: form.sources,
      });
      if (!res.ok) {
        toast.error(res.message);
        return;
      }
      toast.success(`Beat « ${beat.externalId} » enregistré.`);
      // Round de correction 1 (Task 12, I3) : `res.spokenText` est la valeur RÉELLEMENT stockée —
      // passée par sanitizeArticleHtml côté serveur (lib/video/persist.ts#updateBeatCore) — pas le
      // HTML brut de Tiptap (`form.spokenText`). BeatList réinjecte cette valeur en
      // `dangerouslySetInnerHTML` : lui faire porter du HTML jamais assaini, même temporairement
      // avant le prochain chargement serveur, casse l'invariant « spokenText est toujours assaini »
      // (contrainte du brief). Même motif pour `estimatedDurationSec` : la valeur stockée, calculée
      // avec la cadence des réglages, pas recalculée côté client (voir BeatList#storedSeconds).
      setForm((prev) => (prev ? { ...prev, spokenText: res.spokenText } : prev));
      onSaved({
        id: beat.id,
        spokenText: res.spokenText,
        directionNote,
        screenText,
        transitionIn,
        transitionOut,
        durationOverrideSec: res.durationOverrideSec,
        estimatedDurationSec: res.estimatedDurationSec,
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
      {/* `key={beat.id}` (round de correction 1, C1) : force un remontage COMPLET — RichEditor
          compris — à chaque changement direct de beat, en défense en profondeur du reset-on-close
          ci-dessus. RichEditor n'écoute `value` qu'à la création de son éditeur Tiptap ; sans ce
          remontage, un changement de beat qui ne passerait pas par un cycle "fermé" intermédiaire
          laisserait le texte de l'ancien beat affiché sous l'en-tête du nouveau. */}
      <SheetContent key={beat.id} side="right" className="sm:max-w-lg data-[side=right]:sm:max-w-lg">
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

          {inserts.length > 0 && (
            <div className="space-y-1.5">
              <Label>Inserts</Label>
              <ul className="space-y-2">
                {inserts.map((insert) => (
                  <InsertRow key={insert.id} insert={insert} disabled={isPending} onSaved={handleInsertSaved} />
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
