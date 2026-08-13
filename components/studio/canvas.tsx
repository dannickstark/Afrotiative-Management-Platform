"use client";

import { useRef } from "react";
import type { Dispatch, CSSProperties, PointerEvent, MouseEvent } from "react";
import type { Layer, Scene } from "@/lib/studio/scene";
import {
  type EditorAction, selectMany, toggleSelection, clearSelection, singleSelectedId,
} from "@/lib/studio/editor-state";
// Chantier B, Tâche 5 — un clic sur un MEMBRE de groupe sélectionne le GROUPE ENTIER (spec §6). Voir
// son commentaire en tête de module pour le modèle FLAT — cette fonction dérive les membres à la
// volée, aucune donnée « groupe » n'est stockée à part.
// Chantier B, Tâche 6 — `groupBounds` (T5, même module) donne à la barre contextuelle flottante la
// MÊME géométrie que le glisser de groupe utilise déjà pour son propre calcul : jamais une seconde
// boîte englobante qui pourrait diverger de celle que l'utilisateur voit déjà bouger à l'écran.
import { expandSelectionToGroups, groupBounds } from "@/lib/studio/groups";
import { useLayerDrag, HANDLES, type HandleId } from "@/hooks/use-layer-drag";
// U3 Tâche 3 (arbitrage A) : LA MÊME question que les deux chemins de rendu posent — cette forme
// tourne-t-elle ? — pour que le chrome de sélection (contour, poignées) ne promette pas une rotation
// que le rendu ne fera pas.
import { layerSupportsRotation } from "@/lib/studio/shapes";
import { resolveDisplayColor } from "@/lib/studio/values";
import { SAMPLE_VALUES } from "@/lib/studio/sample-values";
// U4 Tâche 6 (spec §5) : « voir les liaisons » — `usesInLayer` est la MÊME fonction que
// lib/studio/tokens.ts#extractTokens appelle déjà pour valider la scène entière (jamais une copie
// parallèle du repérage de jetons). `TOKEN_LABELS` vient de lib/studio/token-labels.ts — PAS de
// components/studio/token-picker.tsx, qui RÉ-EXPORTE la même table mais importe aussi
// Popover/PopoverContent/PopoverTrigger (base-ui) pour le sélecteur lui-même : importer la table
// DEPUIS ce composant aurait tiré tout l'arbre Popover dans Canvas, statiquement, pour un seul
// `Record<TokenId,string>` qui n'en a besoin d'aucun — correctif de revue après un incident constaté
// (tests/studio-layer-view.test.ts perdait son test réel de clic Popover, gelé par
// `useIsoLayoutEffect`, dès que Canvas importait Popover en amont dans le même process `bun test`
// sans `--isolate` — voir le commentaire de tête de token-labels.ts).
import { usesInLayer, type TokenId } from "@/lib/studio/tokens";
import { TOKEN_LABELS } from "@/lib/studio/token-labels";
import { LayerView } from "./layer-view";
// Chantier B, Tâche 6 — la barre contextuelle flottante. PAS de Popover/Select à l'intérieur (voir
// son en-tête) : `FloatingToolbar` ne réutilise que `<Button>`, donc son import ici ne réintroduit
// jamais l'incident que tests/studio-no-popover-in-canvas.test.ts garde (voir le commentaire de U4
// Tâche 6 plus haut dans ce fichier).
import { FloatingToolbar } from "./floating-toolbar";

// Le canevas est du DOM, pas un `<canvas>` (spec §2) : chaque calque est une `div` positionnée en
// absolu, à l'intérieur d'un conteneur mis à l'échelle. Le conteneur EXTÉRIEUR (celui que le parent
// dimensionne dans sa mise en page) fait `canvas.width * scale` × `canvas.height * scale` px
// écran ; le conteneur INTÉRIEUR, lui, garde les dimensions RÉELLES du gabarit et porte
// `transform: scale(k)` — exactement la stratégie du spec, pour que TOUTES les coordonnées
// manipulées (frames, deltas de glisser) restent en pixels du gabarit, jamais en pixels écran.
// Chantier B, Tâche 7 (spec §5) — le menu contextuel du clic droit. `CanvasContextMenuPayload` est
// définie ICI, LOCALEMENT, jamais importée de components/studio/canvas-context-menu.tsx (le
// composant base-ui RÉEL, rendu par editor-shell.tsx) — voir le MANDAT DE CONCEPTION en tête de
// canvas-context-menu.tsx et de tests/studio-no-popover-in-canvas.test.ts : un import, même de TYPE
// seul, d'un spécificateur portant "canvas-context-menu" ferait tomber le garde structurel de ce
// dernier fichier (`FORBIDDEN_SPECIFIER_SUFFIXES`, correspondance sur le SPÉCIFICATEUR littéral de
// la ligne `import`, pas sur ce que TypeScript efface ou non à la compilation) — et, plus
// fondamentalement, romprait l'INVARIANT que ce garde protège : canvas.tsx ne doit JAMAIS avoir
// besoin de résoudre le module qui porte @base-ui/react/menu, même pour un type. Ce composant-ci ne
// RENDS donc AUCUN menu : il (a) sélectionne la cible du clic droit EN PREMIER (même règle que le
// clic gauche de glisser-groupe, Tâche 5 — voir handleLayerContextMenu plus bas), (b) calcule le
// point d'ancrage écran, et (c) appelle CETTE prop — sans jamais importer de composant base-ui.
export interface CanvasContextMenuPayload {
  x: number;
  y: number;
  /** L'id du calque ciblé, ou `null` pour le canevas VIDE — ET pour un clic droit qui est retombé
   * sur le canevas via la règle de repli U3 (voir handleCanvasContextMenu plus bas : un calque
   * VERROUILLÉ ne porte, comme pour onPointerDown, AUCUN gestionnaire onContextMenu propre — le clic
   * droit dessus atteint donc TOUJOURS ce gestionnaire-racine, jamais handleLayerContextMenu). */
  targetLayerId: string | null;
}

