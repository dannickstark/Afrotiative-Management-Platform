"use client";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RoleGate } from "@/components/role-gate";
import { fixArticleFields } from "@/lib/actions/article-actions";
import { MISSING_LABEL, type MissingField } from "@/lib/pipeline/completeness";
import type { QueueRow } from "@/lib/queries/queue";

export function FixPopover({
  row, categories,
}: {
  row: QueueRow;
  categories: { id: string; name: string }[];
}) {
  const [open, setOpen] = useState(false);
  const [categoryId, setCategoryId] = useState<string>("");
  const [imageUrl, setImageUrl] = useState("");
  const [credit, setCredit] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [isSaving, startSaving] = useTransition();

  const missing = row.missingFields;
  if (missing.length === 0) return <span className="text-muted-foreground">—</span>;

  // On ne montre QUE les champs réellement manquants : un formulaire complet obligerait à
  // relire des valeurs déjà correctes pour corriger un seul trou.
  const needs = (k: MissingField) => missing.includes(k);

  function handleSave() {
    startSaving(async () => {
      try {
        const res = await fixArticleFields({
          id: row.id,
          ...(categoryId ? { categoryId } : {}),
          ...(imageUrl.trim() ? { featuredImageUrl: imageUrl.trim() } : {}),
          ...(credit.trim() ? { imageCredit: credit.trim() } : {}),
          ...(sourceUrl.trim() ? { imageSourceUrl: sourceUrl.trim() } : {}),
        });
        if (res.missingFields.length === 0) toast.success("Article complet.");
        else toast.success(`Enregistré — reste ${res.missingFields.length} manque(s).`);
        setOpen(false);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Échec de l'enregistrement.");
      }
    });
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Badge variant="outline"
            className="cursor-pointer border-amber-500/50 text-amber-700 dark:text-amber-400"
            title={missing.map((m) => MISSING_LABEL[m]).join(", ")}>
            {missing.length} manque{missing.length > 1 ? "s" : ""}
          </Badge>
        }
      />
      <PopoverContent className="w-80 space-y-3">
        <p className="text-sm font-medium">Compléter cet article</p>

        <RoleGate allow={["admin", "editor"]}>
          {needs("categoryId") && (
            <div className="space-y-1.5">
              <Label>Catégorie</Label>
              {/* Base UI's Select can emit a null value (cleared selection) — coerce to "" so
                  categoryId stays the plain string state handleSave() already expects. */}
              <Select value={categoryId} onValueChange={(v) => setCategoryId(v ?? "")}>
                <SelectTrigger>
                  <SelectValue placeholder="Choisir…">
                    {(v: string) => categories.find((c) => c.id === v)?.name ?? "Choisir…"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {categories.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}

          {needs("featuredImageUrl") && (
            <div className="space-y-1.5">
              <Label htmlFor={`img-${row.id}`}>URL de l&apos;image</Label>
              <Input id={`img-${row.id}`} value={imageUrl} placeholder="https://…"
                onChange={(e) => setImageUrl(e.target.value)} />
            </div>
          )}

          {needs("imageCredit") && (
            <div className="space-y-1.5">
              <Label htmlFor={`credit-${row.id}`}>Crédit image</Label>
              <Input id={`credit-${row.id}`} value={credit} placeholder="Ecofin"
                onChange={(e) => setCredit(e.target.value)} />
            </div>
          )}

          {needs("imageSourceUrl") && (
            <div className="space-y-1.5">
              <Label htmlFor={`src-${row.id}`}>Source de l&apos;image</Label>
              <Input id={`src-${row.id}`} value={sourceUrl} placeholder="https://…"
                onChange={(e) => setSourceUrl(e.target.value)} />
            </div>
          )}

          {/* « Sources » n'est pas corrigeable ici : un article sans source ne peut pas en
              recevoir une à la main depuis la file — c'est un cas de rejet. */}
          {missing.includes("sources") && (
            <p className="text-xs text-destructive">
              Aucune source : cet article ne peut pas être publié.
            </p>
          )}

          <Button size="sm" className="w-full" disabled={isSaving} onClick={handleSave}>
            {isSaving ? "Enregistrement…" : "Enregistrer"}
          </Button>
        </RoleGate>
      </PopoverContent>
    </Popover>
  );
}
