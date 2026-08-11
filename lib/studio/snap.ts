// lib/studio/snap.ts — Tâche 5 (U2, spec §5) : accrochage (« magnétisme ») et guides intelligents,
// en géométrie PURE.
//
// Un module FEUILLE au même sens que lib/studio/align.ts : ses seuls imports de VALEUR sont
// `boundingBox`/`artboardFrame` de ce même module d'alignement (lui-même sans import de valeur), et
// tout le reste est `import type`, donc effacé à la compilation. Aucun DOM, aucun React, aucun
// réducteur : tout ici est une fonction de cadres vers des cadres, testable avec des littéraux
// d'objet (tests/studio-snap.test.ts affirme des COORDONNÉES exactes, pas des propriétés molles).
//
// ── HUIT DÉCISIONS, chacune épinglée par un test ─────────────────────────────────────────────────
//
//  1. LE SEUIL EST EN PIXELS ÉCRAN, converti UNE SEULE FOIS ici (`threshold / scale`). C'est
//     l'exigence du plan — « pour que ça se sente pareil à tous les zooms » — et c'est la propriété
//     que le dispatch de cette tâche signale comme la plus susceptible d'être livrée cassée, parce
//     que l'implémentation naturelle compare des distances en px GABARIT à un seuil en px ÉCRAN et
//     que personne ne s'en aperçoit avant de zoomer. TOUTES les distances de ce module sont en px
//     gabarit ; le seuil est le SEUL endroit où l'échelle intervient. Un `scale` non fini, nul ou
//     négatif désactive l'accrochage au lieu de produire un seuil infini ou négatif.
//
//  2. LES CANDIDATS SONT LES CALQUES VISIBLES, VERROUILLÉS COMPRIS, sauf CEUX qu'on manipule
//     (`snapCandidates`). Deux moitiés, chacune avec sa raison, et chacune épinglée par un test sur la
//     MÊME fixture (seul l'état du calque change) :
//       • TOUT CALQUE EN COURS DE GESTE S'EXCLUT LUI-MÊME : ses propres bords sont à distance 0 de
//         lui-même, ils gagneraient à chaque pas et le calque serait littéralement impossible à déplacer.
//         Depuis le glisser de GROUPE (revue finale U0+U2, Important 1), « celui qu'on manipule » est
//         un ENSEMBLE : les autres participants bougent eux aussi, donc leurs bords ne sont pas des
//         références — un guide qui les nommerait annoncerait un alignement défait à la fin du geste.
//       • UN CALQUE VERROUILLÉ **EST** UNE RÉFÉRENCE (défaut de plan #11 ; le plan disait « unlocked »
//         et a été amendé). Une référence d'accrochage est en LECTURE SEULE : s'accrocher à un calque ne
//         modifie que celui qu'on tire. L'exclusion avait été recopiée de la Tâche 4, où elle est juste
//         pour une raison qui NE TRANSPOSE PAS — là, les calques verrouillés sont des PARTICIPANTS d'une
//         opération et devraient bouger. Son coût ici était réel : verrouiller un cadre de fond pour
//         cesser de le pousser par accident est la façon normale de construire un gabarit, et
//         l'exclusion faisait que verrouiller détruisait la possibilité de s'aligner dessus — l'outil
//         punissait le bon geste.
//       • UN CALQUE MASQUÉ N'EN EST PAS UNE : il n'a aucune ligne à l'écran, donc un guide qui le nomme
//         affirmerait quelque chose d'invisible — exactement le principe de la décision 7.
//
//  3. L'ACCROCHAGE EST AVEUGLE À LA ROTATION, comme l'alignement de la Tâche 4 (sa décision 1) : les
//     bords manipulés sont ceux du cadre NON PIVOTÉ (`layer.frame`), jamais la boîte englobante à
//     l'écran d'un calque tourné. La conséquence est ASSUMÉE et différente selon le geste :
//       • DÉPLACEMENT : accrochage normal quelle que soit la rotation. Une translation COMMUTE avec la
//         rotation, donc accrocher le cadre non pivoté déplace le calque affiché d'exactement la même
//         quantité — rien ne dérive à l'écran, et la Tâche 1 n'est pas touchée.
//         EXCEPTION EXPLICITE À LA DÉCISION 7, à ne pas laisser découvrir : sur un calque tourné, le
//         guide ainsi allumé marque le CADRE NON PIVOTÉ, pas le contour visible. Mesuré : un calque
//         200×150 accroché à `x = 100` a, à 45°, son point visible le plus à gauche à **93,18** — le
//         guide manque donc le contour de 6,82 px et traverse la forme. C'est inhérent à
//         l'aveuglement à la rotation hérité de la Tâche 4 (le cadre EST ce qui s'aligne, ici comme
//         dans la bande de géométrie), et ce n'est donc PAS corrigeable sans abandonner ce choix — mais
//         la décision 7 dit « un guide est une affirmation visuelle, il ne doit pas s'afficher quand
//         c'est faux », et cette affirmation-là est plus faible que les autres. L'interface le DIT
//         (components/studio/geometry-strip.tsx, note `snap-rotation-note`) plutôt que de laisser
//         l'utilisateur conclure que le guide est cassé.
//       • REDIMENSIONNEMENT : AUCUN accrochage dès que `rotationDeg !== 0` (retour anticipé explicite).
//         Ce n'est pas de la paresse, c'est que « accrocher le bord est » n'a alors plus de référent :
//         à 180°, `computeResizedFrame({100,100,200,150}, "e", {x:6,y:0}, {rotationDeg:180})` rend
//         `{x:106, w:194}` — le bord DROIT du cadre reste EXACTEMENT à 300 et c'est le bord GAUCHE qui
//         bouge (mesuré, pas déduit). Le bord « porté » par la poignée ne bouge donc pas du tout dans
//         l'espace du plan de travail à cet angle, et à un angle intermédiaire les DEUX bords bougent
//         d'un mélange des deux axes locaux. Accrocher malgré tout demanderait soit de corriger le
//         cadre APRÈS coup (ce qui réintroduit exactement la dérive du bord ancré que la Tâche 1 a
//         corrigée), soit d'inverser une application affine dégénérée à certains angles. Refuser est
//         la seule option qui ne casse rien ; un guide qui ne correspond à aucun bord visible serait
//         de toute façon incompréhensible.
//
//  4. PRÉCÉDENCE AVEC LES MODIFICATEURS : LE MODIFICATEUR CONTRAINT, L'ACCROCHE SE PROJETTE SUR LA
//     LIBERTÉ RESTANTE (note 2 du brief de la tâche). L'accrochage n'ajuste JAMAIS le cadre produit :
//     il ajuste le DELTA du geste et laisse `computeResizedFrame` le recalculer. Trois conséquences,
//     toutes obtenues par construction plutôt que par du code dédié :
//       • Maj (ratio verrouillé) : le ratio reste EXACT, jamais « plié » — la propriété de la Tâche 2
//         n'a donc PAS besoin d'être qualifiée. Comme il ne reste qu'un degré de liberté (le facteur
//         `t`), au plus UN axe peut accrocher : le candidat le plus proche gagne et l'autre axe suit
//         le ratio. C'est pour ça que le couplage des axes est DÉTECTÉ (voir décision 6) au lieu
//         d'être redéclaré ici.
//       • Alt (depuis le centre) : le centre reste fixe au bit près, et le bord tiré atterrit
//         exactement sur la ligne — les deux à la fois, parce qu'Alt garde déjà la poignée sous le
//         curseur (Tâche 2, Important 2), donc déplacer le delta de `s` déplace le bord tiré de `s`.
//       • Le clamp de taille minimale garde le dernier mot : une accroche qu'il rend irréalisable ne
//         s'allume PAS (décision 7).
//
//  5. QUELS BORDS ACCROCHENT PENDANT UN REDIMENSIONNEMENT VIENT DE `handleAxes` (exportée par la
//     Tâche 2 exprès pour cette tâche), consommée par l'APPELANT et passée ici en paramètre `axes`.
//     Ce module ne redérive JAMAIS la table poignée -> axes : deux copies dériveraient au premier
//     changement de l'une (c'est la note 1 du brief). Seuls les bords PORTÉS par la poignée
//     accrochent ; le bord opposé ne peut pas accrocher, puisque ce n'est pas lui que le geste tire.
//     PORTÉE EXACTE de « il ne bouge pas », qui n'est vraie que HORS Alt (revue Tâche 5, Mineur 4a) :
//     sur un geste sans modificateur ou sous Maj, le bord opposé est ANCRÉ et ressort bit-identique —
//     c'est la moitié « l'accrochage ne DÉPLACE jamais pendant un redimensionnement » de la propriété
//     du plan, et elle est épinglée telle quelle. Sous Alt (`fromCenter`) il n'existe AUCUN bord ancré :
//     accrocher le bord est de `s` déplace le bord ouest de `−s`, par construction du modificateur, et
//     ce qui reste fixe est le CENTRE (épinglé aussi). L'accroche n'ajoute donc jamais de translation
//     qui lui soit propre — elle laisse intact ce que le geste tient fixe, quel qu'il soit.
//     L'autre moitié — « l'accrochage ne REDIMENSIONNE jamais pendant un déplacement » — est vraie
//     par construction : `snapMove` ne touche que x et y, jamais w ni h.
//
//  6. LE COUPLAGE DES AXES EST DÉTECTÉ, PAS DÉCLARÉ. Pour savoir si les deux axes peuvent accrocher
//     indépendamment (poignée d'angle nue) ou si un seul le peut (Maj), ce module SONDE la fonction de
//     redimensionnement : il pousse le delta de 1px sur CHAQUE axe et regarde si le bord de L'AUTRE
//     bouge — les DEUX sens, parce qu'un couplage unidirectionnel y -> x échapperait à un seul sondage
//     (revue Tâche 5, Mineur 2). Écrire `modifiers.shift && axes.isCorner` ici serait une deuxième copie
//     de la condition `lockAspectRatio && isCorner` de `computeResizedFrame` — exactement le genre de
//     doublon que la note 1 du brief interdit. La détection reste donc vraie de la fonction que
//     l'appelant fournit, y compris d'un futur modificateur qui couplerait les axes autrement.
//
//  7. UNE ACCROCHE IRRÉALISABLE NE S'ALLUME PAS. Après avoir ajusté le delta, le module RE-SONDE et
//     vérifie que le bord visé atterrit bien sur la ligne (à 1e-6 px près). Sinon — clamp de taille
//     minimale atteint, pente nulle, cadre dégénéré — l'ajustement est ABANDONNÉ et aucun guide n'est
//     produit. Un guide est une affirmation visuelle (« ce bord est aligné sur cette ligne ») ; il ne
//     doit pas s'afficher quand c'est faux.
//
//  8. UNE ACCROCHE NE DÉPLACE JAMAIS UN BORD DE PLUS QUE LE SEUIL (`shiftWithin`). Conséquence :
//     tout saut de la position accrochée reste borné par 2×seuil, pour le redimensionnement comme pour
//     le déplacement. Sans cette règle, un calque à ratio extrême sous Maj sautait de 50 px pour un
//     mouvement de curseur de 0,001 px — mesuré, pas supposé. Voir le commentaire de `shiftWithin`.
//
import type { Frame } from "./scene";
import type { Point } from "./editor-state";
// `HandleAxes` seulement — un `import type`, effacé à la compilation, donc AUCUN import de valeur
// depuis un module « use client » et aucun cycle à l'exécution (hooks/use-layer-drag.ts importe ce
// fichier-ci pour ses valeurs). La fonction `handleAxes()` reste l'UNIQUE implémentation de la table
// poignée -> axes ; ce module ne fait que recevoir son résultat (décision 5).
import type { HandleAxes } from "@/hooks/use-layer-drag";
import { artboardFrame, boundingBox } from "./align";

