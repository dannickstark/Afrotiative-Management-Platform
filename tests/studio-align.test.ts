import { describe, it, expect } from "bun:test";
import type { Frame } from "@/lib/studio/scene";
import {
  ALIGN_MODES,
  alignFrames,
  alignParticipants,
  artboardFrame,
  boundingBox,
  distributeFrames,
  planAlign,
  planDistribute,
  type AlignMode,
  type AlignSubject,
} from "@/lib/studio/align";

// tests/studio-align.test.ts — Tâche 4 (U2, spec §4) : le module PUR aligner/répartir.
//
// ── Deux pièges que ce fichier est écrit pour éviter, nommés explicitement ────────────────────────
//
//  1. LA VACUITÉ. « Aligner un ensemble DÉJÀ aligné est un no-op (idempotent) » est satisfaite par une
//     fonction qui ne fait RIEN DU TOUT. Chaque test d'idempotence ci-dessous est donc APPARIÉ à un
//     test qui exige des COORDONNÉES EXACTES sur un ensemble non aligné — calculées à la main dans le
//     commentaire de la fixture, jamais recopiées depuis la sortie de l'implémentation — et le test
//     d'idempotence lui-même vérifie d'abord que la PREMIÈRE application a réellement déplacé quelque
//     chose (`expect(once).not.toEqual(input)`), sinon il ne prouverait rien.
//
//  2. « VRAI EN CHAQUE POINT, FAUX ENTRE LES POINTS » (deux fois vu dans ce programme, voir
//     progress.md). Pour la répartition, le point sensible n'est pas l'arithmétique des écarts — elle
//     est linéaire — mais la fonction de CHOIX : l'ORDRE dans lequel les cadres sont posés. Un cas
//     heureux (trois cadres déjà croissants en x, largeurs égales, dans l'ordre du tableau) passerait
//     avec une implémentation qui ignore complètement la position et se contente de l'ordre du
//     tableau. Ce fichier visite donc : entrée en ordre INVERSE, entrée PERMUTÉE, écarts déjà égaux,
//     écarts NULS (cadres jointifs), cadres qui SE CHEVAUCHENT (écart négatif), et deux cadres au
//     MÊME x (égalité dans le tri).
const EPS = 9; // décimales pour toBeCloseTo — « à epsilon près » du plan

// ── Fixture « non alignée », coordonnées calculées à la main ─────────────────────────────────────
// f1 = {10,20,100,50}   droite=110  bas=70
// f2 = {200,100,60,80}  droite=260  bas=180
// f3 = {120,300,40,20}  droite=160  bas=320
// boîte englobante : x=min(10,200,120)=10 · y=min(20,100,300)=20
//                    droite=max(110,260,160)=260 -> w=250 · bas=max(70,180,320)=320 -> h=300
const BBOX: Frame = { x: 10, y: 20, w: 250, h: 300 };
function unaligned(): Frame[] {
  return [
    { x: 10, y: 20, w: 100, h: 50 },
    { x: 200, y: 100, w: 60, h: 80 },
    { x: 120, y: 300, w: 40, h: 20 },
  ];
}

// Les six colonnes attendues, dérivées de BBOX à la main (et non de la fonction testée) :
//   left    x = 10                       -> 10, 10, 10
//   right   x = 10+250-w = 260-w         -> 160, 200, 220
//   hcenter x = 10+(250-w)/2             -> 85, 105, 115
//   top     y = 20                       -> 20, 20, 20
//   bottom  y = 20+300-h = 320-h         -> 270, 240, 300
//   vmiddle y = 20+(300-h)/2             -> 145, 130, 160
const EXPECTED_BBOX_ALIGN: Record<AlignMode, { axis: "x" | "y"; values: number[] }> = {
  left: { axis: "x", values: [10, 10, 10] },
  right: { axis: "x", values: [160, 200, 220] },
  hcenter: { axis: "x", values: [85, 105, 115] },
  top: { axis: "y", values: [20, 20, 20] },
  bottom: { axis: "y", values: [270, 240, 300] },
  vmiddle: { axis: "y", values: [145, 130, 160] },
};

describe("boundingBox", () => {
  it("englobe exactement les cadres fournis (bords extrêmes, pas la somme des largeurs)", () => {
    expect(boundingBox(unaligned())).toEqual(BBOX);
  });

  it("d'un seul cadre, c'est ce cadre — et c'est pourquoi une sélection SIMPLE ne peut pas s'aligner sur sa propre boîte", () => {
    const only: Frame = { x: 33, y: 44, w: 55, h: 66 };
    expect(boundingBox([only])).toEqual(only);
  });

  it("d'aucun cadre, c'est `null` — jamais une boîte à zéro qui se lirait comme le coin haut-gauche", () => {
    expect(boundingBox([])).toBeNull();
  });

  it("ne dépend pas de l'ordre du tableau", () => {
    const [a, b, c] = unaligned();
    expect(boundingBox([c, a, b])).toEqual(BBOX);
  });
});

