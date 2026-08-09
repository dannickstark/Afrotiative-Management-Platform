"use client";

import type { CSSProperties } from "react";
import type { Frame, Layer } from "@/lib/studio/scene";
import { textStyleFor, gradientCss } from "@/lib/studio/element";

// Rendu PUREMENT visuel d'UN calque, en pixels du gabarit (le parent — canvas.tsx — applique déjà
// `transform: scale(k)` sur son conteneur, donc ce composant ne connaît pas l'échelle) — À UNE
// EXCEPTION PRÈS : `scale`, ci-dessous, sert UNIQUEMENT à compenser la largeur du contour de
// sélection (voir son usage dans le style plus bas). Ce contour vit, comme toute la géométrie de ce
// composant, à l'intérieur du conteneur `transform: scale(k)` de canvas.tsx — une largeur de
// contour en pixels GABARIT non compensée rend donc à `2k` px écran, imperceptible pour un format
// comme `story` (k≈0,31), exactement le même défaut que les poignées de canvas.tsx (revue Lot 2,
// Important 3). Pas de logique de glisser/redimensionner/rotation ici : ça reste dans canvas.tsx +
// hooks/use-layer-drag (Tâche 6), pour que ce fichier ne fasse qu'une seule chose et la fasse bien —
// le contrat de la Tâche 5 est « affiche la scène », pas « rend la scène manipulable ».
export interface LayerViewProps {
  layer: Layer;
  /** Cadre à peindre — celui du calque par défaut, ou une prévisualisation live pendant un geste
   * (fournie par canvas.tsx / use-layer-drag.ts, Tâche 6). Séparé de `layer.frame` pour que Task 6
   * puisse afficher un aperçu SANS committer d'action au réducteur à chaque pointermove. */
  frame: Frame;
  rotation: number;
  selected: boolean;
  /** Source résolue pour un calque image/qr (URL d'asset déjà téléchargé, ou data URI). Absente
   * pour un calque `source.kind === "slot"` : l'éditeur n'a jamais de valeur de jeton (voir le
   * commentaire de imageContent ci-dessous). */
  image?: string;
  /** Échelle du canevas parent — sert SEULEMENT à compenser le contour de sélection (voir plus
   * haut). Par défaut 1 (contour à sa taille nominale) pour tout appelant qui n'a pas d'échelle à
   * fournir. */
  scale?: number;
  onPointerDown?: (e: React.PointerEvent<HTMLDivElement>) => void;
}

function frameStyle(frame: Frame, rotation: number, layer: Layer): CSSProperties {
  return {
    position: "absolute",
    left: frame.x,
    top: frame.y,
    width: frame.w,
    height: frame.h,
    transform: rotation ? `rotate(${rotation}deg)` : undefined,
    opacity: layer.opacity,
    boxSizing: "border-box",
  };
}

// Espace réservé pour tout ce que l'éditeur ne peut pas peindre lui-même : un `{{slot}}` d'image
// non résolu (aucune valeur de jeton disponible hors rendu réel, spec §2/§4) ou un asset introuvable.
function Placeholder({ label }: { label: string }) {
  return (
    <div
      style={{
        width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center",
        background: "repeating-linear-gradient(45deg, #444 0, #444 8px, #333 8px, #333 16px)",
        color: "#eee", fontSize: 12, textAlign: "center", overflow: "hidden", padding: 4,
      }}
    >
      {label}
    </div>
  );
}

function ImageContent({ layer, image }: { layer: Extract<Layer, { type: "image" }>; image?: string }) {
  // Un jeton ({{slot}}) n'a de valeur qu'au rendu réel (article/valeurs saisies) — l'éditeur n'en
  // a jamais, par construction (spec §2 : « l'éditeur n'a pas les valeurs de jeton »). Donc PAS de
  // tentative de résolution ici, un espace réservé nommé systématiquement.
  if (layer.source.kind === "slot") return <Placeholder label={`{{${layer.source.slot}}}`} />;
  const src = layer.source.kind === "url" ? layer.source.url : image;
  if (!src) return <Placeholder label={layer.name || "Image"} />;
  return (
    <img
      src={src}
      alt=""
      style={{
        width: "100%", height: "100%",
        objectFit: layer.fit,
        borderRadius: layer.radius,
        filter: layer.blur ? `blur(${layer.blur}px)` : undefined,
      }}
    />
  );
}

