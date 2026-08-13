import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import sharp from "sharp";
import { renderScene } from "@/lib/studio/render";
import { parseScene } from "@/lib/studio/scene";
import type { Scene } from "@/lib/studio/scene";

// ============================================================================
// Properties Pro P1, Tâche 3 — §0 PIXEL du CHEMIN DE RENDU UNIQUE (image en `<div>` de fond).
//
// La Tâche 3 remplace le `<img objectFit>` d'un calque image par un `<div>` à `background-image`
// (`background-size`/`repeat`/`position`), et fait préparer l'image à sa taille NATURELLE (plus de
// pré-recadrage sharp au cadre). Ce fichier PROUVE au pixel, à travers `renderScene()` de bout en
// bout (satori -> resvg -> sharp), deux choses que l'ancien chemin ne savait pas faire toutes les
// deux :
//   1. `cover` (le cas historique) remplit toujours le cadre — un pixel INTÉRIEUR est l'image, pas
//      le fond, et le témoin `contain` laisse au contraire une bande de fond visible.
//   2. `tile` (un mode NOUVEAU du spike) répète réellement le motif — la BANDE rouge du motif
//      REVIENT dans la 2ᵉ tuile, ce qu'aucune image simplement mise à l'échelle ne fait.
//
// POURQUOI DES PIXELS. Un `background-size`/`repeat` ignoré produit un PNG parfaitement valide :
// « ça n'a pas levé » ne prouve rien de ce que resvg RASTERISE. Chaque affirmation compare donc la
// COULEUR d'un pixel de sortie, tolérance ±24 par canal (même convention que
// tests/studio-shape-render.test.ts), et chaque probe est à ≥ 20 px de toute frontière pour qu'aucun
// anticrénelage ni artefact JPEG ne l'explique.
// ============================================================================