/** Seuil d'accrochage par défaut, en pixels ÉCRAN (décision 1). 8px est la valeur des outils de
 * conception courants : assez large pour être attrapable à la souris, assez étroit pour ne pas
 * empêcher de poser un calque à 10px d'un autre. Le plan ne fixe pas de chiffre ; celui-ci est donc un
 * choix, surchargeable par appel (`threshold`). */
export const SNAP_THRESHOLD_PX = 8;

/** Tolérance de vérification (décision 7), en px gabarit. La résolution est EXACTE pour une
 * application affine (une seule étape de Newton suffit), donc le résidu observé est de l'ordre de
 * 1e-13 : 1e-6 laisse passer l'arrondi flottant et rejette tout ce qui a réellement échoué. */
const EXACT_EPS = 1e-6;

/** Pas de sondage du `probe`, en px gabarit (décisions 6 et 7). 1px : assez grand pour que la
 * différence de deux positions de bord soit très au-dessus du bruit flottant, et sans importance pour
 * la précision puisque l'application sondée est affine — la pente est exacte quel que soit le pas. */
const PROBE_STEP = 1;

/** Une pente en dessous de ce seuil est traitée comme nulle : le bord ne répond pas au delta (cadre
 * clampé, dimension nulle), donc aucune accroche n'est réalisable sur cet axe. */