export interface CanvasProps {
  scene: Scene;
  /** Tâche 3 (U2, spec §3) — la sélection COMPLÈTE, dans l'ordre où l'utilisateur l'a construite.
   * Chaque calque de cet ensemble reçoit son contour de sélection ; les POIGNÉES, elles, n'apparaissent
   * que pour une sélection simple (voir `soleSelectedId` dans le corps du composant). */
  selectedIds: string[];
  dispatch: Dispatch<EditorAction>;
  scale: number;
  /** Sources déjà résolues, par id de calque — assets/QR téléchargés par l'appelant (bibliothèque,
   * Lot 3). Un calque `image` à jeton (`{{slot}}`) n'y figure jamais : l'éditeur n'a pas de valeur
   * de jeton, quoi qu'il arrive (voir layer-view.tsx). */
  images?: Map<string, string>;
  /** U4 Tâche 6 (spec §5) : « voir les liaisons » — dessine un contour d'accent + une étiquette de
   * jeton sur chaque calque VISIBLE portant au moins un `{{jeton}}` (texte, image en slot, QR, ou
   * n'importe quel champ couleur). Défaut `false` (même idiome que rulers/grid, EditorPrefs) : un
   * canevas neuf n'a rien à signaler avant qu'un jeton n'y soit posé, et cette surcouche resterait
   * un bruit permanent pour qui n'édite jamais de gabarit lié. */
  showBindings?: boolean;
  /** Chantier B, Tâche 7 (spec §5) — appelée par un VRAI événement `contextmenu` (clic droit), APRÈS
   * que la sélection a déjà été mise à jour (voir CanvasContextMenuPayload ci-dessus). Le parent
   * (editor-shell.tsx) en tire l'état `{ open, anchor, targetLayerId }` du VRAI menu base-ui. Absente
   * -> aucun changement de comportement (§0) : un `Canvas` sans ce prop reste octet pour octet celui
   * d'avant cette tâche, `preventDefault()` mis à part (qui ne fait que supprimer le menu natif du
   * navigateur, jamais observable par les tests d'avant cette tâche). */
  onContextMenu?: (payload: CanvasContextMenuPayload) => void;
}

const HANDLE_CURSOR: Record<HandleId, string> = {
  n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize",
  ne: "nesw-resize", sw: "nesw-resize", nw: "nwse-resize", se: "nwse-resize",
};

// Position de chaque poignée, en % du cadre du calque (coin ou milieu de côté) — indépendant de
// l'échelle puisque exprimé en pourcentage du conteneur, lui-même déjà mis à l'échelle par le
// parent.
//
// ATTENTION (revue Lot 2, Important 3) : ceci ne couvre QUE la position en %. La TAILLE de chaque
// poignée (width/height/margin ci-dessous, plus le décalage `top: -24` de la poignée de rotation)
// est en pixels ABSOLUS du gabarit, à l'intérieur du même conteneur `transform: scale(k)` que le
// reste du canevas — donc ces longueurs-là NE SONT PAS indépendantes de l'échelle, contrairement à
// ce qu'affirmait ce commentaire avant correction : elles rendent à `8k`/`24k` px écran. Pour
// `story` (1080×1920, k≈0,31) une poignée de 8px gabarit tombe à ~2,5px écran, et la poignée de
// rotation, décalée de -24px gabarit au-dessus du cadre, peut être entièrement recouverte par
// `overflow: hidden` du conteneur pour tout calque proche du haut du canevas — donc impossible à
// saisir. Corrigé en divisant chaque longueur par `scale` dans handleStyleFor()/le rendu ci-dessous,
// pour qu'elles gardent une taille ÉCRAN constante quel que soit le format édité.
// Couleur des guides d'accrochage (Tâche 5, U2). DÉLIBÉRÉMENT différente du bleu de sélection
// (#2563eb, poignées et contours) : un guide n'est pas une partie du calque sélectionné mais une
// relation TEMPORAIRE avec autre chose, et les outils de référence les distinguent tous par la
// couleur. Le rose/rouge est le choix le plus répandu pour ce rôle.
const GUIDE_COLOR = "#e11d48";

