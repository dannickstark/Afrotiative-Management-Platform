import { describe, it, expect, mock } from "bun:test";
import sharp from "sharp";
import { renderScene } from "@/lib/studio/render";
import type { Scene } from "@/lib/studio/scene";
import * as shapesModule from "@/lib/studio/shapes";
import { polygonClip, type ShapeCss } from "@/lib/studio/shapes";

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
// LA DÉCOUPE, À TRAVERS renderScene()
//
// La seule chose substituée est la SORTIE de `shapeCssFor` — la description. `shapeNode()`,
// `sceneToElement()`, `renderScene()`, satori, resvg et sharp sont le code de production réel.
// MUTATION QUI FAIT ROUGIR : retirer `...shapeCssFor(layer)` du style de `shapeNode()` (ou le poser
// sur un nœud enfant) — la découpe n'arrive alors jamais aux pixels et les quatre points basculent.
// ────────────────────────────────────────────────────────────────────────────────────────────────
const REAL_SHAPES = { ...shapesModule }; // capturé AVANT tout mock.module (cf. tests/ai-fallback.test.ts)

function stubShapeCss(css: ShapeCss): void {
  mock.module("@/lib/studio/shapes", () => ({ ...REAL_SHAPES, shapeCssFor: () => css }));
}
function restoreShapes(): void {
  mock.module("@/lib/studio/shapes", () => ({ ...REAL_SHAPES }));
}
async function pixelsWithCss(css: ShapeCss): Promise<Sampler> {
  stubShapeCss(css);
  try {
    return await pixelsOf(sceneWith());
  } finally {
    restoreShapes();
  }
}

describe("renderScene() — une découpe émise par la description arrive bien aux pixels", () => {
  const TRIANGLE_PTS = [[50, 0], [100, 100], [0, 100]] as const;

  it("le triangle construit par polygonClip() est réellement découpé", async () => {
    const px = await pixelsWithCss({ clipPath: polygonClip(TRIANGLE_PTS) });
    expect(px(40, 40)).toBe("fond");           // coin haut-gauche : EXCLU (arête à x=360 pour y=40)
    expect(px(760, 40)).toBe("fond");          // coin haut-droit  : EXCLU (arête à x=440)
    expect(px(400, 200)).toBe("remplissage");  // centre
    expect(px(700, 380)).toBe("remplissage");  // bas-droit, DANS le triangle (arête à x=780)
  });

  it("TÉMOIN : sans découpe, ces deux coins sont du remplissage", async () => {
    const px = await pixelsWithCss({});
    expect(px(40, 40)).toBe("remplissage");
    expect(px(760, 40)).toBe("remplissage");
    expect(px(400, 200)).toBe("remplissage");
  });

  // LA MUTATION QUI GARDE LA RÈGLE D'ESPACEMENT VIVANTE (arbitrage B). La chaîne « à espaces » est
  // dérivée de la sortie du constructeur lui-même : si `polygonClip` se mettait un jour à émettre
  // « , », le test précédent basculerait sur CE résultat-ci. Les deux géométries diffèrent, en
  // pixels, à travers le pipeline de production — sur un cadre CARRÉ elles seraient identiques.
  it("la MÊME suite de sommets écrite avec une espace après la virgule donne une AUTRE géométrie", async () => {
    const espacee = polygonClip(TRIANGLE_PTS).replaceAll(",", ", ");
    expect(espacee).toContain(", "); // la variante testée est bien celle qu'on croit
    const px = await pixelsWithCss({ clipPath: espacee });
    expect(px(700, 380)).toBe("fond");          // DANS le triangle voulu, et pourtant vide
    expect(px(200, 300)).toBe("remplissage");   // la découpe a bien eu lieu : ce n'est pas « ignoré »
    expect(px(40, 40)).toBe("fond");
  });

  it("la description réelle est RESTAURÉE — aucun mock ne fuit hors de ce fichier", async () => {
    // Sans cette garde, un `mock.module` oublié suivrait le processus `bun test` entier et
    // contaminerait silencieusement d'autres fichiers.
    const module = await import("@/lib/studio/shapes");
    expect(module.shapeCssFor(sceneWith(24).layers[0] as never)).toEqual({ borderRadius: 24 });
    const px = await pixelsOf(sceneWith("50%"));
    expect(px(100, 60)).toBe("fond");
  });
});
