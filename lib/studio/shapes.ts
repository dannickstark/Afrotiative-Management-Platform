// lib/studio/shapes.ts — U3 Tâche 2 : LA description d'une forme, consommée par les DEUX chemins.
//
// LE FAIT STRUCTUREL (§0 du plan U3). Il existe DEUX implémentations indépendantes du dessin d'une
// forme, et aucune ne connaît l'autre :
//
//   Export  | lib/studio/element.ts -> shapeNode()            | Satori -> resvg -> le PNG livré
//   Éditeur | components/studio/layer-view.tsx -> ShapeContent | le canevas que le designer regarde
//
// Chacune portait son propre `switch` (implicite : « un rectangle, avec un rayon peut-être »). Une
// tâche qui apprend une forme à L'UNE des deux livre un éditeur en désaccord avec son propre export
// — le designer dessine une ellipse, l'image exportée contient un rectangle — SANS qu'aucun test ne
// rougisse. Ce module est la réponse : la forme est décrite ICI, une fois, et les deux chemins
// DEMANDENT la CSS au lieu de la redériver. Même raisonnement, même remède que `textStyleFor`
// (element.ts), extrait pour que la sonde d'auto-ajustement mesure exactement la boîte réellement
// peinte.
//
// PUR — aucune I/O, aucun import de valeur (les deux imports ci-dessous sont des TYPES, effacés à la
// compilation). C'est ce qui autorise `layer-view.tsx`, un composant `"use client"`, à l'importer :
// ce fichier ne peut atteindre ni `@/db` ni quoi que ce soit de serveur, par construction.
import type { ShapeKind, ShapeLayer } from "./scene";

// LES SEULES propriétés CSS qui DÉFINISSENT la géométrie d'une forme, et les seules que le plafond
// du moteur autorise pour cela (feuille de route, « Le plafond du moteur ») : `border-radius` — que
// la sonde a mesuré capable d'une VRAIE ellipse en « 50% » — et `clip-path: polygon(…)`, mesuré
// capable d'un triangle et d'une étoile à travers le pipeline réel. Les deux se composent en
// INTERSECTION propre (mesuré, Tâche 1). Le remplissage, la bordure et le cadre ne sont PAS ici :
// ils ne dépendent pas de la forme, chaque chemin les pose déjà et continue de le faire.
export type ShapeCss = {
  borderRadius?: number | string;
  clipPath?: string;
};

export type ShapeDescriptor = {
  kind: ShapeKind;
  /** Libellé français — LA source unique : la galerie d'insertion (shape-gallery.ts) le lit ici
   * plutôt que d'en garder une copie qui pourrait dériver. */
  label: string;
  /**
   * Cette forme est-elle peinte par un DÉCOUPAGE (`clip-path`) ?
   *
   * C'est LE drapeau qui décide si une rotation a un sens, et c'est pourquoi il vit dans la
   * description plutôt que dans une liste de noms en dur ailleurs. Mesuré en pixels (Tâche 1,
   * réserve 2) : quand `transform` est présent, satori enveloppe la forme dans un
   * `<g clip-path="…">` exprimé dans le repère du PARENT — le remplissage tourne, le masque NON.
   * Un triangle découpé puis pivoté de 90° est identique au pixel près à sa version non pivotée.
   * L'arbitrage A tranche : `rotation` est REFUSÉE sur les formes découpées, et l'interface le dit.
   * `rect` (et l'ellipse de la Tâche 3) passent par `borderRadius`, PAS par une découpe : la
   * rotation leur reste disponible. C'est une limite PAR FORME, pas une limite globale — d'où ce
   * drapeau, interrogé via `supportsRotation()`.
   */
  clipped: boolean;
  /** La CSS qui PEINT cette forme, pour ce calque. Pure, sans effet de bord. */
  css(layer: ShapeLayer): ShapeCss;
};

/**
 * Construit une chaîne `clip-path: polygon(…)` à partir de sommets exprimés en POURCENTAGE de la
 * boîte du calque (x = % de la largeur, y = % de la hauteur).
 *
 * CE CONSTRUCTEUR EXISTE POUR UNE RAISON PRÉCISE, et c'est la réserve 1 de la sonde : dans satori
 * (`src/parser/shape.ts`, `parsePolygon`), une chaîne est découpée par `,` puis chaque sommet par
 * ` `. Une ESPACE APRÈS UNE VIRGULE fabrique donc un premier jeton VIDE : l'abscisse glisse à
 * l'indice 1 et se résout contre la HAUTEUR du cadre au lieu de sa largeur. Sur 800×400,
 * `polygon(50% 0, 100% 100%, 0 100%)` perd silencieusement la moitié droite du triangle — et sur un
 * cadre CARRÉ le défaut est totalement invisible. Rien ne lève, jamais.
 *
 * La construction est donc centralisée ICI pour qu'aucun appelant n'ait plus à connaître ce piège,
 * et tests/studio-shape-render.test.ts le garde vivant en PIXELS : la même suite de sommets écrite
 * avec des espaces produit une géométrie DIFFÉRENTE à travers `renderScene()`.
 *
 * @param points au moins trois sommets `[x, y]`, en pourcentage de la boîte.
 */
