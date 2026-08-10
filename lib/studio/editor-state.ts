// lib/studio/editor-state.ts — réducteur PUR de l'état de l'éditeur (V2 Tâche 4).
//
// Aucune I/O, aucun DOM, aucun React : ce module ne fait que transformer un état en un autre état,
// de façon synchrone et déterministe. C'est le socle sur lequel s'appuie tout le reste de
// l'éditeur (canevas, panneau de calques, panneau de propriétés — tâches suivantes du Lot 2).
//
// Invariant central (spec §3) : CHAQUE scène produite passe par parseScene() avant d'entrer dans
// l'état. Si une action produirait une scène invalide, le réducteur renvoie l'état PRÉCÉDENT
// inchangé — la même référence — plutôt qu'un état neuf : l'éditeur ne détient donc jamais une
// scène invalide, même de façon transitoire.
//
// Verrouillage (`layer.locked`). Ignoré par moveLayer / resizeLayer / rotateLayer / deleteLayer —
// les quatre actions qui altèrent la position, la taille, l'angle ou l'existence d'un calque.
// setLayerProp, toggleVisible et reorderLayer NE sont PAS bloqués par le verrou : un calque
// verrouillé protège contre une manipulation accidentelle à la souris sur le canevas (spec §2 :
// « un calque locked ne répond ni au clic ni au glisser »), pas contre une édition explicite via
// le panneau de propriétés. Quant à toggleLocked lui-même, il n'est JAMAIS bloqué par le verrou
// qu'il bascule — sinon un calque verrouillé le resterait pour toujours, un verrou sans sortie.
//
// Historique. select/undo/redo ne s'empilent pas eux-mêmes : ce ne sont pas des modifications de
// la scène. `past` est plafonné à MAX_HISTORY entrées (les plus anciennes tombent en premier
// lorsqu'il déborde) ; `future` est vidé à chaque nouvelle modification (le motif undo/redo
// classique) et ne peut structurellement jamais dépasser MAX_HISTORY lui-même, puisqu'il ne se
// remplit qu'en dépilant `past`, déjà plafonné.
import { parseScene, SceneError, type Scene, type Layer, type Frame } from "./scene";

const MAX_HISTORY = 50;

export interface EditorState {
  scene: Scene;
  selectedId: string | null;
  past: Scene[];
  future: Scene[];
}

