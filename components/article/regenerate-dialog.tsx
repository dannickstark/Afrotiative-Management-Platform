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
export function RegenerateDialog({ articleId, disabled: triggerDisabled }: { articleId: string; disabled?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [fields, setFields] = useState<RegenerateFieldsInput>(ALL_CHECKED);
  const [isPending, startTransition] = useTransition();
  const [jobId, setJobId] = useState<string | null>(null);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    // Reset on any close: an in-flight regenerate() already captured its `fields`,
    // so resetting the UI state is safe even mid-submit.
    if (!next) setFields(ALL_CHECKED);
  }

  function toggle(key: FieldKey) {
    setFields((f) => ({ ...f, [key]: !f[key] }));
  }

  const noneChecked = !Object.values(fields).some(Boolean);

  function handleConfirm() {
    if (noneChecked) return;
    startTransition(async () => {
      // imageMode n'est pas encore choisissable par l'utilisateur (Tâche 19) : on passe le
      // littéral "auto" en attendant.
      const r = await startRegenJob({ articleIds: [articleId], fields, imageMode: "auto" });
      if (!r.ok) { toast.error(r.message); return; }
      setJobId(r.jobId);
    });
  }

  function handleJobFinished(job: RegenJobView) {
    setJobId(null);
    const item = job.items[0];
    if (item?.status === "failed") toast.error(item.message ?? "Échec du renvoi à l'IA.");
    else if (item?.status === "awaiting_image") toast.success("Sources extraites — image à choisir.");
    else toast.success("Article régénéré — déposé en revue.");
    setOpen(false);
    setFields(ALL_CHECKED);
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
