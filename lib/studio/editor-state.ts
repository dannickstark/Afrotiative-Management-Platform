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
// les quatre actions qui altèrent la position, la taille, l'angle ou l'existence d'un calque — et
// par setFrames (Tâche 4, U2), qui saute LIGNE À LIGNE les calques verrouillés de son lot au lieu de
// refuser le lot entier : aligner une sélection dont un calque est verrouillé aligne bien les autres.
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
//
// Sélection (Tâche 3, U2, spec §3). `selectedId: string | null` est devenu `selectedIds: string[]`.
// Trois décisions, chacune vérifiée par tests/studio-editor-state.test.ts :
//
//  1. UN TABLEAU, PAS UN `Set` : `selectedIds` porte l'ORDRE d'insertion (l'ordre dans lequel
//     l'utilisateur a Maj-cliqué), que la Tâche 4 (aligner/répartir) exploitera pour désigner une
//     référence d'alignement. Le réducteur DÉDOUBLONNE (jamais deux fois le même id) mais ne trie
//     jamais et ne reprojette jamais la sélection sur l'ordre de peinture de `scene.layers`.
//
//  2. LA SÉLECTION N'EST PAS VALIDÉE CONTRE LA SCÈNE. Un id absent de `scene.layers` est accepté tel
//     quel : tous les lecteurs font déjà un `.find()` qui rend `null` (voir property-panel.tsx, dont
//     un test couvre explicitement « l'id sélectionné n'existe plus »). Filtrer ici transformerait
//     `select` en action dépendante de la scène, sans fermer aucun défaut réel.
//
//  3. L'HISTORIQUE PORTE LA SÉLECTION (`HistoryEntry`, ci-dessous), et c'est un CHANGEMENT de
//     comportement, pas une simple migration de type. Avant cette tâche, undo/redo reportait la
//     sélection COURANTE (`selectedId: state.selectedId`) : annuler un ajout de calque laissait donc
//     `selectedId` pointer sur un calque qui venait de disparaître de la scène restaurée. Le plan U2
//     demande « annuler/rétablir restaure la sélection qui existait » — ce qui n'a de sens que si
//     chaque entrée d'historique se souvient de la sélection d'alors. C'est ce que fait `commit()`.
//     `select`/`toggleSelection` continuent de NE PAS s'empiler : changer de sélection n'est pas une
//     modification annulable, seulement une modification de la scène l'est.
import { parseScene, SceneError, type Scene, type Layer, type Frame } from "./scene";
// Chantier D, Tâche 5 — `FormatKey` (la clé externe de `scene.formatOverrides`, voir Tâche 1) vient
// de formats.ts, la SEULE source de vérité des clés de format (`FORMAT_PRESETS`) : la réutiliser ici
// plutôt que d'accepter une `string` nue évite qu'un appelant écrive `setFrameOverride("storry", …)`
// sans que le compilateur ne le voie.
import type { FormatKey } from "./formats";
// Tâche 4 (U2) : `FrameChange` et `sameFrame` viennent du module d'alignement — une FEUILLE pure
// (aucun import de valeur, voir son en-tête), donc l'importer ici n'ajoute rien au graphe d'exécution
// des composants client. Les réutiliser plutôt que de redéclarer une paire {id, frame} et une
// comparaison de cadres évite d'avoir deux définitions à garder d'accord.
import { sameFrame, type FrameChange } from "./align";

const MAX_HISTORY = 50;

/** Une entrée d'historique : la scène ET la sélection qui existait avec elle (voir le point 3 de
 * l'en-tête de module). `scene` est toujours stockée par RÉFÉRENCE, jamais recopiée. */
export interface HistoryEntry {
  scene: Scene;
  selectedIds: string[];
}

export interface EditorState {
  scene: Scene;
  selectedIds: string[];
  past: HistoryEntry[];
  future: HistoryEntry[];
}

export function initEditorState(scene: Scene): EditorState {
  return { scene, selectedIds: [], past: [], future: [] };
}