describe("alignFrames — sur la boîte englobante de la sélection (cible implicite)", () => {
  // LE test non vacuant : des coordonnées EXACTES, sur un ensemble qui n'était pas aligné.
  for (const mode of ALIGN_MODES) {
    it(`« ${mode} » déplace chaque cadre à la coordonnée attendue, calculée à la main`, () => {
      const { axis, values } = EXPECTED_BBOX_ALIGN[mode];
      const out = alignFrames(unaligned(), mode);
      expect(out.map((f) => f[axis])).toEqual(values);
    });
  }

  it("l'ensemble des six modes est bien celui qu'expose le module (garde de complétude sur la VRAIE source)", () => {
    // Pas un miroir recopié à la main (le défaut déjà rencontré dans ce dépôt, voir SHAPE_KINDS) :
    // on compare la liste canonique du module à celle que ce fichier prétend couvrir.
    expect(Object.keys(EXPECTED_BBOX_ALIGN).sort()).toEqual([...ALIGN_MODES].map(String).sort());
    expect(ALIGN_MODES).toHaveLength(6);
  });

  it("ne redimensionne JAMAIS : w et h sont bit-identiques pour les six modes", () => {
    for (const mode of ALIGN_MODES) {
      const input = unaligned();
      const out = alignFrames(input, mode);
      expect(out.map((f) => [f.w, f.h])).toEqual(input.map((f) => [f.w, f.h]));
    }
  });

  it("ne touche PAS l'axe qu'il ne concerne pas (aligner à gauche ne bouge aucun y)", () => {
    const input = unaligned();
    for (const mode of ["left", "right", "hcenter"] as const) {
      expect(alignFrames(input, mode).map((f) => f.y)).toEqual(input.map((f) => f.y));
    }
    for (const mode of ["top", "bottom", "vmiddle"] as const) {
      expect(alignFrames(input, mode).map((f) => f.x)).toEqual(input.map((f) => f.x));
    }
  });

  it("est IDEMPOTENT — et la première application, elle, a bel et bien déplacé des cadres", () => {
    for (const mode of ALIGN_MODES) {
      const input = unaligned();
      const once = alignFrames(input, mode);
      // Sans cette ligne, tout ce bloc serait satisfait par une fonction identité (le piège de
      // vacuité nommé en tête de fichier).
      expect(once).not.toEqual(input);
      const twice = alignFrames(once, mode);
      expect(twice).toEqual(once);
    }
  });

  it("un ensemble DÉJÀ aligné traverse la fonction sans changer d'un bit", () => {
    const already: Frame[] = [
      { x: 50, y: 0, w: 100, h: 10 },
      { x: 50, y: 40, w: 20, h: 10 },
      { x: 50, y: 80, w: 70, h: 10 },
    ];
    expect(alignFrames(already, "left")).toEqual(already);
  });

  it("un SEUL cadre sur sa propre boîte est un no-op strict — la raison d'être de la cible « plan de travail »", () => {
    const only: Frame[] = [{ x: 10, y: 20, w: 100, h: 50 }];
    for (const mode of ALIGN_MODES) {
      expect(alignFrames(only, mode)).toEqual(only);
    }
  });

  it("aucun cadre -> aucun cadre", () => {
    expect(alignFrames([], "left")).toEqual([]);
  });

  it("ne mute pas son entrée", () => {
    const input = unaligned();
    const snapshot = structuredClone(input);
    for (const mode of ALIGN_MODES) alignFrames(input, mode);
    expect(input).toEqual(snapshot);
  });
});

