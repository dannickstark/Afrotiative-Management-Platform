import { describe, it, expect } from "bun:test";
import type { Frame } from "@/lib/studio/scene";
import type { Point } from "@/lib/studio/editor-state";
import { computeResizedFrame, handleAxes, type HandleId, type ResizeOptions } from "@/hooks/use-layer-drag";
import {
  SNAP_THRESHOLD_PX,
  snapCandidates,
  snapMove,
  snapResize,
  type SnapGuide,
  type SnapSubject,
} from "@/lib/studio/snap";

// tests/studio-snap.test.ts — Tâche 5 (U2, spec §5) : le moteur d'accroche PUR.
//
// TOUTES les valeurs attendues ci-dessous sont dérivées À LA MAIN dans les commentaires, jamais
// recopiées de la sortie de l'implémentation (leçon de la Tâche 4 : un attendu copié depuis le code
// ne teste que la stabilité du code). Le plan de travail est 800×600 sauf mention contraire, ce qui
// donne ces LIGNES d'accroche du plan de travail, présentes dans TOUS les cas de ce fichier :
//   axe x : 0 et 800 (bords), 400 (centre), 266,666… et 533,333… (tiers)
//   axe y : 0 et 600 (bords), 300 (centre), 200 et 400 (tiers)
// Chaque fixture a donc été choisie pour que ces lignes-là n'interfèrent pas avec la distance
// mesurée — les commentaires le vérifient position par position.
//
// Le seuil par défaut est SNAP_THRESHOLD_PX px ÉCRAN ; à l'échelle 1 il vaut donc autant de px
// gabarit, ce qui rend les distances calculées à la main directement comparables.

const CANVAS = { width: 800, height: 600 };

function frame(x: number, y: number, w: number, h: number): Frame {
  return { x, y, w, h };
}

function sub(id: string, f: Frame, extra: Partial<SnapSubject> = {}): SnapSubject {
  return { id, frame: f, visible: true, locked: false, ...extra };
}

/** Le `probe` que le moteur de geste fournit à `snapResize` : `computeResizedFrame` LIÉE au cadre de
 * départ, à la poignée et aux options — exactement ce que fait hooks/use-layer-drag.ts. Aucune
 * géométrie de redimensionnement n'est recopiée dans ce fichier ni dans lib/studio/snap.ts. */
function resizeProbe(start: Frame, handle: HandleId, options: ResizeOptions = {}) {
  return (d: Point) => computeResizedFrame(start, handle, d, options);
}

