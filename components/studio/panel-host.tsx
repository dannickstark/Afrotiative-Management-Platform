"use client";

import type { ReactNode } from "react";
import { ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RAIL_LABELS, nextOpenPanel, type RailCategory } from "@/lib/studio/editor-prefs";

// components/studio/panel-host.tsx — Tâche 1 (U1, spec §3) : le cadre commun du panneau accosté
// (~212px). Skeleton partagé par les six catégories (spec §3, tableau) : un slot de recherche
// optionnel, UNE action primaire optionnelle, une zone de contenu, et le chevron de bord qui replie
// le panneau. Le chevron réutilise `nextOpenPanel` — jamais un simple `onCollapse` opaque — pour
// rester la MÊME règle que le clic sur le rail (lib/studio/editor-prefs.ts) plutôt qu'une deuxième
// implémentation de « fermer » qui pourrait diverger.
//
// Correctif revue finale — Important 2 : les slots `search`/`primaryAction` ci-dessous sont restés
// MORTS pendant tout U1 — chaque panneau rendait sa propre action dans son corps au lieu de la
// passer ici, et aucun panneau n'avait de champ de recherche alors que spec §3 en promet un pour
// « every panel ». Répartition DÉCIDÉE par la revue (spec §3 amendée) plutôt que « chaque panneau
// comme il veut » :
//   - `primaryAction` : câblé pour Modèles, Images et Texte — les trois seuls panneaux qui EN ONT
//     une (spec §3, tableau : Éléments/Marque/Calques listent « — »).
//   - `search` : câblé pour Modèles et Images UNIQUEMENT — les deux listes vraiment longues
//     (l'ensemble des gabarits ; toute la bibliothèque d'assets). PAS Texte ni Éléments : filtrer
//     trois préréglages, quatorze lignes de jetons ou deux tuiles de forme serait du théâtre.
// components/studio/panels/modeles-panel.tsx et images-panel.tsx enrobent désormais eux-mêmes ce
// composant (au lieu d'être de simples `children` enrobés par editor-shell.tsx) pour pouvoir peupler
// ces deux slots ; components/studio/panels/calques-panel.tsx, elements-panel.tsx et marque-panel.tsx
// restent de simples `children`, toujours enrobés par editor-shell.tsx — ils n'ont ni l'un ni
// l'autre.
export interface PanelHostProps {
  open: RailCategory;
  onOpenChange: (next: RailCategory | null) => void;
  search?: ReactNode;
  primaryAction?: ReactNode;
  children?: ReactNode;
  // Chantier A Tâche 3 (spec §2/§3) : largeur COURANTE (px), désormais pilotée par
  // EditorPrefs.railPanelWidth (lib/studio/editor-prefs.ts) via une poignée de glisser posée par
  // editor-shell.tsx (components/studio/panel-resize-handle.tsx) — jamais par ce composant lui-même,
  // qui reste ignorant du geste. Défaut 212 : la valeur FIXE qu'un `w-[212px]` codait en dur avant
  // cette tâche, pour qu'un appelant qui omet cette prop (aucun aujourd'hui hors editor-shell.tsx et
  // les trois panneaux qui s'enrobent eux-mêmes) rende exactement la même largeur qu'avant.
  width?: number;
}

export function PanelHost({ open, onOpenChange, search, primaryAction, children, width = 212 }: PanelHostProps) {
  return (
    <div
      data-testid="panel-host"
      data-panel={open}
      style={{ width }}
      className="flex shrink-0 flex-col gap-2 overflow-hidden rounded-lg border"
    >
      <div className="flex items-center justify-between border-b px-2 py-1.5">
        <span className="text-sm font-medium">{RAIL_LABELS[open]}</span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          data-action="collapse-panel"
          aria-label="Replier le panneau"
          onClick={() => onOpenChange(nextOpenPanel(open, open))}
        >
          <ChevronLeft />
        </Button>
      </div>

      {/* `data-testid` propres à CHAQUE slot (Correctif revue finale) : permet aux tests de vérifier
          qu'un nœud passé en `search`/`primaryAction` atterrit RÉELLEMENT dans la zone dédiée du
          skeleton, pas seulement « quelque part dans le panneau » — exactement le doute que la revue
          soulève pour ces deux slots. */}
      {search && <div className="px-2 pt-2" data-testid="panel-search">{search}</div>}
      {primaryAction && <div className="px-2" data-testid="panel-primary-action">{primaryAction}</div>}

      <div className="flex-1 overflow-auto px-2 pb-2">{children}</div>
    </div>
  );
}
