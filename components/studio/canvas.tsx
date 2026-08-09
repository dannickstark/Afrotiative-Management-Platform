"use client";

import type { Dispatch } from "react";
import type { Scene } from "@/lib/studio/scene";
import { type EditorAction, select } from "@/lib/studio/editor-state";
import { LayerView } from "./layer-view";

// Le canevas est du DOM, pas un `<canvas>` (spec §2) : chaque calque est une `div` positionnée en
// absolu, à l'intérieur d'un conteneur mis à l'échelle. Le conteneur EXTÉRIEUR (celui que le parent
// dimensionne dans sa mise en page) fait `canvas.width * scale` × `canvas.height * scale` px
// écran ; le conteneur INTÉRIEUR, lui, garde les dimensions RÉELLES du gabarit et porte
// `transform: scale(k)` — exactement la stratégie du spec, pour que TOUTES les coordonnées
// manipulées (frames, deltas de glisser) restent en pixels du gabarit, jamais en pixels écran.
export interface CanvasProps {
  scene: Scene;
  selectedId: string | null;
  dispatch: Dispatch<EditorAction>;
  scale: number;
  /** Sources déjà résolues, par id de calque — assets/QR téléchargés par l'appelant (bibliothèque,
   * Lot 3). Un calque `image` à jeton (`{{slot}}`) n'y figure jamais : l'éditeur n'a pas de valeur
   * de jeton, quoi qu'il arrive (voir layer-view.tsx). */
  images?: Map<string, string>;
}

export function Canvas({ scene, selectedId, dispatch, scale, images }: CanvasProps) {
  return (
    <div
      data-testid="studio-canvas"
      style={{
        position: "relative",
        width: scene.canvas.width * scale,
        height: scene.canvas.height * scale,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          position: "relative",
          width: scene.canvas.width,
          height: scene.canvas.height,
          transform: `scale(${scale})`,
          transformOrigin: "top left",
          background: scene.canvas.background === "transparent" ? undefined : scene.canvas.background,
        }}
      >
        {scene.layers.map((layer) => {
          if (!layer.visible) return null;
          return (
            <LayerView
              key={layer.id}
              layer={layer}
              frame={layer.frame}
              rotation={layer.rotation ?? 0}
              selected={layer.id === selectedId}
              image={images?.get(layer.id)}
              onPointerDown={() => dispatch(select(layer.id))}
            />
          );
        })}
      </div>
    </div>
  );
}
