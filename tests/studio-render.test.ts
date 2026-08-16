import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import sharp from "sharp";
import { renderScene, fitFontSize, supersampleScale, RenderError } from "@/lib/studio/render";
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

    // Round 1 de revue — Finding 3 : la sonde d'autoFit mesurait un style texte reconstruit à la
    // main (sans letterSpacing ni fontStyle), différent de celui réellement peint par element.ts.
    // Un texte avec un espacement de lettres large mesurait "tient" alors qu'il débordait
    // réellement une fois rendu. Vérifié empiriquement avant le correctif : à 1040×220, taille 64,
    // la hauteur mesurée SANS letterSpacing est 140px (tient), et AVEC letterSpacing:20 est 350px
    // (déborde largement un cadre de 220px) — donc la taille retenue doit être nettement plus
    // petite avec un tel espacement.
    it("mesure la même boîte que le rendu final : un letterSpacing large réduit la taille retenue", async () => {
      const content = "Le cacao camerounais bat un record d'exportation en 2026";
      const withoutLS = await fitFontSize(baseLayer(content), fonts);
      const withLS = await fitFontSize({ ...baseLayer(content), letterSpacing: 20 }, fonts);
      expect(withLS).toBeLessThan(withoutLS);
    });

    // Round 1 de revue — bug annexe : AUTOFIT_PASSES=5 sur [12, taille] laisse un résidu (la
    // recherche dichotomique ne teste jamais la borne haute elle-même), donc un texte qui tenait
    // DÉJÀ à la taille demandée ressortait quand même rétréci de quelques pixels sans raison.
    it("ne rétrécit PAS un texte qui tient déjà à la taille demandée (pas de résidu)", async () => {
      const size = await fitFontSize(baseLayer("Titre court"), fonts);
      expect(size).toBe(64); // la taille demandée elle-même, pas 63 ou une valeur voisine
    });

    // Round 1 de revue — bug annexe : avec une taille de base déjà inférieure à AUTOFIT_MIN, la
    // recherche ne s'exécutait jamais et renvoyait AUTOFIT_MIN (12) tel quel — un agrandissement,
    // alors qu'autoFit ne doit jamais dépasser la taille demandée par le gabarit.
    it("n'agrandit jamais au-delà de la taille demandée, même en dessous du plancher AUTOFIT_MIN", async () => {
      const size = await fitFontSize({ ...baseLayer("Titre court"), font: { family: "Noto Sans", size: 10, weight: 700 } }, fonts);
      expect(size).toBe(10);
    });
  });
});

describe("renderScene — erreurs natives (pas de fuite anglaise, échec franc)", () => {
  // Finding 1 (revue round 1) : une valeur de jeton qui n'est PAS une couleur valable
  // (validateScene ne vérifie que le TYPE du jeton, jamais sa valeur d'exécution) atteint satori
  // telle quelle et fait planter le rendu avec un message anglais interne
  // ("Failed to parse declaration…"). render.ts doit intercepter et reformuler en français, sans
  // reproduire ce texte brut.
  it("category.color lié à une valeur qui n'est pas une couleur échoue franchement, en français", async () => {
    const s = agribusinessScene();
    const badValues = { ...values, "category.color": "pas-une-couleur" };
    const err = await renderScene({ scene: s, values: badValues, fetchImpl: fixtureFetch }).catch((e) => e);
    expect(err).toBeInstanceOf(RenderError);
    expect((err as Error).message).not.toContain("Failed to parse");
    expect((err as Error).message.toLowerCase()).toContain("invalide");
    // Important 3 (revue de branche) : le message affiché reste français et sans détail natif, mais
    // l'erreur satori d'origine doit rester accessible via `.cause` — seule trace qui survit en
    // production au-delà du `console.error` (non vérifiable depuis un test).
    expect((err as Error).cause).toBeDefined();
  });

  // Finding 1 (revue round 1) : QRCode.toString lève une erreur anglaise ("The amount of data is
  // too big…") quand le contenu dépasse la capacité d'un QR code. render.ts doit reformuler.
  it("un contenu QR trop volumineux échoue franchement, en français", async () => {
    const scene: Scene = {
      schemaVersion: 1,
      canvas: { width: 400, height: 400, background: "#FFFFFF" },
      layers: [
        { ...b, id: "qr", name: "QR", frame: { x: 20, y: 20, w: 360, h: 360 },
          type: "qr", slot: "article.url", fg: "#000000", bg: "#FFFFFF", margin: 1 },
      ],
    };
    const err = await renderScene({ scene, values: { "article.url": "x".repeat(5000) } }).catch((e) => e);
    expect(err).toBeInstanceOf(RenderError);
    expect((err as Error).message).not.toContain("too big");
    expect((err as Error).cause).toBeDefined();
  });
});

