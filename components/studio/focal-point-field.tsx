"use client";

import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

// components/studio/focal-point-field.tsx — Properties Pro P1, Tâche 6 : le point focal DÉPLAÇABLE,
// mécanique de glisser 2D calquée sur le carré Saturation/Valeur de `color-picker.tsx` (chantier C,
// Tâche 4) — MÊME patron `pointerdown`+`setPointerCapture`, `pointermove` qui met à jour UNIQUEMENT
// un tampon local (jamais de commit pendant le glisser), `pointerup` qui calcule le ratio final et
// appelle `onCommit` UNE SEULE fois (une entrée d'historique par geste, même discipline que
// `NumberField`/`ColorPicker`). `e.currentTarget` est lu SYNCHRONEMENT dans chaque gestionnaire —
// jamais depuis l'intérieur d'un correcteur fonctionnel de `setState`, React invoque celui-ci de façon
// DIFFÉRÉE et `currentTarget` d'un événement synthétique ne survit pas au-delà du passage synchrone du
// gestionnaire (même piège documenté sur `svMove`, color-picker.tsx).
//
// Convention du point focal (lib/studio/image-css.ts) : `{x,y}` NORMALISÉS [0,1], `{0.5,0.5}` =
// centre, Y suit CSS (0 = haut, 1 = bas) — donc la fraction verticale du glisser (haut→bas de la
// vignette) correspond DIRECTEMENT à `y`, aucune inversion à faire ici (contrairement au carré SV du
// sélecteur de couleur, où `v` est inversé).

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

export interface ImageFocal {
  x: number;
  y: number;
}

function focalFromRect(el: Element, clientX: number, clientY: number): ImageFocal {
  const rect = el.getBoundingClientRect();
  const w = rect.width || 1; // jsdom (bun test) ne mesure jamais de layout réel — voir les tests.
  const h = rect.height || 1;
  return {
    x: clamp((clientX - rect.left) / w, 0, 1),
    y: clamp((clientY - rect.top) / h, 0, 1),
  };
}

export interface FocalPointFieldProps {
  /** `layer.focal ?? {x:0.5, y:0.5}` — l'appelant (ImageFields, property-panel.tsx) applique déjà le
   * repli centre, ce composant reste un contrôle nu qui affiche exactement ce qu'on lui donne. */
  value: ImageFocal;
  /** L'URL affichable de l'image source (ImageFields la résout déjà pour les sources `url`/`asset` ;
   * `undefined` pour une source `slot` sans aperçu résolu, ou tout cas où l'appelant n'a rien à
   * offrir) — un placeholder neutre est peint à la place, le point restant déplaçable normalement :
   * pas de nouvelle résolution de données ICI, un composant purement présentationnel. */
  imageSrc?: string;
  onCommit: (v: ImageFocal) => void;
}

export function FocalPointField({ value, imageSrc, onCommit }: FocalPointFieldProps) {
  // Tampon de GLISSER : `null` tant qu'aucun geste n'est en cours — le point AFFICHÉ (`point`
  // ci-dessous) retombe alors sur `value`, la VRAIE valeur committée. Pendant un glisser, ce tampon
  // porte la position de travail, jamais committée avant le relâchement (même patron que
  // `dragHsva`/`hsva`, color-picker.tsx).
  const [dragFocal, setDragFocal] = useState<ImageFocal | null>(null);
  const point = dragFocal ?? value;
  const dragging = useRef(false);

  function down(e: ReactPointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragging.current = true;
    setDragFocal(focalFromRect(e.currentTarget, e.clientX, e.clientY));
  }
  function move(e: ReactPointerEvent<HTMLDivElement>) {
    if (!dragging.current) return;
    const next = focalFromRect(e.currentTarget, e.clientX, e.clientY); // lecture SYNCHRONE, voir l'en-tête
    setDragFocal(next);
  }
  function up(e: ReactPointerEvent<HTMLDivElement>) {
    if (!dragging.current) return;
    dragging.current = false;
    const final = focalFromRect(e.currentTarget, e.clientX, e.clientY);
    onCommit(final);
    setDragFocal(null);
  }
  function cancel() {
    dragging.current = false;
    setDragFocal(null);
  }

  return (
    <div
      data-testid="focal-point-field"
      className="relative h-24 w-full cursor-crosshair touch-none overflow-hidden rounded-md border border-input bg-muted"
      style={
        imageSrc
          ? { backgroundImage: `url(${imageSrc})`, backgroundSize: "cover", backgroundPosition: "center" }
          : undefined
      }
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={cancel}
    >
      <span
        aria-hidden="true"
        data-testid="focal-point-dot"
        className="absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-primary shadow"
        style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}
      />
    </div>
  );
}
