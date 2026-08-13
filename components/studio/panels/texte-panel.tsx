"use client";

import type { Dispatch } from "react";
import { Type } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { addLayer, type EditorAction } from "@/lib/studio/editor-state";
import { dynamicTextRowsFor, insertDynamicTextLayer } from "@/lib/studio/dynamic-text";
import { TEXT_PRESET_IDS, TEXT_PRESETS, buildPresetTextLayer } from "@/lib/studio/text-presets";
import type { TemplateContext } from "@/lib/studio/tokens";
import { PanelHost } from "@/components/studio/panel-host";
import type { RailCategory } from "@/lib/studio/editor-prefs";

// components/studio/panels/texte-panel.tsx — Tâche 3 (U1, spec §3/§4) : le contenu de la catégorie
// « Texte » du rail. Contrairement au panneau Images (Tâche 2, volontairement browse-only —
// spec §3 n'a jamais demandé à Images d'insérer), CE panneau insère : c'est tout l'objet de la
// Tâche 3 (spec §4, « Why this task exists ») — un clic transforme un jeton en calque texte déjà
// lié, plutôt que de forcer un designer à sélectionner un calque puis chercher le champ jeton.
//
// Trois sections (spec §3, tableau « Texte ») :
//   1. Action primaire « Ajouter une zone de texte » — désormais dans le slot `primaryAction` de
//      PanelHost (Correctif revue finale, Important 2 : ce slot était mort, chaque panneau rendait
//      son action dans son propre corps — voir le commentaire d'en-tête de panel-host.tsx pour la
//      répartition exacte entre panneaux).
//   2. « Styles » — TEXT_PRESETS (lib/studio/text-presets.ts) rendus À LEUR TAILLE RÉELLE (spec §3).
//      Correctif revue finale — Important 4 : ces lignes étaient de simples `<li>` inertes, au bord/
//      rayon/padding identiques aux quatorze lignes VRAIMENT cliquables de « Texte dynamique » juste
//      en dessous — un piège visuel. Un clic insère désormais un calque texte via
//      `buildPresetTextLayer` (lib/studio/text-presets.ts) — un TextLayer NORMAL et NON lié à un
//      jeton (à la différence de « Texte dynamique »), qui réutilise la MÊME formule de cadrage
//      (`textFrameFor`, lib/studio/layer-geometry.ts) plutôt qu'une nouvelle géométrie.
//   3. « Texte dynamique » (spec §4) — dynamicTextRowsFor(context) (lib/studio/dynamic-text.ts) lit
//      CONTEXT_TOKENS/TOKEN_KINDS (tokens.ts) pour griser les lignes illégales dans ce contexte,
//      SANS jamais redéfinir la règle ici. `insertDynamicTextLayer(row, canvas)` porte la décision
//      « une ligne indisponible n'insère rien » (spec §9), testée indépendamment du rendu. Correctif
//      revue finale — Important 5, amendement de spec §4 sur mandat exprès du produit : la raison
//      d'une ligne indisponible n'est plus portée UNIQUEMENT par `title` (inatteignable au clavier,
//      annoncée de façon peu fiable) — elle est désormais une ligne visible DANS la rangée, et le
//      bouton reste focusable (`aria-disabled="true"` + `aria-describedby`, PAS l'attribut HTML
//      `disabled` qui retire de l'ordre de tabulation) tandis que `onClick` ne fait rien.
export interface TextePanelProps {
  context: TemplateContext;
  canvas: { width: number; height: number };
  dispatch: Dispatch<EditorAction>;
  onOpenChange?: (next: RailCategory | null) => void;
  // Chantier A Tâche 3 (spec §2/§3) : transmise TELLE QUELLE à PanelHost — voir son commentaire
  // (panel-host.tsx) pour la source (EditorPrefs.railPanelWidth) et le défaut.
  width?: number;
}

export function TextePanel({ context, canvas, dispatch, onOpenChange = () => {}, width }: TextePanelProps) {
  const rows = dynamicTextRowsFor(context);

  return (
    <PanelHost
      open="texte"
      onOpenChange={onOpenChange}
      width={width}
      primaryAction={
        <Button
          type="button"
          variant="default"
          size="sm"
          className="w-full"
          data-action="add-text"
          onClick={() => dispatch(addLayer("text"))}
        >
          <Type aria-hidden />Ajouter une zone de texte
        </Button>
      }
    >
      <div className="flex flex-col gap-4" data-testid="texte-panel">
        <section className="space-y-1.5">
          <h3 className="font-heading text-xs font-semibold text-muted-foreground uppercase">Styles</h3>
          <ul className="flex flex-col gap-1.5">
            {TEXT_PRESET_IDS.map((id) => {
              const preset = TEXT_PRESETS[id];
              return (
                <li key={id}>
                  <button
                    type="button"
                    data-preset={id}
                    onClick={() => dispatch(addLayer("text", buildPresetTextLayer(id, canvas)))}
                    className="w-full truncate rounded-md border px-2 py-1.5 text-left hover:bg-accent"
                    style={{ fontSize: preset.size, fontWeight: preset.weight, lineHeight: 1.1 }}
                  >
                    {preset.label}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="space-y-1.5">
          <h3 className="font-heading text-xs font-semibold text-muted-foreground uppercase">Texte dynamique</h3>
          <ul className="flex flex-col gap-1">
            {rows.map((row) => {
              const reasonId = `dynamic-text-reason-${row.tokenId}`;
              return (
                <li key={row.tokenId}>
                  <button
                    type="button"
                    data-token={row.tokenId}
                    data-available={row.available}
                    aria-disabled={!row.available}
                    aria-describedby={row.available ? undefined : reasonId}
                    onClick={() => {
                      const layer = insertDynamicTextLayer(row, canvas);
                      if (layer) dispatch(addLayer("text", layer));
                    }}
                    className={cn(
                      "flex w-full flex-col items-start rounded-md border px-2 py-1.5 text-left text-sm hover:bg-accent",
                      !row.available && "cursor-not-allowed opacity-50 hover:bg-transparent",
                    )}
                  >
                    <span>{row.label}</span>
                    <span className="text-xs text-muted-foreground">{`{{${row.tokenId}}}`}</span>
                    {!row.available && (
                      <span id={reasonId} className="text-[11px] text-muted-foreground">
                        {row.reason}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      </div>
    </PanelHost>
  );
}
