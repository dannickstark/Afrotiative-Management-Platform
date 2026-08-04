"use client";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { ArticleDetail } from "@/lib/queries/article";

// Sentinel for "no category" — Base UI's Select needs a real item value, it
// can't bind directly to `categoryId === null`.
const NONE = "__none__";

// Constrained to `article.categories` (the WordPress category mirror) —
// journalists/editors pick from the existing list, they don't type free text.
export function CategorySelect({
  categories, categoryId, onChange, readOnly,
}: {
  categories: ArticleDetail["categories"];
  categoryId: string | null;
  onChange: (id: string | null) => void;
  readOnly?: boolean;
}) {
  const nameById = new Map(categories.map((c) => [c.id, c.name]));

  return (
    <Select
      value={categoryId ?? NONE}
      onValueChange={(v) => onChange(v === NONE ? null : v)}
      disabled={readOnly}
    >
      <SelectTrigger className="w-full">
        <SelectValue placeholder="Catégorie">
          {(v: string) =>
            v === NONE || !v ? (
              <span className="font-medium text-[var(--status-pending)]">Aucune catégorie (à choisir)</span>
            ) : (
              (nameById.get(v) ?? v)
            )
          }
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>
          <span className="text-[var(--status-pending)]">Aucune catégorie (à choisir)</span>
        </SelectItem>
        {categories.map((c) => (
          <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
