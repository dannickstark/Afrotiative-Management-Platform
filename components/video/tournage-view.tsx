"use client";
// components/video/tournage-view.tsx — Task 5 (SP4) : l'onglet Tournage. Deux modes — Journal (par
// défaut) qui liste chaque beat avec ses prises, et Prompteur qui affiche un beat à la fois en
// grand texte pour la lecture caméra. Même motif d'écriture que components/video/verify-all-links.tsx
// et montage-share-panel.tsx : useTransition par action, toast + router.refresh() sur succès,
// gestion `{ ok: false }` via `res.message`.
import { useState, useTransition, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Star, ChevronLeft, ChevronRight, Maximize, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { RichEditor } from "@/components/article/rich-editor";
import { AspectRatioGuide } from "@/components/video/aspect-ratio-guide";
import {
  addTake, updateTake, deleteTake, selectTake, updateBeat,
} from "@/lib/actions/video-actions";
import { TAKE_STATUS_LABEL } from "@/lib/video/labels";
import type { TournageBeat } from "@/lib/video/takes-core";

type LogStatus = "bonne" | "mauvaise" | "a_revoir";

const LOG_BUTTONS: { status: LogStatus; label: string }[] = [
  { status: "bonne", label: "Bonne" },
  { status: "mauvaise", label: "Mauvaise" },
  { status: "a_revoir", label: "À revoir" },
];

function LogButtons({ beatId, disabled, onDone }: { beatId: string; disabled?: boolean; onDone: () => void }) {
  const [isPending, startTransition] = useTransition();

  function handleLog(status: LogStatus) {
    startTransition(async () => {
      const res = await addTake({ beatId, status });
      if (!res.ok) {
        toast.error(res.message);
        return;
      }
      toast.success("Prise enregistrée.");
      onDone();
    });
  }

  return (
    <div className="flex flex-wrap gap-3">
      {LOG_BUTTONS.map((b) => (
        <Button
          key={b.status}
          type="button"
          size="lg"
          variant="outline"
          disabled={disabled || isPending}
          className="grow sm:grow-0"
          onClick={() => handleLog(b.status)}
        >
          {b.label}
        </Button>
      ))}
    </div>
  );
}

function TakeRow({ beatId, take, selected }: { beatId: string; take: TournageBeat["takes"][number]; selected: boolean }) {
  const router = useRouter();
  const [note, setNote] = useState(take.note ?? "");
  const [isSelecting, startSelecting] = useTransition();
  const [isSaving, startSaving] = useTransition();

  function handleSelect() {
    startSelecting(async () => {
      const res = await selectTake({ beatId, takeId: selected ? null : take.id });
      if (!res.ok) {
        toast.error(res.message);
        return;
      }
      router.refresh();
    });
  }

  function handleSaveNote() {
    startSaving(async () => {
      const res = await updateTake({ takeId: take.id, note });
      if (!res.ok) {
        toast.error(res.message);
        return;
      }
      toast.success("Note enregistrée.");
      router.refresh();
    });
  }

  function handleDelete() {
    startSaving(async () => {
      const res = await deleteTake(take.id);
      if (!res.ok) {
        toast.error(res.message);
        return;
      }
      toast.success("Prise supprimée.");
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button" variant="ghost" size="icon-sm" disabled={isSelecting}
          aria-label={selected ? "Désélectionner cette prise" : "Retenir cette prise"}
          onClick={handleSelect}
        >
          <Star className={selected ? "fill-current text-[var(--status-approved)]" : ""} aria-hidden />
        </Button>
        <span className="text-sm font-medium">Prise {take.number}</span>
        <Badge variant="outline">{TAKE_STATUS_LABEL[take.status] ?? take.status}</Badge>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Textarea
          value={note} onChange={(e) => setNote(e.target.value)}
          placeholder="Note…" className="min-h-9 flex-1"
        />
        <Button type="button" size="sm" disabled={isSaving} onClick={handleSaveNote}>
          Enregistrer
        </Button>
        <ConfirmDialog
          trigger={<Button type="button" variant="ghost" size="sm" className="text-destructive" disabled={isSaving}>Supprimer</Button>}
          title="Supprimer cette prise ?"
          description="Cette action est définitive. Si cette prise était retenue, la sélection du beat sera effacée."
          confirmLabel="Supprimer"
          destructive
          onConfirm={handleDelete}
        />
      </div>
    </div>
  );
}

function JournalBeatCard({ beat }: { beat: TournageBeat }) {
  const router = useRouter();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{beat.kindLabel}</CardTitle>
        <CardDescription className="text-base text-foreground">{beat.spokenText}</CardDescription>
        {beat.directionNote && <p className="text-xs text-muted-foreground">{beat.directionNote}</p>}
      </CardHeader>
      <CardContent className="space-y-4">
        <LogButtons beatId={beat.id} onDone={() => router.refresh()} />
        <div className="space-y-2">
          {beat.takes.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aucune prise pour ce beat.</p>
          ) : (
            beat.takes.map((t) => (
              <TakeRow key={t.id} beatId={beat.id} take={t} selected={beat.selectedTakeId === t.id} />
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function PrompteurMode({ beats, aspectRatio }: { beats: TournageBeat[]; aspectRatio: string }) {
  const router = useRouter();
  const [index, setIndex] = useState(0);
  const beat = beats[index];

  // Contenu édité localement (Tiptap ne relit `value` qu'à la création — `key={beat.id}` sur
  // RichEditor remonte l'éditeur au changement de beat). Resynchronisé explicitement ici aussi
  // pour que `html`/`dirtyRef` (lus par `save()`) reflètent bien le nouveau beat, et pas le
  // contenu édité (non sauvegardé) du beat précédent.
  const [html, setHtml] = useState(beat.spokenText);
  const dirtyRef = useRef(false);
  useEffect(() => {
    setHtml(beat.spokenText);
    dirtyRef.current = false;
  }, [beat.id, beat.spokenText]);

  const [isSaving, startSaving] = useTransition();

  // Plein écran natif ; repli en overlay `fixed inset-0` si `requestFullscreen` est refusé/absent
  // (iOS Safari notamment).
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [fs, setFs] = useState(false);
  const [overlay, setOverlay] = useState(false);

  // Retourne `false` uniquement sur échec réel de la sauvegarde (garde `dirtyRef.current` à
  // `true`) — tout appelant qui enchaîne sur un changement de beat (`goTo`) DOIT vérifier ce
  // retour avant de bouger l'index : `setIndex` change `beat.id`, ce qui déclenche le
  // `useEffect` de resynchronisation ci-dessus et écraserait silencieusement `html`/`dirtyRef`
  // avec le nouveau beat, perdant l'édit non sauvegardé du beat précédent sans aucun recours.
  async function save(): Promise<boolean> {
    if (!dirtyRef.current) return true;
    const res = await updateBeat({ beatId: beat.id, spokenText: html });
    if (!res.ok) {
      toast.error(res.message);
      return false;
    }
    dirtyRef.current = false;
    // `router.refresh()` recharge les beats depuis le serveur — ne pas ré-injecter localement
    // `res.spokenText` par-dessus : le prochain rendu porte déjà la version sanitisée serveur.
    router.refresh();
    return true;
  }

  function goTo(next: number) {
    startSaving(async () => {
      const ok = await save();
      if (!ok) return; // reste sur le beat courant — l'édit non sauvegardé est préservé
      setIndex(next);
    });
  }

  useEffect(() => {
    function onFullscreenChange() {
      const active = !!document.fullscreenElement;
      setFs(active);
      if (!active) startSaving(async () => { await save(); });
    }
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [beat.id, html]);

  useEffect(() => {
    if (!overlay) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        startSaving(async () => {
          await save();
          setOverlay(false);
        });
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlay, beat.id, html]);

  async function enterFullscreen() {
    try {
      await surfaceRef.current?.requestFullscreen();
    } catch {
      setOverlay(true);
    }
  }

  function closeOverlay() {
    startSaving(async () => {
      await save();
      setOverlay(false);
    });
  }

  const content = (
    <div ref={surfaceRef} className="prompteur-surface space-y-6 rounded-xl border border-border p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button type="button" variant="outline" size="lg" disabled={index === 0 || isSaving} onClick={() => goTo(Math.max(0, index - 1))}>
          <ChevronLeft aria-hidden /> Précédent
        </Button>
        <span className="text-sm">Beat {index + 1} / {beats.length}</span>
        <Button type="button" variant="outline" size="lg" disabled={index === beats.length - 1 || isSaving} onClick={() => goTo(Math.min(beats.length - 1, index + 1))}>
          Suivant <ChevronRight aria-hidden />
        </Button>
      </div>
      <AspectRatioGuide ratio={aspectRatio} />
      <div className="space-y-3 text-center">
        <p className="text-sm">{beat.kindLabel}</p>
        <RichEditor
          key={beat.id}
          value={beat.spokenText}
          onChange={(h) => {
            setHtml(h);
            dirtyRef.current = true;
          }}
          editable={!isSaving}
          allowHighlight
          className="font-editorial prose prose-neutral max-w-none focus:outline-none prompteur-editor"
        />
        {beat.directionNote && <p className="text-sm">{beat.directionNote}</p>}
      </div>
      <LogButtons beatId={beat.id} disabled={isSaving} onDone={() => router.refresh()} />
      <div className="flex flex-wrap items-center gap-3">
        {overlay ? (
          <Button type="button" variant="outline" size="lg" disabled={isSaving} onClick={closeOverlay}>
            <X aria-hidden /> Fermer
          </Button>
        ) : (
          <Button type="button" variant="outline" size="lg" disabled={isSaving} aria-pressed={fs} onClick={enterFullscreen}>
            <Maximize aria-hidden /> Plein écran
          </Button>
        )}
        <Button type="button" size="lg" disabled={isSaving} onClick={() => startSaving(async () => { await save(); })}>
          {isSaving && <Loader2 className="animate-spin" aria-hidden />}
          Enregistrer
        </Button>
      </div>
    </div>
  );

  if (overlay) {
    return <div className="fixed inset-0 z-50 overflow-auto bg-white p-4">{content}</div>;
  }
  return content;
}

export function TournageView({
  beats, aspectRatio = "16:9",
}: {
  beats: TournageBeat[];
  aspectRatio?: string;
}) {
  const [prompteur, setPrompteur] = useState(false);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Button type="button" variant={prompteur ? "default" : "outline"} size="lg" onClick={() => setPrompteur((p) => !p)}>
          Mode prompteur
        </Button>
      </div>
      {beats.length === 0 ? (
        <p className="text-sm text-muted-foreground">Aucun beat à tourner.</p>
      ) : prompteur ? (
        <PrompteurMode beats={beats} aspectRatio={aspectRatio} />
      ) : (
        <div className="space-y-4">
          {beats.map((b) => (
            <JournalBeatCard key={b.id} beat={b} />
          ))}
        </div>
      )}
    </div>
  );
}
