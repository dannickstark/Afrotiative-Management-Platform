"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { setProjectCategory } from "@/lib/actions/video-actions";
import type { VideoCategoryOption } from "@/lib/queries/video-categories";

const NO_CATEGORY = "__none__";

// Placé dans l'onglet Brief, au-dessus du texte : c'est là que le changement est immédiatement
// visible — le brief se réécrit sous les yeux. Dans l'en-tête du projet, l'effet serait à deviner.
export function ProjectCategorySelect({
  projectId, categoryId, categories,
}: { projectId: string; categoryId: string | null; categories: VideoCategoryOption[] }) {
  const router = useRouter();
  const [isSaving, startSaving] = useTransition();

  // `items` donne à `<Select>` la correspondance valeur → libellé : sans elle, `<SelectValue>`
  // n'a rien à consulter avant que le menu ait été ouvert une première fois (les `SelectItem` ne
  // s'enregistrent qu'à leur montage) et affiche la valeur brute — l'UUID de la catégorie, ou le
  // sentinel `__none__` — au lieu du nom, dès le premier rendu. Ce contrôle n'existe que pour
  // montrer la catégorie courante du projet ouvert : cet affichage brut serait un échec fonctionnel.
  const items: Record<string, string> = { [NO_CATEGORY]: "Aucune catégorie" };
  for (const c of categories) items[c.id] = c.name;

  function handleChange(value: string | null) {
    const next = !value || value === NO_CATEGORY ? null : value;
    startSaving(async () => {
      try {
        const res = await setProjectCategory({ projectId, categoryId: next });
        if (!res.ok) { toast.error(res.message); return; }
        toast.success("Catégorie mise à jour.");
        // Le brief est rendu côté serveur : il faut rafraîchir pour le voir se réécrire.
        router.refresh();
      } catch (err) {
        const message = err instanceof Error ? err.message : "Échec de la mise à jour.";
        toast.error(message);
      }
    });
  }

  return (
    <div className="flex items-center gap-3">
      <Label htmlFor="brief-category" className="shrink-0">Catégorie</Label>
      <Select value={categoryId ?? NO_CATEGORY} onValueChange={handleChange} disabled={isSaving} items={items}>
        <SelectTrigger id="brief-category" className="w-72">
          <SelectValue placeholder="Aucune catégorie" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_CATEGORY}>Aucune catégorie</SelectItem>
          {categories.map((c) => (
            <SelectItem key={c.id} value={c.id}>
              {c.name}
              {c.description && (
                <span className="ml-2 text-xs text-muted-foreground">{c.description}</span>
              )}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
