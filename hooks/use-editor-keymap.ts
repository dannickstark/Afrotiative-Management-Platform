"use client";

import { useEffect, useRef } from "react";
import type { Dispatch } from "react";
import { resolveShortcut, isEditingText, isPopupOpen } from "@/lib/studio/keymap";
import {
  type EditorAction, type EditorState,
  undo, redo, selectMany, clearSelection, deleteLayer, moveLayer, singleSelectedId,
} from "@/lib/studio/editor-state";

// hooks/use-editor-keymap.ts — Chantier B, Tâche 1 : le pont navigateur pour
// lib/studio/keymap.ts#resolveShortcut (lui-même PUR). Un écouteur CENTRAL, monté UNE FOIS dans
// EditorShell, qui remplace les écouteurs dispersés par calque (voir la migration de
// canvas.tsx#handleKeyDown dans le même commit).
//
// ── PHASE DE CAPTURE, PAS DE BOUILLONNEMENT (correctif post-livraison — Échap était mort) ───────────
// `window.addEventListener("keydown", handleKeyDown, true)` — le `true` final EST le correctif, pas un
// détail. Le premier jet écoutait en bouillonnement (comme le ⌘/ de editor-shell.tsx), et un test EN
// CONDITIONS RÉELLES (VRAI EditorShell, VRAI PropertyPanel, calque sélectionné) a montré qu'Échap
// n'atteignait JAMAIS cet écouteur : `PropertyPanel` pose au moins un `<SelectField>` (base-ui Select)
// dès qu'un calque est sélectionné, quel que soit son type — et ce `<Select>`, MÊME FERMÉ, intercepte
// « Échap » sur `document` en appelant `stopPropagation()`/`preventDefault()` AVANT que l'événement
// n'atteigne le bouillonnement de `window`. Instrumenté directement (capture/cible/bouillonnement des
// trois niveaux document/window) : `window` en bouillonnement ne voyait RIEN. En capture, `window` est
// le PREMIER nœud du trajet — notre écouteur voit donc l'événement avant `document`, avant le popup.
//
// Corollaire ASSUMÉ, PAS un détail secondaire : voir `ctx.isPopupOpen` (lib/studio/keymap.ts) — sans
// cette garde, écouter en capture ferait de NOUS l'intercepteur indésirable (Échap désélectionnerait
// au lieu de fermer le popup ; une flèche casserait la navigation d'un `<Select>` ouvert). La garde de
// popup est donc INDISSOCIABLE de ce passage en capture, pas une amélioration à part.
//
// ── DÉPENDANCES STABLES DE L'EFFET (correctif post-livraison, mineur) ────────────────────────────────
// L'écouteur est posé UNE SEULE FOIS (deps `[]` — `dispatch` d'un `useReducer` est déjà stable d'un
// rendu à l'autre, React le garantit, donc `[]` et `[dispatch]` sont équivalents ici ; `[]` documente
// l'intention). Le PREMIER jet dépendait de `[state, dispatch]` : `state` change de référence à CHAQUE
// dispatch, donc l'effet retirait et reposait l'écouteur à CHAQUE frappe traitée — inutile (aucun test
// ne l'a jamais dépendu) et un coût qui grandit avec la fréquence des raccourcis. `stateRef` porte la
// valeur COURANTE sans jamais faire dépendre l'effet lui-même de son contenu — le motif standard pour
// un écouteur global qui doit lire un état FRAIS sans se réabonner à chaque changement.
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
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const current = stateRef.current;
      const command = resolveShortcut(
        { key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey },
        {
          hasSelection: current.selectedIds.length > 0,
          isEditingText: isEditingText(e.target),
          isPopupOpen: isPopupOpen(document),
        },
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
          dispatch(selectMany(current.scene.layers.map((l) => l.id)));
          return;
        case "deselect":
          e.preventDefault();
          dispatch(clearSelection());
          return;
        case "delete": {
          const id = singleSelectedId(current.selectedIds);
          const layer = id ? current.scene.layers.find((l) => l.id === id && l.visible) : null;
          if (!layer || layer.locked) return;
          e.preventDefault();
          dispatch(deleteLayer(id!));
          return;
        }
        case "nudge": {
          const id = singleSelectedId(current.selectedIds);
          const layer = id ? current.scene.layers.find((l) => l.id === id && l.visible) : null;
          if (!layer || layer.locked) return;
          e.preventDefault();
          dispatch(moveLayer(id!, command.dx, command.dy));
          return;
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown, true); // capture — voir l'en-tête de module
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [dispatch]);
}