export function initEditorState(scene: Scene): EditorState {
  return { scene, selectedId: null, past: [], future: [] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Actions

export type EditorAction =
  | { type: "select"; id: string | null }
  | { type: "moveLayer"; id: string; dx: number; dy: number }
  | { type: "resizeLayer"; id: string; frame: Frame }
  | { type: "rotateLayer"; id: string; deg: number }
  | { type: "setLayerProp"; id: string; patch: LayerPatch }
  | { type: "addLayer"; layerType: Layer["type"]; layer?: Layer }
  | { type: "deleteLayer"; id: string }
  | { type: "reorderLayer"; id: string; toIndex: number }
  | { type: "toggleVisible"; id: string }
  | { type: "toggleLocked"; id: string }
  | { type: "undo" }
  | { type: "redo" };

// Correctif de propriétés arbitraire, fusionné superficiellement dans le calque puis validé par
// parseScene — le vrai garde-fou de type (voir « garde-fou scène invalide » dans les tests). Un
// type plus étroit se heurterait à l'union discriminée de Layer (un Partial<Layer> n'autorise pas
// de mélanger des champs propres à des variantes différentes) pour un gain de sûreté illusoire,
// puisque parseScene revalide de toute façon tout correctif avant qu'il n'entre dans l'état.
export type LayerPatch = Record<string, unknown>;

export function select(id: string | null): EditorAction {
  return { type: "select", id };
}
export function moveLayer(id: string, dx: number, dy: number): EditorAction {
  return { type: "moveLayer", id, dx, dy };
}
export function resizeLayer(id: string, frame: Frame): EditorAction {
  return { type: "resizeLayer", id, frame };
}
export function rotateLayer(id: string, deg: number): EditorAction {
  return { type: "rotateLayer", id, deg };
}
export function setLayerProp(id: string, patch: LayerPatch): EditorAction {
  return { type: "setLayerProp", id, patch };
}
// `layer` (Tâche 3, U1 spec §4) : quand fourni, ce calque DÉJÀ CONSTRUIT (ex.
// dynamic-text.ts:buildDynamicTextLayer, un TextLayer déjà lié à un jeton et stylé depuis un
// préréglage) remplace le calque générique que createLayer() aurait produit — plutôt que d'ajouter
// une action parallèle « insertLayer » qui dupliquerait la logique de commit/sélection ci-dessous.
// Omis (la totalité des appels existants, layer-panel.tsx), le comportement générique d'avant est
// inchangé bit à bit.
export function addLayer(type: Layer["type"], layer?: Layer): EditorAction {
  return { type: "addLayer", layerType: type, layer };
}
export function deleteLayer(id: string): EditorAction {
  return { type: "deleteLayer", id };
}
export function reorderLayer(id: string, toIndex: number): EditorAction {
  return { type: "reorderLayer", id, toIndex };
}
export function toggleVisible(id: string): EditorAction {
  return { type: "toggleVisible", id };
}
export function toggleLocked(id: string): EditorAction {
  return { type: "toggleLocked", id };
}
export function undo(): EditorAction {
  return { type: "undo" };
}
export function redo(): EditorAction {
  return { type: "redo" };
}

// ─────────────────────────────────────────────────────────────────────────────
// Aides internes — toutes renvoient des structures NEUVES, jamais de mutation en place.

function layerIndex(scene: Scene, id: string): number {
  return scene.layers.findIndex((l) => l.id === id);
}

function replaceAt<T>(arr: readonly T[], index: number, value: T): T[] {
  const copy = arr.slice();
  copy[index] = value;
  return copy;
}

function pushHistory(past: readonly Scene[], scene: Scene): Scene[] {
  const next = [...past, scene];
  return next.length > MAX_HISTORY ? next.slice(next.length - MAX_HISTORY) : next;
}

// Tente de faire entrer `candidate` dans l'état : le valide avec parseScene, et n'empile
// l'historique QUE si la validation réussit. En cas d'échec, renvoie `state` — LA MÊME
// RÉFÉRENCE — inchangé.
function commit(state: EditorState, candidate: Scene): EditorState {
  let validated: Scene;
  try {
    validated = parseScene(candidate);
  } catch (err) {
    if (err instanceof SceneError) return state;
    throw err;
  }
  return {
    scene: validated,
    selectedId: state.selectedId,
    past: pushHistory(state.past, state.scene),
    future: [],
  };
}

// Facteur commun aux quatre actions bloquées par le verrou (move/resize/rotate/delete) : calque
// introuvable OU verrouillé -> état inchangé, sans même tenter de construire une scène candidate.
function updateUnlockedLayer(
  state: EditorState,
  id: string,
  updater: (layer: Layer, layers: readonly Layer[], index: number) => Layer[],
): EditorState {
  const index = layerIndex(state.scene, id);
  if (index === -1) return state;
  const layer = state.scene.layers[index];
  if (layer.locked) return state;
  return commit(state, { ...state.scene, layers: updater(layer, state.scene.layers, index) });
}

function createLayer(type: Layer["type"]): Layer {
  const id = crypto.randomUUID();
  switch (type) {
    case "text":
      return {
        id, name: "Nouveau texte", visible: true, locked: false,
        frame: { x: 40, y: 40, w: 300, h: 100 },
        type: "text", content: "Nouveau texte",
        font: { family: "Noto Sans", size: 32, weight: 400 },
        color: "#FFFFFF", align: "left", vAlign: "top", lineHeight: 1.2,
      };
    case "image":
      return {
        id, name: "Nouvelle image", visible: true, locked: false,
        frame: { x: 40, y: 40, w: 300, h: 200 },
        type: "image", source: { kind: "slot", slot: "image" }, fit: "cover",
      };
    case "shape":
      return {
        id, name: "Nouvelle forme", visible: true, locked: false,
        frame: { x: 40, y: 40, w: 200, h: 200 },
        type: "shape", shape: "rect", fill: "#CCCCCC",
      };
    case "qr":
      return {
        id, name: "Nouveau QR code", visible: true, locked: false,
        frame: { x: 40, y: 40, w: 150, h: 150 },
        type: "qr", slot: "qr", fg: "#000000", bg: "#FFFFFF", margin: 4,
      };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case "select":
      return action.id === state.selectedId ? state : { ...state, selectedId: action.id };

    case "moveLayer":
      return updateUnlockedLayer(state, action.id, (layer, layers, index) =>
        replaceAt(layers, index, {
          ...layer,
          frame: { ...layer.frame, x: layer.frame.x + action.dx, y: layer.frame.y + action.dy },
        }));

    case "resizeLayer":
      return updateUnlockedLayer(state, action.id, (layer, layers, index) =>
        replaceAt(layers, index, { ...layer, frame: { ...action.frame } }));

    case "rotateLayer":
      return updateUnlockedLayer(state, action.id, (layer, layers, index) =>
        replaceAt(layers, index, { ...layer, rotation: action.deg }));

    case "setLayerProp": {
      const index = layerIndex(state.scene, action.id);
      if (index === -1) return state;
      const layer = state.scene.layers[index];
      // Fusion superficielle puis cast : voir le commentaire sur LayerPatch plus haut — parseScene
      // (dans commit()) est le vrai garde-fou, ce cast ne fait qu'exprimer l'intention.
      const updated = { ...layer, ...action.patch } as unknown as Layer;
      return commit(state, { ...state.scene, layers: replaceAt(state.scene.layers, index, updated) });
    }

    case "addLayer": {
      const layer = action.layer ?? createLayer(action.layerType);
      const next = commit(state, { ...state.scene, layers: [...state.scene.layers, layer] });
      return next === state ? state : { ...next, selectedId: layer.id };
    }

    case "deleteLayer": {
      const index = layerIndex(state.scene, action.id);
      if (index === -1) return state;
      if (state.scene.layers[index].locked) return state;
      const layers = state.scene.layers.filter((l) => l.id !== action.id);
      const next = commit(state, { ...state.scene, layers });
      if (next === state) return state;
      return state.selectedId === action.id ? { ...next, selectedId: null } : next;
    }

    case "reorderLayer": {
      const index = layerIndex(state.scene, action.id);
      if (index === -1) return state;
      const bounded = Math.max(0, Math.min(action.toIndex, state.scene.layers.length - 1));
      if (bounded === index) return state;
      const layers = state.scene.layers.slice();
      const [layer] = layers.splice(index, 1);
      layers.splice(bounded, 0, layer);
      return commit(state, { ...state.scene, layers });
    }

    case "toggleVisible": {
      const index = layerIndex(state.scene, action.id);
      if (index === -1) return state;
      const layer = state.scene.layers[index];
      return commit(state, {
        ...state.scene,
        layers: replaceAt(state.scene.layers, index, { ...layer, visible: !layer.visible }),
      });
    }

    case "toggleLocked": {
      const index = layerIndex(state.scene, action.id);
      if (index === -1) return state;
      const layer = state.scene.layers[index];
      // PAS de garde de verrou ici, volontairement : voir le commentaire d'en-tête du module.
      return commit(state, {
        ...state.scene,
        layers: replaceAt(state.scene.layers, index, { ...layer, locked: !layer.locked }),
      });
    }

    case "undo": {
      if (state.past.length === 0) return state;
      const scene = state.past[state.past.length - 1];
      return {
        scene,
        selectedId: state.selectedId,
        past: state.past.slice(0, -1),
        future: [state.scene, ...state.future],
      };
    }

    case "redo": {
      if (state.future.length === 0) return state;
      const [scene, ...future] = state.future;
      return {
        scene,
        selectedId: state.selectedId,
        past: pushHistory(state.past, state.scene),
        future,
      };
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Conversion de coordonnées. Le canevas est rendu à l'échelle (`transform: scale(k)`) sur un
// conteneur aux dimensions réelles du gabarit (spec §2) ; toutes les coordonnées MANIPULÉES par
// l'éditeur restent en pixels du gabarit — l'échelle n'existe que pour l'affichage et la
// conversion des événements souris. Un glisser de N px écran doit donc déplacer le calque de
// N / k px gabarit.
export interface Point {
  x: number;
  y: number;
}

// Écran -> gabarit (ex. delta de souris pendant un glisser).
export function toCanvasCoords(clientDelta: Point, scale: number): Point {
  return { x: clientDelta.x / scale, y: clientDelta.y / scale };
}

// Gabarit -> écran (inverse ; ex. positionner une poignée de redimensionnement à l'écran).
export function toScreenCoords(canvasDelta: Point, scale: number): Point {
  return { x: canvasDelta.x * scale, y: canvasDelta.y * scale };
}