const FLAT_SLOPE = 1e-9;

export type SnapAxis = "x" | "y";

/** La NATURE d'une ligne d'accrochage. Sert à deux choses : le départage à distance égale (voir
 * `KIND_RANK`) et le rendu (components/studio/canvas.tsx expose `data-guide-kind`). */
export type SnapGuideKind =
  | "layer-edge"
  | "layer-center"
  | "spacing"
  | "artboard-edge"
  | "artboard-center"
  | "artboard-third";

/** Priorité de nature, à distance ÉGALE (voir `compareCandidates`). Les relations entre CALQUES
 * gagnent sur celles du plan de travail : les lignes du plan sont toujours disponibles, donc sans
 * cette règle elles remporteraient toutes les égalités, alors que ce que l'utilisateur arrange est
 * la relation entre ses calques. Les tiers viennent en dernier : ce sont des repères de composition,
 * pas des alignements. */
const KIND_RANK: Record<SnapGuideKind, number> = {
  "layer-edge": 0,
  "layer-center": 1,
  spacing: 2,
  "artboard-edge": 3,
  "artboard-center": 4,
  "artboard-third": 5,
};

/** Un guide qui s'est allumé : une ligne FINE à dessiner, en coordonnées du GABARIT.
 * `axis: "x"` = une ligne VERTICALE à l'abscisse `at`, s'étendant de `from` à `to` en y (et
 * symétriquement pour `"y"`). L'étendue est l'union du cadre accroché et des calques posés sur la
 * ligne — ou le plan de travail entier pour une ligne du plan de travail. */
export interface SnapGuide {
  axis: SnapAxis;
  at: number;
  from: number;
  to: number;
  kind: SnapGuideKind;
  /** Les ids des calques qui portent cette ligne, TRIÉS (donc indépendants de l'ordre d'entrée) ;
   * vide pour une ligne du plan de travail. */
  targetIds: string[];
}

/** Le strict minimum qu'un calque doit exposer pour servir de référence — structurel plutôt que
 * `Layer`, exactement comme `AlignSubject` (lib/studio/align.ts) et pour la même raison : rester
 * testable avec des littéraux, sans construire de scène valide entière. */