export function polygonClip(points: readonly (readonly [number, number])[]): string {
  if (points.length < 3) {
    throw new Error(`shapes.ts : un polygone demande au moins trois sommets, ${points.length} reçu(s).`);
  }
  const vertices = points.map(([x, y]) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error(`shapes.ts : sommet de polygone non fini (${x}, ${y}) — un pourcentage doit être un nombre fini.`);
    }
    return `${pct(x)} ${pct(y)}`;
  });
  // LA VIRGULE EST NUE, SANS ESPACE. Voir le bloc ci-dessus : c'est la géométrie qui en dépend.
  return `polygon(${vertices.join(",")})`;
}

// Quatre décimales suffisent très largement à un sommet exprimé en pourcentage d'un cadre de
// quelques centaines de pixels, et `Number(...)` retire les zéros de queue : « 33.3333% », jamais
// « 33.33333333333336% ».
function pct(value: number): string {
  return `${Number(value.toFixed(4))}%`;
}

const rect: ShapeDescriptor = {
  kind: "rect",
  label: "Rectangle",
  clipped: false,
  // Le rayon du calque traverse TEL QUEL — pixels (nombre) ou longueur CSS (chaîne, depuis la
  // migration de l'arbitrage C). La condition est une VÉRACITÉ, pas un `!== undefined` : un rayon
  // de 0 n'arrondit rien, donc il n'émet rien. C'était déjà le comportement du chemin d'export ;
  // l'éditeur, lui, sérialisait `border-radius:0` — les deux convergent ici (voir
  // tests/studio-shapes.test.ts, « convergence assumée »).
  css: (layer) => (layer.radius ? { borderRadius: layer.radius } : {}),
};

/**
 * LA table. `Record<ShapeKind, …>` : une forme ajoutée à `SHAPE_KINDS` (lib/studio/scene.ts) sans
 * description ne COMPILE pas — et, parce que `bun test` ne typecheck pas, un garde-fou d'exécution
 * itère `SHAPE_KINDS` dans tests/studio-shapes.test.ts pour que ce soit AUSSI un test rouge.
 * Ajouter une forme, c'est ajouter une entrée ICI : les deux chemins de rendu la suivent
 * automatiquement, et c'est tout l'intérêt.
 */
export const SHAPE_DESCRIPTORS: Record<ShapeKind, ShapeDescriptor> = { rect };

/**
 * La description d'une forme, ou une ERREUR FRANCHE. Surtout PAS un repli silencieux sur le
 * rectangle : le repli est exactement le scénario de §0 — le designer insère une forme, l'export
 * contient un rectangle, et rien n'échoue nulle part.
 */
export function descriptorFor(kind: ShapeKind): ShapeDescriptor {
  const descriptor = SHAPE_DESCRIPTORS[kind];
  if (!descriptor) {
    throw new Error(`shapes.ts : aucune description pour la forme « ${kind} » — ajoutez-la à SHAPE_DESCRIPTORS.`);
  }
  return descriptor;
}

/** LE point de contact des deux chemins de rendu : la CSS qui peint ce calque. */
export function shapeCssFor(layer: ShapeLayer): ShapeCss {
  return descriptorFor(layer.shape).css(layer);
}

/** Le libellé français d'une forme (galerie d'insertion, panneau de propriétés). */
export function shapeLabel(kind: ShapeKind): string {
  return descriptorFor(kind).label;
}

/**
 * Cette forme peut-elle tourner ? (arbitrage A.)
 *
 * À interroger ICI, jamais par une liste de noms : c'est le mode de PEINTURE qui décide, pas le nom
 * de la forme. Une forme découpée ne tourne pas — `transform` ne traverse pas le `<g clip-path>` de
 * satori (mesuré en pixels, Tâche 1). La Tâche 3, qui livre la famille polygonale, doit poser cette
 * question au contrôle de rotation (property-panel.tsx / geometry-strip.tsx) et afficher la note
 * française qui l'annonce, sur le modèle des deux précédents de U2 (`snap-rotation-note`,
 * `safe-areas-none`) : interdire en le disant vaut mieux qu'autoriser sans effet.
 */
export function supportsRotation(kind: ShapeKind): boolean {
  return !descriptorFor(kind).clipped;
}
