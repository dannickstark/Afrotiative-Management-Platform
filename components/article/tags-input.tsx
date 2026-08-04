"use client";
import { useState } from "react";
import { Plus, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { cn } from "@/lib/utils";

export type ArticleTag = { tagName: string; isNew: boolean };

// Existing tags (isNew=false) render neutral; tags that don't exist in the
// mirrored WordPress tag list (isNew=true) render in the accent color with a
// "nouveau" hint, since they'll create a new WP term on publish.
export function TagsInput({
  tags, onChange, wpTagNames, readOnly,
}: {
  tags: ArticleTag[];
  onChange: (tags: ArticleTag[]) => void;
  wpTagNames: string[];
  readOnly?: boolean;
}) {
  const [query, setQuery] = useState("");
  const trimmed = query.trim();
  const usedLower = new Set(tags.map((t) => t.tagName.toLowerCase()));

  const matches = trimmed
    ? wpTagNames.filter((n) => !usedLower.has(n.toLowerCase()) && n.toLowerCase().includes(trimmed.toLowerCase()))
    : [];
  const exactMatch = trimmed !== "" && wpTagNames.some((n) => n.toLowerCase() === trimmed.toLowerCase());
  const alreadyAdded = trimmed !== "" && usedLower.has(trimmed.toLowerCase());
  const canCreate = trimmed !== "" && !exactMatch && !alreadyAdded;

  function addTag(name: string, isNew: boolean) {
    const value = name.trim();
    if (!value || usedLower.has(value.toLowerCase())) { setQuery(""); return; }
    onChange([...tags, { tagName: value, isNew }]);
    setQuery("");
  }

  function removeTag(name: string) {
    onChange(tags.filter((t) => t.tagName !== name));
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {tags.length === 0 && <p className="text-xs text-muted-foreground">Aucun tag.</p>}
        {tags.map((t) => (
          <Badge
            key={t.tagName}
            variant="outline"
            className={cn(
              "gap-1",
              t.isNew && "border-[var(--accent-brand)]/40 bg-[var(--accent-brand)]/10 text-[var(--accent-brand)]",
            )}
          >
            {t.tagName}
            {t.isNew && <span className="text-[9px] font-semibold tracking-wide uppercase opacity-80">nouveau</span>}
            {!readOnly && (
              <button
                type="button"
                onClick={() => removeTag(t.tagName)}
                aria-label={`Retirer le tag ${t.tagName}`}
                className="rounded-full opacity-70 hover:opacity-100"
              >
                <X className="size-3" />
              </button>
            )}
          </Badge>
        ))}
      </div>

      {!readOnly && (
        <Command shouldFilter={false} className="rounded-md border">
          <CommandInput placeholder="Ajouter un tag…" value={query} onValueChange={setQuery} />
          {trimmed !== "" && (
            <CommandList>
              {matches.length === 0 && !canCreate && (
                <CommandEmpty>{alreadyAdded ? "Déjà ajouté." : "Aucun résultat."}</CommandEmpty>
              )}
              {matches.map((name) => (
                <CommandItem key={name} value={name} onSelect={() => addTag(name, false)}>
                  {name}
                </CommandItem>
              ))}
              {canCreate && (
                <CommandItem value={trimmed} onSelect={() => addTag(trimmed, true)}>
                  <Plus className="size-3.5" /> Créer « {trimmed} »
                  <span className="ml-auto text-[9px] font-semibold tracking-wide text-[var(--accent-brand)] uppercase">
                    nouveau
                  </span>
                </CommandItem>
              )}
            </CommandList>
          )}
        </Command>
      )}
    </div>
  );
}
