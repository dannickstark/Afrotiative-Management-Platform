import { describe, it, expect } from "bun:test";
import sharp from "sharp";
import { renderScene } from "@/lib/studio/render";
import { SHAPE_KINDS, type Scene, type ShapeKind, type ShapeLayer } from "@/lib/studio/scene";

// ============================================================================
// U3 Tâche 2 — LA BOUCLE QUE LA SONDE N'A PAS PU REFERMER (arbitrage E).
//
// La sonde (tests/studio-render-clippath.test.ts) a prouvé en PIXELS que satori -> resvg -> sharp
// sait découper un polygone et arrondir une ellipse — mais PAS à travers `renderScene()` : aucun
// champ de `ShapeLayer` ne pouvait porter la géométrie, et la sonde avait interdiction de toucher au
// code de production. Elle a donc reproduit l'étape 5 de `renderScene()` et prouvé cette
// reproduction fidèle à l'octet. « Tant que ce n'est pas fait, la preuve porte sur une reproduction
// fidèle du pipeline, pas sur le pipeline. »
//
// Ce fichier referme ce qui PEUT l'être sans ajouter une seule forme (interdit par la Tâche 2) :
//   — l'ELLIPSE : la migration de `radius` (arbitrage C) rend `"50%"` exprimable par le SCHÉMA,
//     donc cette assertion-là passe désormais par le VRAI point d'entrée, sans réplique ;
//   — la DÉCOUPE : aucune forme du catalogue n'en émet encore (la Tâche 3 apporte la famille
//     polygonale), donc le seul moyen d'en faire arriver une jusqu'à `renderScene()` est de
//     substituer la SORTIE de la description — c'est exactement la couture testée : « ce que
//     `shapes.ts` renvoie arrive-t-il aux pixels ? ». Tout le reste du chemin est le vrai code.
//
// ── U3 TÂCHE 3 : LA SUBSTITUTION A DISPARU (dette 3 du piège de la Tâche 2). ────────────────────
// `stubShapeCss` (et le `mock.module` qu'il posait) n'existe plus : la famille polygonale étant
// livrée, une découpe arrive aux pixels par la DESCRIPTION RÉELLE d'une forme du catalogue. Plus
// aucune couture n'est simulée dans ce fichier — de `parseScene`-able jusqu'au JPEG, tout est le code
// de production. La seule assertion qui EXIGEAIT la substitution — rendre une chaîne de polygone
// « à espaces », qu'aucune description n'émet ni ne peut émettre — vit toujours en PIXELS, sur le même
// cadre 800×400 et aux mêmes points, dans tests/studio-render-clippath.test.ts (« RÉSERVE 1 », avec
// son témoin) ; elle n'est donc pas perdue. Ce qui la garde vivante ICI, sur le chemin de production,
// est le point (700,380) du triangle ci-dessous : c'est exactement le point que la variante à espaces
// laisse VIDE, et il est asserté « remplissage ».
//
// POURQUOI DES PIXELS. Un `clipPath` ignoré produit un PNG parfaitement valide et parfaitement
// rectangulaire : « ça n'a pas levé » ne prouve rien, et une assertion sur le SVG intermédiaire ne
// prouve rien de ce que resvg RASTERISE. Chaque affirmation compare donc la COULEUR d'un pixel de
// sortie, et chacune a un TÉMOIN qui produit la classification INVERSE au MÊME point.
//
// CADRE NON CARRÉ (800×400) PARTOUT : sur un cadre carré, le défaut d'espacement des polygones
// (Tâche 1, réserve 1) et la différence stade/ellipse sont l'un comme l'autre INVISIBLES.
// ============================================================================

const FILL = "#FF0000"; // rouge pur
const BG = "#0000FF";   // bleu pur

