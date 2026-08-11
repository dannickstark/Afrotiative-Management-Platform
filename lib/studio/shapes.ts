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
import type { Layer, ShapeKind, ShapeLayer } from "./scene";

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
  /**
   * Le `radius` du CALQUE a-t-il un sens pour cette forme ? (U3 Tâche 3.)
   *
   * « Le rayon s'applique là où il veut dire quelque chose, et il est IGNORÉ — pas mal appliqué — là
   * où il ne veut rien dire » (brief). Trois cas, et ce drapeau est la seule chose que l'interface
   * ait à consulter (property-panel.tsx affiche le champ, ou une note à sa place) :
   *
   *  — `rect` et `line` : OUI. Le rayon arrondit les coins, respectivement les extrémités du trait.
   *  — `ellipse` : NON. La forme EST « border-radius: 50% » ; laisser passer le rayon du calque
   *    remplacerait l'ellipse par un stade (mesuré : sur 800×400, `radius: 200` donne deux
   *    demi-cercles reliés par un rectangle, pas une ellipse — sonde Tâche 1). Le rayon d'un calque
   *    converti depuis un rectangle est donc conservé en base mais sans effet, et réapparaît intact
   *    si la forme redevient un rectangle.
   *  — la famille DÉCOUPÉE : NON, et c'est un arbitrage, pas un oubli. La sonde a mesuré que
   *    `clipPath` et `borderRadius` se composent en INTERSECTION — un « triangle arrondi » est donc
   *    techniquement possible, mais ce n'est pas ce qu'un designer demande : `borderRadius` arrondit
   *    les coins du CADRE, pas les sommets du polygone. Sur un triangle il raboterait les deux coins
   *    de la base en laissant la pointe vive ; sur une étoile, dont aucun sommet ne touche un coin du
   *    cadre, il ne ferait RIEN du tout. Offrir un contrôle dont l'effet va de « rogne un morceau au
   *    hasard » à « aucun » serait pire que de ne pas l'offrir. Arrondir les SOMMETS demande un autre
   *    mécanisme (chemin SVG), hors U3.
   */
  radiusApplies: boolean;
  /**
   * Cette forme est-elle un TRAIT — c'est-à-dire insérée comme une barre fine plutôt que comme un
   * carré ? (U3 Tâche 3.) Seule `line` l'est. Voir sa description ci-dessous pour la décision
   * géométrique complète ; ce drapeau est ce que la galerie d'insertion interroge
   * (lib/studio/shape-gallery.ts) au lieu de coder « si c'est une ligne » en dur.
   */
  thin: boolean;
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
  radiusApplies: true,
  thin: false,
  // Le rayon du calque traverse TEL QUEL — pixels (nombre) ou longueur CSS (chaîne, depuis la
  // migration de l'arbitrage C). La condition est une VÉRACITÉ, pas un `!== undefined` : un rayon
  // de 0 n'arrondit rien, donc il n'émet rien. C'était déjà le comportement du chemin d'export ;
  // l'éditeur, lui, sérialisait `border-radius:0` — les deux convergent ici (voir
  // tests/studio-shapes.test.ts, « convergence assumée »).
  css: (layer) => (layer.radius ? { borderRadius: layer.radius } : {}),
};

const ellipse: ShapeDescriptor = {
  kind: "ellipse",
  label: "Ellipse",
  clipped: false,
  // Le rayon du calque est IGNORÉ : la forme EST le rayon. Voir `radiusApplies` ci-dessus.
  radiusApplies: false,
  thin: false,
  // « 50% », mesuré en pixels À TRAVERS renderScene() (Tâche 2, tests/studio-shape-render.test.ts) :
  // sur un cadre 800×400, ça donne une VRAIE ellipse (demi-axes 400 et 200), là où le plus grand
  // rayon NUMÉRIQUE utile (200) ne donne qu'un stade. C'est la raison d'être de la migration de
  // `radius` vers les chaînes (arbitrage C, douzième défaut de plan du programme).
  //
  // PAS de découpe, donc `clipped: false`, donc la ROTATION reste disponible (arbitrage A) : la sonde
  // a mesuré qu'un `div` pivoté fonctionne de bout en bout, et une ellipse pivotée est une ellipse
  // penchée — exactement ce qu'un designer attend.
  css: () => ({ borderRadius: "50%" }),
};

