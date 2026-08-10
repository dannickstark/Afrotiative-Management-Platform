"use client";

import type { Dispatch } from "react";
import { LayerPanel } from "@/components/studio/layer-panel";
import type { EditorAction } from "@/lib/studio/editor-state";
import type { Scene } from "@/lib/studio/scene";

// components/studio/panels/calques-panel.tsx — Tâche 1 (U1, spec §3) : le contenu de la catégorie
// « Calques » du rail. `LayerPanel` (components/studio/layer-panel.tsx) est repris INCHANGÉ, avec
// exactement les mêmes props qu'avant — c'est ce qui fait de cette tâche un livrable complet plutôt
// qu'un échafaudage : les calques ne sont plus leur propre colonne, ils vivent désormais ICI.
export interface CalquesPanelProps {
  scene: Scene;
  selectedId: string | null;
  dispatch: Dispatch<EditorAction>;
}

export function CalquesPanel({ scene, selectedId, dispatch }: CalquesPanelProps) {
  return <LayerPanel scene={scene} selectedId={selectedId} dispatch={dispatch} />;
}
