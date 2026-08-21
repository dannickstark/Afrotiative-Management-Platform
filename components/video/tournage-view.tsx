"use client";
// components/video/tournage-view.tsx — Task 5 (SP4) : l'onglet Tournage. Deux modes — Journal (par
// défaut) qui liste chaque beat avec ses prises, et Prompteur qui affiche un beat à la fois en
// grand texte pour la lecture caméra. Même motif d'écriture que components/video/verify-all-links.tsx
// et montage-share-panel.tsx : useTransition par action, toast + router.refresh() sur succès,
// gestion `{ ok: false }` via `res.message`.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Star, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
  addTake, updateTake, deleteTake, selectTake,
  markReadyToShoot, startShooting, finishShooting,
} from "@/lib/actions/video-actions";
import { TAKE_STATUS_LABEL } from "@/lib/video/labels";
import type { TournageBeat } from "@/lib/video/takes-core";

type LogStatus = "bonne" | "mauvaise" | "a_revoir";

const LOG_BUTTONS: { status: LogStatus; label: string }[] = [
  { status: "bonne", label: "Bonne" },
  { status: "mauvaise", label: "Mauvaise" },
  { status: "a_revoir", label: "À revoir" },
];

function StatusHeader({ projectId, status }: { projectId: string; status: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function run(action: (projectId: string) => Promise<{ ok: true } | { ok: false; message: string }>) {
    startTransition(async () => {
      const res = await action(projectId);
      if (!res.ok) {
        toast.error(res.message);
        return;
      }
      toast.success("Statut mis à jour.");
      router.refresh();
    });
  }

  let button: { label: string; action: (projectId: string) => Promise<{ ok: true } | { ok: false; message: string }> } | null = null;
  if (status === "en_ecriture") button = { label: "Marquer prêt à tourner", action: markReadyToShoot };
  else if (status === "pret_a_tourner") button = { label: "Démarrer le tournage", action: startShooting };
  else if (status === "tourne") button = { label: "Tournage terminé", action: finishShooting };

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">Statut :</span>
        <Badge variant="outline">{status}</Badge>
      </div>
      {button && (
        <Button type="button" size="lg" disabled={isPending} onClick={() => run(button!.action)}>
          {isPending && <Loader2 className="animate-spin" aria-hidden />}
          {button.label}
        </Button>
      )}
    </div>
  );
}

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

function PrompteurMode({ beats }: { beats: TournageBeat[] }) {
  const router = useRouter();
  const [index, setIndex] = useState(0);
  const beat = beats[index];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <Button type="button" variant="outline" size="lg" disabled={index === 0} onClick={() => setIndex((i) => Math.max(0, i - 1))}>
          <ChevronLeft aria-hidden /> Précédent
        </Button>
        <span className="text-sm text-muted-foreground">Beat {index + 1} / {beats.length}</span>
        <Button type="button" variant="outline" size="lg" disabled={index === beats.length - 1} onClick={() => setIndex((i) => Math.min(beats.length - 1, i + 1))}>
          Suivant <ChevronRight aria-hidden />
        </Button>
      </div>
      <div className="space-y-3 rounded-xl border border-border p-6 text-center">
        <p className="text-sm text-muted-foreground">{beat.kindLabel}</p>
        <p className="text-2xl leading-snug font-medium sm:text-3xl">{beat.spokenText}</p>
        {beat.directionNote && <p className="text-sm text-muted-foreground">{beat.directionNote}</p>}
      </div>
      <LogButtons beatId={beat.id} onDone={() => router.refresh()} />
    </div>
  );
}

export function TournageView({
  projectId, status, beats,
}: {
  projectId: string;
  status: string;
  beats: TournageBeat[];
}) {
  const [prompteur, setPrompteur] = useState(false);

  return (
    <div className="space-y-6">
      <StatusHeader projectId={projectId} status={status} />
      <div className="flex items-center gap-2">
        <Button type="button" variant={prompteur ? "default" : "outline"} size="lg" onClick={() => setPrompteur((p) => !p)}>
          Mode prompteur
        </Button>
      </div>
      {beats.length === 0 ? (
        <p className="text-sm text-muted-foreground">Aucun beat à tourner.</p>
      ) : prompteur ? (
        <PrompteurMode beats={beats} />
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
