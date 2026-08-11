"use client";

import type { Dispatch } from "react";
import { Square, Circle, Minus, Triangle, Star, Hexagon, ArrowRight, MessageCircle, QrCode } from "lucide-react";
import { addLayer, type EditorAction } from "@/lib/studio/editor-state";
import { shapeTilesFor, buildShapeLayer, recentTilesFor, type ShapeTile, type ShapeTileRow } from "@/lib/studio/shape-gallery";
import type { ShapeKind } from "@/lib/studio/scene";
import type { TemplateContext } from "@/lib/studio/tokens";

// components/studio/panels/elements-panel.tsx — Tâche 4 (U1, spec §3) : le contenu de la catégorie
// « Éléments » du rail. Deux sections (spec §3, tableau : « Utilisés récemment », then « Formes »),
// AUCUNE action primaire (le tableau spec §3 liste « — » pour cette catégorie, contrairement à
// Modèles/Texte/Images) : la seule façon d'insérer ici est de cliquer une tuile.
//
// Contrainte centrale de la tâche : ce panneau n'affiche QUE ce que lib/studio/scene.ts accepte —
// voir shape-gallery.ts pour SHAPE_TILES et le garde-fou de complétude testé dans
// tests/studio-shape-gallery.test.ts. AUCUNE tuile désactivée pour une forme que le schéma refuse.
// U3 Tâche 3 : le schéma en accepte désormais HUIT (plus le QR), et il a suffi d'ajouter des entrées
// à SHAPE_TILES — ce composant énumérait déjà ce tableau. Seule l'ICÔNE était codée par TYPE de tuile
// et non par forme ; voir SHAPE_ICON plus bas.
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

// U3 Tâche 3 — UNE ICÔNE PAR FORME, et le typeur l'exige.
//
// L'icône était choisie par le TYPE de tuile (`shape` | `qr`). Avec une seule forme au schéma, ça ne
// se voyait pas ; avec huit, la section « Formes » alignait HUIT CARRÉS IDENTIQUES, distinguables
// seulement en lisant les libellés. Ce n'est pas de la décoration : la galerie est le seul moyen
// d'insérer une forme, et une grille d'icônes identiques annule l'intérêt d'une grille.
//
// `Record<ShapeKind, …>` et non un objet indexé avec repli : c'est le typeur qui refuse alors une
// forme non iconifiée, exactement comme il refuse une forme sans description (`SHAPE_DESCRIPTORS`,
// Tâche 2). Un repli `?? Square` aurait redonné en silence un carré à la prochaine forme — le défaut
// que ce fichier vient de corriger, réintroduit à l'endroit même du correctif.
const SHAPE_ICON: Record<ShapeKind, typeof Square> = {
  rect: Square,
  ellipse: Circle,
  line: Minus,
  triangle: Triangle,
  star: Star,
  hexagon: Hexagon,
  arrow: ArrowRight,
  bubble: MessageCircle,
};

function iconFor(row: ShapeTileRow): typeof Square {
  // `row.shape` est présent si et seulement si `kind === "shape"` (voir ShapeTile) : la tuile QR n'est
  // pas une forme du schéma et garde donc la sienne.
  return row.kind === "shape" && row.shape ? SHAPE_ICON[row.shape] : QrCode;
}

function ShapeTileButton({ row, onClick }: { row: ShapeTileRow; onClick: () => void }) {
  const Icon = iconFor(row);
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
