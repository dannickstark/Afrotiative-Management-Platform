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
export interface PanelHostProps {
  open: RailCategory;
  onOpenChange: (next: RailCategory | null) => void;
  search?: ReactNode;
  primaryAction?: ReactNode;
  children?: ReactNode;
}

export function PanelHost({ open, onOpenChange, search, primaryAction, children }: PanelHostProps) {
  return (
    <div
      data-testid="panel-host"
      data-panel={open}
      className="flex w-[212px] shrink-0 flex-col gap-2 overflow-hidden rounded-lg border"
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

      {search && <div className="px-2 pt-2">{search}</div>}
      {primaryAction && <div className="px-2">{primaryAction}</div>}

      <div className="flex-1 overflow-auto px-2 pb-2">{children}</div>
    </div>
  );
}