export interface SnapSubject {
  id: string;
  frame: Frame;
  visible?: boolean;
  locked?: boolean;
}

/**
 * Les calques qui peuvent servir de référence (décision 2) : VISIBLES — verrouillés compris — et jamais
 * AUCUN de ceux qu'on manipule. Générique pour que l'appelant récupère ses `Layer` complets sans
 * transtypage.
 *
 * `movingIds` est une LISTE, pas un id (revue finale U0+U2, Important 1) : depuis que le glisser
 * déplace toute la sélection, un geste bouge N calques à la fois, et un calque qui BOUGE ne peut pas
 * servir de référence à un autre calque qui bouge — sa ligne aura changé de place à la fin du geste,
 * donc le guide affirmerait un alignement avec un bord qui n'y sera plus. La liste à un élément est le
 * cas d'un glisser simple.
 *
 * `visible` omis vaut « visible » : un littéral de test n'a pas à l'épeler, alors qu'un `Layer` de
 * scène le porte toujours. `locked` n'est PAS lu ici (voir la décision 2 en tête de module), mais reste
 * dans `SnapSubject` : `Layer` le porte, et le retirer du type forcerait les appelants à filtrer eux-mêmes.
 */
export function snapCandidates<T extends SnapSubject>(
  layers: readonly T[],
  movingIds: readonly string[],
): T[] {
  return layers.filter((l) => !movingIds.includes(l.id) && l.visible !== false);
}

// ─────────────────────────────────────────────────────────────────────────────
// Interne — lignes, positions, candidats.

interface SnapLine {
  at: number;
  kind: SnapGuideKind;
  /** Vides pour une ligne du plan de travail. */
  ids: readonly string[];
  frames: readonly Frame[];
  /** Une ligne d'ÉCART ÉGAL ne s'applique qu'au CENTRE du cadre mobile : égaliser deux écarts revient
   * exactement à centrer le cadre dans l'espace libre (voir `spacingLine`). */
  centerOnly?: boolean;
}

/** Une position du cadre mobile susceptible d'accrocher : sa valeur, son décalage par rapport à
 * `frame.x`/`frame.y` (0 pour le bord d'attaque, taille/2 pour le centre, taille pour le bord de
 * fuite) et son rang, utilisé au départage. */
interface SnapPosition {
  pos: number;
  off: number;
  rank: number;
}

const RANK_LEADING = 0;
const RANK_CENTER = 1;
const RANK_TRAILING = 2;

const lead = (f: Frame, axis: SnapAxis) => (axis === "x" ? f.x : f.y);
const size = (f: Frame, axis: SnapAxis) => (axis === "x" ? f.w : f.h);
const crossLead = (f: Frame, axis: SnapAxis) => (axis === "x" ? f.y : f.x);
const crossSize = (f: Frame, axis: SnapAxis) => (axis === "x" ? f.h : f.w);

/** Les lignes d'un axe : trois par calque candidat (bord d'attaque, centre, bord de fuite) et cinq
 * pour le plan de travail (deux bords, le centre, les deux TIERS — exigés par le plan). */
function linesFor(
  axis: SnapAxis,
  candidates: readonly SnapSubject[],
  canvas: { width: number; height: number },
): SnapLine[] {
  const out: SnapLine[] = [];
  for (const c of candidates) {
    const l = lead(c.frame, axis);
    const s = size(c.frame, axis);
    const ids = [c.id];
    const frames = [c.frame];
    out.push({ at: l, kind: "layer-edge", ids, frames });
    out.push({ at: l + s / 2, kind: "layer-center", ids, frames });
    out.push({ at: l + s, kind: "layer-edge", ids, frames });
  }
  const board = artboardFrame(canvas);
  const s = size(board, axis);
  out.push({ at: 0, kind: "artboard-edge", ids: [], frames: [] });
  out.push({ at: s, kind: "artboard-edge", ids: [], frames: [] });
  out.push({ at: s / 2, kind: "artboard-center", ids: [], frames: [] });
  out.push({ at: s / 3, kind: "artboard-third", ids: [], frames: [] });
  out.push({ at: (2 * s) / 3, kind: "artboard-third", ids: [], frames: [] });
  return out;
}

/**
 * La ligne d'ÉCART ÉGAL, ou `null` : « quand le calque mobile est ENTRE deux voisins, accrocher pour
 * rendre les écarts égaux » (plan).
 *
 * Deux choix, tous deux épinglés :
 *
 *  • ELLE S'EXPRIME COMME UNE LIGNE POUR LE CENTRE, et ce n'est pas un raccourci d'implémentation :
 *    les deux écarts sont égaux SI ET SEULEMENT SI le centre du cadre mobile tombe au milieu de
 *    l'espace libre entre les deux voisins. Une seule machinerie sert donc à tous les candidats, et
 *    la ligne dessinée (le milieu de l'espace libre) a un sens visuel immédiat.
 *
 *  • IL FAUT UN CHEVAUCHEMENT SUR L'AXE PERPENDICULAIRE. Sans cette condition, « entre deux voisins »
 *    serait satisfait par deux calques situés n'importe où sur le plan, et l'« écart » égalisé ne
 *    correspondrait à aucun espace visible. Le plan dit « sits between two siblings » ; c'est la
 *    lecture qui rend le geste lisible, et le test montre les deux résultats sur la même abscisse.
 */
