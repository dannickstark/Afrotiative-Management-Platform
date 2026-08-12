"use client";

import { useCallback, useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { clampPanelWidth } from "@/lib/studio/editor-prefs";

// components/studio/panel-resize-handle.tsx — Chantier A Tâche 3 (spec §2/§3) : la poignée de
// glisser qui redimensionne rail-panel↔canevas ET canevas↔inspecteur. MÊME idiome de câblage DOM
// que hooks/use-layer-drag.ts#bind (le SEUL autre geste de glisser du studio, réutilisé ici plutôt
// que réinventé — brief : « reuse the studio's existing pointer patterns — NO new dependency ») :
//   - `onPointerDown` reste un prop React (sur la poignée uniquement), `pointermove`/`pointerup`/
//     `pointercancel` sont posés en écouteurs NATIFS sur `e.currentTarget` (jamais `window`), rendus
//     sûrs quel que soit l'endroit où le curseur quitte la poignée par `setPointerCapture?.(...)` —
//     l'optional chaining contourne l'absence de cette API sous jsdom, exactement comme `bind()`.
//   - bouton gauche uniquement (`e.button !== 0` -> rien), et `stopPropagation`/`preventDefault` AVANT
//     tout effet, pour ne jamais laisser ce pointerdown atteindre un geste de sélection sous-jacent.
//
// Contrairement à un glisser de calque (hooks/use-layer-drag.ts, « une geste = un dispatch » —
// l'historique annuler/rétablir ne doit voir qu'UNE entrée par geste), une largeur de panneau n'est
// PAS un état d'historique : `onResize` est donc appelé à CHAQUE `pointermove`, en continu — c'est
// ce qui fait suivre le panneau le curseur en direct plutôt que de sauter une fois relâché.
//
// `clampPanelWidth` (lib/studio/editor-prefs.ts) est appelée ICI, à CHAQUE mouvement — jamais
// seulement par le parseur de préférences au chargement — pour qu'un glisser ne puisse jamais, ne
// serait-ce qu'un instant, pousser `railPanelWidth`/`inspectorWidth` hors bornes pendant le geste
// lui-même (l'écriture continue dans localStorage, hooks/use-editor-prefs.ts, verrait sinon transiter
// des valeurs hors bornes avant tout rechargement).
export interface PanelResizeHandleProps {
  /** Largeur COURANTE (px) du panneau que cette poignée redimensionne — capturée au `pointerdown`,
   * jamais relue pendant le glisser (une poignée ne fait QUE calculer un delta depuis ce point de
   * départ, elle ne connaît rien d'autre du panneau). */
  currentWidth: number;
  min: number;
  max: number;
  /** `+1` : la poignée vit sur le bord DROIT d'un panneau posé à GAUCHE (rail-panel↔canevas) — glisser
   * vers la DROITE agrandit ce panneau. `-1` : la poignée vit sur le bord GAUCHE d'un panneau posé à
   * DROITE (canevas↔inspecteur) — glisser vers la DROITE le RÉTRÉCIT (son bord gauche avance vers le
   * canevas). Un simple multiplicateur signé plutôt qu'une chaîne "start"/"end" à décoder : la seule
   * décision géométrique de ce composant, explicite à l'appel plutôt que déduite d'un nom. */
  sign: 1 | -1;
  onResize: (width: number) => void;
  label: string;
  testId: string;
}

export function PanelResizeHandle({ currentWidth, min, max, sign, onResize, label, testId }: PanelResizeHandleProps) {
  // `currentWidth`/`min`/`max`/`sign`/`onResize` en REF : le geste dure potentiellement plusieurs
  // rendus (chaque appel à `onResize` déclenche typiquement un nouveau rendu du parent avec une
  // largeur mise à jour), mais les écouteurs natifs posés au `pointerdown` restent ceux du PREMIER
  // rendu — même raison que dispatchRef/scaleRef dans hooks/use-layer-drag.ts : lire à travers une
  // ref garantit que `handleMove` voit toujours `onResize` et les bornes les plus À JOUR sans jamais
  // avoir à retirer/reposer les écouteurs à chaque frappe de la souris.
  const propsRef = useRef({ currentWidth, min, max, sign, onResize });
  propsRef.current = { currentWidth, min, max, sign, onResize };

  const dragStartRef = useRef<{ pointerX: number; startWidth: number } | null>(null);

  const handlePointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();

    dragStartRef.current = { pointerX: e.clientX, startWidth: propsRef.current.currentWidth };
    const target = e.currentTarget;
    target.setPointerCapture?.(e.pointerId);

    function handleMove(ev: PointerEvent) {
      const drag = dragStartRef.current;
      if (!drag) return;
      const { min: curMin, max: curMax, sign: curSign, onResize: curOnResize } = propsRef.current;
      const rawDelta = ev.clientX - drag.pointerX;
      const next = clampPanelWidth(drag.startWidth + curSign * rawDelta, curMin, curMax);
      curOnResize(next);
    }
    function cleanup() {
      dragStartRef.current = null;
      target.removeEventListener("pointermove", handleMove);
      target.removeEventListener("pointerup", handleUp);
      target.removeEventListener("pointercancel", handleCancel);
    }
    function handleUp() { cleanup(); }
    function handleCancel() { cleanup(); }

    target.addEventListener("pointermove", handleMove);
    target.addEventListener("pointerup", handleUp);
    target.addEventListener("pointercancel", handleCancel);
  }, []);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      data-testid={testId}
      onPointerDown={handlePointerDown}
      className="group relative w-2 shrink-0 cursor-col-resize touch-none select-none"
    >
      <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border transition-colors group-hover:bg-ring group-active:bg-ring" />
    </div>
  );
}
