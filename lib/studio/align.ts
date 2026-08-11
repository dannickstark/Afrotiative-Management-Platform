// lib/studio/align.ts — Tâche 4 (U2, spec §4) : aligner et répartir, en géométrie PURE.
//
// Un module FEUILLE : son seul import est un `import type` (donc effacé à la compilation), il ne
// touche ni le DOM, ni React, ni le réducteur. Tout ici est une fonction d'une liste de cadres vers
// une liste de cadres, testable avec des littéraux d'objet — c'est ce qui permet à
// tests/studio-align.test.ts d'affirmer des COORDONNÉES exactes plutôt que des propriétés molles.
//
// ── Cinq décisions, chacune épinglée par un test ──────────────────────────────────────────────────
//
//  1. LA ROTATION N'EST PAS PRISE EN COMPTE, et c'est explicite (exigence du plan). Les boîtes
//     manipulées ici sont les cadres NON PIVOTÉS (`layer.frame`), jamais la boîte englobante à
//     l'écran d'un calque tourné — qui, elle, dépend de l'angle. Un calque à 30° aligné « à gauche »
//     verra donc son `frame.x` collé au bord, pas son coin visible le plus à gauche. C'est le même
//     choix que la Tâche 5 (accrochage) fera pour la même raison : c'est bon marché, cohérent d'un
//     outil à l'autre du studio, et surtout PRÉVISIBLE — la valeur affichée dans le champ X de la
//     bande de géométrie est celle qui s'aligne. L'interface le DIT lorsque ça peut surprendre :
//     components/studio/geometry-strip.tsx#AlignRow affiche une note dès qu'un participant est
//     réellement pivoté (jamais un avertissement permanent que personne ne lirait).
//
//  2. AUCUN « CALQUE DE RÉFÉRENCE ». La Tâche 3 a pris soin de préserver l'ORDRE D'INSERTION de
//     `selectedIds` (l'ordre des Maj-clics) en notant que la Tâche 4 pourrait s'en servir pour
//     désigner une référence d'alignement. Ce n'est PAS ce qui est implémenté : le plan demande « align
//     -left sets every x equal to the bounding box's left », ce qui est incompatible avec « tout se
//     cale sur le premier cliqué ». L'alignement se fait donc sur la BOÎTE ENGLOBANTE, l'ordre de
//     sélection n'est pas consommé, et `alignParticipants` suit l'ordre des CALQUES. (Un mode
//     « référence » resterait possible plus tard : il ne changerait que le calcul de `target`.)
//
//  3. UNE SEULE SÉLECTION S'ALIGNE SUR LE PLAN DE TRAVAIL. S'aligner sur sa propre boîte englobante
//     est, pour un cadre unique, un no-op STRICT (la boîte EST le cadre) — la rangée serait donc
//     inerte tant qu'on n'a pas Maj-cliqué un second calque. Le plan tranche : « with a single
//     selection, align relative to the artboard ». Le seuil se compte en PARTICIPANTS, pas en
//     `selectedIds.length` : deux calques sélectionnés dont un verrouillé, c'est un seul participant,
//     donc le plan de travail.
//
//  4. LES CALQUES VERROUILLÉS SONT EXCLUS — DE L'OPÉRATION *ET* DE LA BOÎTE ENGLOBANTE. La première
//     moitié est dans le plan (« locked layers are excluded and the rest still align ») ; la seconde
//     est le corollaire qu'il faut choisir explicitement. Laisser un calque verrouillé peser sur la
//     boîte reviendrait à laisser un calque qu'on ne peut pas bouger décider où atterrissent tous les
//     autres — un effet à distance invisible, et non annulable en le déverrouillant après coup.
//     Verrouiller un calque, c'est le retirer de ce geste. (Le réducteur refuse de toute façon de
//     déplacer un calque verrouillé, exactement comme moveLayer/resizeLayer/rotateLayer/deleteLayer :
//     l'exclusion ici n'est donc pas la seule barrière, mais celle qui rend la boîte honnête.)
//     LA VISIBILITÉ EXCLUT EXACTEMENT DE LA MÊME FAÇON, et pour la raison ci-dessus mot pour mot.
//     Ce commentaire a d'abord affirmé le contraire (« la visibilité n'exclut rien »), au motif qu'un
//     calque masqué reste déplaçable ailleurs et qu'inventer une exclusion ajouterait une règle à
//     retenir. C'était faux, et mesuré : deux calques visibles à x=500 et x=600 plus un calque MASQUÉ
//     à x=0, tous sélectionnés, et « aligner à gauche » déplaçait LES DEUX CALQUES VISIBLES de 500 px
//     pour les poser sur le bord d'un calque qu'on ne voit pas. C'est l'« effet à distance invisible »
//     du paragraphe précédent, au sens le plus littéral du terme — et le même geste avec le calque
//     lointain VERROUILLÉ était, lui, déjà correct. La divergence était accidentelle, pas raisonnée
//     (revue finale U0+U2, Important 2). La Tâche 5 exclut d'ailleurs déjà les calques masqués comme
//     RÉFÉRENCES d'accrochage (snap.ts), pour un motif compatible : un calque masqué n'a pas de ligne
//     à l'écran, donc rien à quoi s'aligner honnêtement.
//     Atteignable en trois gestes : Maj-cliquer trois calques, en masquer un depuis le panneau des
//     calques (l'œil ne vide pas la sélection), aligner.
//
//  5. LES CADRES EXTRÊMES NE BOUGENT PAS À LA RÉPARTITION, et « extrême » se lit en POSITION, pas en
//     ordre de tableau — voir distributeFrames.
import type { Frame } from "./scene";

