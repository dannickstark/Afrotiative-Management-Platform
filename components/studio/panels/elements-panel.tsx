"use client";

import type { Dispatch } from "react";
import { Square, QrCode } from "lucide-react";
import { addLayer, type EditorAction } from "@/lib/studio/editor-state";
import { SHAPE_TILES, buildShapeLayer, recentTilesFor, type ShapeTile } from "@/lib/studio/shape-gallery";

// components/studio/panels/elements-panel.tsx — Tâche 4 (U1, spec §3) : le contenu de la catégorie
// « Éléments » du rail. Deux sections (spec §3, tableau : « Utilisés récemment », then « Formes »),
// AUCUNE action primaire (le tableau spec §3 liste « — » pour cette catégorie, contrairement à
// Modèles/Texte/Images) : la seule façon d'insérer ici est de cliquer une tuile.
//
// Contrainte centrale de la tâche : ce panneau n'affiche QUE ce que lib/studio/scene.ts accepte
// AUJOURD'HUI (rectangle + QR) — voir shape-gallery.ts pour SHAPE_TILES et le garde-fou de
// complétude testé dans tests/studio-shape-gallery.test.ts. AUCUNE tuile désactivée pour
// ellipse/ligne/polygone : quand U3 étendra le schéma, il lui suffira d'ajouter des entrées à
// SHAPE_TILES — ce composant énumère déjà ce tableau sans rien coder en dur par forme.
//
// Toute tuile — récente ou dans « Formes » — dispatch EXACTEMENT le même chemin qu'un clic sur une
// ligne de Texte dynamique (Tâche 3, texte-panel.tsx) : `addLayer(tile.kind, buildShapeLayer(...))`,
// où `tile.kind` ("shape" | "qr") est déjà un `Layer["type"]` valide — le calque construit remplace
// le calque générique que createLayer() aurait produit (editor-state.ts), plutôt qu'un chemin
// d'insertion parallèle. `addLayer` sélectionne lui-même le calque inséré (editor-state.ts:221-225).
export interface ElementsPanelProps {
  canvas: { width: number; height: number };
  recentShapes: readonly string[];
  dispatch: Dispatch<EditorAction>;
  // Tâche 4 : enregistre la tuile cliquée dans EditorPrefs.recentShapes (Tâche 4, editor-prefs.ts).
  // Ce panneau ne connaît pas la forme de EditorPrefs ni comment elle est persistée (localStorage,
  // hooks/use-editor-prefs.ts) — il se contente de signaler QUELLE tuile vient d'être insérée ;
  // c'est editor-shell.tsx (le seul endroit qui détient `setPrefs`) qui décide comment combiner ça
  // avec shape-gallery.ts#withRecentShape.
  onShapeInserted: (tileId: string) => void;
}

const TILE_ICON: Record<ShapeTile["kind"], typeof Square> = { shape: Square, qr: QrCode };

function ShapeTileButton({ tile, onClick }: { tile: ShapeTile; onClick: () => void }) {
  const Icon = TILE_ICON[tile.kind];
  return (
    <button
      type="button"
      data-tile={tile.id}
      onClick={onClick}
      className="flex flex-col items-center gap-1 rounded-md border px-2 py-3 text-xs hover:bg-accent"
    >
      <Icon aria-hidden className="size-5" />
      <span className="truncate">{tile.label}</span>
    </button>
  );
}

export function ElementsPanel({ canvas, recentShapes, dispatch, onShapeInserted }: ElementsPanelProps) {
  const recentTiles = recentTilesFor(recentShapes);

  function insert(tile: ShapeTile) {
    dispatch(addLayer(tile.kind, buildShapeLayer(tile, canvas)));
    onShapeInserted(tile.id);
  }

  return (
    <div className="flex flex-col gap-4" data-testid="elements-panel">
      {recentTiles.length > 0 && (
        <section className="space-y-1.5">
          <h3 className="text-xs font-semibold text-muted-foreground uppercase">Utilisés récemment</h3>
          <div className="grid grid-cols-3 gap-1.5" data-testid="elements-recent">
            {recentTiles.map((tile) => (
              <ShapeTileButton key={`recent-${tile.id}`} tile={tile} onClick={() => insert(tile)} />
            ))}
          </div>
        </section>
      )}

      <section className="space-y-1.5">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase">Formes</h3>
        <div className="grid grid-cols-3 gap-1.5" data-testid="elements-shapes">
          {SHAPE_TILES.map((tile) => (
            <ShapeTileButton key={tile.id} tile={tile} onClick={() => insert(tile)} />
          ))}
        </div>
      </section>
    </div>
  );
}
