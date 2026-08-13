"use client";

import { LayoutTemplate, Shapes, Type, Image as ImageIcon, Palette, Layers } from "lucide-react";
import { cn } from "@/lib/utils";
import { RAIL_CATEGORIES, RAIL_LABELS, type RailCategory } from "@/lib/studio/editor-prefs";
import { STUDIO_ICON, STUDIO_ICON_STROKE } from "@/lib/studio/studio-icons";

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
              "flex w-14 flex-col items-center gap-1 rounded-lg px-1 py-2 text-center text-[11px] leading-tight font-medium text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent-brand/50",
              // Correctif revue finale (Minor) : la même phrase de spec §3 (« selected state a
              // filled pill ») avait deux lectures différentes ici et dans mode-switch.tsx:56,
              // visibles côte à côte à l'écran (rail à gauche, sélecteur de mode flottant au-dessus
              // du canevas). Alignée sur le style plein de mode-switch.tsx plutôt que l'inverse.
              //
              // Chantier E Tâche 5 (finition de marque) : la pastille pleine passe de `bg-primary`
              // (neutre) à `--accent-brand` (terracotta, « actions only » — globals.css) — CETTE
              // pastille EST une action (choisir une catégorie), l'affordance que le token distingue
              // précisément. `mode-switch.tsx` PORTE LA MÊME phrase de spec (voir ci-dessus) ET
              // PORTE DÉSORMAIS LE MÊME ACCENT (correctif revue) — les deux pastilles actives
              // restent donc visuellement identiques, comme voulu ici depuis le départ.
              isSelected && "bg-accent-brand text-accent-brand-foreground hover:bg-accent-brand hover:text-accent-brand-foreground",
            )}
          >
            <Icon className={STUDIO_ICON} strokeWidth={STUDIO_ICON_STROKE} aria-hidden="true" />
            <span>{RAIL_LABELS[category]}</span>
          </button>
        );
      })}
    </nav>
  );
}