describe("renderScene — magasin d'assets défaillant (Finding 1)", () => {
  function textOnlyScene(): Scene {
    return {
      schemaVersion: 1,
      canvas: { width: 300, height: 200, background: "#000000" },
      layers: [
        { ...b, id: "title", name: "Titre", frame: { x: 10, y: 10, w: 280, h: 180 },
          type: "text", content: "Bonjour",
          font: { assetId: "asset-1", family: "Police Perso", size: 40, weight: 400 },
          color: "#FFFFFF", align: "left", vAlign: "top", lineHeight: 1.2 },
      ],
    };
  }

  // Finding 1 (revue round 1) : un magasin d'assets qui LÈVE (panne réseau, R2 injoignable) au lieu
  // de renvoyer null crashait tout le rendu au lieu de dégrader — la seule défaillance tolérée du
  // pipeline (police manquante) devenait un échec dur précisément quand le magasin va mal.
  const throwingFontLoader: AssetLoader = {
    async font() { throw new Error("R2 GetObject failed: connection reset"); },
    async imageUrl() { return null; },
  };

  it("un magasin d'assets qui lève au lieu de renvoyer null dégrade quand même, sans planter", async () => {
    const out = await renderScene({ scene: textOnlyScene(), values: {}, assets: throwingFontLoader });
    expect(out.degraded).toBe(true);
    expect(out.width).toBe(300);
    expect(out.height).toBe(200);
  });
});

describe("renderScene — image de calque introuvable (Finding 2)", () => {
  // Finding 2 (revue round 1) : un calque image visible dont la source ne peut pas être résolue en
  // URL (ex. `source: {kind:"asset"}` sous le NullAssetLoader par défaut — aucun gabarit V1 n'utilise
  // cette source, donc ceci ne peut pas casser les gabarits déjà semés) était auparavant traité
  // comme la dégradation tolérée (police manquante) au lieu d'un échec franc, produisant un rendu
  // "réussi" avec le calque silencieusement absent. element.ts documente lui-même le contrat inverse
  // : "render.ts a déjà échoué franchement si la préparation était obligatoire".
  it("un calque image dont la source ne peut pas être résolue échoue franchement", async () => {
    const scene: Scene = {
      schemaVersion: 1,
      canvas: { width: 300, height: 200, background: "#000000" },
      layers: [
        { ...b, id: "logo", name: "Logo", frame: { x: 0, y: 0, w: 300, h: 200 },
          type: "image", source: { kind: "asset", assetId: "logo-1" }, fit: "cover" },
      ],
    };
    const err = await renderScene({ scene, values: {} }).catch((e) => e);
    expect(err).toBeInstanceOf(RenderError);
  });
});