/** Les six modes d'alignement. Liste CANONIQUE : l'interface (geometry-strip.tsx#AlignRow) itère ce
 * tableau et indexe une table `Record<AlignMode, …>`, si bien qu'ajouter un mode ici sans lui donner
 * de bouton ne compile pas — plutôt que de le laisser inaccessible en silence (le défaut que
 * SHAPE_KINDS, lib/studio/scene.ts, existe pour empêcher côté formes). */
export const ALIGN_MODES = ["left", "hcenter", "right", "top", "vmiddle", "bottom"] as const;
export type AlignMode = (typeof ALIGN_MODES)[number];

export const DISTRIBUTE_AXES = ["horizontal", "vertical"] as const;
export type DistributeAxis = (typeof DISTRIBUTE_AXES)[number];

/** Le résultat d'un geste aligner/répartir : le nouveau cadre de CHAQUE calque qui doit bouger — et
 * d'aucun autre. C'est exactement la charge utile de l'action `setFrames` du réducteur
 * (lib/studio/editor-state.ts), qui l'applique en UNE SEULE entrée d'historique. */
export interface FrameChange {
  id: string;
  frame: Frame;
}

/** Le strict minimum qu'un calque doit exposer pour participer. Structurel plutôt que `Layer` : ce
 * module n'a besoin ni du type, ni du contenu, ni du style d'un calque, et rester structurel le garde
 * testable avec des littéraux (tests/studio-align.test.ts) sans construire de scène valide entière. */
export interface AlignSubject {
  id: string;
  frame: Frame;
  locked?: boolean;
  /** `false` exclut le calque du geste ET de la boîte englobante (décision 4). Optionnel, et absent
   *  vaut VISIBLE : un littéral de test qui ne s'intéresse pas à la visibilité garde le comportement
   *  par défaut, et seul un `visible: false` explicite exclut. */
  visible?: boolean;
}

/** Comparaison de cadres champ à champ — sert à ne PAS produire de changement pour un cadre qui est
 * déjà à sa place (voir `changesFrom`), ce qui est le cas normal quand on aligne un ensemble déjà
 * aligné. Réutilisée par le réducteur pour la même raison (une entrée d'historique fantôme est un
 * « annuler » qui ne défait rien de visible). */
export function sameFrame(a: Frame, b: Frame): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

/** La boîte englobante des cadres NON PIVOTÉS (décision 1). `null` — et non une boîte à zéro, qui se
 * lirait comme le coin haut-gauche du plan de travail — quand il n'y a aucun cadre. */