// Couleur du contour « liaisons » (Tâche 6, U4). DÉLIBÉRÉMENT différente des trois autres surcouches
// déjà posées sur ce canevas : le bleu de sélection (#2563eb), le rose des guides d'accrochage
// (#e11d48, Tâche 5), et l'ambre des zones sûres (canvas-chrome.tsx, rgba(245,158,11,…)) — un calque
// LIÉ n'est ni une sélection, ni une relation temporaire de geste, ni une contrainte de format : le
// violet reste le seul des quatre rôles à ne porter aucune de ces trois couleurs.
const BINDING_COLOR = "#7c3aed";

const HANDLE_STYLE: Record<HandleId, CSSProperties> = {
  n: { top: 0, left: "50%" }, s: { bottom: 0, left: "50%" },
  e: { right: 0, top: "50%" }, w: { left: 0, top: "50%" },
  ne: { top: 0, right: 0 }, nw: { top: 0, left: 0 },
  se: { bottom: 0, right: 0 }, sw: { bottom: 0, left: 0 },
};

// ─────────────────────────────────────────────────────────────────────────────
// Les deux usages de Maj SUR LE CANEVAS, et pourquoi ils ne se heurtent pas (Tâche 3, U2)
//
// Maj était déjà pris ici par la Tâche 2 : Maj-glisser sur une POIGNÉE de redimensionnement
// verrouille le ratio (hooks/use-layer-drag.ts, `lockAspectRatio`). La Tâche 3 lui ajoute Maj-clic
// sur le CORPS d'un calque pour ajouter/retirer de la sélection. Trois raisons pour lesquelles les
// deux coexistent sans ambiguïté — vérifiées par un test dédié dans tests/studio-interactions.test.ts
// (« Maj-GLISSER sur une POIGNÉE … ne touche PAS la sélection ») plutôt que laissées au raisonnement :
//
//  1. Les CIBLES sont disjointes dans l'arbre. Les poignées vivent dans `handles-overlay`, un FRÈRE
//     des nœuds de calque, jamais un descendant : un pointerdown sur une poignée ne traverse
//     JAMAIS le gestionnaire du corps d'un calque.
//  2. `bind()` (use-layer-drag.ts) appelle `e.stopPropagation()` sur le pointerdown d'une poignée —
//     l'événement n'atteint donc pas non plus le gestionnaire « clic dans le vide » de la racine.
//  3. Sur le corps d'un calque, Maj fait du pointerdown une bascule de sélection PURE : aucun geste
//     de déplacement n'est armé (voir le gestionnaire plus bas). Sans cela, Maj-cliquer pour ajouter
//     un calque le déplacerait au moindre tremblement de main.
//
// ⌘/Ctrl-clic a été écarté comme alternative : ⌘ porte déjà ⌘/ (replier le panneau accosté,
// editor-shell.tsx) et macOS synthétise Ctrl-clic en clic DROIT, ce qui rendrait le geste
// inatteignable pour la moitié du parc.
export function Canvas({
  scene, selectedIds, dispatch, scale, images, showBindings = false, onContextMenu,
}: CanvasProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  // Tâche 5 (U2, spec §5) — le contexte d'accrochage : la scène ENTIÈRE plus les dimensions du plan de
  // travail. Le moteur en retire lui-même TOUS les calques que le geste déplace (le calque tiré, et les
  // autres participants d'un glisser de groupe) ainsi que les calques masqués (`snapCandidates`,
  // lib/studio/snap.ts, décision 2 — un calque VERROUILLÉ reste, lui, une référence légitime) :
  // refiltrer ici serait une deuxième copie de cette règle.
  const { preview, getMoveHandler, getResizeHandler, getRotateHandler } = useLayerDrag(dispatch, scale, {
    layers: scene.layers,
    canvas: scene.canvas,
  });

  // Le calque à OUTILLER (poignées, rotation) : celui d'une sélection SIMPLE, jamais le premier d'une
  // sélection multiple. Poignées et flèches manipulent UN cadre — les afficher sur une sélection
  // multiple laisserait croire qu'elles agissent sur l'ensemble. Les opérations par LOT sur une
  // sélection multiple attendaient l'action « un lot = une entrée d'historique » : la Tâche 4 l'a
  // livrée (`setFrames`, lib/studio/editor-state.ts) et s'en sert pour aligner/répartir
  // (components/studio/geometry-strip.tsx#AlignRow). Suppr et les flèches restent DÉLIBÉRÉMENT en
  // sélection simple — les généraliser est un geste de produit à part entière (que faut-il faire d'un
  // calque verrouillé dans le lot ? d'un calque masqué ?), hors périmètre ; ce qu'il ne faut surtout
  // pas faire, c'est les dispatcher une action par calque, ce qui empilerait N entrées d'annulation
  // pour un seul geste, à rebours de l'invariant « un geste = une entrée » de U1.
  //
  // Chantier B, Tâche 1 : Suppr et les flèches ne sont PLUS gérées ICI — `handleKeyDown` (posé sur ce
  // composant, focus canevas requis) a migré vers le KEYMAP CENTRAL, un écouteur `window` unique monté
  // dans editor-shell.tsx (hooks/use-editor-keymap.ts). Ce hook réutilise EXACTEMENT la même dérivation
  // qu'ici — `singleSelectedId` puis un calque visible et non verrouillé — pour ne rien changer au
  // comportement d'un canevas focalisé ; `selectedLayer` ci-dessous reste donc utile aux poignées/
  // rotation seules, plus au clavier.
  const soleSelectedId = singleSelectedId(selectedIds);
  const selectedLayer = scene.layers.find((l) => l.id === soleSelectedId && l.visible) ?? null;

  // Chantier B, Tâche 6 — la sélection RÉSOLUE contre la scène (jamais les ids bruts de la prop), sur
  // le modèle de `selectedLayers()` (hooks/use-editor-keymap.ts, copier/dupliquer) : un id qui ne
  // désigne plus aucun calque (§2 de l'en-tête d'editor-state.ts, « la sélection n'est pas validée
  // contre la scène ») est silencieusement absent, jamais une entrée `undefined`. AUCUN filtre sur
  // `visible`/`locked` ici — contrairement à `selectedLayer` ci-dessus (poignées de geste), la barre
  // contextuelle affiche des ACTIONS (dupliquer, verrouiller…) qui ont un sens même sur un calque
  // masqué ou déjà verrouillé (verrouiller reste, par construction, jamais bloqué par son propre
  // verrou — voir editor-state.ts#toggleLocked).
  const selectedLayers = scene.layers.filter((l) => selectedIds.includes(l.id));

  // U4 Tâche 3 — le fond du canevas, résolu pour l'AFFICHAGE (même discipline que LayerView) : un
  // fond lié à `{{jeton}}` montre l'échantillon plutôt qu'une chaîne CSS invalide silencieusement
  // abandonnée par le navigateur (le §0 du plan U4). `scene.canvas.background` lui-même n'est jamais
  // touché — `resolveDisplayColor` est pure, comme `resolveTokens`.
  const displayBackground = resolveDisplayColor(scene.canvas.background, SAMPLE_VALUES);

  // GLISSER DE GROUPE (revue finale U0+U2, Important 1) : l'aperçu peut porter le cadre de PLUSIEURS
  // calques (`preview.frames`), pas seulement celui qu'on tire. On regarde donc le lot d'abord — il
  // contient le calque tiré, avec exactement le cadre que `preview.frame` porte — puis on retombe sur
  // le canal simple. Un aperçu qui n'afficherait que le calque tiré montrerait un geste DIFFÉRENT de
  // celui qui sera committé, ce qui est précisément le défaut que ce programme n'arrête pas de trouver.
  function frameFor(layer: Layer) {
    const dansLeLot = preview?.frames?.find((c) => c.id === layer.id);
    if (dansLeLot) return dansLeLot.frame;
    return preview?.layerId === layer.id && preview.frame ? preview.frame : layer.frame;
  }
  function rotationFor(layer: Layer) {
    // U3 Tâche 3 (arbitrage A) : une forme DÉCOUPÉE ne tourne dans AUCUN des deux moteurs de rendu
    // (lib/studio/shapes.ts#layerRotation supprime la `transform` côté export comme côté éditeur). Le
    // contour de sélection et les poignées doivent donc rester droits eux aussi : un cadre penché
    // autour d'un triangle droit annoncerait une rotation qui n'existe pas.
    if (!layerSupportsRotation(layer)) return 0;
    return preview?.layerId === layer.id && preview.rotation !== undefined
      ? preview.rotation
      : (layer.rotation ?? 0);
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

  // Chantier B, Tâche 7 (spec §5) — clic droit sur un CALQUE : sélectionne la cible EN PREMIER
  // (« right-click selects the target first, like reference tools »), PUIS ouvre le menu via la
  // prop-callback (jamais de composant base-ui ici, voir CanvasContextMenuPayload plus haut).
  //
  // LA MÊME expansion de groupe que le glisser (Tâche 5, voir le pointerdown des calques plus bas) —
  // un membre de groupe cliqué DROIT sélectionne le GROUPE ENTIER, jamais lui seul — mais SANS armer
  // aucun geste de déplacement (un clic droit n'ouvre jamais un glisser). `déjàSélectionné` reprend
  // la MÊME garde que le clic gauche : cliquer droit un calque déjà membre de la sélection COURANTE
  // (par ex. une sélection Maj-clic ad hoc à travers plusieurs groupes) GARDE cette sélection telle
  // quelle plutôt que de la réduire au seul groupe de la cible — le menu agit alors sur CE lot-là
  // pour copier/dupliquer/grouper (voir canvas-context-menu.tsx), exactement ce qu'un clic droit sur
  // un membre d'une sélection multiple ferait dans un outil de référence.
  //
  // `stopPropagation()` : empêche l'événement de remonter jusqu'au gestionnaire `onContextMenu` de la
  // RACINE plus bas, qui ouvrirait EN PLUS le menu « canevas vide » sur le même clic — un calque et
  // le canevas ne doivent jamais répondre tous deux au même clic droit (même discipline que le
  // Maj-clic du pointerdown, plus bas).
  function handleLayerContextMenu(layer: Layer) {
    return (e: MouseEvent<HTMLElement>) => {
      e.preventDefault();
      e.stopPropagation();
      rootRef.current?.focus();
      const déjàSélectionné = selectedIds.includes(layer.id);
      if (!déjàSélectionné) dispatch(selectMany(expandSelectionToGroups([layer.id], scene)));
      onContextMenu?.({ x: e.clientX, y: e.clientY, targetLayerId: layer.id });
    };
  }

  // Clic droit sur le CANEVAS — atteint par un clic droit réellement vide, ET par un clic droit sur
  // un calque VERROUILLÉ (règle de repli U3, voir l'en-tête de CanvasContextMenuPayload) : un calque
  // locked ne reçoit AUCUN `onContextMenu` propre (layer-view.tsx, même discipline que
  // `onPointerDown`), donc l'événement bouillonne jusqu'ICI sans qu'aucun code de ce fichier n'ait à
  // tester `layer.locked` explicitement — l'ABSENCE de gestionnaire, pas une garde, produit le repli.
  // AUCUNE sélection n'est touchée ici (contrairement au clic GAUCHE dans le vide, plus bas) : la
  // spec (§5) ne demande que « paste + select-all only » pour ce menu, jamais d'effacer quoi que ce
  // soit — un clic droit dans le vide alors qu'une sélection existe garde cette sélection intacte.
  function handleCanvasContextMenu(e: MouseEvent<HTMLDivElement>) {
    e.preventDefault();
    onContextMenu?.({ x: e.clientX, y: e.clientY, targetLayerId: null });
  }

  const selectedFrame = selectedLayer ? frameFor(selectedLayer) : null;
  const selectedRotation = selectedLayer ? rotationFor(selectedLayer) : 0;

  return (
    <div
      ref={rootRef}
      // `tabIndex={0}` reste nécessaire même sans `onKeyDown` propre à ce composant (Chantier B,
      // Tâche 1 : Suppr/flèches ont migré vers le keymap central, window-level — voir plus haut) :
      // `rootRef.current?.focus()`, plus bas, déplace le focus DOM ici au clic d'un calque, ce qui
      // fait sortir `document.activeElement` d'un éventuel champ de saisie du panneau de propriétés —
      // exactement ce que `isEditingText` (lib/studio/keymap.ts) regarde pour lever sa garde.
      tabIndex={0}
      // « Cliquer le canevas vide efface la sélection » (Tâche 3, spec §3). Posé ICI, sur la racine,
      // et atteint UNIQUEMENT par les pointerdown qui n'ont été absorbés par rien : le corps d'un
      // calque comme une poignée passent tous par `bind()` (use-layer-drag.ts), qui appelle
      // `e.stopPropagation()`, et le chemin Maj du corps d'un calque le fait explicitement lui aussi.
      // Deux gardes :
      //  - `e.button !== 0` : même garde que `bind()`, pour qu'un clic droit (menu contextuel) ne
      //    détruise pas la sélection alors qu'il n'arme aucun geste non plus.
      //  - `e.shiftKey` : Maj est le mode « ajouter/retirer », jamais « détruire » — Maj-cliquer à
      //    côté d'un calque en cours d'ajout ne doit pas anéantir la sélection en construction.
      //
      // CONSÉQUENCE ASSUMÉE sur les calques VERROUILLÉS : un calque locked ne porte aucun
      // gestionnaire et rend `pointer-events: none` (layer-view.tsx), donc cliquer DESSUS atteint ce
      // gestionnaire-ci et efface la sélection — là où, avant la Tâche 3, il ne se passait rien. C'est
      // le comportement des outils de référence (un objet verrouillé est traversé par le clic, pas un
      // trou qui protège la sélection) et il est épinglé par un test plus bas.
      onPointerDown={(e) => {
        if (e.button !== 0 || e.shiftKey) return;
        if (selectedIds.length > 0) dispatch(clearSelection());
      }}
      onContextMenu={handleCanvasContextMenu}
      data-testid="studio-canvas"
      style={{
        position: "relative",
        width: scene.canvas.width * scale,
        height: scene.canvas.height * scale,
        overflow: "hidden",
        outline: "none",
        // Tâche 7 (U1, spec §7) : « l'artboard visuellement distinct de son entourage » — TOUJOURS
        // présent, quel que soit scene.canvas.background. Avant ce correctif, un fond "transparent"
        // (voir le rendu de fond, plus bas, qui pose alors `background: undefined`) ne posait AUCUN
        // fond ni ombre sur CE conteneur non plus : la page (fond `bg-muted/20` de editor-shell.tsx)
        // se voyait directement au travers de tout le canevas, rendant ses limites indiscernables de
        // son entourage. Un box-shadow porté ICI (le conteneur EXTÉRIEUR, jamais mis à l'échelle) —
        // plutôt que sur le conteneur intérieur `transform: scale(k)` — garde une épaisseur d'ombre
        // ÉCRAN constante quel que soit le zoom, même raison que HANDLE_STYLE plus haut compense déjà
        // par `/ scale`.
        boxShadow: "0 0 0 1px rgba(0,0,0,0.08), 0 8px 24px rgba(0,0,0,0.12)",
      }}
    >
      <div
        style={{
          position: "relative",
          width: scene.canvas.width,
          height: scene.canvas.height,
          transform: `scale(${scale})`,
          transformOrigin: "top left",
          background: displayBackground === "transparent" ? undefined : displayBackground,
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
              selected={selectedIds.includes(layer.id)}
              image={images?.get(layer.id)}
              scale={scale}
              onPointerDown={(e) => {
                // Tâche 3, M4 (revue finale U0+U2) : LA GARDE DE BOUTON PASSE AVANT TOUT EFFET DE BORD.
                // Avant ce correctif, `stopPropagation()`/`preventDefault()` tournaient AVANT le test
                // `e.button === 0` du chemin Maj — un Maj-clic DROIT était donc avalé ici (à l'époque,
                // mort : aucun gestionnaire `contextmenu` n'existait encore — voir `onContextMenu`
                // séparé plus bas, ajouté par la Tâche 7, qui gère désormais le clic droit à part) alors
                // qu'un clic droit SANS Maj traversait jusqu'à `dispatch(select(...))` et RÉDUISAIT une
                // sélection multiple à un seul calque. Les deux chemins disent maintenant la même
                // chose : un bouton non primaire n'arme rien ICI, ne consomme rien, ne touche pas la
                // sélection — et l'événement remonte jusqu'à la racine, dont la garde `e.button !== 0`
                // est identique.
                if (e.button !== 0) return;
                rootRef.current?.focus();
                if (e.shiftKey) {
                  // Bascule de sélection PURE (voir le commentaire en tête de composant, point 3).
                  // `stopPropagation` empêche l'événement de remonter jusqu'au gestionnaire « clic
                  // dans le vide » de la racine, qui tournerait juste après la bascule et ressortirait
                  // la sélection VIDE — un Maj-clic qui efface tout au lieu d'ajouter. REDONDANT avec
                  // la garde `e.shiftKey` de ce gestionnaire-là : les deux sont indépendamment
                  // suffisantes (vérifié par mutation, voir task-3-report.md), et c'est voulu — si une
                  // tâche future décidait que Maj-clic dans le vide efface bien la sélection, elle
                  // retirerait cette garde-là et le geste d'ici resterait correct. Ne PAS supprimer
                  // l'un en se disant que l'autre couvre : la suite reste verte sur le coup, et le
                  // filet disparaît.
                  e.stopPropagation();
                  e.preventDefault();
                  dispatch(toggleSelection(layer.id));
                  return;
                }
                // GLISSER DE GROUPE (revue finale U0+U2, Important 1). Avant ce correctif, ce
                // gestionnaire dispatchait `select(layer.id)` INCONDITIONNELLEMENT puis armait un
                // déplacement du seul calque tiré : aligner trois calques puis tirer l'un d'eux pour
                // recaler l'ensemble laissait les deux autres sur place ET détruisait la sélection (la
                // rangée aligner/répartir disparaissait dans le même geste). Le glisser était le SEUL
                // geste qui ne refusait ni ne groupait — il DÉTRUISAIT.
                //
                //  • le calque est DÉJÀ dans la sélection -> on ne re-sélectionne PAS (un `select`
                //    réduirait la sélection à ce seul calque) et on arme le déplacement de TOUS les
                //    participants ;
                //  • il n'y est pas -> la sélection est remplacée par lui (comportement d'avant,
                //    inchangé) et le déplacement reste simple.
                //
                // Le groupe est pris dans l'ORDRE DES CALQUES (`scene.layers`), pas dans l'ordre des
                // Maj-clics : c'est déjà l'ordre d'`alignParticipants` (décision 2 de
                // lib/studio/align.ts), et il n'y a aucune raison qu'un lot de cadres dépende de
                // l'ordre où l'utilisateur a cliqué. Les calques VERROUILLÉS sont écartés par le moteur
                // (voir `beginMove`), et les calques MASQUÉS suivent le groupe — décision et motif dans
                // hooks/use-layer-drag.ts.
                const déjàSélectionné = selectedIds.includes(layer.id);
                // Chantier B, Tâche 5 (revue, Critique 1) — `selectedIds` (prop) est encore la valeur
                // D'AVANT ce clic : `dispatch` ne réapplique pas React synchrones dans CE gestionnaire,
                // donc lire `selectedIds` juste après avoir dispatché ne verrait JAMAIS le groupe qu'on
                // vient de sélectionner. Sur le TOUT PREMIER clic d'un membre (pas encore sélectionné),
                // `idsForDrag` doit donc venir de la MÊME expansion que celle qu'on dispatche — pas de
                // `selectedIds`, qui est encore l'ancienne sélection (vide, ou autre chose) à cet
                // instant précis. Sans ce correctif, ce premier clic armait un glisser À UN SEUL calque
                // (`groupe` à `undefined`) : le membre cliqué bougeait seul, les autres restaient
                // plantés — mesuré (actions `["select","moveLayer"]`, pas `"setFrames"`).
                const idsForDrag = déjàSélectionné ? selectedIds : expandSelectionToGroups([layer.id], scene);
                // Un clic qui SÉLECTIONNE (pas déjà dans la sélection) étend TOUJOURS à tout le
                // groupe du calque cliqué : `expandSelectionToGroups` renvoie `[layer.id]` seul pour
                // un calque SANS `groupId` (le comportement d'avant, intact), et TOUS les co-membres
                // pour un calque groupé. `select(layer.id)` (remplacement par UN seul id) ne
                // suffirait plus depuis cette tâche — `selectMany` porte l'ensemble.
                if (!déjàSélectionné) dispatch(selectMany(idsForDrag));
                const groupe = idsForDrag.length > 1
                  ? scene.layers.filter((l) => idsForDrag.includes(l.id))
                  : undefined;
                getMoveHandler(layer, groupe)(e);
              }}
              onContextMenu={handleLayerContextMenu(layer)}
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
                  // Divisées par `scale` (revue Lot 2, Important 3) : ce conteneur vit à l'intérieur
                  // du même `transform: scale(k)` que le reste du canevas (voir plus haut), donc une
                  // longueur en pixels GABARIT non compensée rend à `Nk` px écran — imperceptible et
                  // inattrapable pour `story` (k≈0,31 → poignée de 2,5 px). Diviser par `scale` ici
                  // annule ce facteur pour obtenir une taille ÉCRAN constante, quel que soit le
                  // format édité.
                  position: "absolute", width: 8 / scale, height: 8 / scale,
                  marginLeft: -4 / scale, marginTop: -4 / scale,
                  background: "#fff", border: "1px solid #2563eb", cursor: HANDLE_CURSOR[h],
                  pointerEvents: "auto", ...HANDLE_STYLE[h],
                }}
              />
            ))}
            {/* U3 Tâche 3 (arbitrage A) : PAS de poignée de rotation pour une forme découpée — le
                geste n'aurait aucun effet visible (les deux chemins de rendu ignorent la rotation
                d'une telle forme), et « la fonctionnalité meurt en silence » est exactement ce que U2
                a déjà tranché deux fois. Le panneau de propriétés grise le champ de rotation et
                affiche la note qui dit pourquoi (geometry-strip.tsx, `shape-rotation-none`). */}
            {layerSupportsRotation(selectedLayer) && (
            <div
              data-handle="rotate"
              onPointerDown={handleRotateDown(selectedLayer)}
              style={{
                // `top: -24` compensé de la même façon — sans quoi, pour un calque proche du haut du
                // canevas, la poignée de rotation peut se retrouver entièrement sous
                // `overflow: hidden` du conteneur racine et devenir impossible à saisir (revue Lot 2,
                // Important 3).
                position: "absolute", top: -24 / scale, left: "50%", marginLeft: -4 / scale,
                width: 8 / scale, height: 8 / scale,
                borderRadius: "50%", background: "#fff", border: "1px solid #2563eb",
                cursor: "grab", pointerEvents: "auto",
              }}
            />
            )}
          </div>
        )}

        {/* Guides d'accrochage (Tâche 5, U2, spec §5) — « des lignes fines, avec la surcouche d'aperçu
            existante, qui disparaissent à la fin du geste ». Trois points :
             - ILS VIVENT SUR LE CANAL D'APERÇU : `preview.guides` (hooks/use-layer-drag.ts), donc
               `onPreviewChange(null)` au pointerup/pointercancel les efface SANS code d'effacement
               dédié — il n'y a rien à oublier de nettoyer ;
             - RENDUS EN DERNIER, à l'intérieur du conteneur mis à l'échelle : leurs coordonnées sont
               celles du GABARIT (comme les cadres), et être le dernier enfant les met au-dessus des
               calques comme des poignées, sans z-index (leçon de la grille de U1) ;
             - ÉPAISSEUR `1 / scale` : même compensation que les poignées ci-dessus, pour un trait d'un
               pixel ÉCRAN à tous les zooms plutôt qu'un trait invisible à k≈0,31. Le décalage d'un
               demi-pixel centre le trait SUR la ligne au lieu de le poser à côté. */}
        {preview?.guides?.map((guide) => (
          <div
            key={`${guide.axis}:${guide.at}:${guide.kind}`}
            data-testid="snap-guide"
            data-guide-axis={guide.axis}
            data-guide-kind={guide.kind}
            data-guide-at={guide.at}
            style={{
              position: "absolute",
              background: GUIDE_COLOR,
              pointerEvents: "none",
              ...(guide.axis === "x"
                ? {
                    left: guide.at, top: guide.from,
                    width: 1 / scale, height: guide.to - guide.from,
                    marginLeft: -0.5 / scale,
                  }
                : {
                    top: guide.at, left: guide.from,
                    height: 1 / scale, width: guide.to - guide.from,
                    marginTop: -0.5 / scale,
                  }),
            }}
          />
        ))}

        {/* « Voir les liaisons » (Tâche 6, U4, spec §5) — SIBLING des guides d'accrochage juste
            au-dessus, à l'intérieur du MÊME conteneur mis à l'échelle (jamais un conteneur à côté de
            l'artboard : la leçon de la grille de U1, « present-in-markup ≠ visible »). Rendu EN
            DERNIER, comme les guides : sans z-index, l'ordre du DOM est l'ordre de peinture entre
            enfants `z-index: auto`, et une étiquette de liaison doit rester lisible par-dessus un
            calque, le contour de sélection ou un guide de glisser.

            `frameFor`/`rotationFor` — PAS `layer.frame`/`layer.rotation` directement — pour la MÊME
            raison que le contour de sélection plus haut : ce sont les valeurs RÉELLEMENT PEINTES
            (l'aperçu d'un geste en cours si ce calque y participe, et — décisif ici — `rotationFor`
            retombe sur 0 pour une forme découpée même quand `layer.rotation` brut est non nul,
            puisqu'AUCUN des deux chemins de rendu ne fait tourner une découpe, U3 Tâche 3). Un
            contour qui pivoterait sur la rotation BRUTE d'un triangle annoncerait une orientation que
            le calque n'a, à l'écran, jamais eue — le même désaccord pixel/geste que §0 du plan U3,
            version « affichage d'aide » plutôt que « rendu ».

            Épaisseur de trait et taille de police en `1 / scale` : même idiome que les guides et les
            poignées ci-dessus, pour une taille ÉCRAN constante quel que soit le zoom. */}
        {showBindings && scene.layers.map((layer) => {
          if (!layer.visible) return null;
          const uses = usesInLayer(layer);
          if (uses.length === 0) return null;

          const frame = frameFor(layer);
          const rotation = rotationFor(layer);
          // Jetons UNIQUES de ce calque, dans l'ordre où `usesInLayer` les a trouvés — un calque texte
          // à deux jetons différents (ou un calque dont plusieurs champs couleur pointent le même
          // jeton) obtient UNE étiquette qui les nomme tous, jamais une par occurrence : c'est le
          // CALQUE qui est lié, pas chacun de ses champs séparément.
          const tokenIds = Array.from(new Set(uses.map((u) => u.token)));
          const label = tokenIds.map((id) => TOKEN_LABELS[id as TokenId] ?? id).join(" · ");

          return (
            <div
              key={`binding:${layer.id}`}
              data-testid="binding-outline"
              data-layer-id={layer.id}
              data-token={tokenIds.join(",")}
              style={{
                position: "absolute",
                left: frame.x, top: frame.y, width: frame.w, height: frame.h,
                transform: rotation ? `rotate(${rotation}deg)` : undefined,
                border: `${2 / scale}px solid ${BINDING_COLOR}`,
                boxSizing: "border-box",
                pointerEvents: "none",
              }}
            >
              {/* Ancrée au coin haut-gauche du cadre (0,0 DANS ce conteneur déjà positionné à
                  frame.x/frame.y), jamais recalée selon la position du calque sur le canevas — un
                  ancrage qui « choisirait un coin » selon la proximité d'un bord introduirait un SAUT
                  (une discontinuité) au moment où le calque franchit ce seuil, exactement ce qu'un
                  déplacement continu du calque ne doit jamais produire dans l'étiquette qui le suit. */}
              <span
                data-testid="binding-label"
                style={{
                  position: "absolute",
                  top: 0, left: 0,
                  transform: `translateY(-100%) translateY(${-4 / scale}px)`,
                  fontSize: 10 / scale,
                  lineHeight: 1.4,
                  padding: `${2 / scale}px ${5 / scale}px`,
                  borderRadius: 3 / scale,
                  background: BINDING_COLOR,
                  color: "#fff",
                  whiteSpace: "nowrap",
                }}
              >
                {label}
              </span>
            </div>
          );
        })}

        {/* Barre contextuelle flottante (Chantier B, Tâche 6, spec §4) — SIBLING des calques et des
            surcouches ci-dessus, à l'intérieur du MÊME conteneur mis à l'échelle (même garde que la
            grille de U1 : jamais un conteneur à côté de l'artboard). Rendue EN DERNIER pour rester
            au-dessus de tout le reste à l'écran (ordre de peinture DOM, sans z-index, même idiome que
            les guides/le contour de liaisons plus haut).
              - `selectedLayers.length > 0` : §0 du plan — sans sélection, rien ne s'ancre, le canevas
                reste inchangé (`FloatingToolbar` renvoie aussi `null` de son côté si
                `toolbarActionsFor` renvoyait `[]`, mais la garde ici évite même de calculer
                `groupBounds` sur un tableau vide).
              - `!preview` : « masquée pendant un glisser/redimensionnement/rotation » (brief T6) —
                `preview` (useLayerDrag, plus haut) est truthy pour LA DURÉE du geste entier, qu'il
                déplace un seul calque ou tout un groupe ; la barre réapparaît au relâchement, quand
                `preview` retombe à `null`. */}
        {selectedLayers.length > 0 && !preview && (
          <FloatingToolbar
            selection={selectedLayers}
            layers={scene.layers}
            bounds={groupBounds(selectedLayers)}
            scale={scale}
            dispatch={dispatch}
          />
        )}
      </div>
    </div>
  );
}