describe("renderScene — autoFit appliqué au pipeline complet (Finding 4)", () => {
  // Finding 4 (revue round 1) : les 12 tests précédents restaient tous verts même en supprimant
  // entièrement la phase autoFit de renderScene — fitFontSize était prouvé correct en isolation,
  // mais rien ne prouvait qu'il était réellement appelé par le pipeline. Vérifié manuellement : en
  // commentant la phase autoFit, la même scène rendue avec autoFit:true et sans autoFit produit
  // EXACTEMENT le même nombre d'octets (28510 = 28510) ; avec la phase en place, ces deux rendus
  // divergent nettement (mesuré : 53302 avec autoFit vs 28510 sans). C'est ce test qui distingue
  // les deux situations.
  function longTitleScene(autoFit: boolean): Scene {
    return {
      schemaVersion: 1,
      canvas: { width: 1200, height: 675, background: "#000000" },
      layers: [
        { ...b, id: "title", name: "Titre", frame: { x: 80, y: 380, w: 1040, h: 220 },
          type: "text", content: "{{article.title}}",
          font: { family: "Noto Sans", size: 64, weight: 700 },
          color: "#FFFFFF", align: "left", vAlign: "bottom", lineHeight: 1.1,
          ...(autoFit ? { autoFit: true } : {}) },
      ],
    };
  }

  it("un rendu avec autoFit produit une image mesurablement différente du même rendu sans autoFit", async () => {
    const longValues = { "article.title": "Titre ".repeat(80) } as const;
    const withFit = await renderScene({ scene: longTitleScene(true), values: longValues });
    const without = await renderScene({ scene: longTitleScene(false), values: longValues });
    expect(withFit.bytes.length).not.toBe(without.bytes.length);
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

// ---------------------------------------------------------------------------------------------
// QUALITÉ D'IMAGE (chantier « images de faible qualité »). Trois défauts d'ENCODAGE/RASTERISATION,
// indépendants de la mise en page : ils ne changent ni les dimensions de sortie, ni la scène, ni
// aucun contrat d'appelant — seulement le nombre de pixels échantillonnés et la façon dont ils sont
// compressés. Les tests ci-dessous verrouillent chacun de ces réglages, parce qu'ils sont
// exactement le genre de valeur qu'une refonte ultérieure remettrait « au défaut » sans le voir.
// ---------------------------------------------------------------------------------------------
describe("renderScene — qualité d'encodage", () => {
  it("encode le JPEG en chrominance PLEINE (4:4:4), pas au défaut 4:2:0 de sharp", async () => {
    // LE défaut le plus visible sur du contenu graphique : sous la qualité 90, sharp sous-échantillonne
    // la chrominance en 4:2:0 (résolution de COULEUR divisée par deux sur les deux axes), ce qui
    // frange les bords de glyphes et fait baver les aplats de marque. Invisible sur une photo,
    // ruineux sur une carte titrée — c'est-à-dire sur tout ce que ce moteur produit.
    const out = await renderScene({ scene: agribusinessScene(), values, fetchImpl: fixtureFetch });
    const meta = await sharp(Buffer.from(out.bytes)).metadata();
    expect(meta.chromaSubsampling).toBe("4:4:4");
  });

  it("rend aux dimensions EXACTES du canevas malgré le suréchantillonnage 2x", async () => {
    // Le suréchantillonnage rastérise à 2x puis réduit : une hauteur IMPAIRE est le cas où une
    // réduction naïve (ou un simple `fitTo` sans resize) dériverait d'un pixel. Le contrat public
    // — RenderOutcome.width/height ET les pixels réels — reste `scene.canvas.*`, au pixel près.
    const scene: Scene = {
      schemaVersion: 1,
      canvas: { width: 601, height: 337, background: "#101010" },
      layers: [
        { ...b, id: "dot", name: "Point", frame: { x: 10, y: 10, w: 20, h: 20 },
          type: "shape", shape: "rect", fill: "#FF0000" },
      ],
    };
    const out = await renderScene({ scene, values: {} });
    expect(out.width).toBe(601);
    expect(out.height).toBe(337);
    const meta = await sharp(Buffer.from(out.bytes)).metadata();
    expect(meta.width).toBe(601);
    expect(meta.height).toBe(337);
  });

  it("suréchantillonne à 2x sous le budget pixels, et RETOMBE à 1x au-dessus", () => {
    // Le repli n'est pas un raffinement : à 2x, le PNG intermédiaire a QUATRE fois plus de pixels,
    // donc la taille de canevas à partir de laquelle sharp refuse l'entrée est divisée par quatre.
    // Un canevas qui rendait avant ce chantier doit continuer à rendre — la qualité ne doit jamais
    // transformer un rendu qui passait en rendu qui échoue.
    for (const [w, h] of [[1200, 675], [1080, 1920], [1600, 900]] as const) {
      expect(supersampleScale(w, h)).toBe(2);
    }
    // 4200x4000 = 16,8 Mpx -> 67,2 Mpx suréchantillonné, au-dessus du budget.
    expect(supersampleScale(4200, 4000)).toBe(1);
  });
});

describe("renderScene — image source plus petite que son cadre", () => {
  it("signale le calque dont la photo est peinte AGRANDIE", async () => {
    // Le fixture fait 800x800 ; le cadre du calque « bg » fait 1200x675 en `cover`. La fenêtre
    // focale extraite (800x450) est donc peinte agrandie d'un facteur 1,5 : irrécupérablement
    // floue, et RIEN dans le gabarit ne peut y remédier. Le moteur est le seul à pouvoir le
    // constater (lui seul a décodé les octets), d'où cette remontée.
    const out = await renderScene({ scene: agribusinessScene(), values, fetchImpl: fixtureFetch });
    expect(out.lowResLayerIds).toEqual(["bg"]);
    // Purement informatif : le rendu réussit et `degraded` reste réservé à la police repliée.
    expect(out.degraded).toBe(false);
  });

  it("ne signale RIEN quand la source couvre largement son cadre", async () => {
    // Même fixture 800x800, cadre 400x225 : la source a de la marge, elle est RÉDUITE pour être
    // peinte. Un avertissement ici serait du bruit permanent — et rendrait le vrai cas inaudible.
    const scene: Scene = {
      schemaVersion: 1,
      canvas: { width: 400, height: 225, background: "#000000" },
      layers: [
        { ...b, id: "bg", name: "Fond", frame: { x: 0, y: 0, w: 400, h: 225 },
          type: "image", source: { kind: "slot", slot: "article.image" }, fit: "cover" },
      ],
    };
    const out = await renderScene({
      scene, values: { "article.image": "https://cdn.test/photo.png" }, fetchImpl: fixtureFetch,
    });
    expect(out.lowResLayerIds).toEqual([]);
  });

  it("ne signale jamais un calque QR (un vecteur n'a pas de résolution intrinsèque)", async () => {
    const scene: Scene = {
      schemaVersion: 1,
      canvas: { width: 300, height: 300, background: "#FFFFFF" },
      layers: [
        { ...b, id: "qr1", name: "QR", frame: { x: 20, y: 20, w: 260, h: 260 },
          type: "qr", slot: "article.url", fg: "#000000", bg: "#FFFFFF", margin: 1 },
      ],
    };
    const out = await renderScene({ scene, values: { "article.url": "https://afrotiative.com/a" } });
    expect(out.lowResLayerIds).toEqual([]);
  });
});
