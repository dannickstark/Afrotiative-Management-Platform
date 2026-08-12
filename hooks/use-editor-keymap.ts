"use client";

import { useEffect, useRef } from "react";
import type { Dispatch } from "react";
import { resolveShortcut, isEditingText, isPopupOpen } from "@/lib/studio/keymap";
import {
  type EditorAction, type EditorState,
  undo, redo, selectMany, clearSelection, deleteLayer, moveLayer, singleSelectedId, addLayers,
} from "@/lib/studio/editor-state";
import { cloneLayersWithNewIds, copyToClipboard, readClipboard, PASTE_OFFSET } from "@/lib/studio/clipboard";
import { unionBounds, zoomPresetScale, type ZoomViewport } from "@/lib/studio/zoom";
import type { Layer } from "@/lib/studio/scene";

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
// Résout `selectedIds` en calques RÉELS de la scène courante, dans l'ordre de la sélection — pour
// copy/duplicate (chantier B, tâche 2). Contrairement à `delete`/`nudge` ci-dessus, ni le verrou ni
// la visibilité ne sont un motif d'exclusion ICI : copier (ou dupliquer, qui clone plutôt que
// modifier la source) ne MUTE jamais le calque source, donc rien ne justifie de refuser un calque
// verrouillé ou masqué — seule une sélection pointant vers un id qui n'existe PLUS dans la scène
// (§2 de l'en-tête du module) doit être filtrée.
function selectedLayers(state: EditorState): Layer[] {
  const layers: Layer[] = [];
  for (const id of state.selectedIds) {
    const layer = state.scene.layers.find((l) => l.id === id);
    if (layer) layers.push(layer);
  }
  return layers;
}

// Chantier B, Tâche 3 — le VRAI zoom (⇧0/⇧1/⇧2). Ce que ce hook ajoute à `resolveShortcut`
// (lib/studio/keymap.ts), qui ne connaît que « y a-t-il une sélection » (booléen) : la mesure RÉELLE
// (`fitScale`, le viewport ÉCRAN courant) et l'écriture de la préférence — zoom est un PRÉFÉRENCE,
// jamais une action du réducteur de scène (voir editor-shell.tsx : `setZoom` pose `EditorPrefs.zoom`,
// PAS `dispatch` — aucun `HistoryEntry`, aucun autosave déclenché par un changement de zoom).
export interface ZoomKeymapContext {
  /** L'échelle d'AJUSTEMENT courante (editor-shell.tsx#computeCanvasScale, le `fitScale` ResizeObserver
   * — PAS `scale` = fitScale × factor). Lu à CHAQUE frappe via une ref (voir `zoomRef` plus bas),
   * jamais figé à la valeur du montage : `fitScale` change à chaque redimensionnement de fenêtre. */
  fitScale: number;
  /** La zone ÉCRAN disponible pour cadrer une sélection (le conteneur du canevas), mesurée au moment
   * de la frappe — `null` si le conteneur n'est pas encore monté/mesurable. */
  getViewport: () => ZoomViewport | null;
  /** Écrit `EditorPrefs.zoom` — `"fit"` pour ⇧1, un FACTEUR numérique (relatif à `fitScale`, voir
   * lib/studio/zoom.ts) pour ⇧0/⇧2. Jamais `dispatch` : le zoom ne mute pas `state.scene`. */
  setZoom: (factor: number | "fit") => void;
}

export function useEditorKeymap(
  state: EditorState,
  dispatch: Dispatch<EditorAction>,
  zoom: ZoomKeymapContext,
): void {
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // Même motif que `stateRef` ci-dessus : une ref, jamais une dépendance de l'effet d'écoute plus bas
  // (voir son en-tête, « DÉPENDANCES STABLES DE L'EFFET ») — `zoom` (l'objet littéral passé par
  // editor-shell.tsx) change de référence à CHAQUE rendu (nouvelle closure `getViewport`/`setZoom`),
  // ce qui reposerait l'écouteur `window` à chaque frappe traitée si c'était une dépendance directe.
  const zoomRef = useRef(zoom);
  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

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
        // Chantier B, Tâche 2 — le presse-papiers en session. `resolveShortcut` a déjà tranché
        // « y a-t-il une sélection » (ctx.hasSelection, pour copy/duplicate) ; ce que LUI ne peut pas
        // savoir, comme pour delete/nudge ci-dessus, c'est si ces ids DÉSIGNENT ENCORE des calques
        // réels de la scène courante (§2 de l'en-tête du module, « la sélection n'est pas validée
        // contre la scène ») — donc résolu ICI, pas dans le module pur.
        case "copy": {
          const layers = selectedLayers(current);
          if (layers.length === 0) return;
          e.preventDefault();
          copyToClipboard(layers);
          return;
        }
        case "paste": {
          const clipped = readClipboard();
          if (clipped.length === 0) return; // presse-papiers vide -> no-op, AUCUN dispatch (voir le
          // commentaire d'`addLayers` dans editor-state.ts : un lot vide serait de toute façon un
          // no-op côté réducteur, mais s'arrêter ICI évite même l'appel).
          e.preventDefault();
          dispatch(addLayers(cloneLayersWithNewIds(clipped, PASTE_OFFSET)));
          return;
        }
        case "duplicate": {
          // ⌘D = copier + coller-en-place-décalé comme UN SEUL geste (brief) : clone DIRECTEMENT la
          // sélection courante — sans passer par (ni écraser) le presse-papiers du module, pour que
          // dupliquer et copier restent deux gestes indépendants qui ne se marchent pas dessus.
          const layers = selectedLayers(current);
          if (layers.length === 0) return;
          e.preventDefault();
          dispatch(addLayers(cloneLayersWithNewIds(layers, PASTE_OFFSET)));
          return;
        }
        // Chantier B, Tâche 3 — ⇧0/⇧1/⇧2 : `zoomRef.current.setZoom(...)`, JAMAIS `dispatch` — voir
        // `ZoomKeymapContext` ci-dessus pour pourquoi (préférence, pas action du réducteur de scène).
        case "zoom100":
          e.preventDefault();
          zoomRef.current.setZoom(zoomPresetScale("100", zoomRef.current.fitScale));
          return;
        case "zoomFit":
          e.preventDefault();
          zoomRef.current.setZoom("fit");
          return;
        case "zoomSelection": {
          // `resolveShortcut` a déjà tranché `ctx.hasSelection` — ce que LUI ne peut pas savoir, comme
          // pour copy/duplicate ci-dessus, c'est si ces ids DÉSIGNENT ENCORE des calques réels de la
          // scène courante, ni la géométrie (leurs `frame`) qu'il faut cadrer. Un viewport pas encore
          // mesurable (conteneur pas monté) est un no-op silencieux, pas une erreur.
          const layers = selectedLayers(current);
          if (layers.length === 0) return;
          const bounds = unionBounds(layers.map((l) => l.frame));
          const viewport = zoomRef.current.getViewport();
          if (!bounds || !viewport) return;
          e.preventDefault();
          zoomRef.current.setZoom(zoomPresetScale("selection", zoomRef.current.fitScale, bounds, viewport));
          return;
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown, true); // capture — voir l'en-tête de module
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [dispatch]);
}