function ShapeContent({ layer }: { layer: Extract<Layer, { type: "shape" }> }) {
  const isToken = typeof layer.fill === "string" && layer.fill.startsWith("{{");
  const fillStyle: CSSProperties = isToken
    ? { background: "repeating-linear-gradient(45deg, #666 0, #666 6px, #999 6px, #999 12px)" }
    : typeof layer.fill === "string"
      ? { backgroundColor: layer.fill === "transparent" ? undefined : layer.fill }
      : { backgroundImage: gradientCss(layer.fill) };

  const borderStyle: CSSProperties = {};
  if (layer.border) {
    const sides = layer.border.sides ?? ["top", "right", "bottom", "left"];
    const css = `${layer.border.width}px solid ${layer.border.color}`;
    for (const s of sides) {
      const key = `border${s[0].toUpperCase()}${s.slice(1)}` as keyof CSSProperties;
      (borderStyle as Record<string, string>)[key] = css;
    }
  }

  return (
    <div
      style={{
        width: "100%", height: "100%",
        ...fillStyle, ...borderStyle,
        borderRadius: layer.radius,
      }}
    />
  );
}

// « Représentatif » (contrat Tâche 5) : pas de vrai QR code généré côté client (ça reste un calcul
// serveur, lib/studio/render.ts), juste un aperçu reconnaissable aux couleurs du calque.
function QrContent({ layer }: { layer: Extract<Layer, { type: "qr" }> }) {
  return (
    <div
      style={{
        width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center",
        background: layer.bg, color: layer.fg, border: `1px solid ${layer.fg}`,
        fontSize: 11, fontWeight: 600,
      }}
    >
      QR
    </div>
  );
}

function TextContent({ layer }: { layer: Extract<Layer, { type: "text" }> }) {
  // C'EST le point de contact avec textStyleFor — la même fonction que le moteur de rendu (V1) et
  // la sonde d'auto-ajustement utilisent déjà (lib/studio/element.ts). Ne pas redériver le style de
  // texte ici : c'est exactement la dérive que l'extraction de textStyleFor a corrigée.
  return (
    <div style={{ width: "100%", height: "100%", display: "flex", ...textStyleFor(layer) }}>
      {layer.content}
    </div>
  );
}

function LayerContent({ layer, image }: { layer: Layer; image?: string }) {
  switch (layer.type) {
    case "text": return <TextContent layer={layer} />;
    case "image": return <ImageContent layer={layer} image={image} />;
    case "shape": return <ShapeContent layer={layer} />;
    case "qr": return <QrContent layer={layer} />;
  }
}

export function LayerView({ layer, frame, rotation, selected, image, scale = 1, onPointerDown }: LayerViewProps) {
  const interactive = !layer.locked;
  return (
    <div
      data-layer-id={layer.id}
      data-selected={selected || undefined}
      data-locked={layer.locked || undefined}
      onPointerDown={interactive ? onPointerDown : undefined}
      style={{
        ...frameStyle(frame, rotation, layer),
        // `2 / scale` (revue Lot 2, Important 3) : voir le commentaire en tête de fichier — sans
        // cette compensation, le contour de sélection s'amenuise avec l'échelle du canevas jusqu'à
        // devenir un liseré à peine visible pour les formats étroits (`story`).
        outline: selected ? `${2 / scale}px solid #2563eb` : layer.locked ? "1px dashed #9ca3af" : undefined,
        outlineOffset: selected ? 1 / scale : undefined,
        cursor: interactive ? "move" : "not-allowed",
        // Un calque verrouillé « ne répond ni au clic ni au glisser » (spec §2) — appliqué au
        // niveau CSS, pas seulement en omettant le gestionnaire React, pour qu'aucun enfant ne
        // puisse non plus intercepter un événement pointeur qui lui serait destiné.
        pointerEvents: interactive ? undefined : "none",
        overflow: layer.type === "shape" ? undefined : "hidden",
      }}
    >
      <LayerContent layer={layer} image={image} />
    </div>
  );
}
