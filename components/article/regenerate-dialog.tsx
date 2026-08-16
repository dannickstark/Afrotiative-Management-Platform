"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, RefreshCw } from "lucide-react";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { startRegenJob } from "@/lib/actions/regen-actions";
import { RegenProgress } from "@/components/queue/regen-progress";
import type { RegenJobView } from "@/lib/pipeline/regen-live";
import type { RegenerateFieldsInput } from "@/lib/validation";

type FieldKey = keyof RegenerateFieldsInput;
const FIELD_LABELS: { key: FieldKey; label: string }[] = [
  { key: "title", label: "Titre" },
  { key: "body", label: "Corps" },
  { key: "excerpt", label: "Extrait" },
  { key: "category", label: "Catégorie" },
  { key: "tags", label: "Tags" },
  { key: "image", label: "Image à la une" },
];
const ALL_CHECKED: RegenerateFieldsInput = { title: true, body: true, excerpt: true, category: true, tags: true, image: true };

// Self-contained Dialog (owns its own trigger + open state), mirroring AddMemberDialog's pattern.
// Lets the editor pick exactly which fields get overwritten by a fresh AI pass over the
// article's existing sources — a full "regenerate everything" is just all six boxes checked.
export function RegenerateDialog({ articleId, disabled: triggerDisabled, defaultImageMode }:
  { articleId: string; disabled?: boolean; defaultImageMode: "auto" | "manual" }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [fields, setFields] = useState<RegenerateFieldsInput>(ALL_CHECKED);
  const [imageMode, setImageMode] = useState<"auto" | "manual">(defaultImageMode);
  const [isPending, startTransition] = useTransition();
  const [jobId, setJobId] = useState<string | null>(null);

  function handleOpenChange(next: boolean) {
    // Tant qu'un job tourne, la fenêtre refuse de se fermer : RegenProgress est le SEUL observateur
    // du job côté client, et le démonter ferait perdre le toast de fin et le rafraîchissement. La
    // sortie, c'est le bouton « Annuler » de la barre de progression, pas la croix.
    if (!next && jobId !== null) return;
    setOpen(next);
    // Reset on any close: an in-flight regenerate() already captured its `fields`,
    // so resetting the UI state is safe even mid-submit.
    if (!next) {
      setFields(ALL_CHECKED);
      setImageMode(defaultImageMode);
    }
  }

  function toggle(key: FieldKey) {
    setFields((f) => ({ ...f, [key]: !f[key] }));
  }

  const noneChecked = !Object.values(fields).some(Boolean);

  function handleConfirm() {
    if (noneChecked) return;
    startTransition(async () => {
      // startRegenJob JETTE sur un refus RBAC (requirePermission) et rejette sur tout aléa
      // DB/transport — sans ce try/catch, l'éditeur ne voit RIEN : ni toast, ni fenêtre qui se
      // referme, juste un bouton qui redevient inerte.
      try {
        const r = await startRegenJob({ articleIds: [articleId], fields, imageMode });
        if (!r.ok) { toast.error(r.message); return; }
        setJobId(r.jobId);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Renvoi à l'IA impossible.");
      }
    });
  }

  function handleJobFinished(job: RegenJobView) {
    setJobId(null);
    const item = job.items[0];
    // finalizeRegenJob balaie un item non terminé d'une annulation avec status "failed" (voir
    // lib/pipeline/regen-store.ts) — c'est un artefact de fermeture, pas un échec réel. Le job porte
    // le bon verdict dans son propre statut : on le prend en priorité pour ne pas afficher un toast
    // d'erreur là où l'éditeur a lui-même demandé l'annulation.
    if (job.status === "cancelled") toast.warning("Renvoi à l'IA annulé.");
    else if (item?.status === "failed") toast.error(item.message ?? "Échec du renvoi à l'IA.");
    else if (item?.status === "awaiting_image") toast.success("Sources extraites — image à choisir.");
    else toast.success("Article régénéré — déposé en revue.");
    setOpen(false);
    setFields(ALL_CHECKED);
    setImageMode(defaultImageMode);
    router.refresh();
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger render={<Button type="button" variant="ghost" disabled={triggerDisabled}>Renvoyer à l&apos;IA</Button>} />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Renvoyer à l&apos;IA</DialogTitle>
          <DialogDescription>
            Choisissez les champs à régénérer à partir des sources de l&apos;article. Les champs non
            cochés conservent leur valeur actuelle.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          {FIELD_LABELS.map(({ key, label }) => (
            <Label key={key} htmlFor={`regen-${key}`} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 font-normal hover:bg-muted/50">
              <input
                id={`regen-${key}`}
                type="checkbox"
                checked={fields[key]}
                disabled={isPending || jobId !== null}
                onChange={() => toggle(key)}
              />
              {label}
            </Label>
          ))}
        </div>
        {fields.image && (
          <fieldset className="space-y-1 rounded border p-2">
            <legend className="px-1 text-sm font-medium">Choix de l&apos;image</legend>
            {([["auto", "L'IA choisit parmi les images trouvées"], ["manual", "Je choisis moi-même (depuis la file)"]] as const).map(([value, label]) => (
              <Label key={value} htmlFor={`regen-mode-${value}`} className="flex cursor-pointer items-center gap-2 font-normal">
                <input
                  id={`regen-mode-${value}`} type="radio" name="regen-mode"
                  checked={imageMode === value} disabled={isPending || jobId !== null}
                  onChange={() => setImageMode(value)}
                />
                {label}
              </Label>
            ))}
          </fieldset>
        )}
        {jobId !== null && <RegenProgress key={jobId} jobId={jobId} onFinished={handleJobFinished} />}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => handleOpenChange(false)} disabled={isPending || jobId !== null}>Annuler</Button>
          <Button type="button" onClick={handleConfirm} disabled={isPending || jobId !== null || noneChecked}>
            {isPending ? <Loader2 className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}
            {isPending ? "Régénération…" : "Régénérer"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
