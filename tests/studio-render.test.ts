import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import sharp from "sharp";
import { renderScene, fitFontSize } from "@/lib/studio/render";
import { MissingTokensError } from "@/lib/studio/values";
import { loadFallbackFonts, type AssetLoader, type LoadedFont } from "@/lib/studio/fonts";
import type { Scene, TextLayer } from "@/lib/studio/scene";

let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(async () => {
  const png = await sharp({
    create: { width: 800, height: 800, channels: 3, background: { r: 20, g: 120, b: 60 } },
  }).png().toBuffer();

  // Damier grossier à fort contraste (2x2, quadrants blanc/noir) — contrairement à la couleur unie
  // ci-dessus, une composition RÉUSSIE de cette image produit un écart-type élevé, tandis qu'une
  // composition ratée (calque image ignoré, canevas noir uni derrière) resterait proche de zéro.
  // C'est ce qui permet à un test de distinguer « le calque image a réellement été peint » de
  // « autre chose sur le canevas a suffi à faire varier les pixels ».
  const checker = await sharp({
    create: { width: 400, height: 400, channels: 3, background: { r: 255, g: 255, b: 255 } },
  }).composite([
    { input: await sharp({ create: { width: 200, height: 200, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toBuffer(), left: 200, top: 0 },
    { input: await sharp({ create: { width: 200, height: 200, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toBuffer(), left: 0, top: 200 },
  ]).png().toBuffer();

  server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/checker.png") return new Response(checker, { headers: { "content-type": "image/png" } });
      return new Response(png, { headers: { "content-type": "image/png" } });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

// RenderSceneOptions.fetchImpl est typé `typeof fetch` (signature imposée par le brief), qui sous
// bun-types inclut la propriété statique `preconnect` en plus de la signature d'appel. Une simple
// lambda de redirection vers le serveur fixture ne l'a pas ; on ne s'en sert jamais à l'exécution
// (prepareImage n'appelle que la signature d'appel), donc l'assertion de type ici est sûre.
const fixtureFetch: typeof fetch = (() => fetch(`${base}/x.png`)) as unknown as typeof fetch;
const fixtureCheckerFetch: typeof fetch = (() => fetch(`${base}/checker.png`)) as unknown as typeof fetch;

const b = { visible: true, locked: false };
function agribusinessScene(): Scene {
  return {
    schemaVersion: 1,
    canvas: { width: 1200, height: 675, background: "#000000" },
    layers: [
      { ...b, id: "bg", name: "Fond", frame: { x: 0, y: 0, w: 1200, h: 675 },
        type: "image", source: { kind: "slot", slot: "article.image" }, fit: "cover",
        blur: 24, overlay: "#000000A6" },
      { ...b, id: "frame", name: "Bordure", frame: { x: 0, y: 0, w: 1200, h: 675 },
        type: "shape", shape: "rect", fill: "transparent",
        border: { width: 12, color: "{{category.color}}" } },
      { ...b, id: "title", name: "Titre", frame: { x: 80, y: 380, w: 1040, h: 220 },
        type: "text", content: "{{article.title}}",
        font: { family: "Noto Sans", size: 64, weight: 700 },
        color: "#FFFFFF", align: "left", vAlign: "bottom", lineHeight: 1.1, maxLines: 3 },
    ],
  };
}

const values = {
  "article.image": "https://cdn.test/photo.png",
  "article.title": "Le cacao camerounais bat un record d'exportation en 2026",
  "category.color": "#1B7F4A",
} as const;

describe("renderScene", () => {
  it("rend un JPEG aux dimensions du canevas", async () => {
    const out = await renderScene({
      scene: agribusinessScene(), values, fetchImpl: fixtureFetch,
    });
    expect(out.width).toBe(1200);
    expect(out.height).toBe(675);
    expect(out.mime).toBe("image/jpeg");
    expect(out.degraded).toBe(false);
    const meta = await sharp(Buffer.from(out.bytes)).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBe(1200);
    expect(meta.height).toBe(675);
  });

  it("produit une image réellement peinte, pas un aplat noir", async () => {
    const out = await renderScene({
      scene: agribusinessScene(), values, fetchImpl: fixtureFetch,
    });
    const stats = await sharp(Buffer.from(out.bytes)).stats();
    // Un aplat uniforme aurait un écart-type quasi nul sur tous les canaux.
    //
    // ATTENTION en le lisant : ce test à lui seul NE PROUVE PAS que le calque image de fond est
    // composité. Le fixture ci-dessus est une couleur UNIE (20,120,60) : même floutée et teintée,
    // une image de fond ratée resterait indiscernable d'une image de fond réussie côté écart-type,
    // les deux étant plats. La variance mesurée ici vient en réalité du titre (texte blanc) et de
    // la bordure colorée du calque « frame », que ce test rend en même temps. Le test dédié
    // ci-dessous (« le calque image de fond est réellement composité… ») isole spécifiquement le
    // calque image avec une image source à fort contraste, pour de vrai le prouver.
    expect(Math.max(...stats.channels.map((c) => c.stdev))).toBeGreaterThan(5);
  });

  it("le calque image de fond est réellement composité (pas juste ignoré derrière un canevas noir)", async () => {
    // Scène RÉDUITE au SEUL calque image, sans texte ni bordure : si la composition d'image échoue
    // silencieusement (calque ignoré), il ne reste que le fond noir uni du canevas, et ce test doit
    // alors échouer. L'image source (damier 2x2 fort contraste) garantit une variance mesurable
    // uniquement si elle a été réellement dessinée.
    const scene: Scene = {
      schemaVersion: 1,
      canvas: { width: 400, height: 400, background: "#000000" },
      layers: [
        { ...b, id: "bg", name: "Fond", frame: { x: 0, y: 0, w: 400, h: 400 },
          type: "image", source: { kind: "slot", slot: "article.image" }, fit: "cover" },
      ],
    };
    const out = await renderScene({
      scene, values: { "article.image": "https://cdn.test/checker.png" }, fetchImpl: fixtureCheckerFetch,
    });
    const stats = await sharp(Buffer.from(out.bytes)).stats();
    expect(Math.max(...stats.channels.map((c) => c.stdev))).toBeGreaterThan(50);
  });

  it("refuse de rendre quand une valeur manque, en la nommant", async () => {
    await expect(
      renderScene({ scene: agribusinessScene(), values: { "article.title": "x" }, fetchImpl: fixtureFetch }),
    ).rejects.toBeInstanceOf(MissingTokensError);
  });

  it("aboutit malgré un titre hors norme quand autoFit est actif", async () => {
    const s = agribusinessScene();
    const title = s.layers[2];
    if (title.type !== "text") throw new Error("type");
    title.autoFit = true;
    delete title.maxLines;
    const long = { ...values, "article.title": "Titre ".repeat(80) };
    const out = await renderScene({ scene: s, values: long, fetchImpl: fixtureFetch });
    expect(out.width).toBe(1200); // le rendu aboutit malgré un texte hors norme
  });

  // Le test précédent prouve seulement que le rendu n'a pas planté — un autoFit qui ne ferait
  // RIEN (bug silencieux) le passerait tout aussi bien. On teste ici directement fitFontSize
  // (l'unité qui fait le travail réel) pour prouver que la taille de police RÉDUIT effectivement
  // quand le texte déborde, et reste proche du maximum quand il tient déjà.
  describe("fitFontSize", () => {
    let fonts: LoadedFont[];
    beforeAll(async () => { fonts = await loadFallbackFonts(); });

    const baseLayer = (content: string): TextLayer => ({
      visible: true, locked: false,
      id: "title", name: "Titre",
      frame: { x: 80, y: 380, w: 1040, h: 220 },
      type: "text", content,
      font: { family: "Noto Sans", size: 64, weight: 700 },
      color: "#FFFFFF", align: "left", vAlign: "bottom", lineHeight: 1.1,
      autoFit: true,
    });

    it("garde une taille proche du maximum quand le texte tient déjà dans le cadre", async () => {
      const size = await fitFontSize(baseLayer("Le cacao camerounais bat un record d'exportation en 2026"), fonts);
      expect(size).toBeGreaterThan(50);
      expect(size).toBeLessThanOrEqual(64);
    });

    it("réduit substantiellement la taille de police pour un titre extrêmement long", async () => {
      const shortSize = await fitFontSize(baseLayer("Titre court"), fonts);
      const longSize = await fitFontSize(baseLayer("Titre ".repeat(80)), fonts);
      expect(longSize).toBeLessThan(shortSize);
      expect(longSize).toBeLessThan(30); // très en dessous des 64px de départ
    });
  });
});

describe("renderScene — QR", () => {
  function qrScene(): Scene {
    return {
      schemaVersion: 1,
      canvas: { width: 400, height: 400, background: "#FFFFFF" },
      layers: [
        { ...b, id: "qr", name: "QR", frame: { x: 20, y: 20, w: 360, h: 360 },
          type: "qr", slot: "article.url", fg: "#000000", bg: "#FFFFFF", margin: 1 },
      ],
    };
  }

  it("rend un QR code réellement peint (SVG embarqué en data URI, rasterisé par resvg)", async () => {
    const out = await renderScene({
      scene: qrScene(),
      values: { "article.url": "https://example.com/article/42" },
    });
    expect(out.width).toBe(400);
    expect(out.height).toBe(400);
    const stats = await sharp(Buffer.from(out.bytes)).stats();
    // Un carré blanc uni (QR non peint) aurait un écart-type quasi nul.
    expect(Math.max(...stats.channels.map((c) => c.stdev))).toBeGreaterThan(20);
  });

  it("exige la valeur du jeton du slot QR même si elle n'est jamais substituée dans le texte", async () => {
    await expect(
      renderScene({ scene: qrScene(), values: {} }),
    ).rejects.toBeInstanceOf(MissingTokensError);
  });
});

describe("renderScene — police manquante (dégradation tolérée)", () => {
  function textOnlyScene(): Scene {
    return {
      schemaVersion: 1,
      canvas: { width: 300, height: 200, background: "#000000" },
      layers: [
        { ...b, id: "title", name: "Titre", frame: { x: 10, y: 10, w: 280, h: 180 },
          type: "text", content: "Bonjour",
          font: { assetId: "asset-introuvable", family: "Police Perso", size: 40, weight: 400 },
          color: "#FFFFFF", align: "left", vAlign: "top", lineHeight: 1.2 },
      ],
    };
  }

  const missingFontLoader: AssetLoader = {
    async font() { return null; },
    async imageUrl() { return null; },
  };

  it("retombe sur la police de repli et marque le rendu dégradé quand l'asset est introuvable", async () => {
    const out = await renderScene({ scene: textOnlyScene(), values: {}, assets: missingFontLoader });
    expect(out.degraded).toBe(true);
    expect(out.width).toBe(300);
    expect(out.height).toBe(200);
  });
});

describe("renderScene — canal alpha", () => {
  function transparentScene(): Scene {
    return {
      schemaVersion: 1,
      canvas: { width: 100, height: 100, background: "transparent" },
      layers: [
        { ...b, id: "dot", name: "Point", frame: { x: 10, y: 10, w: 20, h: 20 },
          type: "shape", shape: "rect", fill: "#FF0000" },
      ],
    };
  }

  it("préserve le canal alpha en WebP quand le fond du canevas est transparent", async () => {
    const out = await renderScene({ scene: transparentScene(), values: {}, encode: "webp" });
    expect(out.mime).toBe("image/webp");
    const meta = await sharp(Buffer.from(out.bytes)).metadata();
    expect(meta.hasAlpha).toBe(true);
  });

  it("aplatit sur un fond opaque en JPEG (le format n'a pas de canal alpha)", async () => {
    const out = await renderScene({ scene: transparentScene(), values: {}, encode: "jpeg" });
    expect(out.mime).toBe("image/jpeg");
    const meta = await sharp(Buffer.from(out.bytes)).metadata();
    expect(meta.hasAlpha).toBe(false);
  });
});