/**
 * L'id sélectionné quand il y en a EXACTEMENT un, sinon `null` — l'aide dérivée que réclame le plan
 * (« expose a derived helper for the common single-selection case ») pour les consommateurs qui
 * n'ont de sens QUE sur un calque unique : les poignées du canevas (elles manipulent UN cadre), les
 * sections par type du panneau de propriétés, le sélecteur d'asset du panneau Images.
 *
 * `null` pour une sélection MULTIPLE, pas le premier id : c'est le cœur de l'aide. Un
 * `selectedIds[0] ?? null` afficherait les propriétés du premier calque alors que l'utilisateur en a
 * sélectionné trois — exactement le genre de « ça marche pour une sélection simple, donc ça marche »
 * que cette fonction existe pour rendre impossible.
 */
export function singleSelectedId(selectedIds: readonly string[]): string | null {
  return selectedIds.length === 1 ? selectedIds[0] : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Actions

export type EditorAction =
  // Une SEULE action de remplacement (`select`) et une de bascule (`toggleSelection`) : les quatre
  // constructeurs exportés plus bas (select/selectMany/clearSelection/toggleSelection) ne sont que
  // les gestes de l'interface exprimés dessus.
  | { type: "select"; ids: string[] }
  | { type: "toggleSelection"; id: string }
  | { type: "moveLayer"; id: string; dx: number; dy: number }
  | { type: "resizeLayer"; id: string; frame: Frame }
  // Tâche 4 (U2, spec §4) : UN lot de cadres, UNE entrée d'historique — voir son cas dans le
  // réducteur et le commentaire de `setFrames` plus bas.
  | { type: "setFrames"; changes: readonly FrameChange[] }
  // Chantier D, Tâche 5 — l'échappatoire manuelle par format : écrit
  // `scene.formatOverrides[format][layerId]`, JAMAIS `layer.frame` (voir son cas dans le réducteur
  // et le commentaire de `setFrameOverride`/`frameEditAction` plus bas). C'est l'action que doit
  // recevoir un geste d'édition de cadre exécuté pendant qu'un format NON-accueil est prévisualisé —
  // `resizeLayer`/`setFrames` ci-dessus restent, eux, les actions du format d'accueil.
  | { type: "setFrameOverride"; format: FormatKey; layerId: string; frame: Frame }
  | { type: "rotateLayer"; id: string; deg: number }
  | { type: "setLayerProp"; id: string; patch: LayerPatch }
  // Chantier D, Tâche 4 — le pendant PLURIEL de `setLayerProp` : le MÊME correctif superficiel
  // appliqué à PLUSIEURS calques comme UNE SEULE entrée d'historique, sur le modèle de `setFrames`
  // ci-dessus (un lot = une entrée). Le widget de contraintes de l'inspecteur (ConstraintsField,
  // components/studio/constraints-field.tsx) en a besoin pour son geste « Maj-clic » : appliquer le
  // même ancrage à toute la sélection multiple sans empiler N annulations pour un seul geste.
  | { type: "setLayerProps"; ids: readonly string[]; patch: LayerPatch }
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

// Le geste « clic » : REMPLACE la sélection par ce seul calque (ou la vide pour `null`). Signature
// conservée telle quelle à travers la Tâche 3 — c'est ce qui laisse inchangés tous les appelants du
// cas simple (canvas.tsx au clic, layer-panel.tsx à la prise de focus d'un renommage).
export function select(id: string | null): EditorAction {
  return { type: "select", ids: id === null ? [] : [id] };
}
// Remplace la sélection par CET ensemble, dans cet ordre.
export function selectMany(ids: readonly string[]): EditorAction {
  return { type: "select", ids: [...ids] };
}
// Le geste « Maj-clic » : ajoute l'id s'il est absent, le retire s'il est présent.
export function toggleSelection(id: string): EditorAction {
  return { type: "toggleSelection", id };
}
// Le geste « clic dans le vide ». Nommé plutôt que `select(null)` là où l'intention est « vider »
// et non « sélectionner rien de précis » — les deux produisent la même action.
export function clearSelection(): EditorAction {
  return { type: "select", ids: [] };
}
export function moveLayer(id: string, dx: number, dy: number): EditorAction {
  return { type: "moveLayer", id, dx, dy };
}
export function resizeLayer(id: string, frame: Frame): EditorAction {
  return { type: "resizeLayer", id, frame };
}
// Tâche 4 (U2, spec §4) : « une action appliquant un lot de changements de cadre comme UNE SEULE
// entrée d'annulation, pas une par calque ». C'est l'action des gestes qui déplacent PLUSIEURS calques
// d'un coup — aligner et répartir aujourd'hui (components/studio/geometry-strip.tsx#AlignRow), et ce
// qui manquait à la Tâche 3 pour généraliser Suppr et les flèches à une sélection multiple (voir
// components/studio/canvas.tsx : les brancher sur N actions empilerait N entrées pour un seul geste).
// Ne PAS l'utiliser pour un calque unique déplacé à la souris : `moveLayer`/`resizeLayer` disent
// mieux l'intention et sont déjà couverts.
export function setFrames(changes: readonly FrameChange[]): EditorAction {
  return { type: "setFrames", changes };
}
// Chantier D, Tâche 5 : voir le commentaire de `"setFrameOverride"` sur `EditorAction` ci-dessus —
// écrit une surcharge de cadre pour CE calque, à CE format, sans toucher `layer.frame`.
export function setFrameOverride(format: FormatKey, layerId: string, frame: Frame): EditorAction {
  return { type: "setFrameOverride", format, layerId, frame };
}

// Chantier D, Tâche 5 — LE routeur home-vs-surcharge, l'invariant que réclame le plan (« editing a
// frame at the HOME format still edits layer.frame ; overrides only for non-home formats »).
//
// SEAM CONNU, documenté honnêtement plutôt que masqué (même posture que la Tâche 3 pour sa note) :
// aucune surface d'édition non-accueil n'existe ENCORE dans l'interface. Le mode Montage n'édite
// toujours QUE le format d'accueil (`layer.frame`, via resizeLayer/setFrames) ; le mode Rendu
// (render-mode.tsx) n'affiche les autres formats qu'en APERÇU lecture seule — `sceneForFormat` y
// substitue juste les dimensions de canevas pour le rendu, sans jamais déclencher la moindre action
// du réducteur (voir son commentaire d'en-tête : « aucune affordance adapter/réagencer n'apparaît
// nulle part »). Câbler CE routeur sur un geste réel de canevas exigerait donc d'inventer une surface
// éditable qui n'existe pas — précisément ce que le brief demande de NE PAS fabriquer.
//
// Cette fonction est donc, pour l'instant, la SEULE consommatrice testée de l'invariant — exercée
// directement par tests/studio-editor-state.test.ts.
//
// CE QUE CE ROUTEUR NE DÉCIDE PAS (revue Tâche 5, Important) : le VERROU. `setFrameOverride`
// lui-même n'a délibérément AUCUNE garde de verrou (voir son commentaire) — et ce routeur n'en ajoute
// pas non plus. La raison n'est PAS un oubli : le bon comportement dépend de la NATURE du futur
// appelant, que ce fichier ne connaît pas encore.
//   • Un glisser sur un CANEVAS (mécanisme souris, comme `resizeLayer`/`moveLayer` aujourd'hui) DOIT
//     respecter le verrou — c'est la distinction que documente déjà l'en-tête du module (« un calque
//     locked ne répond ni au clic ni au glisser »).
//   • Un champ NUMÉRIQUE de panneau (édition explicite, comme `setLayerProp`/`toggleVisible`
//     aujourd'hui) ne le doit PAS, par la même distinction.
// Puisqu'on ne sait pas ENCORE laquelle des deux surfaces appellera ce routeur (voire les deux, pour
// des gestes différents), câbler une garde ICI la rendrait FAUSSE pour l'un des deux cas d'usage
// possibles. C'est donc au FUTUR appelant de trancher — un appelant « glisser » enveloppera son geste
// d'une vérification `layer.locked` avant de dispatcher, exactement comme le canevas actuel le fait
// déjà pour `resizeLayer`/`moveLayer` (voir canvas.tsx) ; un appelant « panneau » n'aura rien à
// ajouter, comme `setLayerProp` aujourd'hui.
//
// TODO(next-UI-task) : quand une tâche future rend un format non-accueil éditable (ex. un canevas
// Montage qui suit `view.selectedId` comme render-mode.tsx le fait déjà pour l'aperçu), c'est CETTE
// fonction qu'elle appellera pour décider quelle action dispatcher — elle n'aura pas à être réécrite,
// seulement branchée sur un `onFrameChange` réel, AVEC la garde de verrou tranchée ci-dessus posée
// côté appelant si ce dernier est un geste de glisser sur le canevas.
export function frameEditAction(
  homeFormat: FormatKey,
  activeFormat: FormatKey,
  layerId: string,
  frame: Frame,
): EditorAction {
  return activeFormat === homeFormat
    ? resizeLayer(layerId, frame)
    : setFrameOverride(activeFormat, layerId, frame);
}
export function rotateLayer(id: string, deg: number): EditorAction {
  return { type: "rotateLayer", id, deg };
}
export function setLayerProp(id: string, patch: LayerPatch): EditorAction {
  return { type: "setLayerProp", id, patch };
}
// Chantier D, Tâche 4 : voir le commentaire de `"setLayerProps"` sur `EditorAction` ci-dessus — le
// MÊME correctif appliqué à CHAQUE id de `ids`, en une seule entrée d'historique.
export function setLayerProps(ids: readonly string[], patch: LayerPatch): EditorAction {
  return { type: "setLayerProps", ids: [...ids], patch };
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

function pushHistory(past: readonly HistoryEntry[], entry: HistoryEntry): HistoryEntry[] {
  const next = [...past, entry];
  return next.length > MAX_HISTORY ? next.slice(next.length - MAX_HISTORY) : next;
}

// L'entrée d'historique correspondant à l'état COURANT — la paire (scène, sélection) vers laquelle un
// undo/redo doit pouvoir revenir. Un seul endroit où cette paire se construit, pour que commit/undo/
// redo ne puissent pas diverger sur ce qu'ils empilent.
function snapshot(state: EditorState): HistoryEntry {
  return { scene: state.scene, selectedIds: state.selectedIds };
}

// Dédoublonne en conservant la PREMIÈRE occurrence de chaque id (voir le point 1 de l'en-tête).
function dedupeIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

// Deux sélections sont « la même » si elles ont les mêmes ids DANS LE MÊME ORDRE — l'ordre fait
// partie de la valeur (point 1 de l'en-tête), donc [a, b] et [b, a] sont deux sélections distinctes.
// Sert uniquement à préserver l'identité référentielle de l'état quand rien ne change réellement, ce
// que faisait déjà `action.id === state.selectedId` avant la Tâche 3 (et sur quoi React s'appuie pour
// ne pas re-rendre).
function sameSelection(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
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
    selectedIds: state.selectedIds,
    // L'entrée empilée porte la sélection D'AVANT la modification — c'est CE couple que l'undo
    // restaurera (point 3 de l'en-tête de module).
    past: pushHistory(state.past, snapshot(state)),
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
    case "select": {
      const ids = dedupeIds(action.ids);
      return sameSelection(ids, state.selectedIds) ? state : { ...state, selectedIds: ids };
    }

    case "toggleSelection": {
      // `filter` plutôt qu'un vidage : c'est TOUTE la propriété « retirer un calque de la sélection
      // ne rend pas les autres orphelins ». Ajout EN FIN de tableau, pour que l'ordre reste l'ordre
      // dans lequel l'utilisateur a cliqué.
      const ids = state.selectedIds.includes(action.id)
        ? state.selectedIds.filter((id) => id !== action.id)
        : [...state.selectedIds, action.id];
      return { ...state, selectedIds: ids };
    }

    case "moveLayer":
      return updateUnlockedLayer(state, action.id, (layer, layers, index) =>
        replaceAt(layers, index, {
          ...layer,
          frame: { ...layer.frame, x: layer.frame.x + action.dx, y: layer.frame.y + action.dy },
        }));

    case "resizeLayer":
      return updateUnlockedLayer(state, action.id, (layer, layers, index) =>
        replaceAt(layers, index, { ...layer, frame: { ...action.frame } }));

    // Tâche 4 (U2, spec §4). Trois propriétés, chacune épinglée par un test :
    //
    //  1. UNE SEULE ENTRÉE D'HISTORIQUE pour tout le lot — un seul `commit()`, quel que soit le nombre
    //     de calques touchés. C'est LA raison d'être de cette action : une boucle sur `moveLayer`
    //     empilerait N entrées et forcerait N « annuler » pour défaire un seul geste.
    //  2. TOLÉRANTE ligne à ligne, ATOMIQUE sur la validation. Un id absent ou un calque verrouillé est
    //     simplement SAUTÉ (même garde de verrou que move/resize/rotate/delete) et le reste s'applique ;
    //     mais si la scène ainsi construite est invalide (largeur négative, par exemple), `commit()` la
    //     refuse EN ENTIER et l'état revient inchangé — jamais un lot à moitié appliqué.
    //  3. AUCUNE ENTRÉE FANTÔME. Si rien ne change réellement (lot vide, ou tous les cadres déjà à leur
    //     place — le cas normal quand on aligne un ensemble déjà aligné), l'état est renvoyé TEL QUEL,
    //     même référence : cliquer deux fois « aligner à gauche » ne laisse pas deux « annuler » à
    //     consommer dont le second ne défait rien.
    //
    // Un même id présent deux fois dans le lot : la dernière occurrence gagne (application séquentielle).
    // Aucun appelant ne le fait — planAlign/planDistribute produisent un id par calque participant.
    case "setFrames": {
      let layers = state.scene.layers;
      let touched = false;
      for (const change of action.changes) {
        const index = layers.findIndex((l) => l.id === change.id);
        if (index === -1) continue;
        const layer = layers[index];
        if (layer.locked) continue;
        if (sameFrame(layer.frame, change.frame)) continue;
        // Le cadre est RECOPIÉ : l'état ne doit jamais partager d'objet mutable avec la charge utile
        // d'une action que l'appelant pourrait réutiliser.
        layers = replaceAt(layers, index, { ...layer, frame: { ...change.frame } });
        touched = true;
      }
      if (!touched) return state;
      return commit(state, { ...state.scene, layers });
    }

    // Chantier D, Tâche 5 — l'échappatoire manuelle : écrit
    // `scene.formatOverrides[format][layerId] = frame`, IMMUABLEMENT (deux niveaux d'objet neufs,
    // jamais de mutation en place de la carte existante), et NE TOUCHE PAS `layers` — c'est ce qui
    // garantit `layer.frame` intact pour le calque édité, l'invariant central de cette tâche.
    //
    // Le calque doit exister dans la scène (même garde que `setLayerProp` : un id absent est un
    // no-op, pas une erreur). PAS de garde de verrou ici, délibérément — mais PAS parce que cette
    // action serait catégoriquement une « édition de panneau » : elle n'a ENCORE aucun appelant réel
    // (voir `frameEditAction` ci-dessus), donc rien ne dit si son futur appelant sera un glisser sur
    // le canevas (devrait respecter le verrou, comme `resizeLayer`) ou un champ de panneau (ne le
    // devrait pas, comme `setLayerProp`). Câbler la garde ICI la rendrait fausse pour l'un des deux
    // cas. La décision est donc reportée au futur appelant — voir le commentaire de `frameEditAction`
    // pour le détail de ce partage de responsabilité (revue Tâche 5, Important).
    //
    // AUCUN code de nettoyage dédié pour l'annulation : `commit()` empile l'entrée d'historique
    // habituelle, et l'`undo` générique (cas "undo" plus bas) restaure la scène ENTIÈRE d'avant CETTE
    // action — surcharge y compris. Une surcharge ajoutée puis annulée ne laisse donc jamais
    // d'entrée orpheline dans `formatOverrides` : il n'y a simplement rien de spécifique à nettoyer,
    // le mécanisme générique suffit (voir tests/studio-editor-state.test.ts, « SANS ORPHELIN »).
    case "setFrameOverride": {
      const index = layerIndex(state.scene, action.layerId);
      if (index === -1) return state;
      const forFormat = { ...(state.scene.formatOverrides?.[action.format] ?? {}), [action.layerId]: { ...action.frame } };
      const formatOverrides = { ...(state.scene.formatOverrides ?? {}), [action.format]: forFormat };
      return commit(state, { ...state.scene, formatOverrides });
    }

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

    // Chantier D, Tâche 4 — le même correctif superficiel que "setLayerProp" ci-dessus, appliqué à
    // CHAQUE id du lot, sur le modèle de "setFrames" plus haut : une seule entrée d'historique pour
    // tout le lot, aucune entrée fantôme si aucun id ne matche (l'état revient tel quel, même
    // référence — même garantie que "setFrames"). Un id absent est ignoré ligne à ligne, jamais
    // rejeté en bloc.
    case "setLayerProps": {
      let layers = state.scene.layers;
      let touched = false;
      for (const id of action.ids) {
        const index = layers.findIndex((l) => l.id === id);
        if (index === -1) continue;
        const layer = layers[index];
        const updated = { ...layer, ...action.patch } as unknown as Layer;
        layers = replaceAt(layers, index, updated);
        touched = true;
      }
      if (!touched) return state;
      return commit(state, { ...state.scene, layers });
    }

    case "addLayer": {
      const layer = action.layer ?? createLayer(action.layerType);
      const next = commit(state, { ...state.scene, layers: [...state.scene.layers, layer] });
      // Un ajout REMPLACE la sélection par le seul calque ajouté (comportement d'avant la Tâche 3,
      // inchangé) : c'est celui que l'utilisateur vient de créer et va vouloir régler.
      return next === state ? state : { ...next, selectedIds: [layer.id] };
    }

    case "deleteLayer": {
      const index = layerIndex(state.scene, action.id);
      if (index === -1) return state;
      if (state.scene.layers[index].locked) return state;
      const layers = state.scene.layers.filter((l) => l.id !== action.id);
      const next = commit(state, { ...state.scene, layers });
      if (next === state) return state;
      // Retire UNIQUEMENT l'id supprimé de la sélection — les autres survivent. La migration naïve
      // de l'ancien `selectedId === action.id ? null : …` (« la sélection contient-elle cet id ?
      // alors vide-la ») viderait toute la sélection dès qu'un seul de ses calques est supprimé.
      const remaining = next.selectedIds.filter((id) => id !== action.id);
      return sameSelection(remaining, next.selectedIds) ? next : { ...next, selectedIds: remaining };
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

    // undo/redo restaurent la SCÈNE **et** la SÉLECTION portées par l'entrée dépilée, et empilent
    // dans l'autre pile la paire courante — parfaitement symétriques, donc un aller-retour rend
    // exactement l'état de départ (point 3 de l'en-tête de module).
    case "undo": {
      if (state.past.length === 0) return state;
      const entry = state.past[state.past.length - 1];
      return {
        scene: entry.scene,
        selectedIds: entry.selectedIds,
        past: state.past.slice(0, -1),
        future: [snapshot(state), ...state.future],
      };
    }

    case "redo": {
      if (state.future.length === 0) return state;
      const [entry, ...future] = state.future;
      return {
        scene: entry.scene,
        selectedIds: entry.selectedIds,
        past: pushHistory(state.past, snapshot(state)),
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