function spacingLine(
  axis: SnapAxis,
  moving: Frame,
  candidates: readonly SnapSubject[],
): SnapLine | null {
  const mLead = lead(moving, axis);
  const mTrail = mLead + size(moving, axis);
  const mCross = crossLead(moving, axis);
  const mCrossEnd = mCross + crossSize(moving, axis);

  let before: SnapSubject | null = null;
  let after: SnapSubject | null = null;
  for (const c of candidates) {
    const cCross = crossLead(c.frame, axis);
    if (!(cCross < mCrossEnd && mCross < cCross + crossSize(c.frame, axis))) continue; // pas de chevauchement
    const cLead = lead(c.frame, axis);
    const cTrail = cLead + size(c.frame, axis);
    if (cTrail <= mLead) {
      // Voisin AVANT : on garde le plus proche (le plus grand bord de fuite). Départage par id pour
      // que deux voisins au même bord ne fassent pas dépendre le résultat de l'ordre d'entrée.
      if (
        !before ||
        cTrail > lead(before.frame, axis) + size(before.frame, axis) ||
        (cTrail === lead(before.frame, axis) + size(before.frame, axis) && c.id < before.id)
      ) {
        before = c;
      }
    } else if (cLead >= mTrail) {
      // Voisin APRÈS : le plus proche (le plus petit bord d'attaque).
      if (!after || cLead < lead(after.frame, axis) || (cLead === lead(after.frame, axis) && c.id < after.id)) {
        after = c;
      }
    }
  }
  if (!before || !after) return null;
  const gapStart = lead(before.frame, axis) + size(before.frame, axis);
  const gapEnd = lead(after.frame, axis);
  return {
    at: (gapStart + gapEnd) / 2,
    kind: "spacing",
    ids: [before.id, after.id],
    frames: [before.frame, after.frame],
    centerOnly: true,
  };
}

interface Candidate {
  line: SnapLine;
  /** Distance ABSOLUE, en px gabarit, entre la position mobile et la ligne. */
  distance: number;
  /** La coordonnée que la ligne vise pour la position en question (`at`), utilisée telle quelle. */
  target: number;
  off: number;
  rank: number;
}

/**
 * L'ORDRE TOTAL de départage — « deux candidats concurrents se résolvent de façon déterministe », et
 * la règle est celle-ci, dans cet ordre :
 *   1. la plus PETITE distance (la correction la plus faible à l'écran) ;
 *   2. la PRIORITÉ DE NATURE (`KIND_RANK` : bord de calque, centre de calque, écart égal, bord du
 *      plan, centre du plan, tiers du plan) ;
 *   3. le bord mobile le plus « en amont » (attaque, puis centre, puis fuite) ;
 *   4. la plus petite coordonnée `at` ;
 *   5. le plus petit id de calque (`""` pour le plan de travail).
 *
 * Deux candidats égaux sur les CINQ critères portent la même ligne, de la même nature, pour le même
 * bord : ils produisent donc le même cadre et le même guide, et l'ordre d'entrée ne peut pas fuiter
 * dans le résultat (test de permutation). Même discipline que le tri de `distributeFrames` (Tâche 4),
 * total lui aussi.
 */
function compareCandidates(a: Candidate, b: Candidate): number {
  return (
    a.distance - b.distance ||
    KIND_RANK[a.line.kind] - KIND_RANK[b.line.kind] ||
    a.rank - b.rank ||
    a.target - b.target ||
    firstId(a.line).localeCompare(firstId(b.line))
  );
}

function firstId(line: SnapLine): string {
  return line.ids.length > 0 ? [...line.ids].sort()[0] : "";
}

/** Le meilleur candidat d'un axe, ou `null` si aucun n'est dans le seuil. */
function choose(
  positions: readonly SnapPosition[],
  lines: readonly SnapLine[],
  threshold: number,
): Candidate | null {
  let best: Candidate | null = null;
  for (const p of positions) {
    for (const line of lines) {
      if (line.centerOnly && p.rank !== RANK_CENTER) continue;
      const distance = Math.abs(line.at - p.pos);
      if (!(distance <= threshold)) continue; // `!(… <= …)` couvre aussi NaN
      const candidate: Candidate = { line, distance, target: line.at, off: p.off, rank: p.rank };
      if (best === null || compareCandidates(candidate, best) < 0) best = candidate;
    }
  }
  return best;
}

/**
 * Le guide correspondant au candidat gagnant. Toutes les lignes de MÊME coordonnée et MÊME nature
 * sont AGRÉGÉES : trois calques alignés sur la même abscisse donnent UN guide qui les nomme tous les
 * trois et s'étend sur les trois, plutôt que trois guides superposés — et `targetIds` trié rend le
 * résultat indépendant de l'ordre d'entrée.
 */