describe("alignFrames — sur une cible EXPLICITE (le plan de travail)", () => {
  const ARTBOARD = artboardFrame({ width: 1000, height: 500 });
  const only: Frame[] = [{ x: 10, y: 20, w: 100, h: 50 }];

  it("artboardFrame place l'origine en (0,0) et prend les dimensions du canevas", () => {
    expect(ARTBOARD).toEqual({ x: 0, y: 0, w: 1000, h: 500 });
  });

  // Calculs à la main sur 1000×500, cadre 100×50 : left 0 · right 900 · hcenter 450
  //                                                top  0 · bottom 450 · vmiddle 225
  const EXPECTED_ARTBOARD: Record<AlignMode, { axis: "x" | "y"; value: number }> = {
    left: { axis: "x", value: 0 },
    right: { axis: "x", value: 900 },
    hcenter: { axis: "x", value: 450 },
    top: { axis: "y", value: 0 },
    bottom: { axis: "y", value: 450 },
    vmiddle: { axis: "y", value: 225 },
  };

  for (const mode of ALIGN_MODES) {
    it(`« ${mode} » d'un cadre unique se cale sur le plan de travail, pas sur lui-même`, () => {
      const { axis, value } = EXPECTED_ARTBOARD[mode];
      const [out] = alignFrames(only, mode, ARTBOARD);
      expect(out[axis]).toBe(value);
      expect([out.w, out.h]).toEqual([100, 50]);
    });
  }

  it("reste idempotent avec une cible explicite (la cible ne bouge pas, elle)", () => {
    for (const mode of ALIGN_MODES) {
      const once = alignFrames(only, mode, ARTBOARD);
      expect(alignFrames(once, mode, ARTBOARD)).toEqual(once);
    }
  });

  it("une cible explicite sur PLUSIEURS cadres les cale tous sur elle (chaque x égal au bord de la cible)", () => {
    const out = alignFrames(unaligned(), "left", ARTBOARD);
    expect(out.map((f) => f.x)).toEqual([0, 0, 0]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Répartition. Convention établie ici et vérifiée par les tests : les cadres EXTRÊMES (le premier et
// le dernier dans l'ordre des positions, PAS dans l'ordre du tableau) ne bougent pas ; les autres se
// replacent pour que les écarts entre cadres consécutifs soient égaux.
function gapsAlong(frames: readonly Frame[], axis: "horizontal" | "vertical"): number[] {
  const lead = (f: Frame) => (axis === "horizontal" ? f.x : f.y);
  const size = (f: Frame) => (axis === "horizontal" ? f.w : f.h);
  const sorted = [...frames].sort((a, b) => lead(a) - lead(b) || size(a) - size(b));
  return sorted.slice(1).map((f, i) => lead(f) - (lead(sorted[i]) + size(sorted[i])));
}

describe("distributeFrames — moins de trois cadres est un no-op", () => {
  it("zéro, un et deux cadres traversent la fonction inchangés (rien à répartir entre deux extrêmes)", () => {
    const zero: Frame[] = [];
    const one: Frame[] = [{ x: 10, y: 10, w: 20, h: 20 }];
    const two: Frame[] = [{ x: 10, y: 10, w: 20, h: 20 }, { x: 500, y: 300, w: 40, h: 40 }];
    for (const axis of ["horizontal", "vertical"] as const) {
      expect(distributeFrames(zero, axis)).toEqual(zero);
      expect(distributeFrames(one, axis)).toEqual(one);
      expect(distributeFrames(two, axis)).toEqual(two);
    }
  });
});

describe("distributeFrames — horizontal", () => {
  // g1 = {0,   w:100} · g2 = {150, w:50} · g3 = {400, w:100}
  // étendue = (400+100) - 0 = 500 · somme des largeurs = 250 · écart = (500-250)/2 = 125
  // pose : x=0 ; puis 0+100+125 = 225 ; puis extrême épinglé à 400
  function trio(): Frame[] {
    return [
      { x: 0, y: 0, w: 100, h: 10 },
      { x: 150, y: 5, w: 50, h: 10 },
      { x: 400, y: 9, w: 100, h: 10 },
    ];
  }

  it("produit les x attendus, calculés à la main", () => {
    expect(distributeFrames(trio(), "horizontal").map((f) => f.x)).toEqual([0, 225, 400]);
  });

  it("les écarts sont égaux, et les cadres extrêmes n'ont pas bougé", () => {
    const out = distributeFrames(trio(), "horizontal");
    const gaps = gapsAlong(out, "horizontal");
    expect(gaps).toHaveLength(2);
    for (const g of gaps) expect(g).toBeCloseTo(125, EPS);
    expect(out[0].x).toBe(0);
    expect(out[2].x).toBe(400);
  });

  it("ne touche ni y, ni w, ni h", () => {
    const input = trio();
    const out = distributeFrames(input, "horizontal");
    expect(out.map((f) => [f.y, f.w, f.h])).toEqual(input.map((f) => [f.y, f.w, f.h]));
  });

  it("ne dépend PAS de l'ordre du tableau : une entrée permutée donne la permutation du même résultat", () => {
    // Le test qui attrape une implémentation qui poserait les cadres dans l'ordre du TABLEAU au lieu
    // de l'ordre des POSITIONS — un cas heureux (tableau déjà trié) ne la distinguerait pas.
    const [g1, g2, g3] = trio();
    expect(distributeFrames([g3, g1, g2], "horizontal").map((f) => f.x)).toEqual([400, 0, 225]);
    expect(distributeFrames([g2, g3, g1], "horizontal").map((f) => f.x)).toEqual([225, 400, 0]);
  });

  it("deux cadres qui S'ÉGALENT sur (bord d'attaque, taille) mais DIFFÈRENT sur l'axe perpendiculaire ne dépendent pas non plus de l'ordre d'entrée", () => {
    // LA contre-épreuve du test précédent (revue finale U0+U2). Le tri se départageait par bord
    // d'attaque puis taille SUR L'AXE RÉPARTI seulement, puis se repliait sur l'index d'entrée : deux
    // cadres au même x et à la même largeur mais de HAUTEURS différentes échangeaient donc leurs
    // placements (0 ↔ 250) d'une permutation à l'autre — alors que la documentation de
    // `distributeFrames` promettait « le même résultat par cadre » sans réserve. Les critères d'axe
    // perpendiculaire rendent le tri TOTAL à l'identité près, et l'affirmation vraie.
    //
    // Ce que le test exige : chaque cadre, IDENTIFIÉ PAR SA HAUTEUR, reçoit le même x dans les deux
    // ordres. Comparer les tableaux résultats entre eux ne le dirait pas — ils sont permutés.
    const plat: Frame = { x: 0, y: 0, w: 10, h: 5 };
    const haut: Frame = { x: 0, y: 0, w: 10, h: 99 };
    const loin: Frame = { x: 500, y: 0, w: 10, h: 10 };

    const xParHauteur = (input: Frame[]) =>
      new Map(distributeFrames(input, "horizontal").map((f) => [f.h, f.x]));

    const direct = xParHauteur([plat, haut, loin]);
    const permuté = xParHauteur([haut, plat, loin]);
    expect([...direct.entries()].sort()).toEqual([...permuté.entries()].sort());
    // …et les valeurs sont bien celles attendues, pas deux fois la même erreur : le plus PLAT (h=5)
    // passe avant le plus HAUT (h=99) parce que `crossSize` les départage, dans les deux ordres.
    expect(direct.get(5)).toBe(0);
    expect(direct.get(99)).toBe(250);
    expect(permuté.get(5)).toBe(0);
    expect(permuté.get(99)).toBe(250);
  });

  it("entrée en ordre x DÉCROISSANT : les extrêmes restent les extrêmes de POSITION, pas ceux du tableau", () => {
    const desc: Frame[] = [
      { x: 400, y: 0, w: 100, h: 10 },
      { x: 150, y: 0, w: 50, h: 10 },
      { x: 0, y: 0, w: 100, h: 10 },
    ];
    const out = distributeFrames(desc, "horizontal");
    expect(out.map((f) => f.x)).toEqual([400, 225, 0]);
  });

  it("écarts DÉJÀ égaux : inchangé au bit près (donc idempotent)", () => {
    const equal: Frame[] = [
      { x: 0, y: 0, w: 10, h: 10 },
      { x: 20, y: 0, w: 10, h: 10 },
      { x: 40, y: 0, w: 10, h: 10 },
    ];
    expect(distributeFrames(equal, "horizontal")).toEqual(equal);
    // Et idempotence sur un cas qui, lui, bouge vraiment.
    const once = distributeFrames(trio(), "horizontal");
    expect(once).not.toEqual(trio());
    expect(distributeFrames(once, "horizontal")).toEqual(once);
  });

  it("écarts NULS (cadres jointifs) : inchangé, l'écart calculé vaut exactement 0", () => {
    const touching: Frame[] = [
      { x: 0, y: 0, w: 10, h: 10 },
      { x: 10, y: 0, w: 10, h: 10 },
      { x: 20, y: 0, w: 10, h: 10 },
    ];
    const out = distributeFrames(touching, "horizontal");
    expect(out).toEqual(touching);
    for (const g of gapsAlong(out, "horizontal")) expect(g).toBe(0);
  });

  it("cadres qui SE CHEVAUCHENT : l'écart devient négatif mais reste ÉGAL, et les extrêmes tiennent", () => {
    // {0,w100} {20,w100} {30,w100} : étendue = 130, somme = 300 -> écart = (130-300)/2 = -85
    // pose : 0 ; 0+100-85 = 15 ; extrême épinglé à 30
    const overlapping: Frame[] = [
      { x: 0, y: 0, w: 100, h: 10 },
      { x: 20, y: 0, w: 100, h: 10 },
      { x: 30, y: 0, w: 100, h: 10 },
    ];
    const out = distributeFrames(overlapping, "horizontal");
    expect(out.map((f) => f.x)).toEqual([0, 15, 30]);
    for (const g of gapsAlong(out, "horizontal")) expect(g).toBeCloseTo(-85, EPS);
  });

  it("cadre du MILIEU plus large que l'étendue positionnelle : l'écart négatif sort du plan de travail, et c'est assumé", () => {
    // Revue Tâche 4, Mineur 3 : la seule forme d'ordonnancement que le fichier ne visitait pas.
    // `span` se mesure du bord gauche du PREMIER au bord droit du DERNIER (align.ts), donc un cadre
    // central plus large que cette étendue force un écart très négatif — ici étendue = 30, somme des
    // largeurs = 1020, écart = (30 − 1020)/2 = −495, et B part à 0 + 10 − 495 = −485.
    // Des coordonnées hors plan de travail sont LÉGALES (scene.ts ne borne ni x ni y, et le glisser
    // ne les borne pas non plus) : ce test fixe le comportement documenté au lieu de le laisser être
    // une découverte. Il passerait au rouge si quelqu'un ajoutait un bornage silencieux.
    const wideMiddle: Frame[] = [
      { x: 0, y: 0, w: 10, h: 10 },
      { x: 5, y: 0, w: 1000, h: 10 },
      { x: 20, y: 0, w: 10, h: 10 },
    ];
    const out = distributeFrames(wideMiddle, "horizontal");
    expect(out.map((f) => f.x)).toEqual([0, -485, 20]);

    // CE QUE CE CAS RÉVÈLE, et qui vaut plus que la coordonnée négative : l'écart devient si négatif
    // que B se retrouve à GAUCHE de A. L'ORDRE POSITIONNEL S'INVERSE. Or l'écart égal est attribué
    // dans l'ordre de RÉPARTITION (celui du tri d'entrée) ; « écarts égaux » n'est donc observable en
    // re-mesurant par position que TANT QUE la répartition préserve l'ordre. Ici elle ne le préserve
    // pas, et les deux mesures divergent — ce n'est pas un bug de calcul, c'est la portée exacte de la
    // garantie. `gapsAlong` re-trie par position (voir sa définition) : il mesure donc l'autre chose.
    expect(gapsAlong(out, "horizontal")).toEqual([-515, 10]); // par POSITION : inégaux
    const inDistributionOrder = [
      out[1].x - (out[0].x + out[0].w), // A -> B, l'ordre du tri d'entrée
      out[2].x - (out[1].x + out[1].w), // B -> C
    ];
    for (const g of inDistributionOrder) expect(g).toBeCloseTo(-495, EPS); // par RÉPARTITION : égaux

    // Les extrêmes restent épinglés à leur bord d'origine, garantie qui survit même à l'inversion.
    expect(out[0].x).toBe(0);
    expect(out[2].x).toBe(20);
  });

  it("deux cadres au MÊME x : le tri est total et déterministe (le plus étroit d'abord), pas dépendant du tableau", () => {
    // A={100,w:80} B={100,w:20} C={400,w:50} — même bord gauche pour A et B.
    // Ordre de pose : B (w=20) puis A (w=80) puis C. étendue = 450-100 = 350 · somme = 150
    // écart = (350-150)/2 = 100 -> B.x=100 ; A.x = 100+20+100 = 220 ; C épinglé à 400.
    const a: Frame = { x: 100, y: 0, w: 80, h: 10 };
    const b: Frame = { x: 100, y: 0, w: 20, h: 10 };
    const c: Frame = { x: 400, y: 0, w: 50, h: 10 };
    expect(distributeFrames([a, b, c], "horizontal").map((f) => f.x)).toEqual([220, 100, 400]);
    // Le MÊME résultat par cadre quand l'égalité arrive dans l'autre ordre dans le tableau : le tri
    // ne se replie pas sur l'ordre d'entrée pour départager.
    expect(distributeFrames([b, a, c], "horizontal").map((f) => f.x)).toEqual([100, 220, 400]);
  });

  it("quatre cadres, écart non représentable en binaire : écarts égaux à epsilon près ET extrêmes EXACTS", () => {
    // {0,w10} {20,w10} {50,w10} {100,w10} : étendue = 110 · somme = 40 · écart = 70/3 = 23.333…
    //
    // FIXTURE CHOISIE PAR MESURE, pas par commodité. Ma première version utilisait un dernier cadre à
    // x=140 (écart 110/3) : le curseur accumulé y retombe sur 140 EXACTEMENT, si bien qu'une
    // implémentation qui n'épinglerait PAS le dernier cadre passait le test — la mutation
    // correspondante laissait les 58 tests de ce fichier verts. Avec x=100, l'accumulation vaut
    // 99.99999999999999 (dérive mesurée : -1.42e-14), donc le `toBe(100)` ci-dessous exige réellement
    // l'épinglage documenté dans distributeFrames.
    const frames: Frame[] = [
      { x: 0, y: 0, w: 10, h: 10 },
      { x: 20, y: 0, w: 10, h: 10 },
      { x: 50, y: 0, w: 10, h: 10 },
      { x: 100, y: 0, w: 10, h: 10 },
    ];
    const out = distributeFrames(frames, "horizontal");
    const gaps = gapsAlong(out, "horizontal");
    expect(gaps).toHaveLength(3);
    for (const g of gaps) expect(g).toBeCloseTo(70 / 3, EPS);
    // Les extrêmes sont EXACTS, pas seulement proches — un cadre que l'utilisateur voit comme immobile
    // ne doit pas dériver d'un cheveu parce qu'il est le dernier de la chaîne d'additions.
    expect(out[0].x).toBe(0);
    expect(out[3].x).toBe(100);
    // Et les cadres du MILIEU, eux, ont bien bougé (sinon les deux lignes ci-dessus seraient
    // satisfaites par une fonction identité).
    expect(out[1].x).toBeCloseTo(0 + 10 + 70 / 3, EPS);
    expect(out[2].x).toBeCloseTo(0 + 20 + 140 / 3, EPS);
  });

  it("ne mute pas son entrée", () => {
    const input = trio();
    const snapshot = structuredClone(input);
    distributeFrames(input, "horizontal");
    distributeFrames(input, "vertical");
    expect(input).toEqual(snapshot);
  });
});

describe("distributeFrames — vertical", () => {
  // La transposée exacte du trio horizontal : y/h là où il y avait x/w.
  function trio(): Frame[] {
    return [
      { x: 7, y: 0, w: 5, h: 100 },
      { x: 3, y: 150, w: 5, h: 50 },
      { x: 9, y: 400, w: 5, h: 100 },
    ];
  }

  it("produit les y attendus et laisse x, w, h intacts", () => {
    const input = trio();
    const out = distributeFrames(input, "vertical");
    expect(out.map((f) => f.y)).toEqual([0, 225, 400]);
    expect(out.map((f) => [f.x, f.w, f.h])).toEqual(input.map((f) => [f.x, f.w, f.h]));
  });

  it("les écarts verticaux sont égaux et les extrêmes tiennent", () => {
    const out = distributeFrames(trio(), "vertical");
    for (const g of gapsAlong(out, "vertical")) expect(g).toBeCloseTo(125, EPS);
    expect(out[0].y).toBe(0);
    expect(out[2].y).toBe(400);
  });

  it("l'axe vertical ne se laisse pas gouverner par les x (une entrée triée par x mais pas par y)", () => {
    // x croissants, y en désordre : une implémentation qui trierait par le mauvais axe échoue ici.
    const mixed: Frame[] = [
      { x: 0, y: 400, w: 10, h: 100 },
      { x: 10, y: 0, w: 10, h: 100 },
      { x: 20, y: 150, w: 10, h: 50 },
    ];
    const out = distributeFrames(mixed, "vertical");
    // ordre des positions : (y=0,h=100) (y=150,h=50) (y=400,h=100)
    // étendue = 500-0 = 500 · somme = 250 · écart = 125 -> 0 ; 225 ; 400
    expect(out.map((f) => f.y)).toEqual([400, 0, 225]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Le pont entre les cadres nus et la scène : quels calques PARTICIPENT, et sur quoi on s'aligne.
function sub(id: string, frame: Frame, locked = false): AlignSubject {
  return { id, frame, locked };
}

describe("alignParticipants — la sélection moins les calques verrouillés", () => {
  const layers = [
    sub("a", { x: 10, y: 0, w: 10, h: 10 }),
    sub("b", { x: 20, y: 0, w: 10, h: 10 }, true),
    sub("c", { x: 30, y: 0, w: 10, h: 10 }),
  ];

  it("ne garde que les calques SÉLECTIONNÉS et NON verrouillés", () => {
    expect(alignParticipants(layers, ["a", "b", "c"]).map((l) => l.id)).toEqual(["a", "c"]);
  });

  it("ignore un id sélectionné absent de la scène (la sélection n'est pas validée contre la scène, Tâche 3)", () => {
    expect(alignParticipants(layers, ["a", "fantôme"]).map((l) => l.id)).toEqual(["a"]);
  });

  it("suit l'ordre des CALQUES, pas celui de la sélection — l'ordre de clic ne désigne aucune référence ici", () => {
    // Décision explicite (voir l'en-tête de lib/studio/align.ts) : l'alignement se fait sur la BOÎTE
    // ENGLOBANTE, jamais sur « le premier calque cliqué ». L'ordre d'insertion que la Tâche 3 préserve
    // n'est donc pas consommé par cette tâche, et ce test fixe ce choix plutôt que de le laisser
    // implicite.
    expect(alignParticipants(layers, ["c", "a"]).map((l) => l.id)).toEqual(["a", "c"]);
  });

  it("sélection vide -> aucun participant", () => {
    expect(alignParticipants(layers, [])).toEqual([]);
  });
});

describe("planAlign", () => {
  const canvas = { width: 1000, height: 500 };

  it("un calque VERROUILLÉ est exclu — et n'entre PAS non plus dans la boîte englobante", () => {
    // a={10} · b VERROUILLÉ={0} · c={200}. Si b comptait dans la boîte, sa gauche serait 0 et les DEUX
    // autres bougeraient (a: 10->0, c: 200->0). Exclu, la boîte des participants commence à 10 : seul
    // c bouge. Ce sont deux résultats franchement différents — la portée du test est réelle.
    const layers = [
      sub("a", { x: 10, y: 0, w: 100, h: 10 }),
      sub("b", { x: 0, y: 0, w: 100, h: 10 }, true),
      sub("c", { x: 200, y: 0, w: 100, h: 10 }),
    ];
    const changes = planAlign(layers, ["a", "b", "c"], "left", canvas);
    expect(changes).toEqual([{ id: "c", frame: { x: 10, y: 0, w: 100, h: 10 } }]);
  });

  it("AVEUGLE À LA ROTATION : un calque tourné s'aligne par son CADRE, jamais par son emprise visuelle", () => {
    // Revue Tâche 4, Mineur 2 : la cécité à la rotation n'était affirmée que par l'en-tête d'align.ts et
    // par la note d'interface — RIEN ne serait passé au rouge si quelqu'un apprenait la rotation à
    // `boundingBox`. Ce test la fixe comme COMPORTEMENT, avec deux résultats franchement différents.
    //
    // r = {x:100, w:200, h:20} tourné de 90° autour de son centre (200,10) : son emprise VISUELLE
    // devient 20×200 centrée au même point, donc son bord gauche à l'écran est 190, pas 100.
    // a = {x:150, w:100} n'est pas tourné.
    //   • aveugle (attendu) : boîte des participants = min(100,150) = 100 -> a passe à 100, r ne bouge pas.
    //   • consciente de la rotation : boîte = min(190,150) = 150 -> a ne bouge pas et r reculerait à 60.
    // `AlignSubject` n'a pas de champ `rotation` : le champ superflu est délibéré, pour que le test
    // reste rouge même après l'ajout du champ (c'est ce jour-là qu'il doit protester).
    const rotated = { id: "r", frame: { x: 100, y: 0, w: 200, h: 20 }, locked: false, rotation: 90 };
    const layers: AlignSubject[] = [rotated, sub("a", { x: 150, y: 0, w: 100, h: 10 })];
    expect(planAlign(layers, ["r", "a"], "left", canvas)).toEqual([
      { id: "a", frame: { x: 100, y: 0, w: 100, h: 10 } },
    ]);
  });

  it("un calque MASQUÉ est exclu comme un verrouillé — et n'entre pas non plus dans la boîte englobante", () => {
    // Revue finale U0+U2, Important 2, avec les valeurs mesurées telles quelles. Si le calque masqué
    // comptait, la boîte commencerait à 0 et les DEUX calques visibles feraient un bond de 500 px
    // pour se poser sur le bord d'un calque qu'on ne voit pas. Exclu, la boîte des participants
    // commence à 500 : seul le second bouge, de 100 px. Deux résultats franchement différents.
    const layers: AlignSubject[] = [
      { id: "vis1", frame: { x: 500, y: 0, w: 100, h: 10 } },
      { id: "vis2", frame: { x: 600, y: 0, w: 100, h: 10 } },
      { id: "hid", frame: { x: 0, y: 0, w: 100, h: 10 }, visible: false },
    ];
    const changes = planAlign(layers, ["vis1", "vis2", "hid"], "left", canvas);
    expect(changes).toEqual([{ id: "vis2", frame: { x: 500, y: 0, w: 100, h: 10 } }]);
    // Et le calque masqué n'est JAMAIS dans le lot — pas même déplacé « au passage ».
    expect(changes.some((c) => c.id === "hid")).toBe(false);
  });

  it("`visible` ABSENT vaut visible : les littéraux qui ignorent le champ gardent le comportement d'avant", () => {
    // L'exclusion est déclenchée par un `false` EXPLICITE, jamais par un champ manquant — sinon
    // ajouter le champ à l'interface aurait silencieusement vidé tous les gestes d'alignement.
    const layers: AlignSubject[] = [
      { id: "a", frame: { x: 10, y: 0, w: 100, h: 10 } },
      { id: "b", frame: { x: 200, y: 0, w: 100, h: 10 }, visible: true },
    ];
    expect(planAlign(layers, ["a", "b"], "left", canvas)).toEqual([
      { id: "b", frame: { x: 10, y: 0, w: 100, h: 10 } },
    ]);
  });

  it("tous les participants masqués : rien à aligner, aucun changement", () => {
    const layers: AlignSubject[] = [
      { id: "a", frame: { x: 10, y: 0, w: 100, h: 10 }, visible: false },
      { id: "b", frame: { x: 200, y: 0, w: 100, h: 10 }, visible: false },
    ];
    expect(planAlign(layers, ["a", "b"], "left", canvas)).toEqual([]);
    expect(planDistribute(layers, ["a", "b"], "horizontal")).toEqual([]);
  });

  it("ne renvoie AUCUN changement pour un calque non sélectionné", () => {
    const layers = [
      sub("a", { x: 10, y: 0, w: 100, h: 10 }),
      sub("z", { x: 900, y: 0, w: 100, h: 10 }),
      sub("c", { x: 200, y: 0, w: 100, h: 10 }),
    ];
    const changes = planAlign(layers, ["a", "c"], "right", canvas);
    // boîte des participants : x=10, droite=300 -> w=290 ; aligner à droite : x = 300-100 = 200
    // a: 10 -> 200 (change) · c: 200 -> 200 (déjà là, donc absent de la liste)
    expect(changes).toEqual([{ id: "a", frame: { x: 200, y: 0, w: 100, h: 10 } }]);
  });

  it("UN SEUL participant s'aligne sur le PLAN DE TRAVAIL, pas sur sa propre boîte (sinon rien ne bougerait)", () => {
    const layers = [sub("a", { x: 10, y: 20, w: 100, h: 50 })];
    expect(planAlign(layers, ["a"], "hcenter", canvas)).toEqual([
      { id: "a", frame: { x: 450, y: 20, w: 100, h: 50 } },
    ]);
    expect(planAlign(layers, ["a"], "bottom", canvas)).toEqual([
      { id: "a", frame: { x: 10, y: 450, w: 100, h: 50 } },
    ]);
  });

  it("deux sélectionnés dont un VERROUILLÉ -> un seul participant -> plan de travail, pas boîte englobante", () => {
    // Le cas limite qui fait la différence entre « compter la sélection » et « compter les
    // PARTICIPANTS » : selectedIds.length vaut 2, mais un seul calque peut bouger.
    const layers = [
      sub("a", { x: 10, y: 20, w: 100, h: 50 }),
      sub("b", { x: 800, y: 400, w: 100, h: 50 }, true),
    ];
    expect(planAlign(layers, ["a", "b"], "left", canvas)).toEqual([
      { id: "a", frame: { x: 0, y: 20, w: 100, h: 50 } },
    ]);
  });

  it("un ensemble DÉJÀ aligné ne produit AUCUN changement (liste vide, pas une liste de cadres identiques)", () => {
    const layers = [
      sub("a", { x: 50, y: 0, w: 100, h: 10 }),
      sub("b", { x: 50, y: 40, w: 20, h: 10 }),
    ];
    expect(planAlign(layers, ["a", "b"], "left", canvas)).toEqual([]);
  });

  it("aucun participant (sélection vide, ou tout verrouillé) -> aucun changement", () => {
    const layers = [sub("a", { x: 10, y: 0, w: 10, h: 10 }, true)];
    expect(planAlign(layers, [], "left", canvas)).toEqual([]);
    expect(planAlign(layers, ["a"], "left", canvas)).toEqual([]);
  });

  it("ne mute ni les calques ni leurs cadres", () => {
    const layers = [
      sub("a", { x: 10, y: 0, w: 100, h: 10 }),
      sub("c", { x: 200, y: 0, w: 100, h: 10 }),
    ];
    const snapshot = structuredClone(layers);
    for (const mode of ALIGN_MODES) planAlign(layers, ["a", "c"], mode, canvas);
    expect(layers).toEqual(snapshot);
  });
});

describe("planDistribute", () => {
  it("moins de TROIS participants -> aucun changement", () => {
    const layers = [
      sub("a", { x: 0, y: 0, w: 10, h: 10 }),
      sub("b", { x: 100, y: 0, w: 10, h: 10 }),
    ];
    expect(planDistribute(layers, ["a", "b"], "horizontal")).toEqual([]);
    expect(planDistribute(layers, ["a"], "horizontal")).toEqual([]);
  });

  it("trois participants sur quatre sélectionnés (un VERROUILLÉ) répartissent les trois, et le verrouillé ne compte pas comme extrême", () => {
    // v est verrouillé et se trouve à x=1000 : s'il comptait, l'étendue irait jusqu'à 1100 et les
    // écarts seraient tout autres.
    const layers = [
      sub("a", { x: 0, y: 0, w: 100, h: 10 }),
      sub("b", { x: 150, y: 0, w: 50, h: 10 }),
      sub("v", { x: 1000, y: 0, w: 100, h: 10 }, true),
      sub("c", { x: 400, y: 0, w: 100, h: 10 }),
    ];
    const changes = planDistribute(layers, ["a", "b", "v", "c"], "horizontal");
    // Mêmes nombres que le trio de référence : écart 125 -> b passe de 150 à 225 ; a et c ne bougent pas.
    expect(changes).toEqual([{ id: "b", frame: { x: 225, y: 0, w: 50, h: 10 } }]);
  });

  it("répartir verticalement ne touche que y", () => {
    const layers = [
      sub("a", { x: 7, y: 0, w: 5, h: 100 }),
      sub("b", { x: 3, y: 150, w: 5, h: 50 }),
      sub("c", { x: 9, y: 400, w: 5, h: 100 }),
    ];
    expect(planDistribute(layers, ["a", "b", "c"], "vertical")).toEqual([
      { id: "b", frame: { x: 3, y: 225, w: 5, h: 50 } },
    ]);
  });

  it("un ensemble DÉJÀ équiréparti -> aucun changement", () => {
    const layers = [
      sub("a", { x: 0, y: 0, w: 10, h: 10 }),
      sub("b", { x: 20, y: 0, w: 10, h: 10 }),
      sub("c", { x: 40, y: 0, w: 10, h: 10 }),
    ];
    expect(planDistribute(layers, ["a", "b", "c"], "horizontal")).toEqual([]);
  });

  it("l'ordre de la SÉLECTION ne change pas le résultat (c'est la position qui gouverne)", () => {
    const layers = [
      sub("a", { x: 0, y: 0, w: 100, h: 10 }),
      sub("b", { x: 150, y: 0, w: 50, h: 10 }),
      sub("c", { x: 400, y: 0, w: 100, h: 10 }),
    ];
    const one = planDistribute(layers, ["a", "b", "c"], "horizontal");
    const other = planDistribute(layers, ["c", "a", "b"], "horizontal");
    expect(other).toEqual(one);
    expect(one).toEqual([{ id: "b", frame: { x: 225, y: 0, w: 50, h: 10 } }]);
  });
});
