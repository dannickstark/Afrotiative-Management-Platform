"use client";
import { useState } from "react";
import { RefreshCw } from "lucide-react";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
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

// Variante « N articles » de RegenerateDialog (components/article/regenerate-dialog.tsx) : mêmes six
// cases, même défaut (tout coché). Présentationnel uniquement — c'est la barre d'actions parente qui
// possède l'appel serveur, le pending et le rapport de succès partiel (on réutilise sa machinerie).
export function BulkRegenerateDialog({ count, disabled, onConfirm, defaultImageMode }:
  {
    count: number; disabled?: boolean;
    onConfirm: (fields: RegenerateFieldsInput, imageMode: "auto" | "manual") => void;
    defaultImageMode: "auto" | "manual";
  }) {
  const [open, setOpen] = useState(false);
  const [fields, setFields] = useState<RegenerateFieldsInput>(ALL_CHECKED);
  const [imageMode, setImageMode] = useState<"auto" | "manual">(defaultImageMode);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setFields(ALL_CHECKED); // Reset à « tout coché » à chaque fermeture.
      setImageMode(defaultImageMode);
    }
  }

  function toggle(key: FieldKey) {
    setFields((f) => ({ ...f, [key]: !f[key] }));
  }

  const noneChecked = !Object.values(fields).some(Boolean);

  function handleConfirm() {
    if (noneChecked) return;
    onConfirm(fields, imageMode);
    handleOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger render={<Button type="button" variant="ghost" size="sm" disabled={disabled}>Renvoyer à l&apos;IA</Button>} />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Renvoyer à l&apos;IA</DialogTitle>
          <DialogDescription>
            Choisissez les champs à régénérer à partir des sources des {count} article{count > 1 ? "s" : ""} sélectionné{count > 1 ? "s" : ""}.
            Les champs non cochés conservent leur valeur actuelle.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          {FIELD_LABELS.map(({ key, label }) => (
            <Label key={key} htmlFor={`bulk-regen-${key}`} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 font-normal hover:bg-muted/50">
              <input
                id={`bulk-regen-${key}`}
                type="checkbox"
                checked={fields[key]}
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
              <Label key={value} htmlFor={`bulk-regen-mode-${value}`} className="flex cursor-pointer items-center gap-2 font-normal">
                <input
                  id={`bulk-regen-mode-${value}`} type="radio" name="bulk-regen-mode"
                  checked={imageMode === value}
                  onChange={() => setImageMode(value)}
                />
                {label}
              </Label>
            ))}
          </fieldset>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => handleOpenChange(false)}>Annuler</Button>
          <Button type="button" onClick={handleConfirm} disabled={noneChecked}>
            <RefreshCw aria-hidden />
            Renvoyer à l&apos;IA
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