// Serveurs fixture LOCAUX — même recette que tests/studio-render.test.ts. Deux images distinctes :
//   /cover.png : 400×200 ROUGE uni. En `cover` sur un cadre 400×400, elle est mise à l'échelle ×2 et
//                remplit TOUT le cadre (elle déborde en largeur) ; en `contain`, elle laisse deux
//                bandes de fond haut/bas — c'est ce qui distingue les deux modes au pixel.
//   /tile.png  : 100×100, moitié GAUCHE rouge (x 0..50), moitié DROITE verte (x 50..100). Répétée en
//                mosaïque (scale 1, focal {0,0} pour ancrer les tuiles à l'origine 0), le motif
//                red|green se répète tous les 100 px.
let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(async () => {
  const cover = await sharp({
    create: { width: 400, height: 200, channels: 3, background: { r: 255, g: 0, b: 0 } },
  }).png().toBuffer();

  const tile = await sharp({
    create: { width: 100, height: 100, channels: 3, background: { r: 255, g: 0, b: 0 } },
  }).composite([
    { input: await sharp({ create: { width: 50, height: 100, channels: 3, background: { r: 0, g: 255, b: 0 } } }).png().toBuffer(), left: 50, top: 0 },
  ]).png().toBuffer();

  // /crop.png : un TÉMOIN HORS-CENTRE pour LOCKER le recadrage au POINT FOCAL (revue de branche). Source
  // 1200×400 (aspect 3:1, ≠ le cadre carré), trois tiers verticaux : BLEU [0,400) | ROUGE [400,800) |
  // VERT [800,1200). Rendue `cover` sur un cadre 300×300, prepareImage RECADRE la source DANS sharp au
  // point focal (échelle cover s=0.75 → fenêtre 400×400 ; focal centre → origine x=400) puis la
  // redimensionne à l'aspect du cadre : l'image préparée est donc DÉJÀ le tiers ROUGE (le CENTRE), et
  // Satori la peint `cover` à 1:1 (aucun débordement, position 0). Le bleu (gauche) et le vert (droite)
  // sont recadrés HORS champ. C'est ce qui prouve, au pixel, que l'export suit le point focal.
  const crop = await sharp({
    create: { width: 1200, height: 400, channels: 3, background: { r: 0, g: 0, b: 255 } },
  }).composite([
    { input: await sharp({ create: { width: 400, height: 400, channels: 3, background: { r: 255, g: 0, b: 0 } } }).png().toBuffer(), left: 400, top: 0 },
    { input: await sharp({ create: { width: 400, height: 400, channels: 3, background: { r: 0, g: 255, b: 0 } } }).png().toBuffer(), left: 800, top: 0 },
  ]).png().toBuffer();

  // /blurA.png (300×300) et /blurB.png (1200×1200) : MÊME motif (moitié gauche ROUGE, moitié droite
  // VERTE), deux résolutions TRÈS différentes, pour prouver que le flou final est INDÉPENDANT du
  // plafond (revue de branche). Sur un cadre 300×300 `cover` : A (300, sous plafond) est peinte à
  // l'échelle 1, B (1200, bornée à 600) à l'échelle 0.5. AVANT le correctif, le flou effectif dépendait
  // de cette échelle (sigma 20 vs 10 pour blur 40) ; APRÈS, les deux valent ≈ blur/2 au cadre.
  const mkHalfRedGreen = (n: number) =>
    sharp({ create: { width: n, height: n, channels: 3, background: { r: 255, g: 0, b: 0 } } })
      .composite([{ input: { create: { width: n / 2, height: n, channels: 3, background: { r: 0, g: 255, b: 0 } } }, left: n / 2, top: 0 }])
      .png().toBuffer();
  const blurA = await mkHalfRedGreen(300);
  const blurB = await mkHalfRedGreen(1200);

  server = Bun.serve({
    port: 0,
    fetch(req) {
      const p = new URL(req.url).pathname;
      if (p === "/tile.png") return new Response(tile, { headers: { "content-type": "image/png" } });
      if (p === "/crop.png") return new Response(crop, { headers: { "content-type": "image/png" } });
      if (p === "/blurA.png") return new Response(blurA, { headers: { "content-type": "image/png" } });
      if (p === "/blurB.png") return new Response(blurB, { headers: { "content-type": "image/png" } });
      return new Response(cover, { headers: { "content-type": "image/png" } });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

const coverFetch: typeof fetch = (() => fetch(`${base}/cover.png`)) as unknown as typeof fetch;
const tileFetch: typeof fetch = (() => fetch(`${base}/tile.png`)) as unknown as typeof fetch;
const cropFetch: typeof fetch = (() => fetch(`${base}/crop.png`)) as unknown as typeof fetch;
const blurAFetch: typeof fetch = (() => fetch(`${base}/blurA.png`)) as unknown as typeof fetch;
const blurBFetch: typeof fetch = (() => fetch(`${base}/blurB.png`)) as unknown as typeof fetch;

// Échantillonneur à trois couleurs primaires saturées — tolérance très supérieure au bruit JPEG.
const TOLERANCE = 24;
type Sampler = (x: number, y: number) => string;
async function sampler(bytes: Uint8Array): Promise<Sampler> {
  const { data, info } = await sharp(Buffer.from(bytes)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return (x, y) => {
    const i = (y * info.width + x) * info.channels;
    const p = [data[i], data[i + 1], data[i + 2], data[i + 3]];
    const near = (t: number[]) => t.every((v, k) => Math.abs(p[k] - v) <= TOLERANCE);
    if (near([255, 0, 0])) return "rouge";
    if (near([0, 255, 0])) return "vert";
    if (near([0, 0, 255])) return "bleu";
    return `rgba(${p.join(",")})`;
  };
}

const BASE = { visible: true, locked: false };

describe("renderScene() — §0 pixel : une image COVER remplit le cadre (chemin de fond, Tâche 3)", () => {
  // Cadre plein canevas 400×400 sur un fond BLEU. La source cover.png (400×200 rouge) est mise à
  // l'échelle ×2 en `cover` et remplit tout le cadre : chaque pixel intérieur — jusqu'au bord haut —
  // est rouge. Le fond bleu ne doit apparaître NULLE PART.
  function coverScene(sizing?: "cover" | "contain"): Scene {
    return {
      schemaVersion: 1,
      canvas: { width: 400, height: 400, background: "#0000FF" },
      layers: [{
        ...BASE, id: "img", name: "image", frame: { x: 0, y: 0, w: 400, h: 400 },
        type: "image", source: { kind: "slot", slot: "article.image" }, fit: "cover",
        ...(sizing ? { sizing } : {}),
      }],
    };
  }

  it("un pixel INTÉRIEUR est l'image (rouge), pas le fond — cover remplit jusqu'aux bords", async () => {
    const out = await renderScene({ scene: coverScene("cover"), values: { "article.image": "https://cdn.test/cover.png" }, fetchImpl: coverFetch });
    const px = await sampler(out.bytes);
    expect(px(200, 200)).toBe("rouge"); // centre
    expect(px(200, 20)).toBe("rouge");  // près du bord HAUT : cover recouvre, contain laisserait le fond
    expect(px(20, 200)).toBe("rouge");  // près du bord GAUCHE
  });

  it("TÉMOIN : en `contain`, la MÊME source laisse une bande de FOND (bleu) en haut — cover ≠ contain", async () => {
    // La source 400×200 en `contain` sur 400×400 tient à 400×200, centrée verticalement (bandes
    // 0..100 et 300..400 restées au fond). (200,20) est dans la bande haute → bleu, là où `cover`
    // ci-dessus le peint rouge. C'est ce qui prouve que le mode n'est pas inerte.
    const out = await renderScene({ scene: coverScene("contain"), values: { "article.image": "https://cdn.test/cover.png" }, fetchImpl: coverFetch });
    const px = await sampler(out.bytes);
    expect(px(200, 20)).toBe("bleu");   // bande haute : FOND
    expect(px(200, 200)).toBe("rouge"); // centre : l'image est bien là
  });
});

describe("renderScene() — §0 pixel : un mode NOUVEAU (tile) répète le motif (Tâche 3)", () => {
  // Motif 100×100 red|green, mosaïqué (scale 1) sur un cadre 400×400, tuiles ancrées à l'origine
  // (focal {0,0}). Le motif red|green se répète donc tous les 100 px : rouge sur [0,50), vert sur
  // [50,100), et de nouveau rouge sur [100,150)…
  function tileScene(): Scene {
    return {
      schemaVersion: 1,
      canvas: { width: 400, height: 400, background: "#0000FF" },
      layers: [{
        ...BASE, id: "img", name: "image", frame: { x: 0, y: 0, w: 400, h: 400 },
        type: "image", source: { kind: "slot", slot: "article.image" }, fit: "cover",
        sizing: "tile", focal: { x: 0, y: 0 }, tile: { scale: 1, axis: "both" },
      }],
    };
  }

  it("la BANDE rouge REVIENT dans la 2ᵉ tuile — la mosaïque répète, elle ne s'étire pas", async () => {
    const out = await renderScene({ scene: tileScene(), values: { "article.image": "https://cdn.test/tile.png" }, fetchImpl: tileFetch });
    const px = await sampler(out.bytes);
    // 1ʳᵉ tuile (x 0..100) : le motif red|green.
    expect(px(20, 50)).toBe("rouge"); // x-dans-tuile 20 ∈ [0,50)
    expect(px(70, 50)).toBe("vert");  // x-dans-tuile 70 ∈ [50,100)
    // 2ᵉ tuile (x 100..200) : LE point qui prouve la répétition — le rouge REVIENT après le vert de la
    // 1ʳᵉ tuile. Une image simplement mise à l'échelle (n'importe quel `fit`) est monotone (rouge PUIS
    // vert, une seule fois) et n'a jamais de retour au rouge à x=120.
    expect(px(120, 50)).toBe("rouge"); // pixel DANS la 2ᵉ tuile, bande rouge répétée
    expect(px(170, 50)).toBe("vert");  // et la bande verte de la 2ᵉ tuile aussi
  });
});

// ============================================================================
// §0 (revue de branche) — LE RECADRAGE `cover` SUIT LE POINT FOCAL, MESURÉ AU PIXEL (témoin hors-centre).
//
// prepareImage (images.ts) RECADRE désormais la source DANS sharp au point focal pour `cover`, plutôt
// que de déléguer le recadrage au `background-position` de Satori. RAISON : Satori 0.29 PLAFONNE
// `background-position` négatif à 0 — or un `cover` qui déborde le cadre (aspect source ≠ aspect cadre,
// c.-à-d. quasi toute vraie photo) calcule une position NÉGATIVE, que Satori épinglait à 0, figeant
// l'export sur le coin HAUT-GAUCHE quel que soit le point focal. La correction : sharp livre déjà la
// fenêtre focale (aspect du cadre), Satori la peint `cover` à 1:1 (aucun débordement → position 0),
// donc l'export est FIDÈLE au point focal ET rejoint l'aperçu navigateur (layer-view.tsx, qui émet un
// `background-position` en `%` qu'un vrai navigateur applique correctement — même région conservée).
//
// Le témoin cover.png précédent est ROUGE uni : il ne peut RIEN dire de QUELLE région est conservée. Ce
// test le mesure avec un témoin HORS-CENTRE (BLEU | ROUGE | VERT) et LOCKE la région réellement conservée
// par l'EXPORT en balayant le point focal — pour qu'une régression future (ou un changement de version de
// Satori qui replafonnerait la position) rougisse. WYSIWYG : la région exportée à focal 0.5 est le CENTRE,
// exactement ce que le CSS `background-position:50%` de l'aperçu navigateur montre.
// ============================================================================

describe("renderScene() — §0 pixel : cover recadre au POINT FOCAL — l'export suit le focal et rejoint l'aperçu", () => {
  function coverCropScene(focal?: { x: number; y: number }): Scene {
    return {
      schemaVersion: 1,
      canvas: { width: 300, height: 300, background: "#0000FF" },
      layers: [{
        ...BASE, id: "img", name: "image", frame: { x: 0, y: 0, w: 300, h: 300 },
        type: "image", source: { kind: "slot", slot: "article.image" }, fit: "cover", sizing: "cover",
        ...(focal ? { focal } : {}),
      }],
    };
  }

  it("focal PAR DÉFAUT (0.5,0.5) → le CENTRE de la source (rouge) remplit le cadre — WYSIWYG avec l'aperçu (background-position:50%)", async () => {
    // Source 1200×400 : `cover` s=max(300/1200,300/400)=0.75 → fenêtre visible 400×400. focal centre →
    // origine x=(1200−400)·0.5=400 : sharp extrait [400,800) = le tiers ROUGE (le CENTRE), redimensionné
    // à l'aspect du cadre. Satori le peint `cover` à 1:1 (position 0). Tout le cadre est ROUGE.
    const out = await renderScene({ scene: coverCropScene(), values: { "article.image": "https://cdn.test/crop.png" }, fetchImpl: cropFetch });
    const px = await sampler(out.bytes);
    // Tout le cadre est le tiers CENTRAL de la source — le ROUGE — jusqu'aux deux bords latéraux.
    expect(px(150, 150)).toBe("rouge"); // centre du cadre : le tiers CENTRAL de la source (WYSIWYG avec l'aperçu)
    expect(px(30, 150)).toBe("rouge");  // bord gauche
    expect(px(270, 150)).toBe("rouge"); // bord droit
    expect(px(150, 30)).toBe("rouge");  // haut : l'axe vertical remplit exactement (aucun recadrage vertical)
    expect(px(150, 270)).toBe("rouge"); // bas
    // ANTI-VACUITÉ : le BLEU (gauche) et le VERT (droite) sont recadrés HORS champ, nulle part visibles.
    for (const [x, y] of [[30, 150], [150, 150], [270, 150], [150, 30], [150, 270]] as const) {
      expect(px(x, y)).not.toBe("bleu");
      expect(px(x, y)).not.toBe("vert");
    }
  });

  it("focal {0,0} → le tiers GAUCHE (bleu) — le point focal tire le recadrage vers l'origine", async () => {
    // origine x=(1200−400)·0=0 : sharp extrait [0,400) = le tiers BLEU (gauche). Le focal PILOTE l'export.
    const out = await renderScene({ scene: coverCropScene({ x: 0, y: 0 }), values: { "article.image": "https://cdn.test/crop.png" }, fetchImpl: cropFetch });
    const px = await sampler(out.bytes);
    expect(px(150, 150)).toBe("bleu");
    expect(px(30, 150)).toBe("bleu");
    expect(px(270, 150)).toBe("bleu");
    expect(px(150, 150)).not.toBe("rouge");
    expect(px(150, 150)).not.toBe("vert");
  });

  it("focal {1,0} → le tiers DROIT (vert) — le point focal tire le recadrage vers la fin", async () => {
    // origine x=(1200−400)·1=800 : sharp extrait [800,1200) = le tiers VERT (droite).
    const out = await renderScene({ scene: coverCropScene({ x: 1, y: 0 }), values: { "article.image": "https://cdn.test/crop.png" }, fetchImpl: cropFetch });
    const px = await sampler(out.bytes);
    expect(px(150, 150)).toBe("vert");
    expect(px(30, 150)).toBe("vert");
    expect(px(270, 150)).toBe("vert");
    expect(px(150, 150)).not.toBe("rouge");
    expect(px(150, 150)).not.toBe("bleu");
  });
});

// ============================================================================
// §0 (revue de branche) — LE FLOU EST INDÉPENDANT DU PLAFOND (donc de la résolution SOURCE).
//
// `prepareImage` floute à la résolution PRÉPARÉE (bornée au plafond), puis Satori redimensionne sur le
// cadre — ce qui, sans correction, divisait le sigma effectif par ce facteur et faisait dépendre le
// flou final du plafond. Ce test rend le MÊME motif (moitié rouge / moitié verte), MÊME cadre, MÊME
// `blur`, depuis deux sources de résolutions TRÈS différentes (300 px vs 1200 px), et mesure la LARGEUR
// de la bande de transition floutée au centre : elle doit être quasi identique. AVANT le correctif,
// A (échelle 1) floutait ~2× plus large que B (échelle 0.5) — ce test aurait alors rougi.
// ============================================================================

describe("renderScene() — §0 pixel : le flou ne dépend pas de la résolution source (revue de branche)", () => {
  function blurScene(): Scene {
    return {
      schemaVersion: 1,
      canvas: { width: 300, height: 300, background: "#0000FF" },
      layers: [{
        ...BASE, id: "img", name: "image", frame: { x: 0, y: 0, w: 300, h: 300 },
        type: "image", source: { kind: "slot", slot: "article.image" }, fit: "cover", sizing: "cover",
        blur: 40,
      }],
    };
  }

  // La largeur (en px) de la bande de transition au centre : le long de la ligne y=150, dans la fenêtre
  // x ∈ [30,270] (à l'écart des bords du cadre), on compte les pixels qui ne sont NI rouge pur NI vert
  // pur — la zone que le flou a mélangée. Elle croît avec le sigma effectif du flou.
  async function transitionBand(bytes: Uint8Array): Promise<number> {
    const px = await sampler(bytes);
    let band = 0;
    for (let x = 30; x <= 270; x++) {
      const c = px(x, 150);
      if (c !== "rouge" && c !== "vert") band++;
    }
    return band;
  }

  it("deux sources 300 px vs 1200 px, même cadre + même blur → la MÊME largeur de flou (± tolérance)", async () => {
    const outA = await renderScene({ scene: blurScene(), values: { "article.image": "https://cdn.test/blurA.png" }, fetchImpl: blurAFetch });
    const outB = await renderScene({ scene: blurScene(), values: { "article.image": "https://cdn.test/blurB.png" }, fetchImpl: blurBFetch });
    const bandA = await transitionBand(outA.bytes);
    const bandB = await transitionBand(outB.bytes);

    // Le flou a réellement eu lieu (anti-vacuité : un flou tombé à zéro donnerait une bande ~nulle).
    expect(bandA).toBeGreaterThan(10);
    expect(bandB).toBeGreaterThan(10);
    // Et il est de MÊME largeur des deux côtés — le cœur du correctif. Tolérance large (échantillonnage
    // catégoriel + arrondi sous-pixel) mais bien SOUS l'écart d'avant le correctif (~2×, soit > 15 px).
    expect(Math.abs(bandA - bandB)).toBeLessThanOrEqual(10);
  });
});

// ============================================================================
// Properties Pro P1, Tâche 7 — §0 DE BOUT EN BOUT (intégration finale).
//
// Les deux describe ci-dessus prouvent déjà `sizing` EXPLICITE (cover/contain/tile) au pixel. Ce
// qu'ils NE prouvent PAS : un gabarit ÉCRIT AVANT cette fonctionnalité — qui n'a QUE `fit`, jamais
// `sizing` — retombe bien sur le MÊME `background-size` via `imageCss`#118
// (`layer.sizing ?? (layer.fit === "cover" ? "cover" : "contain")`). C'est un CHEMIN DE CODE distinct
// (la branche `??` de repli, jamais exercée par les tests ci-dessus qui posent toujours `sizing`
// explicitement) — la preuve au pixel doit donc être répétée ici avec un calque qui n'a QUE `fit`.
// ============================================================================

describe("renderScene() — §0 pixel : parité LEGACY (fit SEUL, sans `sizing`) — Tâche 7", () => {
  // Calque STRICTEMENT historique : aucune des clés introduites par la Tâche 2 (`sizing`, `focal`,
  // `tile`, `customSize`) n'apparaît. C'est le gabarit tel qu'un designer l'a écrit avant P1.
  function legacyScene(fit: "cover" | "contain"): Scene {
    return {
      schemaVersion: 1,
      canvas: { width: 400, height: 400, background: "#0000FF" },
      layers: [{
        ...BASE, id: "img", name: "image", frame: { x: 0, y: 0, w: 400, h: 400 },
        type: "image", source: { kind: "slot", slot: "article.image" }, fit,
      }],
    };
  }

  it("`fit: cover` SEUL (sans `sizing`) remplit le cadre jusqu'aux bords — même verdict que sizing:cover explicite", async () => {
    const out = await renderScene({ scene: legacyScene("cover"), values: { "article.image": "https://cdn.test/cover.png" }, fetchImpl: coverFetch });
    const px = await sampler(out.bytes);
    expect(px(200, 200)).toBe("rouge"); // centre
    expect(px(200, 20)).toBe("rouge");  // bord HAUT : cover recouvre
    expect(px(20, 200)).toBe("rouge");  // bord GAUCHE
  });

  it("`fit: contain` SEUL (sans `sizing`) laisse une bande de FOND — même verdict que sizing:contain explicite", async () => {
    const out = await renderScene({ scene: legacyScene("contain"), values: { "article.image": "https://cdn.test/cover.png" }, fetchImpl: coverFetch });
    const px = await sampler(out.bytes);
    expect(px(200, 20)).toBe("bleu");   // bande haute : FOND, contain ne recouvre pas jusqu'au bord
    expect(px(200, 200)).toBe("rouge"); // centre : l'image est bien là
  });
});

describe("parseScene() — aucune dérive de sérialisation sur un calque image legacy — Tâche 7", () => {
  it("une scène image qui n'a que `fit` fait l'aller-retour à l'IDENTIQUE — aucune clé nouvelle injectée, aucun défaut matérialisé", () => {
    const scene: Scene = {
      schemaVersion: 1,
      canvas: { width: 400, height: 400, background: "#0000FF" },
      layers: [{
        ...BASE, id: "img", name: "image", frame: { x: 0, y: 0, w: 400, h: 400 },
        type: "image", source: { kind: "slot", slot: "article.image" }, fit: "cover",
      }],
    };
    expect(parseScene(scene)).toEqual(scene);
  });
});

describe("renderScene() — chaque mode `sizing` NOUVEAU rend sans erreur (smoke, Tâche 7)", () => {
  // Preuve de fumée : la parité pixel PAR MODE (cover/contain/étirer/mosaïque/perso, point focal) est
  // le travail Playwright du contrôleur (WYSIWYG Montage vs Rendu réel) — hors de portée de jsdom.
  // Ici, on prouve seulement que `renderScene` ABOUTIT et produit un buffer non vide pour chaque mode
  // introduit par le schéma (Tâche 2) — aucun ne fait planter le moteur de rendu.
  const modes: Array<{ name: string; layer: Partial<Scene["layers"][number]> }> = [
    { name: "cover", layer: { sizing: "cover" } },
    { name: "contain", layer: { sizing: "contain" } },
    { name: "stretch", layer: { sizing: "stretch" } },
    { name: "tile (avec tile:{scale,axis})", layer: { sizing: "tile", tile: { scale: 1, axis: "both" } } },
    { name: "custom (avec customSize)", layer: { sizing: "custom", customSize: { w: 200, h: 100 } } },
    { name: "focal (point focal seul, sizing par défaut)", layer: { focal: { x: 0.2, y: 0.8 } } },
  ];

  for (const { name, layer } of modes) {
    it(`sizing/focal « ${name} » : renderScene aboutit et produit un buffer non vide`, async () => {
      const scene: Scene = {
        schemaVersion: 1,
        canvas: { width: 400, height: 400, background: "#0000FF" },
        layers: [{
          ...BASE, id: "img", name: "image", frame: { x: 0, y: 0, w: 400, h: 400 },
          type: "image", source: { kind: "slot", slot: "article.image" }, fit: "cover",
          ...layer,
        } as Scene["layers"][number]],
      };
      const out = await renderScene({ scene, values: { "article.image": "https://cdn.test/cover.png" }, fetchImpl: coverFetch });
      expect(out.bytes.length).toBeGreaterThan(0);
    });
  }
});
