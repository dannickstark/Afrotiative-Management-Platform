"use client";

import { useEffect, useState, type Dispatch } from "react";
import { Eye, EyeOff, Lock, Unlock, Trash2, ChevronUp, ChevronDown, Type, Image as ImageIcon, Square, QrCode } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Layer, Scene } from "@/lib/studio/scene";
import {
  type EditorAction, select, toggleVisible, toggleLocked, deleteLayer, reorderLayer, addLayer, setLayerProp,
} from "@/lib/studio/editor-state";

export interface LayerPanelProps {
  scene: Scene;
  selectedId: string | null;
  dispatch: Dispatch<EditorAction>;
}

const TYPE_LABEL: Record<Layer["type"], string> = {
  text: "Texte", image: "Image", shape: "Forme", qr: "QR code",
};
const TYPE_ICON: Record<Layer["type"], typeof Type> = {
  text: Type, image: ImageIcon, shape: Square, qr: QrCode,
};
const ADD_TYPES: Layer["type"][] = ["text", "image", "shape", "qr"];

// `scene.layers` peint du bas vers le haut (index 0 = arrière-plan, spec/scene.ts) ; le panneau
// affiche l'inverse, calque du DESSUS en premier, parce que c'est ce que l'utilisateur s'attend à
// voir dans une liste de calques (Photoshop, Figma, etc.). Cette fonction est LA source de vérité
// de cet inversement — canvas et tests s'appuient dessus plutôt que de réimplémenter un .reverse().
export function layersTopFirst(layers: readonly Layer[]): Layer[] {
  return [...layers].reverse();
}

// Le `toIndex` (dans scene.layers, PAS dans l'ordre affiché du panneau) à viser pour faire
// monter/descendre un calque d'UN cran dans le PANNEAU. Le panneau étant l'inverse de
// scene.layers : monter dans le panneau (= peindre plus tard = plus au-dessus) veut dire
// AUGMENTER l'index dans scene.layers ; descendre veut dire le DIMINUER — l'exact opposé de
// l'intuition qu'on aurait en lisant seulement l'ordre panneau. reorderLayer (Tâche 4) borne déjà
// le résultat à [0, length-1], donc pas besoin de clamp ici.
export function nextIndexForMove(currentIndex: number, direction: "up" | "down"): number {
  return direction === "up" ? currentIndex + 1 : currentIndex - 1;
}

function TypeIcon({ layer }: { layer: Layer }) {
  const Icon = TYPE_ICON[layer.type];
  return <Icon className="size-3.5" />;
}

// Tamponne la frappe localement et ne committe qu'à la perte de focus (ou Entrée) — pas à chaque
// caractère. `setLayerProp` (Tâche 4) empile une entrée d'historique à CHAQUE appel réussi ; sans
// ce tampon, taper un nom de dix lettres empilerait dix annulations pour un seul renommage, à
// rebours de l'esprit « un geste = une entrée » déjà appliqué au glisser (Tâche 6). Se resynchronise
// sur `layer.name` quand il change de source externe (annuler/rétablir, sélection d'un autre
// calque) tant que l'utilisateur n'est pas en train d'y taper.
function RenameField({ layer, dispatch }: { layer: Layer; dispatch: Dispatch<EditorAction> }) {
  const [value, setValue] = useState(layer.name);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!editing) setValue(layer.name);
  }, [layer.id, layer.name, editing]);

  function commit() {
    setEditing(false);
    if (value !== layer.name) dispatch(setLayerProp(layer.id, { name: value }));
  }

  return (
    <Input
      data-action="rename"
      data-layer-id={layer.id}
      value={value}
      onFocus={() => { setEditing(true); dispatch(select(layer.id)); }}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        else if (e.key === "Escape") { setValue(layer.name); setEditing(false); e.currentTarget.blur(); }
      }}
      className="h-6 min-w-0 flex-1 px-1.5 text-xs"
    />
  );
}

