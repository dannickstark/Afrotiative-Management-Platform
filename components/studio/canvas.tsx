"use client";

import { useRef } from "react";
import type { Dispatch, CSSProperties, KeyboardEvent, PointerEvent } from "react";
import type { Layer, Scene } from "@/lib/studio/scene";
import { type EditorAction, select, deleteLayer, moveLayer } from "@/lib/studio/editor-state";
import { useLayerDrag, HANDLES, nudgeDelta, type HandleId } from "@/hooks/use-layer-drag";
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

const HANDLE_CURSOR: Record<HandleId, string> = {
  n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize",
  ne: "nesw-resize", sw: "nesw-resize", nw: "nwse-resize", se: "nwse-resize",
};

// Position de chaque poignée, en % du cadre du calque (coin ou milieu de côté) — indépendant de
// l'échelle puisque exprimé en pourcentage du conteneur, lui-même déjà mis à l'échelle par le
// parent.
const HANDLE_STYLE: Record<HandleId, CSSProperties> = {
  n: { top: 0, left: "50%" }, s: { bottom: 0, left: "50%" },
  e: { right: 0, top: "50%" }, w: { left: 0, top: "50%" },
  ne: { top: 0, right: 0 }, nw: { top: 0, left: 0 },
  se: { bottom: 0, right: 0 }, sw: { bottom: 0, left: 0 },
};

export function Canvas({ scene, selectedId, dispatch, scale, images }: CanvasProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const { preview, getMoveHandler, getResizeHandler, getRotateHandler } = useLayerDrag(dispatch, scale);

  const selectedLayer = scene.layers.find((l) => l.id === selectedId && l.visible) ?? null;

  function frameFor(layer: Layer) {
    return preview?.layerId === layer.id && preview.frame ? preview.frame : layer.frame;
  }
  function rotationFor(layer: Layer) {
    return preview?.layerId === layer.id && preview.rotation !== undefined
      ? preview.rotation
      : (layer.rotation ?? 0);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (!selectedLayer || selectedLayer.locked) return;
    if (e.key === "Delete") {
      e.preventDefault();
      dispatch(deleteLayer(selectedLayer.id));
      return;
    }
    const nudge = nudgeDelta(e.key, e.shiftKey);
    if (nudge) {
      e.preventDefault();
      dispatch(moveLayer(selectedLayer.id, nudge.x, nudge.y));
    }
  }

  function handleRotateDown(layer: Layer) {
    return (e: PointerEvent<HTMLElement>) => {
      const canvasRect = rootRef.current?.getBoundingClientRect();
      const cx = layer.frame.x + layer.frame.w / 2;
      const cy = layer.frame.y + layer.frame.h / 2;
      const center = canvasRect
        ? { x: canvasRect.left + cx * scale, y: canvasRect.top + cy * scale }
        : { x: cx, y: cy };
      getRotateHandler(layer, center)(e);
    };
  }

  const selectedFrame = selectedLayer ? frameFor(selectedLayer) : null;
  const selectedRotation = selectedLayer ? rotationFor(selectedLayer) : 0;

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      data-testid="studio-canvas"
      style={{
        position: "relative",
        width: scene.canvas.width * scale,
        height: scene.canvas.height * scale,
        overflow: "hidden",
        outline: "none",
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
              frame={frameFor(layer)}
              rotation={rotationFor(layer)}
              selected={layer.id === selectedId}
              image={images?.get(layer.id)}
              onPointerDown={(e) => {
                dispatch(select(layer.id));
                rootRef.current?.focus();
                getMoveHandler(layer)(e);
              }}
            />
          );
        })}

        {selectedLayer && selectedFrame && !selectedLayer.locked && (
          <div
            data-testid="handles-overlay"
            style={{
              position: "absolute",
              left: selectedFrame.x, top: selectedFrame.y,
              width: selectedFrame.w, height: selectedFrame.h,
              transform: selectedRotation ? `rotate(${selectedRotation}deg)` : undefined,
              pointerEvents: "none",
            }}
          >
            {HANDLES.map((h) => (
              <div
                key={h}
                data-handle={h}
                onPointerDown={getResizeHandler(selectedLayer, h)}
                style={{
                  position: "absolute", width: 8, height: 8, marginLeft: -4, marginTop: -4,
                  background: "#fff", border: "1px solid #2563eb", cursor: HANDLE_CURSOR[h],
                  pointerEvents: "auto", ...HANDLE_STYLE[h],
                }}
              />
            ))}
            <div
              data-handle="rotate"
              onPointerDown={handleRotateDown(selectedLayer)}
              style={{
                position: "absolute", top: -24, left: "50%", marginLeft: -4, width: 8, height: 8,
                borderRadius: "50%", background: "#fff", border: "1px solid #2563eb",
                cursor: "grab", pointerEvents: "auto",
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
