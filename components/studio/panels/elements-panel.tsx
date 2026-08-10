"use client";

import type { Dispatch } from "react";
import { Square, QrCode } from "lucide-react";
import { addLayer, type EditorAction } from "@/lib/studio/editor-state";
import { shapeTilesFor, buildShapeLayer, recentTilesFor, type ShapeTile, type ShapeTileRow } from "@/lib/studio/shape-gallery";
import type { TemplateContext } from "@/lib/studio/tokens";

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
// Revue Tâche 4, Important 2 — corrigé : `context` (déjà porté par editor-shell.tsx, déjà threadé
// dans <TextePanel>) permet à shape-gallery.ts#shapeTilesFor de griser la tuile QR quand son jeton
// d'emplacement (article.url) est illégal ici — MÊME discipline que texte-panel.tsx pour les lignes
// de Texte dynamique : un `<button disabled>` HTML natif (aucun clic ne peut en sortir un événement,
// pas seulement un style visuel) portant sa raison française en `title`, une tuile grisée restant
// VISIBLE plutôt que disparaissant purement et simplement.
//
// Toute tuile DISPONIBLE — récente ou dans « Formes » — dispatch EXACTEMENT le même chemin qu'un
// clic sur une ligne de Texte dynamique (Tâche 3, texte-panel.tsx) :
// `addLayer(tile.kind, buildShapeLayer(...))`, où `tile.kind` ("shape" | "qr") est déjà un
// `Layer["type"]` valide — le calque construit remplace le calque générique que createLayer() aurait
// produit (editor-state.ts), plutôt qu'un chemin d'insertion parallèle. `addLayer` sélectionne
// lui-même le calque inséré (editor-state.ts:221-225).
export interface ElementsPanelProps {
  context: TemplateContext;
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

// Revue Tâche 4, Important 3 — EXPORTÉE : ce que le clic sur une tuile fait, TOUT ENTIER (dispatch
// l'insertion ET enregistre la tuile comme récemment utilisée) — même idiome que
// components/studio/layer-panel.tsx#nextIndexForMove, la fonction pure derrière un bouton, composée
// dans son test avec le VRAI réducteur (editorReducer). Ce dépôt n'a ni React Testing Library ni
// jsdom pour `bun test` (voir tests/diffusion-settings-ui.test.ts) : aucun clic ne peut donc être
// simulé sur le DOM. `onClick` ci-dessous n'est qu'un enrobage trivial de cet appel — la tester
// directement teste donc exactement ce qu'un clic déclenche, dispatch et onShapeInserted ENSEMBLE,
// pas seulement l'un des deux en isolation.
export function insertShapeTile(
  row: ShapeTileRow,
  canvas: { width: number; height: number },
  context: TemplateContext,
  dispatch: Dispatch<EditorAction>,
  onShapeInserted: (tileId: string) => void,
): void {
  dispatch(addLayer(row.kind, buildShapeLayer(row, canvas, context)));
  onShapeInserted(row.id);
}

const TILE_ICON: Record<ShapeTile["kind"], typeof Square> = { shape: Square, qr: QrCode };

function ShapeTileButton({ row, onClick }: { row: ShapeTileRow; onClick: () => void }) {
  const Icon = TILE_ICON[row.kind];
  return (
    <button
      type="button"
      data-tile={row.id}
      data-available={row.available}
      disabled={!row.available}
      title={row.reason}
      onClick={onClick}
      className="flex flex-col items-center gap-1 rounded-md border px-2 py-3 text-xs hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
    >
      <Icon aria-hidden className="size-5" />
      <span className="truncate">{row.label}</span>
    </button>
  );
}

export function ElementsPanel({ context, canvas, recentShapes, dispatch, onShapeInserted }: ElementsPanelProps) {
  const rows = shapeTilesFor(context);
  const recentTiles = recentTilesFor(rows, recentShapes);

  function insert(row: ShapeTileRow) {
    insertShapeTile(row, canvas, context, dispatch, onShapeInserted);
  }

  return (
    <div className="flex flex-col gap-4" data-testid="elements-panel">
      {recentTiles.length > 0 && (
        <section className="space-y-1.5">
          <h3 className="text-xs font-semibold text-muted-foreground uppercase">Utilisés récemment</h3>
          <div className="grid grid-cols-3 gap-1.5" data-testid="elements-recent">
            {recentTiles.map((row) => (
              <ShapeTileButton key={`recent-${row.id}`} row={row} onClick={() => insert(row)} />
            ))}
          </div>
        </section>
      )}

      <section className="space-y-1.5">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase">Formes</h3>
        <div className="grid grid-cols-3 gap-1.5" data-testid="elements-shapes">
          {rows.map((row) => (
            <ShapeTileButton key={row.id} row={row} onClick={() => insert(row)} />
          ))}
        </div>
      </section>
    </div>
  );
}