// ─────────────────────────────────────────────────────────────────────────────
describe("snapCandidates — qui peut servir de référence", () => {
  const layers: SnapSubject[] = [
    sub("moi", frame(0, 0, 10, 10)),
    sub("visible", frame(100, 100, 10, 10)),
    sub("masqué", frame(200, 200, 10, 10), { visible: false }),
    sub("verrouillé", frame(300, 300, 10, 10), { locked: true }),
  ];

  it("exclut le calque EN COURS de geste et les MASQUÉS, mais garde les VERROUILLÉS", () => {
    // Défaut de plan #11 (plan amendé le 2026-08-11) : « visible, unlocked siblings » se trompait sur
    // `unlocked`. Une référence d'accrochage est en LECTURE SEULE — s'accrocher à un calque ne modifie
    // que celui qu'on tire. L'exclusion venait de la Tâche 4, où elle est juste pour une autre raison
    // (là, les calques verrouillés sont des PARTICIPANTS d'une opération et devraient bouger). Le coût
    // de l'exclusion était réel : verrouiller un cadre de fond pour cesser de le pousser par accident
    // est la façon normale de construire un gabarit, et cela détruisait la possibilité de s'aligner
    // dessus — l'outil punissait le bon geste.
    //
    // La moitié `visible` RESTE : un calque masqué n'a aucune ligne à l'écran, donc un guide qui le
    // nomme affirmerait quelque chose d'invisible — c'est le principe de la décision 7 elle-même.
    expect(snapCandidates(layers, ["moi"]).map((l) => l.id)).toEqual(["visible", "verrouillé"]);
  });

  it("le calque en cours de geste s'exclut LUI-MÊME — sinon ses propres bords l'immobiliseraient", () => {
    // Un calque présent dans ses propres candidats a TOUJOURS trois candidats à distance 0 par axe
    // (chacun de ses bords sur sa propre ligne) : ils gagneraient à chaque pas et le calque serait
    // rigoureusement impossible à déplacer. Ce test cadre le défaut le plus grossier du filtre en
    // montrant les DEUX résultats sur la MÊME géométrie.
    const moving = frame(140, 250, 50, 40);
    const withSelf = snapMove({
      frame: moving, candidates: [sub("moi", moving)], canvas: CANVAS, scale: 1,
    });
    expect(withSelf.guides.length).toBeGreaterThan(0); // s'inclure accroche bien, à distance 0…

    const filtered = snapMove({
      frame: moving, candidates: snapCandidates([sub("moi", moving)], ["moi"]), canvas: CANVAS, scale: 1,
    });
    expect(filtered.guides).toEqual([]); // …et le filtre l'en empêche
    expect(filtered.frame).toBe(moving);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DÉPLACEMENT — le cas de base, et le piège de vacuité du plan.
//
// « Sans candidat dans le seuil, le cadre est rendu inchangé et aucun guide ne s'allume » est
// satisfait par un moteur qui n'accroche JAMAIS. Chaque test négatif ci-dessous est donc APPAIRÉ avec
// un test positif sur la MÊME géométrie, qui épingle des coordonnées exactes.
describe("snapMove — le négatif du plan, appairé avec son positif", () => {
  const a = sub("a", frame(100, 100, 200, 100)); // lignes x 100/200/300, y 100/150/200
  const b = sub("b", frame(500, 400, 100, 100)); // lignes x 500/550/600, y 400/450/500
  const candidates = [a, b];

  // Cadre mobile 50×40 en (140, 250) :
  //   positions x 140/165/190 -> la plus proche des lignes ci-dessus est 200, à 10 de 190 -> HORS seuil
  //   positions y 250/270/290 -> la plus proche est 300, à 10 de 290                      -> HORS seuil
  const loin = frame(140, 250, 50, 40);

  it("aucun candidat dans le seuil : le cadre est rendu TEL QUEL (même référence) et aucun guide", () => {
    const out = snapMove({ frame: loin, candidates, canvas: CANVAS, scale: 1 });
    expect(out.frame).toBe(loin); // la MÊME référence, pas seulement une copie égale
    expect(out.guides).toEqual([]);
  });

  it("le MÊME cadre, à 4px d'une ligne, accroche EXACTEMENT et n'allume QU'UN guide", () => {
    // (104, 250) : bord gauche 104 -> ligne 100 (bord gauche de « a »), distance 4.
    // Les autres positions x sont à 29 (129 -> 100) et 46 (154 -> 200) : le bord gauche gagne.
    // L'axe y est inchangé (250/270/290 restent à 10 de 300).
    const proche = frame(104, 250, 50, 40);
    const out = snapMove({ frame: proche, candidates, canvas: CANVAS, scale: 1 });
    expect(out.frame.x).toBe(100); // EXACT, pas « à peu près »
    expect(out.frame.y).toBe(250);
    expect(out.frame.w).toBe(50);
    expect(out.frame.h).toBe(40);
    expect(out.guides).toHaveLength(1);
    // Étendue du guide : union du cadre accroché (y 250..290) et de « a » (y 100..200) -> 100..290.
    expect(out.guides[0]).toEqual({
      axis: "x", at: 100, from: 100, to: 290, kind: "layer-edge", targetIds: ["a"],
    } satisfies SnapGuide);
  });

  it("accrocher NE REDIMENSIONNE JAMAIS pendant un déplacement, même quand les DEUX axes accrochent", () => {
    // (104, 196) : bord gauche 104 -> 100 (distance 4) ; bord HAUT 196 -> 200 (à la fois bord bas de
    // « a » et tiers du plan de travail, distance 4). w/h doivent sortir BIT-IDENTIQUES.
    const out = snapMove({ frame: frame(104, 196, 50, 40), candidates, canvas: CANVAS, scale: 1 });
    expect(out.frame.x).toBe(100);
    expect(out.frame.y).toBe(200);
    expect(out.frame.w).toBe(50);
    expect(out.frame.h).toBe(40);
    expect(out.guides).toHaveLength(2);
    expect(out.guides.map((g) => g.axis)).toEqual(["x", "y"]);
    // La ligne y=200 est portée par DEUX natures (bord de calque et tiers) : la nature la plus
    // prioritaire nomme le guide, et le calque est cité.
    expect(out.guides[1].kind).toBe("layer-edge");
    expect(out.guides[1].targetIds).toEqual(["a"]);
  });

  it("un calque MASQUÉ n'est pas une référence — même géométrie, résultat opposé", () => {
    const proche = frame(104, 250, 50, 40);
    expect(snapMove({ frame: proche, candidates: [a], canvas: CANVAS, scale: 1 }).frame.x).toBe(100);

    const masqué = snapCandidates([sub("a", a.frame, { visible: false })], ["moi"]);
    const out = snapMove({ frame: proche, candidates: masqué, canvas: CANVAS, scale: 1 });
    expect(out.frame).toBe(proche);
    expect(out.guides).toEqual([]);
  });

  it("un calque VERROUILLÉ, LUI, est une référence — et le guide le nomme (défaut de plan #11)", () => {
    // Même géométrie que le test précédent, verrou au lieu du masque : l'accroche a lieu et le guide
    // nomme le calque. Les deux tests mis côte à côte épinglent les DEUX moitiés du filtre, avec la
    // même fixture, donc un futur remaniement qui rétablirait l'exclusion des verrouillés (ou qui
    // laisserait passer les masqués) est rouge immédiatement.
    const proche = frame(104, 250, 50, 40);
    const verrouillé = snapCandidates([sub("a", a.frame, { locked: true })], ["moi"]);
    expect(verrouillé.map((l) => l.id)).toEqual(["a"]);
    const out = snapMove({ frame: proche, candidates: verrouillé, canvas: CANVAS, scale: 1 });
    expect(out.frame.x).toBe(100);
    expect(out.guides).toEqual([{
      axis: "x", at: 100, from: 100, to: 290, kind: "layer-edge", targetIds: ["a"],
    } satisfies SnapGuide]);
  });
});

describe("snapMove — les candidats du plan de travail (bords, centre, TIERS)", () => {
  it("le bord gauche accroche sur le bord du plan de travail (x=0)", () => {
    const out = snapMove({ frame: frame(5, 250, 50, 40), candidates: [], canvas: CANVAS, scale: 1 });
    expect(out.frame.x).toBe(0);
    expect(out.guides).toHaveLength(1);
    // Un guide du plan de travail s'étend sur TOUTE sa hauteur (0..600), pas sur une union.
    expect(out.guides[0]).toEqual({
      axis: "x", at: 0, from: 0, to: 600, kind: "artboard-edge", targetIds: [],
    } satisfies SnapGuide);
  });

  it("le CENTRE du cadre accroche sur le centre du plan de travail (400, 300)", () => {
    // Cadre 100×80 en (348, 262) : centre (398, 302), donc à 2 sur chaque axe.
    // Après accroche : x = 400 - 50 = 350, y = 300 - 40 = 260.
    const out = snapMove({ frame: frame(348, 262, 100, 80), candidates: [], canvas: CANVAS, scale: 1 });
    expect(out.frame.x).toBe(350);
    expect(out.frame.y).toBe(260);
    expect(out.guides.map((g) => [g.axis, g.at, g.kind])).toEqual([
      ["x", 400, "artboard-center"],
      ["y", 300, "artboard-center"],
    ]);
  });

  it("le bord droit accroche sur le TIERS du plan de travail (2/3 = 533,333…)", () => {
    // Cadre 60 de large en x=471 : bord droit 531, à 2,333… du tiers 533,333….
    // Positions concurrentes : 471 -> 400 = 71 ; 501 -> 533,33 = 32,3. Le bord droit gagne.
    const tiers = (2 * 800) / 3;
    const out = snapMove({ frame: frame(471, 250, 60, 40), candidates: [], canvas: CANVAS, scale: 1 });
    expect(out.frame.x).toBeCloseTo(tiers - 60, 9);
    expect(out.frame.x + out.frame.w).toBeCloseTo(tiers, 9);
    expect(out.guides).toHaveLength(1);
    expect(out.guides[0].kind).toBe("artboard-third");
    expect(out.guides[0].at).toBeCloseTo(tiers, 9);
  });

  it("les tiers HORIZONTAUX existent aussi (y = 200 et 400)", () => {
    // (140, 197), 50×40 : bord haut à 3 du tiers 200 ; positions x 140/165/190 sont à ≥ 76 de toute
    // ligne x (la plus proche est le tiers 266,67), donc seul l'axe y bouge.
    const out = snapMove({ frame: frame(140, 197, 50, 40), candidates: [], canvas: CANVAS, scale: 1 });
    expect(out.frame.y).toBe(200);
    expect(out.frame.x).toBe(140);
    expect(out.guides).toEqual([{
      axis: "y", at: 200, from: 0, to: 800, kind: "artboard-third", targetIds: [],
    } satisfies SnapGuide]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LE SEUIL EST EN PIXELS ÉCRAN — la propriété que le dispatch signale comme la plus susceptible
// d'être livrée cassée : l'implémentation naturelle compare des distances en px GABARIT à un seuil en
// px ÉCRAN, et personne ne s'en aperçoit avant de zoomer.
//
// Les deux premiers tests utilisent un plan de travail VOLONTAIREMENT énorme (100 000 × 100 000) et un
// candidat isolé : à l'échelle 0,25 le seuil vaut 32 px gabarit, et sur un plan 800×600 les lignes du
// plan de travail (0/266/400/533/800) sont alors si proches les unes des autres qu'un autre candidat
// gagnerait la mesure. Un plan géant est le seul moyen d'isoler UNE distance.
describe("snapMove — le seuil est en pixels ÉCRAN, à toutes les échelles", () => {
  const BIG = { width: 100_000, height: 100_000 };
  // Lignes x du candidat : 20 000 / 22 500 / 25 000. Ses lignes y (60 000/60 050/60 100) sont loin du
  // cadre mobile, qui reste autour de y = 20 000 : l'axe y n'accroche jamais dans ces deux tests.
  // Le cadre mobile fait 1000×1000 pour que SEUL son bord gauche puisse être à portée de 20 000 : son
  // centre et son bord droit restent à ≥ 1500 px gabarit de toute ligne, très au-delà du plus grand
  // seuil exploré (96 px gabarit à k=0,25). Sans cette précaution, un cadre étroit accroche par son
  // centre ou son bord droit et la mesure ne porte plus sur la distance qu'on croit mesurer — c'est
  // arrivé sur la première version de cette fixture.
  const cible = sub("cible", frame(20_000, 60_000, 5_000, 100));
  const mobile = (gauche: number) => frame(gauche, 20_000, 1_000, 1_000);

  it("la MÊME distance ÉCRAN accroche (7,99) ou pas (8,01) à 0,3 / 1 / 2 / 3", () => {
    for (const scale of [0.3, 1, 2, 3]) {
      const dedans = mobile(20_000 - 7.99 / scale);
      const ok = snapMove({ frame: dedans, candidates: [cible], canvas: BIG, scale });
      expect(ok.guides).toHaveLength(1);
      expect(ok.frame.x).toBe(20_000);

      const dehors = mobile(20_000 - 8.01 / scale);
      const ko = snapMove({ frame: dehors, candidates: [cible], canvas: BIG, scale });
      expect(ko.frame).toBe(dehors);
      expect(ko.guides).toEqual([]);
    }
  });

  it("la distance-limite MESURÉE vaut le même nombre de px ÉCRAN à toutes les échelles", () => {
    // Dichotomie sur la distance GABARIT qui accroche encore, bornée à 3× le seuil attendu pour que
    // le prédicat reste monotone (aucune autre ligne n'est à moins de 3× le seuil du cadre mobile).
    function limiteÉcran(scale: number): number {
      let dedans = 0;
      let dehors = (3 * SNAP_THRESHOLD_PX) / scale;
      for (let i = 0; i < 60; i++) {
        const mid = (dedans + dehors) / 2;
        const out = snapMove({ frame: mobile(20_000 - mid), candidates: [cible], canvas: BIG, scale });
        if (out.guides.length > 0) dedans = mid;
        else dehors = mid;
      }
      return dedans * scale;
    }
    for (const scale of [0.25, 0.3, 1, 1.75, 3]) {
      expect(limiteÉcran(scale)).toBeCloseTo(SNAP_THRESHOLD_PX, 6);
    }
  });

  it("la même distance GABARIT accroche à 0,5 et PAS à 1 — le test qui distingue les deux bugs", () => {
    // Cadre 90×40 en (200, 230) : bord droit 290, à 10 de la ligne 300 (bord gauche de « a »).
    // 10 px gabarit valent 5 px écran à k=0,5 (DEDANS) et 10 px écran à k=1 (DEHORS).
    // Un moteur qui compare des px gabarit au seuil de 8 accroche dans LES DEUX cas ; un moteur qui
    // MULTIPLIE au lieu de diviser n'accroche dans AUCUN.
    // Positions concurrentes : 245 -> tiers 266,67 = 21,67 ; y 230/250/270 -> ≥ 30 de toute ligne y.
    const a = sub("a", frame(300, 100, 100, 100));
    const f = frame(200, 230, 90, 40);
    const àDemi = snapMove({ frame: f, candidates: [a], canvas: CANVAS, scale: 0.5 });
    expect(àDemi.frame.x).toBe(210);
    expect(àDemi.guides).toHaveLength(1);

    const àUn = snapMove({ frame: f, candidates: [a], canvas: CANVAS, scale: 1 });
    expect(àUn.frame).toBe(f);
    expect(àUn.guides).toEqual([]);
  });

  it("la même distance GABARIT accroche à 1 et PAS à 2 (l'autre côté de la même propriété)", () => {
    // Cadre 90×40 en (204, 230) : bord droit 294, à 6 de 300 -> 6 px écran à k=1, 12 à k=2.
    const a = sub("a", frame(300, 100, 100, 100));
    const f = frame(204, 230, 90, 40);
    expect(snapMove({ frame: f, candidates: [a], canvas: CANVAS, scale: 1 }).frame.x).toBe(210);
    expect(snapMove({ frame: f, candidates: [a], canvas: CANVAS, scale: 2 }).frame).toBe(f);
  });

  it("un seuil explicite remplace le défaut, toujours en px écran", () => {
    const a = sub("a", frame(300, 100, 100, 100));
    const f = frame(200, 230, 90, 40); // bord droit à 10 de la ligne 300
    expect(snapMove({ frame: f, candidates: [a], canvas: CANVAS, scale: 1, threshold: 12 }).frame.x).toBe(210);
    expect(snapMove({ frame: f, candidates: [a], canvas: CANVAS, scale: 1, threshold: 4 }).frame).toBe(f);
    expect(snapMove({ frame: f, candidates: [a], canvas: CANVAS, scale: 1, threshold: 0 }).frame).toBe(f);
  });

  it("une échelle absurde (0, négative, NaN, ∞) ne fait ni accrocher ni planter", () => {
    const a = sub("a", frame(300, 100, 100, 100));
    const f = frame(210, 230, 90, 40); // bord droit EXACTEMENT sur la ligne 300
    for (const scale of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const out = snapMove({ frame: f, candidates: [a], canvas: CANVAS, scale });
      expect(out.frame).toBe(f);
      expect(out.guides).toEqual([]);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ÉCART ÉGAL — « quand le calque mobile est ENTRE deux voisins, accrocher pour égaliser les écarts ».
describe("snapMove — écart égal entre deux voisins", () => {
  const g = sub("g", frame(100, 200, 100, 100)); // bord droit 200
  const d = sub("d", frame(500, 200, 100, 100)); // bord gauche 500
  const candidates = [g, d];

  it("égalise les deux écarts, et le guide nomme les DEUX voisins", () => {
    // Espace libre 200..500 (300 de large) ; cadre mobile 60 de large -> écarts égaux quand son CENTRE
    // vaut (200+500)/2 = 350, donc x = 320 (écarts 120 et 120).
    // Départ en x=316 : centre 346, à 4 de 350. Les autres positions x sont à ≥ 24 (376 -> 400), donc
    // l'écart égal gagne. y = 210, h = 30 : positions 210/225/240, lignes y les plus proches 200 et
    // 250 -> minimum 10, hors seuil, donc l'axe y ne bouge pas.
    const out = snapMove({ frame: frame(316, 210, 60, 30), candidates, canvas: CANVAS, scale: 1 });
    expect(out.frame.x).toBe(320);
    expect(out.frame.y).toBe(210);
    expect(out.frame.x - 200).toBe(500 - (out.frame.x + out.frame.w)); // écarts ÉGAUX
    expect(out.guides).toEqual([{
      axis: "x", at: 350, from: 200, to: 300, kind: "spacing", targetIds: ["d", "g"],
    } satisfies SnapGuide]);
  });

  it("il faut un CHEVAUCHEMENT sur l'axe perpendiculaire — sinon l'écart n'est pas un écart visible", () => {
    // MÊME x que le test précédent, seul y change : le cadre passe SOUS les deux voisins, il n'est
    // plus « entre » eux au sens visuel, et le candidat d'écart égal disparaît. Aucune autre ligne
    // n'est à portée (y 500/515/530 -> ≥ 70 de 400 et 600).
    const dehors = frame(316, 500, 60, 30);
    const out = snapMove({ frame: dehors, candidates, canvas: CANVAS, scale: 1 });
    expect(out.frame).toBe(dehors);
    expect(out.guides).toEqual([]);
  });

  it("un seul voisin ne suffit pas", () => {
    const seul = frame(316, 210, 60, 30);
    const out = snapMove({ frame: seul, candidates: [g], canvas: CANVAS, scale: 1 });
    expect(out.frame).toBe(seul);
    expect(out.guides).toEqual([]);
  });

  it("fonctionne aussi verticalement", () => {
    // Voisins empilés : haut 100..200, bas 500..600 -> espace 200..500, centre 350.
    // Cadre 40 de haut -> y = 330 pour des écarts égaux (130 et 130) ; départ à 334 (centre 354).
    // x = 210, w = 50 : positions 210/235/260, lignes x 200/250/300 (voisins) et 266,67 -> ≥ 6,67…
    // ATTENTION : 260 -> 266,67 vaut 6,67, DANS le seuil. C'est voulu : l'axe x accroche donc aussi,
    // et le test vérifie l'axe y sans prétendre qu'il est seul.
    const haut = sub("haut", frame(200, 100, 100, 100));
    const bas = sub("bas", frame(200, 500, 100, 100));
    const out = snapMove({ frame: frame(210, 334, 50, 40), candidates: [haut, bas], canvas: CANVAS, scale: 1 });
    expect(out.frame.y).toBe(330);
    const vertical = out.guides.filter((gu) => gu.axis === "y");
    expect(vertical).toHaveLength(1);
    expect(vertical[0].kind).toBe("spacing");
    expect(vertical[0].at).toBe(350);
    expect(vertical[0].targetIds).toEqual(["bas", "haut"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LA FONCTION DE CHOIX — « quel candidat gagne ». C'est le point où la Tâche 2 a livré un défaut
// invisible à 79 tests verts : chaque propriété était vraie EN CHAQUE POINT testé alors que la
// fonction de choix sautait ENTRE ces points.
describe("snapMove — départage déterministe entre candidats concurrents", () => {
  it("à distance ÉGALE, la PRIORITÉ DE NATURE tranche (bord de calque > centre du plan de travail)", () => {
    // Cadre 42 de large en x=404 : bord gauche 404 (à 4 du centre du plan de travail, 400) et bord
    // droit 446 (à 4 du bord gauche de « c », 450). DEUX candidats à distance 4 mais des cibles
    // DIFFÉRENTES (x = 400 contre x = 408) : le départage est donc observable, pas théorique.
    const c = sub("c", frame(450, 100, 60, 100));
    const out = snapMove({ frame: frame(404, 250, 42, 40), candidates: [c], canvas: CANVAS, scale: 1 });
    expect(out.frame.x).toBe(408); // le bord de calque gagne
    expect(out.frame.x + out.frame.w).toBe(450);
    expect(out.guides).toHaveLength(1);
    expect(out.guides[0].kind).toBe("layer-edge");
    expect(out.guides[0].at).toBe(450);
  });

  it("à distance et nature égales, la plus PETITE coordonnée gagne — et l'ordre d'entrée n'y change rien", () => {
    // Deux bords gauches de calque à 400 et 408, bord gauche mobile à 404 : distance 4 des deux côtés,
    // même nature, même bord mobile. Seule la coordonnée départage.
    //
    // Les ids sont choisis pour CONTREDIRE la coordonnée (« zz » à 400, « aa » à 408) : sans le
    // critère de coordonnée, le départage tomberait sur l'id et « aa » (à 408) gagnerait. Une première
    // version de ce test nommait les calques d1/d2 dans l'ordre des coordonnées — la mutation qui
    // supprime le critère de coordonnée la laissait VERTE, puisque l'id disait alors la même chose.
    const bas = sub("zz", frame(400, 100, 300, 100));
    const haut = sub("aa", frame(408, 100, 300, 100));
    for (const ordre of [[bas, haut], [haut, bas]]) {
      const out = snapMove({ frame: frame(404, 250, 42, 40), candidates: ordre, canvas: CANVAS, scale: 1 });
      expect(out.frame.x).toBe(400);
      expect(out.guides).toHaveLength(1);
      expect(out.guides[0].at).toBe(400);
      expect(out.guides[0].targetIds).toEqual(["zz"]);
    }
  });

  it("le résultat est IDENTIQUE (cadre ET guides) sous toute permutation des candidats", () => {
    // « alpha » et « zeta » partagent le bord gauche 100 : la ligne gagnante est portée par DEUX
    // calques, donc `targetIds` doit être agrégé ET trié, sinon l'ordre d'entrée fuirait par là.
    const l = [
      sub("zeta", frame(100, 100, 200, 100)), // x 100/200/300, y 100/150/200
      sub("alpha", frame(100, 400, 40, 60)),  // x 100/120/140, y 400/430/460
      sub("mu", frame(500, 100, 100, 100)),   // x 500/550/600
      sub("omega", frame(96, 300, 40, 40)),   // x 96/116/136, y 300/320/340
    ];
    const mobile = frame(104, 250, 50, 40); // positions x 104/129/154 ; 104 -> 100 = 4 gagne
    const base = snapMove({ frame: mobile, candidates: l, canvas: CANVAS, scale: 1 });
    expect(base.frame.x).toBe(100);
    expect(base.guides).toHaveLength(1);
    expect(base.guides[0].targetIds).toEqual(["alpha", "zeta"]);

    for (const p of [[l[3], l[2], l[1], l[0]], [l[1], l[3], l[0], l[2]], [l[2], l[0], l[3], l[1]]]) {
      const out = snapMove({ frame: mobile, candidates: p, canvas: CANVAS, scale: 1 });
      expect(out.frame).toEqual(base.frame);
      expect(out.guides).toEqual(base.guides);
    }
  });

  it("la position accrochée est CONTINUE en la position du curseur sauf aux sauts d'accroche, et les sauts sont BORNÉS par 2×seuil", () => {
    // Balayage de 60 px gabarit au pas de 0,001 px à travers plusieurs zones d'accroche CONCURRENTES
    // (les deux calques donnent les lignes x 380/400/420 et 430/445/460, plus 266,67/400/533,33 du
    // plan de travail ; avec trois bords mobiles cela fait une vingtaine de cibles qui se recouvrent).
    // Quatre propriétés, à tenir ENSEMBLE — chacune tue une implémentation dégénérée différente :
    //   1. tout saut entre deux pas consécutifs est ≤ 2×seuil (+ le pas). Le choix « la cible la plus
    //      proche » commute AU MILIEU de deux cibles, toutes deux à moins du seuil : l'écart maximal
    //      possible entre deux plateaux voisins est donc exactement 2×seuil. Une fonction de choix qui
    //      saute davantage (le défaut de la Tâche 2) est rouge ici ;
    //   2. hors de toute zone, la sortie est EXACTEMENT l'entrée -> un moteur qui renverrait une
    //      constante échoue ;
    //   3. il existe AU MOINS un vrai saut -> un moteur qui n'accroche jamais échoue aussi ;
    //   4. la sortie est croissante en l'entrée (la cible la plus proche est monotone).
    const candidates = [
      sub("p", frame(380, 100, 40, 100)),
      sub("q", frame(430, 100, 30, 100)),
    ];
    const scale = 1;
    const seuil = SNAP_THRESHOLD_PX / scale;
    const pas = 0.001;
    let précédent: number | null = null;
    let sautMax = 0;
    let sauts = 0;
    let identitéRompue = 0;
    let monotonieRompue = 0;
    for (let x = 350; x <= 410; x += pas) {
      const out = snapMove({ frame: frame(x, 250, 50, 40), candidates, canvas: CANVAS, scale });
      if (out.guides.length === 0 && out.frame.x !== x) identitéRompue++;
      if (précédent !== null) {
        const saut = Math.abs(out.frame.x - précédent);
        if (saut > pas * 2) sauts++;
        if (out.frame.x < précédent - 1e-9) monotonieRompue++;
        sautMax = Math.max(sautMax, saut);
      }
      précédent = out.frame.x;
    }
    expect(identitéRompue).toBe(0);
    expect(monotonieRompue).toBe(0);
    expect(sautMax).toBeLessThanOrEqual(2 * seuil + pas);
    expect(sauts).toBeGreaterThan(0);
    expect(sautMax).toBeGreaterThan(0.5); // il s'est VRAIMENT passé des accroches
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// REDIMENSIONNEMENT — quels bords bougent vient de `handleAxes` (exportée par la Tâche 2), jamais
// d'une seconde table.
describe("snapResize — seuls les bords PORTÉS par la poignée accrochent", () => {
  const start = frame(100, 100, 200, 150); // bords x 100/300, y 100/250

  it("poignée « e » : le bord EST accroche, et le cadre NE SE DÉPLACE PAS (x/y/h bit-identiques)", () => {
    // Glisser (+6, 0) -> bord droit brut 306, à 2 de la ligne 308 -> delta corrigé à +8, w = 208.
    const voisin = sub("v", frame(308, 90, 60, 180)); // x 308/338/368, y 90/180/270
    const out = snapResize({
      probe: resizeProbe(start, "e"), delta: { x: 6, y: 0 }, axes: handleAxes("e"),
      candidates: [voisin], canvas: CANVAS, scale: 1,
    });
    const f = computeResizedFrame(start, "e", out.delta);
    expect(f.w).toBe(208);
    expect(f.x).toBe(100); // le bord ANCRÉ n'a pas bougé d'un bit
    expect(f.y).toBe(100);
    expect(f.h).toBe(150);
    expect(out.guides).toHaveLength(1);
    expect(out.guides[0].axis).toBe("x");
    expect(out.guides[0].at).toBe(308);
    expect(out.guides[0].targetIds).toEqual(["v"]);
  });

  it("poignée « e » : une ligne collée au bord OUEST (ancré) n'accroche RIEN", () => {
    // La ligne 98 est à 2 px du bord ouest ANCRÉ (100). Ce bord ne bouge pas pendant ce geste : il ne
    // peut donc pas accrocher. Un moteur qui redériverait « quels bords bougent » à l'envers — ou qui
    // testerait les quatre bords — accrocherait ici et DÉPLACERAIT le calque en cours de
    // redimensionnement, exactement ce que le plan interdit.
    const delta = { x: 40, y: 0 }; // bord droit brut 340 : à ≥ 60 de toute ligne
    const ouest = sub("ouest", frame(98, 400, 40, 40));
    const out = snapResize({
      probe: resizeProbe(start, "e"), delta, axes: handleAxes("e"),
      candidates: [ouest], canvas: CANVAS, scale: 1,
    });
    expect(out.delta).toBe(delta);
    expect(out.guides).toEqual([]);
  });

  it("poignée « w » : le bord OUEST accroche, le bord EST reste EXACTEMENT où il était", () => {
    // Glisser (-6, 0) -> bord gauche brut 94 ; ligne 90 -> distance 4 -> x = 90, w = 210.
    const ligne = sub("g", frame(90, 90, 40, 180)); // x 90/110/130
    const out = snapResize({
      probe: resizeProbe(start, "w"), delta: { x: -6, y: 0 }, axes: handleAxes("w"),
      candidates: [ligne], canvas: CANVAS, scale: 1,
    });
    const f = computeResizedFrame(start, "w", out.delta);
    expect(f.x).toBe(90);
    expect(f.w).toBe(210);
    expect(f.x + f.w).toBe(300); // bord est ancré, inchangé
    expect(out.guides).toHaveLength(1);
    expect(out.guides[0].at).toBe(90);
  });

  it("poignée « n » : seul l'axe y peut accrocher, jamais x", () => {
    // Le candidat porte À LA FOIS une ligne x à 2 px du bord droit (302 contre 300) et une ligne y à
    // 3 px du bord haut brut (91 contre 94). Seule la seconde doit s'allumer : « n » ne porte aucun
    // axe x.
    const both = sub("b", frame(302, 91, 40, 40));
    const out = snapResize({
      probe: resizeProbe(start, "n"), delta: { x: 0, y: -6 }, axes: handleAxes("n"),
      candidates: [both], canvas: CANVAS, scale: 1,
    });
    const f = computeResizedFrame(start, "n", out.delta);
    expect(out.guides).toHaveLength(1);
    expect(out.guides[0].axis).toBe("y");
    expect(f.y).toBe(91);
    expect(f.y + f.h).toBe(250); // bord bas ancré
    expect(f.x).toBe(100);
    expect(f.w).toBe(200);
  });

  it("poignée d'ANGLE sans modificateur : les deux axes accrochent INDÉPENDAMMENT (deux guides)", () => {
    // « se » + (+6, +6) -> bord droit brut 306 (à 2 de 308), bord bas brut 256 (à 4 de 260).
    const angle = sub("c", frame(308, 100, 50, 160)); // x 308/333/358, y 100/180/260
    const out = snapResize({
      probe: resizeProbe(start, "se"), delta: { x: 6, y: 6 }, axes: handleAxes("se"),
      candidates: [angle], canvas: CANVAS, scale: 1,
    });
    const f = computeResizedFrame(start, "se", out.delta);
    expect(f.w).toBe(208);
    expect(f.h).toBe(160);
    expect(f.x).toBe(100);
    expect(f.y).toBe(100);
    expect(out.guides).toHaveLength(2);
    expect(out.guides.map((gu) => gu.axis)).toEqual(["x", "y"]);
  });

  it("aucun candidat dans le seuil : le delta est rendu TEL QUEL (même référence) et aucun guide", () => {
    const delta = { x: 6, y: 6 };
    const out = snapResize({
      probe: resizeProbe(start, "se"), delta, axes: handleAxes("se"),
      candidates: [sub("loin", frame(600, 500, 40, 40))], canvas: CANVAS, scale: 1,
    });
    expect(out.delta).toBe(delta);
    expect(out.guides).toEqual([]);
  });

  it("le seuil du redimensionnement est lui aussi en px ÉCRAN", () => {
    // Bord droit brut à 10 px GABARIT de la ligne : accroche à k=0,5 (5 px écran), pas à k=1.
    const ligne = sub("l", frame(320, 90, 40, 180)); // x 320/340/360
    const delta = { x: 10, y: 0 }; // bord droit brut 310
    const àDemi = snapResize({
      probe: resizeProbe(start, "e"), delta, axes: handleAxes("e"),
      candidates: [ligne], canvas: CANVAS, scale: 0.5,
    });
    expect(computeResizedFrame(start, "e", àDemi.delta).w).toBe(220);
    const àUn = snapResize({
      probe: resizeProbe(start, "e"), delta, axes: handleAxes("e"),
      candidates: [ligne], canvas: CANVAS, scale: 1,
    });
    expect(àUn.delta).toBe(delta);
    expect(àUn.guides).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PRÉCÉDENCE ACCROCHE / MODIFICATEURS (note 2 du brief) : le MODIFICATEUR CONTRAINT, l'accroche se
// projette sur la liberté RESTANTE. Le ratio de Maj n'est donc JAMAIS plié et le centre d'Alt jamais
// déplacé ; sous Maj il ne reste qu'UN degré de liberté, donc au plus UN guide.
describe("snapResize — précédence avec Maj (ratio verrouillé) : le ratio gagne, l'accroche se projette", () => {
  const start = frame(100, 100, 200, 150); // ratio 4/3
  const maj: ResizeOptions = { lockAspectRatio: true };

  it("un seul axe accroche, EXACTEMENT, et le ratio reste exact", () => {
    // « se » + Maj, delta (20, 0) : t = (20×200 + 0×150)/(200² + 150²) = 4000/62500 = 0,064
    //   -> w = 212,8 ; h = 159,6 ; bord droit brut 312,8 ; bord bas brut 259,6.
    // Ligne x 310 -> il faut w = 210, soit t' = 0,05 -> h = 157,5, bord bas 257,5.
    // Le ratio est préservé PAR CONSTRUCTION (les deux dimensions valent start×(1+t')).
    // Le bord bas brut (259,6) est à ≥ 40 de toute ligne y, donc aucun concurrent sur l'autre axe.
    const ligne = sub("l", frame(310, 90, 60, 40)); // x 310/340/370, y 90/110/130
    const out = snapResize({
      probe: resizeProbe(start, "se", maj), delta: { x: 20, y: 0 }, axes: handleAxes("se"),
      candidates: [ligne], canvas: CANVAS, scale: 1,
    });
    const f = computeResizedFrame(start, "se", out.delta, maj);
    expect(f.w).toBeCloseTo(210, 9);
    expect(f.h).toBeCloseTo(157.5, 9);
    expect(f.x + f.w).toBeCloseTo(310, 9); // le bord accroché atterrit SUR la ligne
    expect(f.w / f.h).toBeCloseTo(200 / 150, 12); // ratio intact — la Tâche 2 n'est pas pliée
    expect(f.x).toBe(100);
    expect(f.y).toBe(100);
    expect(out.guides).toHaveLength(1); // JAMAIS deux sous Maj
    expect(out.guides[0].axis).toBe("x");
    expect(out.guides[0].at).toBe(310);
  });

  it("deux candidats sur des axes DIFFÉRENTS : le plus proche gagne, seul", () => {
    // Même geste ; on ajoute une ligne y à 0,4 du bord bas brut (259,6 -> 260) alors que la ligne x
    // est à 2,8. Le candidat y est plus proche : c'est lui qui gagne, et lui seul.
    // h = 160 -> t' = 160/150 - 1 -> w = 200 × (1 + t') = 213,333…
    const lx = sub("lx", frame(310, 500, 60, 40));
    const ly = sub("ly", frame(500, 260, 40, 60));
    const out = snapResize({
      probe: resizeProbe(start, "se", maj), delta: { x: 20, y: 0 }, axes: handleAxes("se"),
      candidates: [lx, ly], canvas: CANVAS, scale: 1,
    });
    const f = computeResizedFrame(start, "se", out.delta, maj);
    expect(out.guides).toHaveLength(1);
    expect(out.guides[0].axis).toBe("y");
    expect(f.y + f.h).toBeCloseTo(260, 9);
    expect(f.h).toBeCloseTo(160, 9);
    expect(f.w).toBeCloseTo(200 * (160 / 150), 9);
    expect(f.w / f.h).toBeCloseTo(200 / 150, 12);
  });

  it("sans Maj, le MÊME geste n'accroche RIEN — la différence vient bien du modificateur", () => {
    // Sans Maj, delta (20, 0) donne un bord droit brut de 320 (à 10 de 310) et un bord bas INCHANGÉ à
    // 250 (à 10 de 260) : les deux sont hors seuil. C'est la preuve que le test précédent mesurait
    // l'effet de Maj — qui déplace les DEUX bords via `t` — et pas autre chose.
    const lx = sub("lx", frame(310, 500, 60, 40));
    const ly = sub("ly", frame(500, 260, 40, 60));
    const delta = { x: 20, y: 0 };
    const out = snapResize({
      probe: resizeProbe(start, "se"), delta, axes: handleAxes("se"),
      candidates: [lx, ly], canvas: CANVAS, scale: 1,
    });
    expect(out.guides).toEqual([]);
    expect(out.delta).toBe(delta);
  });
});

describe("snapResize — précédence avec Alt (redimensionnement depuis le centre)", () => {
  const start = frame(100, 100, 200, 150);

  it("le centre reste EXACTEMENT fixe, et le bord tiré atterrit sur la ligne", () => {
    // « e » + Alt, delta (+6, 0) : w = 200 + 2×6 = 212, x = 94 -> bord droit 306, centre 200.
    // Ligne x 308 -> il faut delta +8 : w = 216, x = 92, bord droit 308, centre TOUJOURS 200.
    const alt: ResizeOptions = { fromCenter: true };
    const ligne = sub("l", frame(308, 90, 60, 180));
    const out = snapResize({
      probe: resizeProbe(start, "e", alt), delta: { x: 6, y: 0 }, axes: handleAxes("e"),
      candidates: [ligne], canvas: CANVAS, scale: 1,
    });
    const f = computeResizedFrame(start, "e", out.delta, alt);
    expect(f.x + f.w).toBeCloseTo(308, 9);
    expect(f.x + f.w / 2).toBeCloseTo(200, 9); // centre de DÉPART, non déplacé
    expect(f.w).toBeCloseTo(216, 9);
    expect(out.guides).toHaveLength(1);
  });

  it("Maj + Alt : ratio exact ET centre fixe, un seul guide", () => {
    // « se » + Maj + Alt, delta (20, 0) : t = 0,064 -> w = 200×(1+2×0,064) = 225,6, h = 169,2, centre
    // fixe (200, 175) -> bord droit 312,8. Ligne x 310 -> w = 220, h = 165, centre inchangé.
    const both: ResizeOptions = { lockAspectRatio: true, fromCenter: true };
    const ligne = sub("l", frame(310, 500, 60, 40));
    const out = snapResize({
      probe: resizeProbe(start, "se", both), delta: { x: 20, y: 0 }, axes: handleAxes("se"),
      candidates: [ligne], canvas: CANVAS, scale: 1,
    });
    const f = computeResizedFrame(start, "se", out.delta, both);
    expect(f.x + f.w).toBeCloseTo(310, 9);
    expect(f.x + f.w / 2).toBeCloseTo(200, 9);
    expect(f.y + f.h / 2).toBeCloseTo(175, 9);
    expect(f.w).toBeCloseTo(220, 9);
    expect(f.h).toBeCloseTo(165, 9);
    expect(f.w / f.h).toBeCloseTo(200 / 150, 12);
    expect(out.guides).toHaveLength(1);
  });
});

describe("snapResize — une accroche IRRÉALISABLE ne s'allume pas", () => {
  it("le clamp de taille minimale gagne : pas de guide mensonger", () => {
    // Un glisser qui écrase le calque très en dessous du minimum : le cadre est bloqué à w = 1, donc
    // AUCUN ajustement du delta ne peut poser le bord droit sur la ligne 105 (à 4 du bord droit
    // clampé, 101). L'accroche doit se retirer proprement plutôt qu'annoncer un guide sur une
    // accroche qui n'a pas eu lieu.
    const start = frame(100, 100, 200, 150);
    const ligne = sub("l", frame(105, 90, 40, 180));
    const delta = { x: -5000, y: 0 };
    const out = snapResize({
      probe: resizeProbe(start, "e"), delta, axes: handleAxes("e"),
      candidates: [ligne], canvas: CANVAS, scale: 1,
    });
    expect(out.guides).toEqual([]);
    expect(out.delta).toBe(delta);
    expect(computeResizedFrame(start, "e", out.delta).w).toBe(1);
  });

  it("clamp PARTIEL : la pente n'est pas nulle mais la cible reste inatteignable — c'est la VÉRIFICATION qui retire l'accroche", () => {
    // Cas plus retors que le précédent, et le seul que la vérification d'exactitude attrape SEULE.
    // Glisser (−199,5) sur un calque 200 de large : w = 0,5 -> clampé à 1, bord droit 101. La pente
    // mesurée n'est PAS nulle (à −198,5 : w = 1,5, bord droit 101,5 -> pente 0,5), donc la garde de
    // pente ne suffit pas ; la résolution propose −203,5, qui reclampe à w = 1 et laisse le bord droit
    // à 101 au lieu des 99 visés. Sans la re-vérification, le moteur annoncerait un guide sur 99 alors
    // que le cadre n'a pas bougé d'un pixel — un guide MENSONGER. (Mutation mesurée : supprimer la
    // vérification laissait les 40 autres tests de ce fichier verts.)
    const start = frame(100, 100, 200, 150);
    const ligne = sub("l", frame(99, 90, 40, 180)); // ligne x 99, à 2 du bord droit clampé (101)
    const delta = { x: -199.5, y: 0 };
    const brut = computeResizedFrame(start, "e", delta);
    expect(brut.w).toBe(1); // clampé
    expect(brut.x + brut.w).toBe(101);
    const out = snapResize({
      probe: resizeProbe(start, "e"), delta, axes: handleAxes("e"),
      candidates: [ligne], canvas: CANVAS, scale: 1,
    });
    expect(out.guides).toEqual([]);
    expect(out.delta).toBe(delta);
  });
});

describe("snapResize — un calque TOURNÉ ne s'accroche pas (décision documentée)", () => {
  const start = frame(100, 100, 200, 150);
  const ligne = sub("l", frame(308, 90, 60, 180));

  it("à rotation ≠ 0 le delta ressort intact, aucun guide, et le cadre reste EXACTEMENT celui de la Tâche 1", () => {
    const delta = { x: 6, y: 0 };
    for (const rotationDeg of [15, 45, 90, 180, -37]) {
      const options: ResizeOptions = { rotationDeg };
      const out = snapResize({
        probe: resizeProbe(start, "e", options), delta, axes: handleAxes("e"),
        candidates: [ligne], canvas: CANVAS, scale: 1, rotationDeg,
      });
      expect(out.delta).toBe(delta);
      expect(out.guides).toEqual([]);
      expect(computeResizedFrame(start, "e", out.delta, options))
        .toEqual(computeResizedFrame(start, "e", delta, options));
    }
  });

  it("à rotation 0 le MÊME geste accroche — la différence vient bien de la rotation", () => {
    const out = snapResize({
      probe: resizeProbe(start, "e"), delta: { x: 6, y: 0 }, axes: handleAxes("e"),
      candidates: [ligne], canvas: CANVAS, scale: 1, rotationDeg: 0,
    });
    expect(out.guides).toHaveLength(1);
    expect(computeResizedFrame(start, "e", out.delta).w).toBe(208);
  });
});

describe("snapMove — un DÉPLACEMENT accroche même sur un calque tourné (aveugle à la rotation, comme la Tâche 4)", () => {
  it("l'accroche porte sur le cadre NON PIVOTÉ, quelle que soit la rotation affichée", () => {
    // `snapMove` ne reçoit même pas la rotation, et c'est le choix : une TRANSLATION commute avec la
    // rotation, donc accrocher le cadre non pivoté déplace le calque affiché d'exactement la même
    // quantité — rien ne dérive à l'écran. C'est le MÊME choix que lib/studio/align.ts (décision 1) ;
    // le redimensionnement, lui, ne peut pas en dire autant (voir le bloc précédent et snap.ts).
    const a = sub("a", frame(100, 100, 200, 100));
    const out = snapMove({ frame: frame(104, 250, 50, 40), candidates: [a], canvas: CANVAS, scale: 1 });
    expect(out.frame.x).toBe(100);
  });
});

describe("snapResize — la fonction de choix est CONTINUE : les sauts restent bornés par 2×seuil, même sous Maj", () => {
  // LE piège de la Tâche 2, reporté sur CETTE fonction de choix (« quel candidat gagne »). Sous Maj il
  // n'y a qu'un degré de liberté : accrocher le bord d'un axe fait bouger l'AUTRE axe du facteur du
  // ratio. Sur un calque à ratio extrême (1000×10), accrocher le bord BAS de 1px déplace le bord DROIT
  // de 100px — et si le gagnant bascule d'un axe à l'autre au milieu du geste, le cadre SAUTE de cette
  // amplitude pour un mouvement de curseur de 0,001px, alors que chaque propriété ponctuelle reste
  // vraie. Mesuré avant correctif sur ce balayage exact : saut de 50,0px pour un seuil de 8.
  //
  // La règle qui ferme ça : une accroche dont la correction RÉALISÉE dépasse le seuil sur un bord
  // quelconque ne s'allume pas (une accroche est par définition une PETITE correction). Le candidat y
  // est alors écarté sur ce calque-là, il n'y a plus de bascule, et la borne 2×seuil tient.
  it("1000×10 sous Maj : aucun saut supérieur à 2×seuil, et l'accroche du grand axe a bien lieu", () => {
    const start = frame(100, 100, 1000, 10); // bords x 100/1100, y 100/110 ; ratio 100
    const maj: ResizeOptions = { lockAspectRatio: true };
    const lx = sub("lx", frame(1150, 90, 40, 200)); // ligne x 1150 (à 50 du bord droit brut)
    const ly = sub("ly", frame(1400, 111, 40, 200)); // ligne y 111 (à 1 du bord bas brut)
    const seuil = SNAP_THRESHOLD_PX;
    const pas = 0.001;
    let précédentW: number | null = null;
    let précédentH: number | null = null;
    let sautMax = 0;
    let sauts = 0;
    let identitéRompue = 0;
    let ratioRompu = 0;
    let guideMenteur = 0;
    let plateau = 0;
    for (let dx = 40; dx <= 58; dx += pas) {
      const delta = { x: dx, y: 0 };
      const out = snapResize({
        probe: resizeProbe(start, "se", maj), delta, axes: handleAxes("se"),
        candidates: [lx, ly], canvas: CANVAS, scale: 1,
      });
      const f = computeResizedFrame(start, "se", out.delta, maj);
      const brut = computeResizedFrame(start, "se", delta, maj);
      if (out.guides.length === 0 && (f.w !== brut.w || f.h !== brut.h)) identitéRompue++;
      if (Math.abs(f.w / f.h - 1000 / 10) > 1e-9) ratioRompu++;
      // HONNÊTETÉ du guide, sur les 18 000 pas : la ligne annoncée est bien celle du bord correspondant
      // du cadre RENDU — jamais un guide qui montre une accroche que le cadre n'a pas réalisée.
      for (const g of out.guides) {
        const bord = g.axis === "x" ? f.x + f.w : f.y + f.h;
        if (Math.abs(bord - g.at) > 1e-6) guideMenteur++;
      }
      if (out.guides.length > 0 && Math.abs(f.x + f.w - 1150) < 1e-6) plateau++;
      if (précédentW !== null && précédentH !== null) {
        const saut = Math.max(Math.abs(f.w - précédentW), Math.abs(f.h - précédentH));
        if (saut > pas * 2) sauts++;
        sautMax = Math.max(sautMax, saut);
      }
      précédentW = f.w;
      précédentH = f.h;
    }
    expect(identitéRompue).toBe(0);
    expect(ratioRompu).toBe(0); // Maj n'est JAMAIS plié, accroche ou pas
    expect(guideMenteur).toBe(0);
    expect(sautMax).toBeLessThanOrEqual(2 * seuil + pas);
    expect(sauts).toBeGreaterThan(0); // il s'est vraiment passé une accroche…
    expect(plateau).toBeGreaterThan(1000); // …et c'est bien le grand axe qui accroche, sur tout un plateau
  });
});

describe("snapResize — le couplage est détecté dans LES DEUX SENS (revue Tâche 5, Mineur 2)", () => {
  it("un couplage y -> x seulement est bien détecté : UN guide, et aucun guide mensonger", () => {
    // La détection de couplage sonde la fonction de redimensionnement au lieu de redéclarer
    // `lockAspectRatio && isCorner` (décision 6). La revue a relevé que la première version poussait le
    // delta sur x et regardait le bord y : un couplage UNIDIRECTIONNEL y -> x passait donc inaperçu.
    // Aucun modificateur actuel ne fait ça — mais `snapResize` accepte un `probe` QUELCONQUE, donc la
    // propriété se teste directement, sans attendre un futur modificateur.
    //
    // Sonde synthétique, affine, couplée dans un seul sens :
    //   w = 200 + dx + 2·dy   (dy déplace le bord DROIT)      h = 150 + dy
    //   -> pousser x ne bouge PAS le bord bas ; pousser y déplace le bord droit de 2×.
    // Cadre brut (delta nul) : {100, 100, 200, 150}, bord droit 300, bord bas 250.
    // Lignes : x = 304 (à 4 du bord droit), y = 253 (à 3 du bord bas).
    //
    // COUPLÉ (correct) : un seul candidat, le plus proche -> y. dy = 3 -> w = 206, h = 153,
    //   bord bas 253 (sur sa ligne), bord droit 306. UN guide, sur y.
    // NON DÉTECTÉ (le défaut) : les deux axes seraient traités indépendamment -> x accroche d'abord
    //   (bord droit 304), puis y (dy = 3) fait glisser le bord droit à 310 — et le guide x, déjà allumé
    //   sur 304, devient FAUX. C'est ce mensonge que la dernière assertion interdit.
    const probe = (d: Point): Frame => ({ x: 100, y: 100, w: 200 + d.x + 2 * d.y, h: 150 + d.y });
    const lx = sub("lx", frame(304, 500, 40, 40)); // ligne x 304
    const ly = sub("ly", frame(600, 253, 40, 40)); // ligne y 253
    const out = snapResize({
      probe, delta: { x: 0, y: 0 }, axes: handleAxes("se"),
      candidates: [lx, ly], canvas: CANVAS, scale: 1,
    });
    const f = probe(out.delta);

    expect(out.guides).toHaveLength(1);
    expect(out.guides[0].axis).toBe("y");
    expect(out.guides[0].at).toBe(253);
    expect(f.y + f.h).toBeCloseTo(253, 9);
    expect(f.w).toBeCloseTo(206, 9);
    // Propriété d'HONNÊTETÉ, valable pour tout guide de redimensionnement : la ligne annoncée est
    // vraiment celle du bord correspondant du cadre RENDU.
    for (const g of out.guides) {
      const bord = g.axis === "x" ? f.x + f.w : f.y + f.h;
      expect(Math.abs(bord - g.at)).toBeLessThan(1e-6);
    }
    expect(out.guides.some((g) => g.at === 304)).toBe(false);
  });
});