function buildGuide(
  axis: SnapAxis,
  winner: Candidate,
  lines: readonly SnapLine[],
  snapped: Frame,
  canvas: { width: number; height: number },
): SnapGuide {
  const ids = new Set<string>();
  const frames: Frame[] = [];
  for (const line of lines) {
    if (line.kind !== winner.line.kind || line.at !== winner.line.at) continue;
    for (const id of line.ids) ids.add(id);
    frames.push(...line.frames);
  }
  // Étendue : l'union du cadre accroché et des calques concernés (`boundingBox`, réutilisée de la
  // Tâche 4 plutôt que réimplémentée) ; le plan de travail entier quand la ligne est la sienne.
  const box = frames.length > 0 ? boundingBox([snapped, ...frames]) : null;
  const board = artboardFrame(canvas);
  const from = box ? crossLead(box, axis) : 0;
  const to = box ? crossLead(box, axis) + crossSize(box, axis) : crossSize(board, axis);
  return {
    axis,
    at: winner.line.at,
    from,
    to,
    kind: winner.line.kind,
    targetIds: [...ids].sort(),
  };
}

/** Le seuil en px GABARIT, ou `null` quand l'accrochage doit être désactivé (décision 1). */
function canvasThreshold(threshold: number, scale: number): number | null {
  if (!Number.isFinite(scale) || scale <= 0) return null;
  if (!Number.isFinite(threshold) || threshold <= 0) return null;
  const t = threshold / scale;
  return Number.isFinite(t) && t > 0 ? t : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// DÉPLACEMENT

export interface SnapMoveInput {
  /** Le cadre mobile BRUT (non accroché), en px gabarit. */
  frame: Frame;
  /** Les références, déjà filtrées — voir `snapCandidates`. */
  candidates: readonly SnapSubject[];
  canvas: { width: number; height: number };
  /** Facteur d'échelle du canevas (px écran = px gabarit × scale). */
  scale: number;
  /** Seuil en px ÉCRAN ; défaut `SNAP_THRESHOLD_PX`. */
  threshold?: number;
}

export interface SnapMoveOutcome {
  frame: Frame;
  guides: SnapGuide[];
}

/**
 * Accroche un DÉPLACEMENT : les deux axes sont libres et s'accrochent INDÉPENDAMMENT (donc au plus
 * deux guides, un par axe).
 *
 * `w`/`h` ressortent BIT-IDENTIQUES : accrocher ne redimensionne jamais pendant un déplacement
 * (moitié de la propriété du plan). Sans aucune accroche, le cadre d'ENTRÉE est renvoyé tel quel —
 * la MÊME référence, ce qui rend l'absence d'effet vérifiable par identité et pas seulement par
 * égalité.
 *
 * La position accrochée est posée DIRECTEMENT (`at - off`) et non par addition d'une correction : le
 * bord d'attaque atterrit alors sur la ligne au bit près, ce que `frame.x + (at - frame.x - off)` ne
 * garantit pas en arithmétique flottante (même leçon que la Tâche 2, Important 3).
 */
export function snapMove({
  frame,
  candidates,
  canvas,
  scale,
  threshold = SNAP_THRESHOLD_PX,
}: SnapMoveInput): SnapMoveOutcome {
  const t = canvasThreshold(threshold, scale);
  if (t === null) return { frame, guides: [] };

  const axes: SnapAxis[] = ["x", "y"];
  const chosen: { axis: SnapAxis; winner: Candidate; lines: SnapLine[] }[] = [];
  for (const axis of axes) {
    const lines = linesFor(axis, candidates, canvas);
    const spacing = spacingLine(axis, frame, candidates);
    if (spacing) lines.push(spacing);
    const s = size(frame, axis);
    const l = lead(frame, axis);
    const positions: SnapPosition[] = [
      { pos: l, off: 0, rank: RANK_LEADING },
      { pos: l + s / 2, off: s / 2, rank: RANK_CENTER },
      { pos: l + s, off: s, rank: RANK_TRAILING },
    ];
    const winner = choose(positions, lines, t);
    if (winner) chosen.push({ axis, winner, lines });
  }
  if (chosen.length === 0) return { frame, guides: [] };

  const snapped: Frame = { ...frame };
  for (const { axis, winner } of chosen) {
    const value = winner.target - winner.off;
    if (axis === "x") snapped.x = value;
    else snapped.y = value;
  }
  return {
    frame: snapped,
    guides: chosen.map(({ axis, winner, lines }) => buildGuide(axis, winner, lines, snapped, canvas)),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// REDIMENSIONNEMENT

/** `computeResizedFrame` LIÉE au cadre de départ, à la poignée et aux options du geste : la seule
 * chose que ce module sait faire d'un delta. Fournie par l'appelant (hooks/use-layer-drag.ts) — c'est
 * ce qui permet d'accrocher SANS recopier une ligne de la géométrie de redimensionnement, et ce qui
 * fait que Maj, Alt, le clamp et la rotation composent tout seuls (décisions 4 et 6). */
export type ResizeProbe = (delta: Point) => Frame;

export interface SnapResizeInput {
  probe: ResizeProbe;
  /** Le delta du geste, en px gabarit (déjà converti par `toCanvasCoords`). */
  delta: Point;
  /** Les axes portés par la poignée — `handleAxes(handle)`, JAMAIS redérivé ici (décision 5). */
  axes: HandleAxes;
  candidates: readonly SnapSubject[];
  canvas: { width: number; height: number };
  scale: number;
  threshold?: number;
  /** Rotation ACTUELLE du calque. Non nulle : aucun accrochage (décision 3). */
  rotationDeg?: number;
}

export interface SnapResizeOutcome {
  /** Le delta AJUSTÉ à repasser à `computeResizedFrame` — jamais un cadre, pour que la géométrie
   * reste produite par une seule implémentation (décision 4). Sans accroche, le delta d'ENTRÉE est
   * renvoyé tel quel (même référence). */
  delta: Point;
  guides: SnapGuide[];
}

/** Le bord d'un cadre sur un axe : `trailing` = bord de fuite (droite/bas), sinon bord d'attaque. */
function edgeOf(f: Frame, axis: SnapAxis, trailing: boolean): number {
  return trailing ? lead(f, axis) + size(f, axis) : lead(f, axis);
}

/**
 * Est-ce que passer de `before` à `after` déplace CHACUN des quatre bords de `limit` au plus ?
 *
 * C'est la décision 8, et elle ferme un défaut MESURÉ, pas hypothétique. Sous Maj il ne reste qu'un
 * degré de liberté : accrocher le bord d'un axe fait bouger l'autre axe du facteur du ratio. Sur un
 * calque 1000×10, accrocher le bord BAS de 1 px déplace donc le bord DROIT de 100 px — et quand le
 * gagnant bascule d'un axe à l'autre au milieu du geste (les deux candidats sont alors à la même
 * distance de leur ligne), le cadre SAUTE de cette amplitude pour un mouvement de curseur de 0,001 px.
 * Mesuré avant ce garde-fou, sur le balayage de tests/studio-snap.test.ts : **50,0 px de saut pour un
 * seuil de 8** — exactement la forme du défaut de la Tâche 2 (« vrai en chaque point testé, faux
 * entre les points »), sur la nouvelle fonction de choix.
 *
 * La règle : une accroche est par définition une PETITE correction. Si la correction réalisée dépasse
 * le seuil sur un bord quelconque, l'accroche ne s'allume pas. Sur un ratio extrême, seul le GRAND axe
 * accroche donc — ce qui est aussi le comportement souhaitable : accrocher le petit axe déplacerait le
 * grand de cent fois la distance demandée. Avec ce garde-fou, tout saut est borné par 2×seuil, comme
 * pour le déplacement (deux plateaux voisins sont à moins de 2×seuil l'un de l'autre puisque le choix
 * bascule à mi-distance).
 */
function shiftWithin(before: Frame, after: Frame, limit: number): boolean {
  // Marge de 1e-6 : la correction de l'axe accroché vaut EXACTEMENT `needed` (≤ limit) au bruit
  // flottant près, et on ne veut pas rejeter une accroche légitime pour 1e-13.
  const slack = limit + EXACT_EPS;
  return (
    Math.abs(after.x - before.x) <= slack &&
    Math.abs(after.x + after.w - (before.x + before.w)) <= slack &&
    Math.abs(after.y - before.y) <= slack &&
    Math.abs(after.y + after.h - (before.y + before.h)) <= slack
  );
}

interface MovingEdge {
  axis: SnapAxis;
  trailing: boolean;
  rank: number;
}

/** Les bords que la poignée fait BOUGER, dérivés de `handleAxes` (décision 5). Une poignée porte au
 * plus un bord par axe : les deux bords opposés du même axe ne peuvent pas être tirés ensemble. */
function movingEdges(axes: HandleAxes): MovingEdge[] {
  const out: MovingEdge[] = [];
  if (axes.hasE) out.push({ axis: "x", trailing: true, rank: RANK_TRAILING });
  else if (axes.hasW) out.push({ axis: "x", trailing: false, rank: RANK_LEADING });
  if (axes.hasS) out.push({ axis: "y", trailing: true, rank: RANK_TRAILING });
  else if (axes.hasN) out.push({ axis: "y", trailing: false, rank: RANK_LEADING });
  return out;
}

function nudge(delta: Point, axis: SnapAxis, step: number): Point {
  return axis === "x" ? { x: delta.x + step, y: delta.y } : { x: delta.x, y: delta.y + step };
}

/**
 * Accroche un REDIMENSIONNEMENT, en ajustant le DELTA du geste (voir `SnapResizeOutcome.delta`).
 *
 * Seuls les bords portés par la poignée accrochent, donc le bord ANCRÉ ne bouge pas d'un bit :
 * accrocher ne DÉPLACE jamais pendant un redimensionnement (l'autre moitié de la propriété du plan).
 *
 * Marche à suivre, et pourquoi elle est sondée plutôt que calculée :
 *  1. rotation ≠ 0 -> on renonce (décision 3) ;
 *  2. cadre brut = `probe(delta)`, d'où la position de chaque bord mobile ;
 *  3. meilleur candidat par axe, avec le même ordre total que le déplacement ;
 *  4. les axes sont-ils COUPLÉS ? On pousse le delta de 1px sur x et on regarde si le bord y bouge
 *     (décision 6). Couplés (Maj sur un angle) -> un SEUL candidat, le plus proche, peut accrocher ;
 *  5. pour chaque candidat retenu, la pente du bord par rapport au delta est mesurée sur le même
 *     sondage, puis le delta est corrigé de `(cible − position) / pente` : une seule étape, exacte
 *     parce que l'application delta -> cadre est affine (linéaire par morceaux) ;
 *  6. re-sondage de vérification : si le bord n'atterrit pas sur la ligne, l'ajustement est abandonné
 *     et aucun guide n'est produit pour cet axe (décision 7).
 */
export function snapResize({
  probe,
  delta,
  axes,
  candidates,
  canvas,
  scale,
  threshold = SNAP_THRESHOLD_PX,
  rotationDeg = 0,
}: SnapResizeInput): SnapResizeOutcome {
  if (rotationDeg !== 0) return { delta, guides: [] };
  const t = canvasThreshold(threshold, scale);
  if (t === null) return { delta, guides: [] };

  const edges = movingEdges(axes);
  if (edges.length === 0) return { delta, guides: [] };

  const raw = probe(delta);

  // Étape 3 — le meilleur candidat par axe mobile.
  const picks: { edge: MovingEdge; winner: Candidate; lines: SnapLine[] }[] = [];
  for (const edge of edges) {
    const lines = linesFor(edge.axis, candidates, canvas);
    const pos = edgeOf(raw, edge.axis, edge.trailing);
    // Un redimensionnement n'accroche QUE le bord tiré : pas de centre, donc pas d'écart égal non
    // plus (le centre n'est pas la grandeur manipulée).
    const winner = choose([{ pos, off: 0, rank: edge.rank }], lines, t);
    if (winner) picks.push({ edge, winner, lines });
  }
  if (picks.length === 0) return { delta, guides: [] };

  // Étape 4 — couplage DÉTECTÉ (décision 6), DANS LES DEUX SENS. Sonder x et regarder le bord y ne
  // suffit pas : un couplage unidirectionnel y -> x passerait inaperçu, les deux axes accrocheraient
  // « indépendamment », et le guide du premier axe deviendrait FAUX dès que le second déplace son bord
  // (revue Tâche 5, Mineur 2 — la première version n'avait que le premier sondage). Aucun modificateur
  // actuel ne se comporte ainsi, mais `probe` est fourni par l'appelant : la détection doit être vraie
  // de la fonction qu'on lui donne, pas des seules fonctions d'aujourd'hui.
  let coupled = false;
  if (edges.length === 2) {
    const [ex, ey] = edges;
    const crossFromX = Math.abs(
      edgeOf(probe(nudge(delta, ex.axis, PROBE_STEP)), ey.axis, ey.trailing) - edgeOf(raw, ey.axis, ey.trailing),
    );
    const crossFromY = Math.abs(
      edgeOf(probe(nudge(delta, ey.axis, PROBE_STEP)), ex.axis, ex.trailing) - edgeOf(raw, ex.axis, ex.trailing),
    );
    coupled = crossFromX > FLAT_SLOPE || crossFromY > FLAT_SLOPE;
  }

  // Axes couplés -> UN SEUL candidat, choisi par le même ordre total que le déplacement. La comparaison
  // est STRICTE (`< 0`), donc une égalité parfaite garde le premier, c'est-à-dire l'axe x (l'ordre de
  // `movingEdges`) : le choix reste déterministe même pour deux candidats indiscernables sur les cinq
  // critères. Et si ce candidat échoue à l'étape de vérification, aucun autre ne prend sa place — la
  // seule autre option serait d'accrocher un axe que l'utilisateur n'a pas approché le plus.
  const retained = coupled
    ? [picks.reduce((a, b) => (compareCandidates(b.winner, a.winner) < 0 ? b : a))]
    : picks;

  // Étapes 5 et 6 — résolution, puis vérification, axe par axe.
  let current = delta;
  let currentFrame = raw;
  const applied: typeof retained = [];
  for (const pick of retained) {
    const { axis, trailing } = pick.edge;
    const here = edgeOf(currentFrame, axis, trailing);
    const needed = pick.winner.target - here;
    if (!(Math.abs(needed) <= t)) continue; // la cible a pu s'éloigner si un autre axe a bougé avant
    const pushed = probe(nudge(current, axis, PROBE_STEP));
    const slope = (edgeOf(pushed, axis, trailing) - here) / PROBE_STEP;
    if (!Number.isFinite(slope) || Math.abs(slope) < FLAT_SLOPE) continue;
    const candidateDelta = nudge(current, axis, needed / slope);
    const candidateFrame = probe(candidateDelta);
    if (Math.abs(edgeOf(candidateFrame, axis, trailing) - pick.winner.target) > EXACT_EPS) continue;
    // Décision 8 : une accroche qui déplacerait un bord de plus que le seuil n'est pas une accroche.
    if (!shiftWithin(currentFrame, candidateFrame, t)) continue;
    current = candidateDelta;
    currentFrame = candidateFrame;
    applied.push(pick);
  }
  if (applied.length === 0) return { delta, guides: [] };

  return {
    delta: current,
    guides: applied.map(({ edge, winner, lines }) =>
      buildGuide(edge.axis, winner, lines, currentFrame, canvas),
    ),
  };
}
