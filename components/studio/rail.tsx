"use client";

import { LayoutTemplate, Shapes, Type, Image as ImageIcon, Palette, Layers } from "lucide-react";
import { cn } from "@/lib/utils";
import { RAIL_CATEGORIES, RAIL_LABELS, type RailCategory } from "@/lib/studio/editor-prefs";

// components/studio/rail.tsx — Tâche 1 (U1, spec §3) : le rail d'icônes libellées, ~62px, état
// sélectionné = pastille pleine. Boutons natifs plutôt que le composant `Button` partagé : ce
// dernier est pensé pour une disposition horizontale (icône + libellé côte à côte), alors qu'ici
// chaque entrée empile icône puis libellé sur une largeur fixe très étroite — une forme assez
// différente pour justifier de ne pas le détourner.
const RAIL_ICONS: Record<RailCategory, typeof Layers> = {
  modeles: LayoutTemplate,
  elements: Shapes,
  texte: Type,
  images: ImageIcon,
  marque: Palette,
  calques: Layers,
};

export interface RailProps {
  selected: RailCategory | null;
  onSelect: (category: RailCategory) => void;
}

export function Rail({ selected, onSelect }: RailProps) {
  return (
    <nav
      aria-label="Catégories de l'éditeur"
      data-testid="editor-rail"
      className="flex w-[62px] shrink-0 flex-col items-center gap-1 overflow-y-auto rounded-lg border bg-muted/10 py-2"
    >
      {RAIL_CATEGORIES.map((category) => {
        const Icon = RAIL_ICONS[category];
        const isSelected = category === selected;
        return (
          <button
            key={category}
            type="button"
            data-testid={`rail-item-${category}`}
            data-category={category}
            aria-pressed={isSelected}
            onClick={() => onSelect(category)}
            className={cn(
              "flex w-14 flex-col items-center gap-1 rounded-lg px-1 py-2 text-center text-[11px] leading-tight font-medium text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50",
              isSelected && "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary",
            )}
          >
            <Icon className="size-4" aria-hidden="true" />
            <span>{RAIL_LABELS[category]}</span>
          </button>
        );
      })}
    </nav>
  );
}