/**
 * LA LIGNE — et la décision géométrique que le brief exige d'expliciter plutôt que de laisser
 * implicite (« a thin rectangle? a rotated one? »).
 *
 * DÉCISION : une ligne est un **rectangle FIN, NON pivoté**, dont l'épaisseur EST la hauteur de son
 * cadre. Elle se peint donc exactement comme un `rect` (aucune CSS de forme propre), et tout ce qui
 * la distingue est son CADRE : la galerie l'insère comme une barre (`thin: true`), pas comme un carré.
 * Une DIAGONALE s'obtient en la faisant tourner — c'est le mécanisme 4 de la sonde, le seul de la
 * Tâche 1 mesuré de bout en bout par `renderScene()` (un cadre 300×8 pivoté de 45° peint bien une
 * diagonale). Elle n'est pas découpée, la rotation lui reste donc acquise.
 *
 * TROIS RAISONS de ne PAS la définir comme « un rectangle déjà pivoté » :
 *  1. la rotation vit dans `layer.rotation`, que l'utilisateur et les poignées du canevas éditent
 *     déjà ; une rotation cachée dans la description se cumulerait à celle-là, et « 0° » afficherait
 *     un trait penché ;
 *  2. l'accrochage, l'alignement et les guides raisonnent tous sur le CADRE NON PIVOTÉ (U2, notes
 *     `snap-rotation-note` / `align-rotation-note`) : une forme intrinsèquement pivotée les mettrait
 *     tous en défaut d'emblée ;
 *  3. redimensionner reste compréhensible — la largeur est la longueur du trait, la hauteur son
 *     épaisseur.
 *
 * À `minSize` (hooks/use-layer-drag.ts : 1 px) le trait fait 1 px d'épaisseur : il reste VISIBLE et
 * sélectionnable (le schéma interdit d'ailleurs une hauteur nulle, `frame.h` est `.positive()`), et
 * c'est ce que vérifient tests/studio-shape-render.test.ts (les extrêmes) et
 * tests/studio-shape-gallery.test.ts (l'épaisseur insérée).
 */
const line: ShapeDescriptor = {
  kind: "line",
  label: "Ligne",
  clipped: false,
  // Un rayon arrondit les EXTRÉMITÉS du trait — un vrai usage, et le seul endroit où l'ancien
  // « rayon des coins » garde tout son sens sur une barre.
  radiusApplies: true,
  thin: true,
  css: (layer) => (layer.radius ? { borderRadius: layer.radius } : {}),
};

// ────────────────────────────────────────────────────────────────────────────────────────────────
// LA FAMILLE POLYGONALE — LES TABLES DE SOMMETS.
//
// Chaque sommet est un POURCENTAGE de la boîte du calque (x = % de la largeur, y = % de la hauteur) :
// la géométrie est donc invariante d'échelle, ce qui est exactement ce qui la rend sûre à `minSize`
// comme à un rapport d'aspect de 370:1 — il n'y a AUCUN pixel dans ces tables, donc rien à dégénérer.
// Une forme dont la pointe serait décrite « à 20 px du bord » se serait effondrée sur un cadre de
// 1 px ; tests/studio-shapes.test.ts épingle cette invariance (« la CSS ne dépend PAS du cadre »).
//
// TOUTES passent par `polygonClip()` — jamais une chaîne écrite à la main. C'est la réserve 1 de la
// sonde : une espace après une virgule fait résoudre l'abscisse contre la HAUTEUR du cadre, et sur un
// cadre carré le défaut est invisible. Le même fichier de tests relit ces chaînes pour vérifier, forme
// par forme, que les sommets restent DANS la boîte, sans doublon, d'aire franche et sans arête qui se
// croise (une coquille dans une table produirait sinon des trous en « evenodd » que personne n'a
// demandés).
//
// Ces formes sont DÉCOUPÉES : `clipped: true`, donc pas de rotation (arbitrage A) et pas de rayon
// (voir `radiusApplies`). La bordure, elle, échappe encore au découpage (réserve 3) — aucune forme
// livrée ici ne porte de bordure par défaut, et la Tâche 4 doit soit la résoudre soit l'annoncer.
// ────────────────────────────────────────────────────────────────────────────────────────────────

/** Fabrique une description DÉCOUPÉE à partir d'une table de sommets. Un seul chemin pour toute la
 * famille : personne ne peut oublier `polygonClip`, ni prétendre `clipped: false`, ni offrir un rayon
 * qui n'aurait pas de sens. La chaîne est construite UNE FOIS, au chargement du module (elle ne
 * dépend pas du calque) — et si une table était invalide, `polygonClip` lèverait ICI, au premier
 * import, pas au premier rendu. */
function clippedDescriptor(
  kind: ShapeKind,
  label: string,
  points: readonly (readonly [number, number])[],
): ShapeDescriptor {
  const clipPath = polygonClip(points);
  return { kind, label, clipped: true, radiusApplies: false, thin: false, css: () => ({ clipPath }) };
}

// Triangle isocèle, pointe en haut, base sur toute la largeur.
const triangle = clippedDescriptor("triangle", "Triangle", [[50, 0], [100, 100], [0, 100]]);

// Étoile à cinq branches, 10 sommets. CES VALEURS SONT CELLES DE LA SONDE (Tâche 1, « découpe aussi
// une étoile à cinq branches ») : elles ont été rendues et échantillonnées en pixels — cœur peint,
// coin du cadre vide, et le CREUX entre les deux branches basses réellement creux.
const star = clippedDescriptor("star", "Étoile", [
  [50, 0], [61, 35], [98, 35], [68, 57], [79, 91], [50, 70], [21, 91], [32, 57], [2, 35], [39, 35],
]);

// Hexagone à toit plat : deux pointes sur les côtés, à mi-hauteur.
const hexagon = clippedDescriptor("hexagon", "Hexagone", [[25, 0], [75, 0], [100, 50], [75, 100], [25, 100], [0, 50]]);