export function boundingBox(frames: readonly Frame[]): Frame | null {
  if (frames.length === 0) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const f of frames) {
    left = Math.min(left, f.x);
    top = Math.min(top, f.y);
    right = Math.max(right, f.x + f.w);
    bottom = Math.max(bottom, f.y + f.h);
  }
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/** Le plan de travail vu comme un cadre — la cible d'alignement d'une sélection simple (décision 3). */
export function artboardFrame(canvas: { width: number; height: number }): Frame {
  return { x: 0, y: 0, w: canvas.width, h: canvas.height };
}

function alignOne(f: Frame, mode: AlignMode, box: Frame): Frame {
  switch (mode) {
    // Un seul axe bouge par mode, et w/h ne bougent JAMAIS : aligner ne redimensionne pas.
    case "left":
      return { ...f, x: box.x };
    case "hcenter":
      return { ...f, x: box.x + (box.w - f.w) / 2 };
    case "right":
      return { ...f, x: box.x + box.w - f.w };
    case "top":
      return { ...f, y: box.y };
    case "vmiddle":
      return { ...f, y: box.y + (box.h - f.h) / 2 };
    case "bottom":
      return { ...f, y: box.y + box.h - f.h };
  }
}

/**
 * Aligne chaque cadre sur `target`, ou — `target` omis — sur la boîte englobante des cadres eux-mêmes.
 *
 * IDEMPOTENT dans les deux cas, et ce n'est pas gratuit pour la cible implicite : après un
 * « aligner à gauche », le minimum des x est inchangé, donc la boîte recalculée a le même bord gauche ;
 * après un « centrer », la boîte se resserre sur le plus large des cadres mais garde le même CENTRE.
 * (tests/studio-align.test.ts vérifie l'idempotence des six modes en exigeant d'abord que la première
 * application ait réellement déplacé quelque chose — sans quoi la propriété serait vraie à vide.)
 */
export function alignFrames(frames: readonly Frame[], mode: AlignMode, target?: Frame): Frame[] {
  const box = target ?? boundingBox(frames);
  if (!box) return [];
  return frames.map((f) => alignOne(f, mode, box));
}

/**
 * Répartit les cadres avec des écarts ÉGAUX le long d'un axe.
 *
 * Moins de trois cadres : no-op (avec deux cadres, il n'y a aucun écart intérieur à égaliser — les
 * deux sont des extrêmes).
 *
 * L'ORDRE DE POSE EST L'ORDRE DES POSITIONS, jamais celui du tableau : les cadres sont triés par bord
 * d'attaque (x, ou y), puis par TAILLE, puis par index d'origine. Le tri par taille départage deux
 * cadres au même bord d'attaque sans se replier sur l'ordre du tableau — deux appels avec les mêmes
 * cadres dans un ordre différent rendent donc le même résultat par cadre (la seule exception étant
 * deux cadres RIGOUREUSEMENT identiques, qu'aucune règle ne peut distinguer et qui reçoivent de toute
 * façon les mêmes valeurs à l'ensemble près).
 *
 * Les deux cadres EXTRÊMES (au sens des positions triées) ne bougent pas ; l'espace restant est
 * réparti à parts égales. Le dernier est ÉPINGLÉ sur sa position d'origine plutôt que posé sur le
 * curseur accumulé : l'erreur d'arrondi des N additions successives se retrouve alors dans le dernier
 * écart (~1e-13, très en dessous de l'epsilon du plan) au lieu de faire dériver un cadre que
 * l'utilisateur voit comme immobile.
 *
 * ÉCART NÉGATIF ASSUMÉ : si la somme des tailles dépasse l'étendue (cadres qui se chevauchent),
 * l'écart calculé est négatif — les cadres se chevauchent alors UNIFORMÉMENT, ce qui est la seule
 * lecture cohérente de « écarts égaux » dans ce cas. Refuser de répartir serait défendable, mais
 * laisserait un bouton inerte sans rien dire ; distribuer uniformément est au moins observable et
 * annulable. (Épinglé par un test, pour que ce ne soit pas découvert comme un bug.)
 */
