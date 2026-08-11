"use client";

import type { Layer } from "@/lib/studio/scene";
import { NumberField, type Patch } from "./property-panel";

// components/studio/geometry-strip.tsx — Tâche 6 (U1, spec §6) : les six champs de cadre (X, Y,
// largeur, hauteur, rotation, opacité) extraits de l'ancienne section « Cadre » de property-panel.tsx
// (qui la fermait en dernier, APRÈS Texte/Police/Apparence/Ombre/Contour pour un calque texte — le
// défaut que cette tâche corrige) pour former une bande ÉPINGLÉE, rendue par PropertyPanel HORS de
// son conteneur défilant (voir property-panel.tsx#PropertyPanel, le div `data-testid="property-
// sections"` porte seul `overflow-auto` ; celui-ci n'en porte aucun). Un designer qui vient nudger
// une position n'a donc plus besoin de défiler devant treize autres contrôles pour l'atteindre.
//
// Ne réutilise QUE `NumberField` et le callback `patch`, tous deux déjà existants dans
// property-panel.tsx — aucune primitive de champ n'est recréée ici (consigne de la Tâche 6 : une
// réorganisation, pas une réécriture des contrôles). L'import ci-dessus ferme un cycle avec
// property-panel.tsx (qui importe `GeometryStrip` en retour) : sans danger ici parce que
// `NumberField` est une DÉCLARATION DE FONCTION (hissée à l'évaluation du module, donc déjà liée
// avant que le corps de property-panel.tsx ne s'exécute), jamais une `const` — voir `bun run build`
// dans le rapport de tâche pour la preuve que le graphe se résout bien.
export interface GeometryStripProps {
  layer: Layer;
  patch: Patch;
}

// Conçue avec de la place pour ce qui arrive PLUS TARD, sans le construire maintenant (spec §6) :
//   - U2 ajoutera ici une rangée align/distribute une fois la sélection multiple disponible ;
//   - U5 ajoutera le widget d'ancrage par côté (chaque côté du calque ancré au côté correspondant du
//     canevas, avec une valeur en pixels).
// Les deux rangées ci-dessous (cadre, puis rotation/opacité) laissent structurellement de la place à
// une troisième sans réagencement — mais aucun nœud DOM n'est réservé pour ces deux fonctionnalités :
// ce serait construire par anticipation ce que l'énoncé interdit explicitement pour cette tâche.
export function GeometryStrip({ layer, patch }: GeometryStripProps) {
  return (
    <div className="space-y-2 border-b p-3" data-testid="geometry-strip">
      <div className="grid grid-cols-4 gap-2">
        <NumberField label="X" value={layer.frame.x} dataField="frame.x" onCommit={(v) => patch({ frame: { ...layer.frame, x: v } })} />
        <NumberField label="Y" value={layer.frame.y} dataField="frame.y" onCommit={(v) => patch({ frame: { ...layer.frame, y: v } })} />
        <NumberField
          label="Largeur" value={layer.frame.w} min={1} dataField="frame.w"
          onCommit={(v) => patch({ frame: { ...layer.frame, w: Math.max(1, v) } })}
        />
        <NumberField
          label="Hauteur" value={layer.frame.h} min={1} dataField="frame.h"
          onCommit={(v) => patch({ frame: { ...layer.frame, h: Math.max(1, v) } })}
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <NumberField label="Rotation (°)" value={layer.rotation ?? 0} dataField="rotation" onCommit={(v) => patch({ rotation: v || undefined })} />
        <NumberField
          label="Opacité (0–1)" value={layer.opacity ?? 1} step={0.05} min={0} max={1} dataField="opacity"
          onCommit={(v) => patch({ opacity: Math.min(1, Math.max(0, v)) })}
        />
      </div>
    </div>
  );
}