// Flèche vers la DROITE : un fût de 40 % de hauteur, une tête qui occupe les 40 % de droite. Pour la
// faire pointer ailleurs il faudrait la tourner — impossible sur une forme découpée (arbitrage A) —
// donc les autres directions sont une décision de produit à part entière, pas un oubli : elles
// demanderaient soit quatre formes, soit le passage aux chemins SVG. Notée pour la suite d'U3.
const arrow = clippedDescriptor("arrow", "Flèche", [
  [0, 30], [60, 30], [60, 0], [100, 50], [60, 100], [60, 70], [0, 70],
]);

// Bulle de dialogue : un corps sur les 72 % du haut, et une queue triangulaire vers le bas à gauche.
// Rectangulaire, pas arrondie : `borderRadius` arrondirait les coins du CADRE (donc aussi la pointe de
// la queue, qui touche le bord bas) — voir `radiusApplies`.
const bubble = clippedDescriptor("bubble", "Bulle de dialogue", [
  [0, 0], [100, 0], [100, 72], [34, 72], [26, 100], [18, 72], [0, 72],
]);

/**
 * LA table. `Record<ShapeKind, …>` : une forme ajoutée à `SHAPE_KINDS` (lib/studio/scene.ts) sans
 * description ne COMPILE pas — et, parce que `bun test` ne typecheck pas, un garde-fou d'exécution
 * itère `SHAPE_KINDS` dans tests/studio-shapes.test.ts pour que ce soit AUSSI un test rouge.
 * Ajouter une forme, c'est ajouter une entrée ICI : les deux chemins de rendu la suivent
 * automatiquement, et c'est tout l'intérêt.
 */
export const SHAPE_DESCRIPTORS: Record<ShapeKind, ShapeDescriptor> = {
  rect, ellipse, line, triangle, star, hexagon, arrow, bubble,
};

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
 * LA liste d'options d'un sélecteur de forme (U3 Tâche 3), dérivée de la table de descriptions —
 * jamais recopiée à la main. Elle vaut `SHAPE_KINDS` : le garde-fou de complétude de
 * tests/studio-shapes.test.ts lie déjà les clés de cette table au schéma. (Pourquoi pas
 * `SHAPE_KINDS` directement ? Ce serait un import de VALEUR de scene.ts, donc zod dans le paquet
 * navigateur de layer-view.tsx, qui importe ce module — voir l'en-tête de fichier.)
 * Exportée depuis ce module PUR plutôt que construite dans le composant : le contenu déroulant d'un
 * `Select` Base UI n'est pas monté tant qu'il est fermé (`keepMounted={false}`, comme le
 * `Collapsible.Panel` documenté dans tests/studio-property-panel.test.ts), donc un rendu serveur ne
 * contient QUE l'option courante. Le seul moyen d'épingler la liste ENTIÈRE est de tester la source
 * qu'utilise le composant, et c'est celle-ci.
 */
export const SHAPE_OPTIONS: readonly { value: ShapeKind; label: string }[] =
  (Object.keys(SHAPE_DESCRIPTORS) as ShapeKind[]).map((kind) => ({ value: kind, label: shapeLabel(kind) }));

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

/**
 * Le même verdict, pour N'IMPORTE QUEL calque — LE point d'interrogation unique des deux chemins de
 * rendu (U3 Tâche 3, dette 2 du piège de la Tâche 2).
 *
 * POURQUOI ÇA NE PEUT PAS ÊTRE SEULEMENT UN CONTRÔLE GRISÉ. Une scène écrite AVANT cette tâche — ou
 * par un import, ou par l'IA, ou en convertissant un rectangle pivoté en triangle — porte déjà
 * `rotation` sur une forme découpée. Or les deux moteurs ne font PAS la même chose de cette rotation :
 * le navigateur tourne l'élément ET sa découpe ; satori tourne le REMPLISSAGE et pas le masque
 * (réserve 2, mesuré en pixels). Sur un cadre non carré, l'export en devient franchement abîmé — un
 * remplissage 800×400 pivoté de 90° ne couvre plus que la bande centrale du masque. Griser le contrôle
 * sans supprimer la `transform` livrerait donc un éditeur en désaccord avec son propre export : le §0
 * de ce sous-projet, réintroduit par son propre correctif. La rotation est donc SUPPRIMÉE des deux
 * côtés, et tests/studio-shape-render.test.ts le prouve OCTET POUR OCTET.
 *
 * La limite est PAR FORME et jamais globale : un calque texte, image ou QR tourne comme avant, et
 * `rect`/`ellipse`/`line` aussi (ils passent par `borderRadius`, pas par une découpe).
 */
export function layerSupportsRotation(layer: Layer): boolean {
  return layer.type !== "shape" || supportsRotation(layer.shape);
}

/** La rotation RÉELLEMENT peinte pour ce calque, en degrés — 0 quand la forme ne tourne pas. Les deux
 * chemins de rendu appellent CECI plutôt que de lire `layer.rotation` directement. */
export function layerRotation(layer: Layer): number {
  return layerSupportsRotation(layer) ? (layer.rotation ?? 0) : 0;
}