// Même échantillonneur que la sonde (tests/studio-render-clippath.test.ts) : deux couleurs primaires
// saturées, une tolérance très supérieure au bruit JPEG (qualité 86), et un pixel qui n'est ni l'une
// ni l'autre est renvoyé TEL QUEL pour que l'échec affiche la valeur réellement lue.
type Sampler = (x: number, y: number) => string;
const TOLERANCE = 24;
async function sampler(bytes: Uint8Array): Promise<Sampler> {
  const { data, info } = await sharp(Buffer.from(bytes)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return (x, y) => {
    const i = (y * info.width + x) * info.channels;
    const p = [data[i], data[i + 1], data[i + 2], data[i + 3]];
    const near = (t: number[]) => t.every((v, k) => Math.abs(p[k] - v) <= TOLERANCE);
    if (near([255, 0, 0])) return "remplissage";
    if (near([0, 0, 255])) return "fond";
    return `rgba(${p.join(",")})`;
  };
}

function sceneWith(radius?: number | string): Scene {
  return {
    schemaVersion: 1,
    canvas: { width: 800, height: 400, background: BG },
    layers: [{
      id: "s", name: "forme", visible: true, locked: false,
      frame: { x: 0, y: 0, w: 800, h: 400 },
      type: "shape", shape: "rect", fill: FILL, ...(radius === undefined ? {} : { radius }),
    }],
  };
}

// U3 Tâche 3 — une scène 800×400 portant UNE forme du catalogue, telle quelle. Aucun style injecté :
// la géométrie vient entièrement de la description (lib/studio/shapes.ts) via `shapeNode()`.
function sceneOf(kind: ShapeKind, extra: Partial<ShapeLayer> = {}): Scene {
  return {
    schemaVersion: 1,
    canvas: { width: 800, height: 400, background: BG },
    layers: [{
      id: "s", name: "forme", visible: true, locked: false,
      frame: { x: 0, y: 0, w: 800, h: 400 },
      type: "shape", shape: kind, fill: FILL, ...extra,
    } as ShapeLayer],
  };
}

async function pixelsOf(scene: Scene): Promise<Sampler> {
  return sampler((await renderScene({ scene, values: {} })).bytes);
}

describe("renderScene() — l'ellipse, par le VRAI point d'entrée (arbitrages C et E)", () => {
  // Ellipse cx=400 cy=200 rx=400 ry=200.
  //   (100,60) : (300/400)² + (140/200)² = 1,05 > 1 -> DEHORS.
  //   (150,80) : (250/400)² + (120/200)² = 0,75 < 1 -> DEDANS.
  // Aucune autre géométrie exprimable ici ne sépare ces deux points : seule une ellipse le fait.
  it("`radius: \"50%\"` produit une VRAIE ellipse sur un cadre non carré", async () => {
    const px = await pixelsOf(sceneWith("50%"));
    expect(px(100, 60)).toBe("fond");
    expect(px(150, 80)).toBe("remplissage");
    expect(px(5, 5)).toBe("fond");
    expect(px(400, 200)).toBe("remplissage");
  });

  it("TÉMOIN : sans rayon, ces deux points sont TOUS DEUX du remplissage", async () => {
    const px = await pixelsOf(sceneWith());
    expect(px(100, 60)).toBe("remplissage");
    expect(px(150, 80)).toBe("remplissage");
    expect(px(5, 5)).toBe("remplissage");
  });

  it("TÉMOIN : le plus grand rayon NUMÉRIQUE utile donne un stade, pas une ellipse", async () => {
    // C'est la raison d'être de la migration (défaut de plan #12) : un nombre ne PEUT PAS exprimer
    // une ellipse sur un cadre non carré. 200 px donne deux demi-cercles reliés par un rectangle —
    // (100,60), hors de l'ellipse, y est peint, et le milieu du bord haut est plat.
    const px = await pixelsOf(sceneWith(200));
    expect(px(100, 60)).toBe("remplissage");
    expect(px(400, 5)).toBe("remplissage");
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// LA DÉCOUPE, À TRAVERS renderScene() — SANS AUCUNE SUBSTITUTION (U3 Tâche 3, dette 3).
//
// `shapeNode()`, `sceneToElement()`, `renderScene()`, satori, resvg et sharp sont le code de
// production réel, ET la géométrie vient maintenant de la DESCRIPTION RÉELLE du triangle
// (lib/studio/shapes.ts) au lieu d'une sortie de `shapeCssFor` substituée par `mock.module`.
// MUTATION QUI FAIT ROUGIR : retirer `...shapeCssFor(layer)` du style de `shapeNode()` (ou le poser
// sur un nœud enfant) — la découpe n'arrive alors jamais aux pixels et les quatre points basculent.
// AUTRE MUTATION : faire émettre à `polygonClip` une virgule SUIVIE D'UNE ESPACE — (700,380) bascule
// à « fond » (mesuré, sonde Tâche 1, réserve 1 : l'abscisse se résout alors contre la HAUTEUR).
// ────────────────────────────────────────────────────────────────────────────────────────────────
describe("renderScene() — une découpe émise par la description arrive bien aux pixels", () => {
  it("le triangle du catalogue est réellement découpé", async () => {
    const px = await pixelsOf(sceneOf("triangle"));
    expect(px(40, 40)).toBe("fond");           // coin haut-gauche : EXCLU (arête à x=360 pour y=40)
    expect(px(760, 40)).toBe("fond");          // coin haut-droit  : EXCLU (arête à x=440)
    expect(px(400, 200)).toBe("remplissage");  // centre
    expect(px(700, 380)).toBe("remplissage");  // bas-droit, DANS le triangle (arête à x=780)
  });

  it("TÉMOIN : sans découpe, ces deux coins sont du remplissage", async () => {
    const px = await pixelsOf(sceneOf("rect"));
    expect(px(40, 40)).toBe("remplissage");
    expect(px(760, 40)).toBe("remplissage");
    expect(px(400, 200)).toBe("remplissage");
  });

  it("la description réelle est bien celle du catalogue — et ce fichier ne mocke plus RIEN", async () => {
    // Ex-« la description réelle est RESTAURÉE » : il n'y a plus de `mock.module` à restaurer dans ce
    // fichier, donc plus de fuite possible vers les autres fichiers du même processus `bun test`.
    // Les deux assertions restent : la description d'un rect à rayon numérique, et l'ellipse en pixels.
    const module = await import("@/lib/studio/shapes");
    expect(module.shapeCssFor(sceneWith(24).layers[0] as never)).toEqual({ borderRadius: 24 });
    const px = await pixelsOf(sceneWith("50%"));
    expect(px(100, 60)).toBe("fond");
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// CHAQUE FORME DU CATALOGUE, EN PIXELS. La table est un `Record<ShapeKind, …>` : une forme ajoutée à
// `SHAPE_KINDS` sans preuve en pixels ne COMPILE pas — et, comme `bun test` ne typecheck pas, un
// garde-fou d'exécution compare les clés à `SHAPE_KINDS`.
//
// Chaque forme apporte au moins un point DEDANS et un point DEHORS. Le point « dehors » est ce qui
// distingue réellement une forme d'un rectangle : sans lui, une description qui n'émettrait rien du
// tout (donc un rectangle plein) passerait chaque assertion « dedans ». Tous les points sont à ≥ 30 px
// de l'arête la plus proche pour qu'aucun anticrénelage ni artefact JPEG ne puisse les expliquer.
// ────────────────────────────────────────────────────────────────────────────────────────────────
type PixelProof = { frame: { x: number; y: number; w: number; h: number }; dedans: [number, number][]; dehors: [number, number][] };

const PIXEL_PROOFS: Record<ShapeKind, PixelProof> = {
  // Plein cadre serait sans « dehors » : un cadre plus petit que le canevas rend le témoin possible.
  rect: { frame: { x: 0, y: 0, w: 400, h: 200 }, dedans: [[200, 100], [20, 20]], dehors: [[600, 300], [600, 100], [200, 300]] },
  // Ellipse cx=400 cy=200 rx=400 ry=200 : (100,60) est DEHORS (1,05), (150,80) DEDANS (0,75) — aucune
  // autre géométrie exprimable ici ne sépare ces deux points.
  ellipse: { frame: { x: 0, y: 0, w: 800, h: 400 }, dedans: [[150, 80], [400, 200]], dehors: [[100, 60], [5, 5]] },
  // La LIGNE est un rectangle FIN : son cadre EST son épaisseur (20 px ici), et de part et d'autre il
  // n'y a rien. C'est ce qui prouve « une ligne a une vraie hauteur » plutôt qu'un trait de 0 px.
  line: { frame: { x: 0, y: 190, w: 800, h: 20 }, dedans: [[400, 200], [20, 200]], dehors: [[400, 100], [400, 300]] },
  triangle: { frame: { x: 0, y: 0, w: 800, h: 400 }, dedans: [[400, 200], [700, 380]], dehors: [[40, 40], [760, 40]] },
  // (400,380) est le CREUX entre les deux branches basses de l'étoile : un simple triangle y peindrait.
  star: { frame: { x: 0, y: 0, w: 800, h: 400 }, dedans: [[400, 200]], dehors: [[40, 40], [400, 380]] },
  hexagon: { frame: { x: 0, y: 0, w: 800, h: 400 }, dedans: [[400, 200], [400, 20]], dehors: [[40, 40], [760, 360]] },
  // (400,60) est au-dessus du fût et à gauche de la pointe : ni l'un ni l'autre ne le couvre.
  arrow: { frame: { x: 0, y: 0, w: 800, h: 400 }, dedans: [[400, 200], [600, 200]], dehors: [[400, 60], [400, 340]] },
  // (208,320) est DANS la queue de la bulle, (40,380) et (700,380) sont à côté d'elle : c'est la queue
  // qui distingue une bulle d'un rectangle, donc elle a ses propres points.
  bubble: { frame: { x: 0, y: 0, w: 800, h: 400 }, dedans: [[400, 200], [208, 320]], dehors: [[700, 380], [40, 380]] },
};

describe("renderScene() — chaque forme du catalogue, prouvée en pixels", () => {
  it("la table de preuves couvre EXACTEMENT les formes du schéma", () => {
    expect(Object.keys(PIXEL_PROOFS).sort()).toEqual([...SHAPE_KINDS].sort());
  });

  for (const kind of SHAPE_KINDS) {
    it(`« ${kind} » : chaque point dedans est peint, chaque point dehors ne l'est pas`, async () => {
      const proof = PIXEL_PROOFS[kind];
      // Anti-vacuité par forme : une ligne de table sans point ne prouverait rien.
      expect(proof.dedans.length).toBeGreaterThan(0);
      expect(proof.dehors.length).toBeGreaterThan(0);
      const px = await pixelsOf(sceneOf(kind, { frame: proof.frame }));
      for (const [x, y] of proof.dedans) expect(`${kind} (${x},${y}) ${px(x, y)}`).toBe(`${kind} (${x},${y}) remplissage`);
      for (const [x, y] of proof.dehors) expect(`${kind} (${x},${y}) ${px(x, y)}`).toBe(`${kind} (${x},${y}) fond`);
    });
  }
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// LA ROTATION D'UNE FORME DÉCOUPÉE EST INERTE — EN PIXELS (arbitrage A, dette 2 du piège).
//
// Pourquoi en pixels et pas seulement en CSS : sur un cadre NON CARRÉ, laisser passer la `transform`
// ne « ne fait rien », ça ABÎME l'export. Satori tourne le REMPLISSAGE mais pas le masque (réserve 2)
// — un remplissage 800×400 pivoté de 90° devient 400×800 et ne couvre plus que la bande centrale du
// masque, alors que le navigateur, lui, tourne la découpe entière. C'est très exactement le désaccord
// éditeur/export de §0. La sonde ne pouvait pas le voir : elle mesurait un cadre CARRÉ, où un
// remplissage pivoté de 90° se superpose à lui-même.
// ────────────────────────────────────────────────────────────────────────────────────────────────
describe("renderScene() — la rotation est inerte sur une forme découpée, et vivante sur les autres", () => {
  async function bytesOf(scene: Scene): Promise<Buffer> {
    return Buffer.from((await renderScene({ scene, values: {} })).bytes);
  }

  it("triangle : pivoté de 90°, l'export est identique OCTET POUR OCTET au non pivoté", async () => {
    const pivote = await bytesOf(sceneOf("triangle", { rotation: 90 }));
    const droit = await bytesOf(sceneOf("triangle"));
    expect(pivote.equals(droit)).toBe(true);
    // Et le résultat est bien le triangle attendu, pas une image vide : sans ces deux points,
    // « identiques » serait aussi vrai de deux images entièrement bleues.
    const px = await sampler(pivote);
    expect(px(700, 380)).toBe("remplissage");
    expect(px(40, 40)).toBe("fond");
  });

  it("TÉMOIN : sur un rect, la rotation N'EST PAS inerte — les octets diffèrent", async () => {
    // Sans ce témoin, le test précédent passerait aussi si `frameStyle` avait cessé d'émettre toute
    // rotation pour tout le monde (ce qui casserait rect, ellipse, texte et image en silence).
    const pivote = await bytesOf(sceneOf("rect", { frame: { x: 200, y: 100, w: 400, h: 200 }, rotation: 20 }));
    const droit = await bytesOf(sceneOf("rect", { frame: { x: 200, y: 100, w: 400, h: 200 } }));
    expect(pivote.equals(droit)).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// LES EXTRÊMES — `minSize` (hooks/use-layer-drag.ts : 1 px) et un rapport d'aspect violent.
// Une découpe percentuelle sur un cadre de 1 px est le cas où resvg pourrait lever, ou rendre une
// image tronquée. Rien de tel : la scène se rend, aux dimensions demandées, forme par forme.
// ────────────────────────────────────────────────────────────────────────────────────────────────
describe("renderScene() — chaque forme survit à minSize et à un aspect très non uniforme", () => {
  const EXTREMES = [
    { x: 0, y: 0, w: 1, h: 1 },
    { x: 0, y: 0, w: 1, h: 400 },
    { x: 0, y: 0, w: 800, h: 1 },
    { x: 0, y: 0, w: 799, h: 3 },
  ] as const;

  it("les huit formes, aux quatre cadres extrêmes, dans UNE scène — aucune exception, image complète", async () => {
    // Toutes les formes dans la MÊME scène (32 calques) : une seule passe de rendu, et la moindre
    // exception de satori/resvg sur une découpe dégénérée fait échouer ce test.
    const layers: ShapeLayer[] = [];
    for (const kind of SHAPE_KINDS) {
      for (const [i, frame] of EXTREMES.entries()) {
        layers.push({
          id: `${kind}-${i}`, name: kind, visible: true, locked: false,
          frame: { ...frame }, type: "shape", shape: kind, fill: FILL, radius: 12,
        } as ShapeLayer);
      }
    }
    expect(layers).toHaveLength(SHAPE_KINDS.length * EXTREMES.length);
    const out = await renderScene({
      scene: { schemaVersion: 1, canvas: { width: 800, height: 400, background: BG }, layers },
      values: {},
    });
    expect(out.width).toBe(800);
    expect(out.height).toBe(400);
    expect(out.degraded).toBe(false);
    // Et l'image contient bien quelque chose de peint : une barre de 800×1 en (0,0) suffit à colorer
    // (400,0). Sans cette assertion, un rendu entièrement bleu passerait pour un succès.
    const px = await sampler(out.bytes);
    expect(px(400, 0)).toBe("remplissage");
  });

  it("une forme découpée réduite à 1 px de large reste dans son cadre — rien ne déborde", async () => {
    // La contre-épreuve du test précédent : un `clip-path` percentuel sur un cadre de 1 px pourrait,
    // s'il était résolu contre une autre boîte, peindre AILLEURS. On vérifie donc qu'à côté du calque,
    // c'est bien le fond.
    const px = await pixelsOf(sceneOf("triangle", { frame: { x: 0, y: 0, w: 1, h: 400 } }));
    expect(px(400, 200)).toBe("fond");
    expect(px(20, 200)).toBe("fond");
    // TÉMOIN POSITIF — revue finale U3, Minor 4 : les deux lignes ci-dessus sont DEUX NÉGATIFS, et une
    // image entièrement bleue (calque jamais peint, exception avalée, rendu dégradé) les passait toutes
    // les deux. Il faut donc montrer que quelque chose EST peint dans la colonne du calque.
    //
    // MISE À JOUR (chantier qualité d'image, suréchantillonnage 2×). Ce témoin affirmait un MÉLANGE
    // en (0,399), sur la mesure d'alors : « sur une colonne de 1 px, AUCUN pixel de sortie n'est
    // intégralement couvert (le plus rouge lu est rgba(152,23,152)) ». Cette mesure décrivait en
    // réalité une LIMITE DU RASTÉRISEUR, pas la géométrie : à la DERNIÈRE ligne du triangle, la base
    // occupe toute la largeur du cadre, donc ce pixel EST intégralement couvert — l'anticrénelage en
    // une seule passe le sous-couvrait. Rastérisé à 2× puis réduit, il se lit désormais
    // rgba(241,0,16) (re-mesuré), soit « remplissage » à la tolérance de ce fichier.
    //
    // On affirme donc le fait NOUVEAU et PLUS FORT — la colonne est réellement peinte, pas seulement
    // teintée — plutôt que de relâcher l'assertion pour retomber sur l'ancienne. Le témoin de mélange
    // n'est pas perdu pour autant : il DÉMÉNAGE à mi-hauteur (0,200), où le triangle ne couvre
    // vraiment qu'une fraction du pixel — une couverture partielle qu'aucune quantité
    // d'échantillonnage ne transformera jamais en aplat, contrairement à celle de la ligne de base.
    expect(px(0, 399)).toBe("remplissage");

    const aMiHauteur = px(0, 200);
    const canaux = /^rgba\((\d+),(\d+),(\d+),\d+\)$/.exec(aMiHauteur);
    expect(`(0,200) mélange : ${canaux !== null} — lu ${aMiHauteur}`).toBe(`(0,200) mélange : true — lu ${aMiHauteur}`);
    expect(Number(canaux![1])).toBeGreaterThan(80); // rouge : le fond en a 0 (± tolérance 24)
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// LA BORDURE N'EST PAS PEINTE SUR UNE FORME DÉCOUPÉE — EN PIXELS (réserve 3, revue de la Tâche 3).
//
// Pourquoi en pixels et pas seulement en CSS : c'est le SEUL moyen de voir la divergence que la sonde
// a mesurée. Satori ne fait pas entrer la bordure dans le `<g clip-path>` — le contour reste
// RECTANGULAIRE autour d'un remplissage triangulaire — tandis que le navigateur applique `clip-path` à
// l'élément entier, bordure comprise. Un `border` sur un triangle donnait donc un cadre complet dans le
// PNG livré et un simple liseré de base à l'écran : §0, mot pour mot.
//
// La bordure est donc supprimée des deux chemins (lib/studio/shapes.ts#layerBorder). Ce test le prouve
// LÀ OÙ ÇA COMPTE : dans les pixels de sortie. MUTATION QUI FAIT ROUGIR : remettre `layer.border` dans
// `shapeNode()` (lib/studio/element.ts) — le coin haut-gauche redevient VERT.
// ────────────────────────────────────────────────────────────────────────────────────────────────
describe("renderScene() — la bordure ne franchit pas la découpe (réserve 3)", () => {
  const CONTOUR = "#00FF00"; // vert pur : ni le remplissage (rouge) ni le fond (bleu)
  const BORDURE = { width: 60, color: CONTOUR, sides: ["top", "right", "bottom", "left"] } as const;

  // Un échantillonneur à TROIS couleurs : sans la troisième, « le coin n'est pas du remplissage » ne
  // distinguerait pas « fond » de « contour » — et c'est justement la distinction qui porte le test.
  async function triColore(bytes: Uint8Array) {
    const { data, info } = await sharp(Buffer.from(bytes)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return (x: number, y: number) => {
      const i = (y * info.width + x) * info.channels;
      const p = [data[i], data[i + 1], data[i + 2], data[i + 3]];
      const near = (t: number[]) => t.every((v, k) => Math.abs(p[k] - v) <= TOLERANCE);
      if (near([255, 0, 0])) return "remplissage";
      if (near([0, 0, 255])) return "fond";
      if (near([0, 255, 0])) return "contour";
      return `rgba(${p.join(",")})`;
    };
  }

  it("triangle bordé : le coin que le polygone exclut reste du FOND, pas du contour", async () => {
    const scene = sceneOf("triangle", { border: { ...BORDURE, sides: [...BORDURE.sides] } });
    const px = await triColore((await renderScene({ scene, values: {} })).bytes);
    // (20,20) est dans le coin haut-gauche : hors du triangle, et DANS la bande de 60 px qu'une
    // bordure rectangulaire couvrirait.
    expect(px(20, 20)).toBe("fond");
    expect(px(780, 20)).toBe("fond");
    // Et l'image reste bien le triangle attendu : sans ces deux points, une image entièrement bleue
    // passerait pour un succès.
    expect(px(400, 200)).toBe("remplissage");
    expect(px(700, 380)).toBe("remplissage");
  });

  it("TÉMOIN : la MÊME bordure sur un rect est bel et bien peinte — le contour n'a pas disparu partout", async () => {
    // Sans ce témoin, le test précédent passerait aussi si la bordure avait cessé d'être émise pour
    // TOUT LE MONDE (ce qui casserait rect, ellipse et ligne en silence).
    const scene = sceneOf("rect", { border: { ...BORDURE, sides: [...BORDURE.sides] } });
    const px = await triColore((await renderScene({ scene, values: {} })).bytes);
    expect(px(20, 20)).toBe("contour");
    expect(px(400, 200)).toBe("remplissage");
  });

  it("TÉMOIN : le vert est bien DISTINGUABLE du fond et du remplissage par cet échantillonneur", async () => {
    // Anti-vacuité de l'assertion « fond » ci-dessus : si l'échantillonneur classait le vert « fond »,
    // le premier test passerait même avec une bordure rectangulaire peinte.
    const scene = sceneOf("rect", { fill: CONTOUR });
    const px = await triColore((await renderScene({ scene, values: {} })).bytes);
    expect(px(400, 200)).toBe("contour");
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// L'OMBRE D'UNE FORME, EN PIXELS — U3 TÂCHE 4.
//
// « L'ombre est VISIBLE, pas seulement présente dans le balisage » (brief). Le piège est connu et
// documenté : en U1, l'ombre de l'artboard était bien dans le style et un conteneur `overflow-hidden`
// la rognait ENTIÈREMENT — un test vert au-dessus d'une propriété non tenue. Une ombre PORTÉE se
// peint HORS de la boîte de son élément : la seule preuve qui vaille est donc la COULEUR d'un pixel
// SITUÉ HORS du cadre du calque, dans l'image réellement produite.
//
// Et la seconde moitié : sur une forme DÉCOUPÉE, satori ne peint AUCUNE ombre (mesuré avant
// implémentation, tests/studio-render-clippath.test.ts « RÉSERVE 4 »), pas plus que le navigateur.
// L'ombre est donc supprimée des deux chemins (lib/studio/shapes.ts#layerBoxShadow) pour que cet
// accord soit STRUCTUREL et non accidentel. Ce bloc le prouve là où ça compte : dans les pixels.
//
// MUTATION QUI FAIT ROUGIR : retirer `boxShadow` du style de `shapeNode()` (l'anneau disparaît) ;
// remplacer `layerBoxShadow(layer)` par `layer.shadow` (le triangle se met à… ne rien peindre non
// plus aujourd'hui, mais le test de CSS des deux chemins, lui, rougit — voir tests/studio-shapes).
// ────────────────────────────────────────────────────────────────────────────────────────────────
describe("renderScene() — l'ombre d'une forme, en pixels", () => {
  const OMBRE_COULEUR = "#00FF00"; // vert pur : ni le remplissage (rouge) ni le fond (bleu)
  // Un anneau de 40 px, sans flou : `0 0 0 40px` n'est pas exprimable par le modèle (pas de champ
  // « spread »), donc on obtient l'équivalent avec un DÉCALAGE franc — une ombre déplacée de 60 px
  // vers le bas-droit, sans flou, qui laisse une bande verte franche sur deux côtés.
  const OMBRE = { x: 60, y: 60, blur: 0, color: OMBRE_COULEUR } as const;
  // Cadre 400×200 (NON carré) posé en (200,100) sur un canevas 800×400 : détaché des quatre bords,
  // pour qu'« aucune ombre » et « ombre hors canevas » ne puissent se confondre.
  const CADRE = { x: 200, y: 100, w: 400, h: 200 };

  // Échantillonneur à TROIS couleurs : sans la troisième, « ce point n'est pas du remplissage » ne
  // distinguerait pas « fond » de « ombre » — et c'est justement cette distinction qui porte le test.
  async function triColore(bytes: Uint8Array) {
    const { data, info } = await sharp(Buffer.from(bytes)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return (x: number, y: number) => {
      const i = (y * info.width + x) * info.channels;
      const p = [data[i], data[i + 1], data[i + 2], data[i + 3]];
      const near = (t: number[]) => t.every((v, k) => Math.abs(p[k] - v) <= TOLERANCE);
      if (near([255, 0, 0])) return "remplissage";
      if (near([0, 0, 255])) return "fond";
      if (near([0, 255, 0])) return "ombre";
      return `rgba(${p.join(",")})`;
    };
  }
  async function pixelsTri(kind: ShapeKind, extra: Partial<ShapeLayer>) {
    const scene = sceneOf(kind, { frame: { ...CADRE }, ...extra });
    return triColore((await renderScene({ scene, values: {} })).bytes);
  }

  // Deux points HORS du cadre du calque, dans la bande que l'ombre décalée de 60/60 doit couvrir :
  // sous le bord bas (y 300..360) et à droite du bord droit (x 600..660).
  const SOUS = [400, 340] as const;
  const DROITE = [640, 200] as const;

  it("un rectangle ombré peint bien du VERT hors de son cadre — l'ombre n'est pas rognée", async () => {
    const px = await pixelsTri("rect", { shadow: { ...OMBRE } });
    expect(px(...SOUS)).toBe("ombre");
    expect(px(...DROITE)).toBe("ombre");
    // Et la forme elle-même est intacte : l'ombre est DERRIÈRE, elle ne remplace pas le remplissage.
    expect(px(400, 200)).toBe("remplissage");
    // Le coin opposé (haut-gauche, hors décalage) reste du fond : l'ombre est bien DÉCALÉE, elle
    // n'inonde pas le canevas.
    expect(px(180, 80)).toBe("fond");
  });

  it("TÉMOIN : le MÊME rectangle SANS ombre laisse ces deux points au fond", async () => {
    const px = await pixelsTri("rect", {});
    expect(px(...SOUS)).toBe("fond");
    expect(px(...DROITE)).toBe("fond");
    expect(px(400, 200)).toBe("remplissage");
  });

  it("TÉMOIN : le vert est DISTINGUABLE du fond et du remplissage par cet échantillonneur", async () => {
    // Anti-vacuité des assertions « fond » ci-dessus : si l'échantillonneur classait le vert « fond »,
    // le témoin précédent passerait même avec une ombre peinte.
    const px = await pixelsTri("rect", { fill: OMBRE_COULEUR });
    expect(px(400, 200)).toBe("ombre");
  });

  it("une forme DÉCOUPÉE ne peint AUCUNE ombre — et c'est la décision, pas un hasard", async () => {
    const px = await pixelsTri("triangle", { shadow: { ...OMBRE } });
    expect(px(...SOUS)).toBe("fond");
    expect(px(...DROITE)).toBe("fond");
    // Le triangle est bien là : sans ces points, une image entièrement bleue passerait pour un succès.
    expect(px(400, 200)).toBe("remplissage");
    expect(px(240, 290)).toBe("remplissage");
  });

  it("une ELLIPSE ombrée peint son ombre, et l'ombre SUIT l'arrondi", async () => {
    // L'ellipse n'est pas découpée (`borderRadius: "50%"`) : elle porte donc l'ombre. Et la mesure
    // (RÉSERVE 4) a montré que l'ombre épouse l'arrondi dans satori COMME dans le navigateur — c'est
    // ce qui fait que l'éditeur et l'export s'accordent, donc ce qui autorise le contrôle ici.
    const px = await pixelsTri("ellipse", { shadow: { ...OMBRE } });
    // L'ellipse du remplissage : centre (400,200), demi-axes 200×100. Celle de l'ombre est la même,
    // décalée de 60/60 : centre (460,260). (460,350) est sous le centre de l'ombre, à 0,81 — DEDANS —
    // et hors du remplissage (0,09 + 2,25).
    expect(px(460, 350)).toBe("ombre");
    // (640,340) est le COIN bas-droit de la BOÎTE de l'ombre (260..660 × 160..360), à 20 px des deux
    // bords. Il est HORS de l'ellipse d'ombre — ((460-640)/200)² + ((260-340)/100)² = 0,81 + 0,64 =
    // 1,45 > 1 — et hors du remplissage (1,44 + 1,96). Une ombre RECTANGULAIRE l'aurait peint ; une
    // ombre qui épouse l'arrondi, non. C'est LE point qui distingue les deux.
    expect(px(640, 340)).toBe("fond");
    expect(px(400, 200)).toBe("remplissage");
  });

  it("TÉMOIN : sur un RECT ombré, ce même coin d'ombre EST peint", async () => {
    // La contre-épreuve : c'est bien `borderRadius` qui sculpte l'ombre, pas une limite de l'ombre
    // elle-même ni un artefact de l'échantillonnage à cet endroit précis.
    const px = await pixelsTri("rect", { shadow: { ...OMBRE } });
    expect(px(640, 340)).toBe("ombre");
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// LE RAYON PAR COIN, EN PIXELS — U3 TÂCHE 4.
//
// Le modèle acceptait DÉJÀ « 8px 24px 8px 24px » (migration de la Tâche 2, arbitrage C) et les deux
// chemins transportaient DÉJÀ la chaîne telle quelle (tests/studio-shapes.test.ts, balayage). Ce qui
// n'était prouvé NULLE PART, c'est que satori HONORE la forme courte à plusieurs valeurs — il aurait
// pu n'en lire que la première longueur, ou l'ignorer, et les assertions de CSS seraient restées
// vertes pendant que l'export arrondissait les quatre coins pareil. C'est exactement la famille du
// piège « stade au lieu d'ellipse » : la CSS était juste, le pixel non.
//
// MESURÉ ICI : satori honore l'ORDRE CSS (haut-gauche, haut-droit, bas-droit, bas-gauche), la forme
// à deux valeurs, et les pourcentages. C'est ce qui autorise le texte d'aide du panneau à annoncer
// cet ordre — il est asserté en pixels, pas supposé.
// ────────────────────────────────────────────────────────────────────────────────────────────────
describe("renderScene() — le rayon PAR COIN, en pixels", () => {
  // Cadre plein canevas 800×400 (non carré) : les quatre coins de l'image SONT les quatre coins du
  // calque. À 20 px du sommet, un coin arrondi de 150 px laisse le pixel AU FOND, un coin vif le
  // laisse REMPLI — le seul discriminant qui sépare « un coin » de « les quatre ».
  const COINS = {
    "haut-gauche": [20, 20],
    "haut-droit": [779, 20],
    "bas-droit": [779, 379],
    "bas-gauche": [20, 379],
  } as const;

  // Chaque cas dit, coin par coin, s'il doit être ARRONDI (donc au fond).
  const CAS: [string, number | string, Record<keyof typeof COINS, boolean>][] = [
    ["aucun rayon (témoin)", 0,
      { "haut-gauche": false, "haut-droit": false, "bas-droit": false, "bas-gauche": false }],
    ["scalaire 150 — la forme HISTORIQUE, inchangée", 150,
      { "haut-gauche": true, "haut-droit": true, "bas-droit": true, "bas-gauche": true }],
    ["« 150px » (une longueur)", "150px",
      { "haut-gauche": true, "haut-droit": true, "bas-droit": true, "bas-gauche": true }],
    ["« 0px 150px 0px 0px » — le HAUT-DROIT seul", "0px 150px 0px 0px",
      { "haut-gauche": false, "haut-droit": true, "bas-droit": false, "bas-gauche": false }],
    ["« 0px 0px 150px 0px » — le BAS-DROIT seul", "0px 0px 150px 0px",
      { "haut-gauche": false, "haut-droit": false, "bas-droit": true, "bas-gauche": false }],
    ["« 0px 0px 0px 150px » — le BAS-GAUCHE seul", "0px 0px 0px 150px",
      { "haut-gauche": false, "haut-droit": false, "bas-droit": false, "bas-gauche": true }],
    ["« 150px 0px » — les DIAGONALES (forme à deux valeurs)", "150px 0px",
      { "haut-gauche": true, "haut-droit": false, "bas-droit": true, "bas-gauche": false }],
    ["« 0% 40% 0% 0% » — le haut-droit, en POURCENTAGE", "0% 40% 0% 0%",
      { "haut-gauche": false, "haut-droit": true, "bas-droit": false, "bas-gauche": false }],
  ];

  for (const [nom, radius, attendu] of CAS) {
    it(`${nom}`, async () => {
      const px = await pixelsOf(sceneWith(radius));
      for (const [coin, [x, y]] of Object.entries(COINS)) {
        const arrondi = attendu[coin as keyof typeof COINS];
        expect(`${coin} (${x},${y}) ${px(x, y)}`).toBe(`${coin} (${x},${y}) ${arrondi ? "fond" : "remplissage"}`);
      }
      // Le centre est TOUJOURS peint : sans lui, une image entièrement bleue satisferait chaque
      // « fond » attendu ci-dessus.
      expect(px(400, 200)).toBe("remplissage");
    });
  }

  it("les huit cas ne sont pas tous identiques — la table sépare bien les coins", () => {
    // ANTI-VACUITÉ de la table : si chaque ligne attendait la même chose partout, la boucle
    // ci-dessus passerait sans jamais distinguer un coin d'un autre. On exige donc qu'au moins un cas
    // attende des coins DIFFÉRENTS entre eux, et que les quatre coins soient chacun arrondi dans au
    // moins un cas et vif dans au moins un autre.
    const mixtes = CAS.filter(([, , a]) => new Set(Object.values(a)).size > 1);
    expect(mixtes.length).toBeGreaterThan(0);
    for (const coin of Object.keys(COINS) as (keyof typeof COINS)[]) {
      expect(`${coin} arrondi au moins une fois`).toBe(
        `${coin} ${CAS.some(([, , a]) => a[coin]) ? "arrondi au moins une fois" : "JAMAIS arrondi"}`,
      );
      expect(`${coin} vif au moins une fois`).toBe(
        `${coin} ${CAS.some(([, , a]) => !a[coin]) ? "vif au moins une fois" : "JAMAIS vif"}`,
      );
    }
  });
});