export function distributeFrames(frames: readonly Frame[], axis: DistributeAxis): Frame[] {
  const out = frames.map((f) => ({ ...f }));
  if (frames.length < 3) return out;

  const horizontal = axis === "horizontal";
  const lead = (f: Frame) => (horizontal ? f.x : f.y);
  const size = (f: Frame) => (horizontal ? f.w : f.h);

  const order = frames
    .map((_, i) => i)
    .sort((i, j) => lead(frames[i]) - lead(frames[j]) || size(frames[i]) - size(frames[j]) || i - j);

  const first = frames[order[0]];
  const last = frames[order[order.length - 1]];
  const span = lead(last) + size(last) - lead(first);
  const total = frames.reduce((sum, f) => sum + size(f), 0);
  const gap = (span - total) / (frames.length - 1);

  let cursor = lead(first);
  for (let k = 0; k < order.length; k++) {
    const idx = order[k];
    const place = k === order.length - 1 ? lead(last) : cursor;
    if (horizontal) out[idx].x = place;
    else out[idx].y = place;
    cursor = place + size(frames[idx]) + gap;
  }
  return out;
}

/**
 * Les calques qui PARTICIPENT au geste : sélectionnés, non verrouillés ET non masqués (décision 4),
 * dans l'ordre des calques (décision 2). Générique pour que l'appelant récupère ses `Layer` complets
 * — l'interface a besoin de `rotation` pour décider si elle affiche sa note, et re-filtrer de son
 * côté serait une deuxième copie de la règle, donc une occasion de dériver.
 *
 * CETTE FONCTION EST LE SEUL ENDROIT où la règle est écrite : `planAlign`/`planDistribute` la
 * traversent tous les deux, donc la boîte englobante ne peut pas diverger de l'ensemble déplacé.
 * C'était le mécanisme de l'Important 2 — la boîte et le déplacement partageaient déjà cette source,
 * et il suffisait donc d'y ajouter la visibilité pour corriger les deux d'un coup.
 */
export function alignParticipants<T extends AlignSubject>(
  layers: readonly T[],
  selectedIds: readonly string[],
): T[] {
  return layers.filter((l) => selectedIds.includes(l.id) && !l.locked && l.visible !== false);
}

function changesFrom(subjects: readonly AlignSubject[], frames: readonly Frame[]): FrameChange[] {
  const out: FrameChange[] = [];
  for (let i = 0; i < subjects.length; i++) {
    // Un cadre déjà à sa place ne produit AUCUN changement : c'est ce qui fait qu'aligner un ensemble
    // déjà aligné n'empile pas d'entrée d'historique (le réducteur renvoie l'état tel quel pour un lot
    // vide), plutôt qu'une entrée qui ne défait rien.
    if (!sameFrame(subjects[i].frame, frames[i])) out.push({ id: subjects[i].id, frame: frames[i] });
  }
  return out;
}

/** Le geste « aligner » complet : de la scène + la sélection au lot de cadres à appliquer. */
export function planAlign(
  layers: readonly AlignSubject[],
  selectedIds: readonly string[],
  mode: AlignMode,
  canvas: { width: number; height: number },
): FrameChange[] {
  const participants = alignParticipants(layers, selectedIds);
  if (participants.length === 0) return [];
  const frames = participants.map((p) => p.frame);
  // UN participant -> plan de travail ; plusieurs -> boîte englobante (décision 3).
  const target = participants.length === 1 ? artboardFrame(canvas) : undefined;
  return changesFrom(participants, alignFrames(frames, mode, target));
}

/** Le geste « répartir » complet. Moins de trois PARTICIPANTS (et non moins de trois sélectionnés) :
 * aucun changement — l'interface désactive d'ailleurs les deux boutons dans ce cas. */
export function planDistribute(
  layers: readonly AlignSubject[],
  selectedIds: readonly string[],
  axis: DistributeAxis,
): FrameChange[] {
  const participants = alignParticipants(layers, selectedIds);
  if (participants.length < 3) return [];
  const frames = participants.map((p) => p.frame);
  return changesFrom(participants, distributeFrames(frames, axis));
}
