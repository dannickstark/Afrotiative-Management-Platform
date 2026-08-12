"use client";

import { useEffect } from "react";
import type { Dispatch } from "react";
import { resolveShortcut, isEditingText } from "@/lib/studio/keymap";
import {
  type EditorAction, type EditorState,
  undo, redo, selectMany, clearSelection, deleteLayer, moveLayer, singleSelectedId,
} from "@/lib/studio/editor-state";

// hooks/use-editor-keymap.ts — Chantier B, Tâche 1 : le pont navigateur pour
// lib/studio/keymap.ts#resolveShortcut (lui-même PUR). Même recette que le ⌘/ de editor-shell.tsx
// (un `window.addEventListener("keydown", …)`, jamais `document` — les deux atteignent l'autre par
// bouillonnement, mais `window` est déjà le choix établi de ce fichier) : un écouteur CENTRAL,
// monté UNE FOIS dans EditorShell, qui remplace les écouteurs dispersés par calque (voir la migration
// de canvas.tsx#handleKeyDown dans le même commit).
//
// CE QUE CE HOOK DÉCIDE QUE `resolveShortcut` NE PEUT PAS DÉCIDER — deux résolutions d'ID que la
// fonction pure ignore délibérément (elle ne connaît que `ctx.hasSelection`, un booléen) :
//   - Suppr/flèches restent, comme avant cette tâche, des gestes de SÉLECTION SIMPLE (voir le
//     commentaire de canvas.tsx#soleSelectedId qu'elles suivaient déjà : « généraliser est un geste de
//     produit à part entière », hors périmètre ici). `singleSelectedId` renvoie `null` pour une
//     sélection multiple -> aucune commande dispatchée, IDENTIQUE au comportement d'avant (l'ancien
//     handleKeyDown de canvas.tsx ne s'armait déjà que sur `selectedLayer`, la même dérivation).
//   - le VERROU. Ni `resolveShortcut` ni son `ctx` ne savent qu'un calque est verrouillé — c'est une
//     donnée de LA SCÈNE, pas de l'événement clavier. Reproduit ici la garde exacte que canvas.tsx
//     posait (`!selectedLayer || selectedLayer.locked`) — y COMPRIS `l.visible`, qui faisait déjà
//     partie de la définition de `selectedLayer` là-bas : un calque masqué n'est pas plus supprimable
//     ou déplaçable au clavier qu'il ne l'était avant.
export function useEditorKeymap(state: EditorState, dispatch: Dispatch<EditorAction>): void {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const command = resolveShortcut(
        { key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey },
        { hasSelection: state.selectedIds.length > 0, isEditingText: isEditingText(e.target) },
      );
      if (!command) return;

      switch (command.kind) {
        case "undo":
          e.preventDefault();
          dispatch(undo());
          return;
        case "redo":
          e.preventDefault();
          dispatch(redo());
          return;
        case "selectAll":
          e.preventDefault();
          dispatch(selectMany(state.scene.layers.map((l) => l.id)));
          return;
        case "deselect":
          e.preventDefault();
          dispatch(clearSelection());
          return;
        case "delete": {
          const id = singleSelectedId(state.selectedIds);
          const layer = id ? state.scene.layers.find((l) => l.id === id && l.visible) : null;
          if (!layer || layer.locked) return;
          e.preventDefault();
          dispatch(deleteLayer(id!));
          return;
        }
        case "nudge": {
          const id = singleSelectedId(state.selectedIds);
          const layer = id ? state.scene.layers.find((l) => l.id === id && l.visible) : null;
          if (!layer || layer.locked) return;
          e.preventDefault();
          dispatch(moveLayer(id!, command.dx, command.dy));
          return;
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [state, dispatch]);
}