export function LayerPanel({ scene, selectedId, dispatch }: LayerPanelProps) {
  const entries = layersTopFirst(scene.layers).map((layer) => ({
    layer,
    index: scene.layers.findIndex((l) => l.id === layer.id),
  }));
  const lastIndex = scene.layers.length - 1;

  return (
    <div className="flex flex-col gap-2" data-testid="layer-panel">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">Calques</span>
      </div>

      <div className="flex flex-wrap gap-1">
        {ADD_TYPES.map((type) => {
          const Icon = TYPE_ICON[type];
          return (
            <Button
              key={type}
              type="button"
              variant="outline"
              size="sm"
              data-action="add"
              data-add-type={type}
              onClick={() => dispatch(addLayer(type))}
            >
              <Icon />
              {TYPE_LABEL[type]}
            </Button>
          );
        })}
      </div>

      <ul className="flex flex-col gap-1">
        {entries.map(({ layer, index }) => {
          const atTop = index === lastIndex;
          const atBottom = index === 0;
          return (
            <li
              key={layer.id}
              data-layer-row-id={layer.id}
              className="flex items-center gap-1 rounded-lg border border-transparent px-1.5 py-1 aria-selected:border-border aria-selected:bg-muted"
              aria-selected={layer.id === selectedId}
              draggable
              onDragStart={(e) => e.dataTransfer.setData("text/layer-id", layer.id)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const draggedId = e.dataTransfer.getData("text/layer-id");
                if (!draggedId || draggedId === layer.id) return;
                dispatch(reorderLayer(draggedId, index));
              }}
            >
              <Button
                type="button" variant="ghost" size="icon-sm"
                data-action="toggle-visible" data-layer-id={layer.id}
                aria-pressed={layer.visible}
                aria-label={layer.visible ? "Masquer le calque" : "Afficher le calque"}
                onClick={() => dispatch(toggleVisible(layer.id))}
              >
                {layer.visible ? <Eye /> : <EyeOff />}
              </Button>

              <Button
                type="button" variant="ghost" size="icon-sm"
                data-action="toggle-locked" data-layer-id={layer.id}
                aria-pressed={layer.locked}
                aria-label={layer.locked ? "Déverrouiller le calque" : "Verrouiller le calque"}
                onClick={() => dispatch(toggleLocked(layer.id))}
              >
                {layer.locked ? <Lock /> : <Unlock />}
              </Button>

              <span
                className="text-muted-foreground"
                title={TYPE_LABEL[layer.type]}
                aria-hidden="true"
              >
                <TypeIcon layer={layer} />
              </span>

              <RenameField layer={layer} dispatch={dispatch} />

              <Button
                type="button" variant="ghost" size="icon-sm"
                data-action="move-up" data-layer-id={layer.id}
                aria-label="Monter le calque"
                disabled={atTop}
                onClick={() => dispatch(reorderLayer(layer.id, nextIndexForMove(index, "up")))}
              >
                <ChevronUp />
              </Button>
              <Button
                type="button" variant="ghost" size="icon-sm"
                data-action="move-down" data-layer-id={layer.id}
                aria-label="Descendre le calque"
                disabled={atBottom}
                onClick={() => dispatch(reorderLayer(layer.id, nextIndexForMove(index, "down")))}
              >
                <ChevronDown />
              </Button>

              <Button
                type="button" variant="ghost" size="icon-sm"
                data-action="delete" data-layer-id={layer.id}
                aria-label="Supprimer le calque"
                disabled={layer.locked}
                onClick={() => dispatch(deleteLayer(layer.id))}
              >
                <Trash2 />
              </Button>
            </li>
          );
        })}
      </ul>

      {entries.length === 0 && (
        <p className="px-1.5 py-4 text-center text-xs text-muted-foreground">
          Aucun calque — ajoutez-en un ci-dessus.
        </p>
      )}
    </div>
  );
}
