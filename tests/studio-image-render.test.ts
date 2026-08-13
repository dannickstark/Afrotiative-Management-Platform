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

  server = Bun.serve({
    port: 0,
    fetch(req) {
      const p = new URL(req.url).pathname;
      if (p === "/tile.png") return new Response(tile, { headers: { "content-type": "image/png" } });
      return new Response(cover, { headers: { "content-type": "image/png" } });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

const coverFetch: typeof fetch = (() => fetch(`${base}/cover.png`)) as unknown as typeof fetch;
const tileFetch: typeof fetch = (() => fetch(`${base}/tile.png`)) as unknown as typeof fetch;

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
