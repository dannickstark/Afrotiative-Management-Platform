"use client";

import type { Dispatch } from "react";
import { Type } from "lucide-react";
import { Button } from "@/components/ui/button";
import { addLayer, type EditorAction } from "@/lib/studio/editor-state";
import { dynamicTextRowsFor, buildDynamicTextLayer } from "@/lib/studio/dynamic-text";
import { TEXT_PRESET_IDS, TEXT_PRESETS } from "@/lib/studio/text-presets";
import type { TemplateContext } from "@/lib/studio/tokens";

// components/studio/panels/texte-panel.tsx — Tâche 3 (U1, spec §3/§4) : le contenu de la catégorie
// « Texte » du rail. Contrairement au panneau Images (Tâche 2, volontairement browse-only —
// spec §3 n'a jamais demandé à Images d'insérer), CE panneau insère : c'est tout l'objet de la
// Tâche 3 (spec §4, « Why this task exists ») — un clic transforme un jeton en calque texte déjà
// lié, plutôt que de forcer un designer à sélectionner un calque puis chercher le champ jeton.
//
// Trois sections (spec §3, tableau « Texte ») :
//   1. Action primaire « Ajouter une zone de texte » — dispatch(addLayer("text")) SANS second
//      argument : le calque générique existant (editor-state.ts:createLayer), inchangé.
//   2. « Styles » — TEXT_PRESETS (lib/studio/text-presets.ts) rendus À LEUR TAILLE RÉELLE
//      (spec §3). Volontairement un aperçu, PAS un troisième chemin d'insertion : l'interface que
//      la Tâche 3 doit produire (voir le brief) ne définit qu'UN builder de calque,
//      buildDynamicTextLayer(row, canvas) — qui exige une DynamicTextRow liée à un jeton — et
//      aucun équivalent pour un préréglage nu. Ajouter ce troisième chemin sans qu'il figure dans
//      l'interface aurait été de la logique non spécifiée par-dessus la tâche, pas une omission.
//   3. « Texte dynamique » (spec §4) — dynamicTextRowsFor(context) (lib/studio/dynamic-text.ts) lit
//      CONTEXT_TOKENS/TOKEN_KINDS (tokens.ts) pour griser les lignes illégales dans ce contexte,
//      SANS jamais redéfinir la règle ici. Une ligne disponible dispatch
//      addLayer("text", buildDynamicTextLayer(row, canvas)) — LA MÊME action que l'insertion
//      générique ci-dessus, avec son calque déjà construit en second argument (Tâche 3,
//      editor-state.ts) plutôt qu'un chemin d'insertion parallèle. Une ligne indisponible est
//      `disabled` (bouton HTML natif : aucun clic ne peut en sortir un événement, pas seulement un
//      style visuel) et porte sa raison française en `title`.
export interface TextePanelProps {
  context: TemplateContext;
  canvas: { width: number; height: number };
  dispatch: Dispatch<EditorAction>;
}

export function TextePanel({ context, canvas, dispatch }: TextePanelProps) {
  const rows = dynamicTextRowsFor(context);

  return (
    <div className="flex flex-col gap-4" data-testid="texte-panel">
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

      <section className="space-y-1.5">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase">Styles</h3>
        <ul className="flex flex-col gap-1.5">
          {TEXT_PRESET_IDS.map((id) => {
            const preset = TEXT_PRESETS[id];
            return (
              <li
                key={id}
                data-preset={id}
                className="truncate rounded-md border px-2 py-1.5"
                style={{ fontSize: preset.size, fontWeight: preset.weight, lineHeight: 1.1 }}
              >
                {preset.label}
              </li>
            );
          })}
        </ul>
      </section>

      <section className="space-y-1.5">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase">Texte dynamique</h3>
        <ul className="flex flex-col gap-1">
          {rows.map((row) => (
            <li key={row.tokenId}>
              <button
                type="button"
                data-token={row.tokenId}
                data-available={row.available}
                disabled={!row.available}
                title={row.reason}
                onClick={() => dispatch(addLayer("text", buildDynamicTextLayer(row, canvas)))}
                className="flex w-full flex-col items-start rounded-md border px-2 py-1.5 text-left text-sm hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
              >
                <span>{row.label}</span>
                <span className="text-xs text-muted-foreground">{`{{${row.tokenId}}}`}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
