"use client";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Loader2, RefreshCw } from "lucide-react";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { regenerate } from "@/lib/actions/article-actions";
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
  const [open, setOpen] = useState(false);
  const [fields, setFields] = useState<RegenerateFieldsInput>(ALL_CHECKED);
  const [isPending, startTransition] = useTransition();

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
      try {
        const r = await regenerate(articleId, fields);
        if (r.ok) {
          toast.success(r.message);
          setOpen(false);
          setFields(ALL_CHECKED);
        } else {
          toast.error(r.message);
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Échec du renvoi à l'IA.");
      }
    });
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
                disabled={isPending}
                onChange={() => toggle(key)}
              />
              {label}
            </Label>
          ))}
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => handleOpenChange(false)} disabled={isPending}>Annuler</Button>
          <Button type="button" onClick={handleConfirm} disabled={isPending || noneChecked}>
            {isPending ? <Loader2 className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}
            {isPending ? "Régénération…" : "Régénérer"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
