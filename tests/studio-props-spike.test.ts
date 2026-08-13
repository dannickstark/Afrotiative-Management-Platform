import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import sharp from "sharp";
import { renderScene } from "@/lib/studio/render";
import { loadFallbackFonts, type LoadedFont } from "@/lib/studio/fonts";
import type { Scene, ImageLayer } from "@/lib/studio/scene";
import type { SatoriNode } from "@/lib/studio/element";

// ============================================================================
// SPIKE — Studio Properties Pro P1, Tâche 1 : LE MODÈLE DE FOND DE SATORI 0.29 (STOP-AND-REPORT).
//
// QUESTION : le futur calque image peint-il en `<div background-image/background-size/…>` plutôt
// qu'en `<img objectFit>` ? Seule une preuve AU PIXEL, à travers le VRAI moteur de rendu
// (satori -> resvg -> sharp), peut y répondre — un `clipPath` ignoré, ou ici un `background-size`
// ignoré, produit un PNG parfaitement valide et ne lève JAMAIS. Ce fichier ne prescrit rien : il
// MESURE, mode par mode, et consigne chaque résultat dans
// .superpowers/sdd/2026-08-13-afrotiative-studio-props-p1-image/spike-satori-background-report.md.
//
// POURQUOI PAS renderScene() DE BOUT EN BOUT POUR CHAQUE MODE. `element.ts#imageNode` n'émet
// aujourd'hui qu'un `<img objectFit>` — aucun champ du schéma ne porte encore `backgroundSize` /
// `backgroundRepeat` / `backgroundBlendMode`, et cette tâche a INTERDICTION de toucher au code de
// production (element.ts/images.ts/scene.ts). Chaque mode est donc mesuré en construisant l'arbre
// satori À LA MAIN et en rejouant l'ÉTAPE 5 de `renderScene()` à l'identique — satori(width/height/
// fonts/embedFont:true) -> Resvg(fitTo width) -> sharp().removeAlpha().jpeg({quality:86,
// mozjpeg:true}) — exactement le motif déjà établi par tests/studio-render-clippath.test.ts pour la
// même raison (clipPath, alors absent du schéma). SEULE la section §0 ci-dessous appelle
// `renderScene()` en direct, pour comparer le VRAI chemin de production (image -> URL -> fetch ->
// prepareImage -> `<img objectFit:cover>`) à la reconstruction main.
//
// L'IMAGE TÉMOIN : 100×100, quadrant haut-gauche 50×50 ROUGE pur, le reste BLANC pur — générée avec
// sharp, encodée en data URI. Chaque sonde compare la couleur d'un pixel de sortie à une attente
// ANALYTIQUE (géométrie calculée à la main, pas de navigateur — la parité navigateur revient à la
// Tâche 7 du plan). Là où satori rend correctement, le test PASSE ; là où il diverge, il est marqué
// `it.skip` avec ce qui a été OBSERVÉ, et le rapport documente l'écart.
// ============================================================================

let fonts: LoadedFont[];
let witnessBytes: Buffer;
let witnessDataUri: string;
let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(async () => {
  fonts = await loadFallbackFonts();

  const redSquare = await sharp({
    create: { width: 50, height: 50, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
  }).png().toBuffer();
  witnessBytes = await sharp({
    create: { width: 100, height: 100, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
  }).composite([{ input: redSquare, top: 0, left: 0 }]).png().toBuffer();
  witnessDataUri = `data:image/png;base64,${witnessBytes.toString("base64")}`;

  // Fixture HTTP locale — même motif que tests/studio-render-clippath.test.ts : §0 seul a besoin
  // d'atteindre `renderScene()` par une URL réelle (prepareImage fait un vrai fetch).
  // Cast nécessaire : `witnessBytes` (déclaré `Buffer` en portée module, contrairement aux fixtures
  // existantes qui le laissent local à `beforeAll`) résout `BodyInit` vers une surcharge de
  // `Response` différente sous ce tsconfig — vérifié : la même valeur passée en `const` local ne
  // pose pas le problème, seule l'annotation de type explicite en portée module le déclenche.
  server = Bun.serve({ port: 0, fetch(_req) { return new Response(witnessBytes as unknown as BodyInit, { headers: { "content-type": "image/png" } }); } });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

// Typé `typeof fetch` (bun-types y ajoute `preconnect`, jamais utilisé à l'exécution) — même
// contournement de type que les fixtures existantes.
const fixtureFetch: typeof fetch = (() => fetch(`${base}/witness.png`)) as unknown as typeof fetch;

// Réplique EXACTE de l'étape 5 de renderScene() (lib/studio/render.ts) — voir le commentaire d'en-tête.
async function probe(node: SatoriNode, width: number, height: number): Promise<Uint8Array> {
  const svg = await satori(node as never, {
    width, height,
    fonts: fonts as unknown as Parameters<typeof satori>[1]["fonts"],
    embedFont: true,
  });
  const png = new Resvg(svg, { fitTo: { mode: "width", value: width } }).render().asPng();
  return new Uint8Array(await sharp(png).removeAlpha().jpeg({ quality: 86, mozjpeg: true }).toBuffer());
}

// Racine canevas (position relative + display flex, comme sceneToElement) contenant UN calque
// cadre-plein-canevas (position absolute, comme frameStyle) qui porte le style de fond sous sonde.
function bgNode(size: number | { w: number; h: number }, canvasBg: string, frameStyle: Record<string, unknown>): SatoriNode {
  const w = typeof size === "number" ? size : size.w;
  const h = typeof size === "number" ? size : size.h;
  return {
    type: "div",
    props: {
      style: { display: "flex", position: "relative", width: w, height: h, backgroundColor: canvasBg },
      children: {
        type: "div",
        props: { style: { position: "absolute", left: 0, top: 0, width: w, height: h, display: "flex", ...frameStyle } },
      },
    },
  };
}

const TOLERANCE = 24;
const RED: [number, number, number] = [255, 0, 0];
const WHITE: [number, number, number] = [255, 255, 255];
const BLUE: [number, number, number] = [0, 0, 255];

type Sampler = (x: number, y: number) => string;
async function sampler(bytes: Uint8Array, palette: Record<string, [number, number, number]>): Promise<Sampler> {
  const { data, info } = await sharp(Buffer.from(bytes)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return (x, y) => {
    const i = (y * info.width + x) * info.channels;
    const p = [data[i], data[i + 1], data[i + 2]];
    for (const [name, t] of Object.entries(palette)) {
      if (t.every((v, k) => Math.abs(p[k] - v) <= TOLERANCE)) return name;
    }
    return `rgba(${p.join(",")})`;
  };
}
async function rgbAt(bytes: Uint8Array, x: number, y: number): Promise<[number, number, number]> {
  const { data, info } = await sharp(Buffer.from(bytes)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [data[i], data[i + 1], data[i + 2]];
}

const PALETTE = { rouge: RED, blanc: WHITE, fond: BLUE };

// ────────────────────────────────────────────────────────────────────────────────────────────────
// background-size
// ────────────────────────────────────────────────────────────────────────────────────────────────
describe("Satori 0.29 — background-size", () => {
  it("cover : cadre carré 200×200, l'image (aussi carrée) remplit tout le cadre sans bande", async () => {
    // Aspect image = aspect cadre (1:1) : cover se réduit à une mise à l'échelle uniforme ×2, sans
    // recadrage — le rouge, quadrant haut-gauche de l'image, occupe le quadrant haut-gauche du cadre.
    //
    // `backgroundPosition: "0% 0%"` ICI (et dans les 3 tests suivants), PAS "50% 50%" : mesuré
    // séparément (describe "background-position" plus bas) que satori 0.29 calcule un pourcentage de
    // position comme `taille du CADRE × pourcentage`, et NON `(cadre − image) × pourcentage` (la
    // formule CSS) — à 0 % les deux formules coïncident (décalage nul), ce qui isole ICI la question
    // de `background-size` de celle, distincte, de `background-position`.
    const node = bgNode(200, "#0000FF", {
      backgroundImage: `url(${witnessDataUri})`, backgroundSize: "cover",
      backgroundPosition: "0% 0%", backgroundRepeat: "no-repeat",
    });
    const px = await sampler(await probe(node, 200, 200), PALETTE);
    expect(px(25, 25)).toBe("rouge");
    expect(px(175, 25)).toBe("blanc");
    expect(px(25, 175)).toBe("blanc");
    expect(px(175, 175)).toBe("blanc");
  });

  it("contain : cadre 200×100 (non carré), l'image tient ENTIÈRE et le fond apparaît en bande", async () => {
    // scale = min(200/100,100/100) = 1, taille 100×100, position 0%/0% → décalage nul. Le fond (bleu)
    // doit rester visible dans la bande latérale que `cover` aurait recadrée — c'est ce qui distingue
    // les deux modes ; un cadre carré ne le pourrait pas (cover == contain quand les aspects coïncident).
    const node = bgNode({ w: 200, h: 100 }, "#0000FF", {
      backgroundImage: `url(${witnessDataUri})`, backgroundSize: "contain",
      backgroundPosition: "0% 0%", backgroundRepeat: "no-repeat",
    });
    const px = await sampler(await probe(node, 200, 100), PALETTE);
    expect(px(25, 25)).toBe("rouge");
    expect(px(75, 25)).toBe("blanc");
    expect(px(150, 50)).toBe("fond");
    expect(px(25, 75)).toBe("blanc");
  });

  it("100px 100px : taille explicite en pixels honorée, image à sa taille naturelle", async () => {
    const node = bgNode(200, "#0000FF", {
      backgroundImage: `url(${witnessDataUri})`, backgroundSize: "100px 100px",
      backgroundPosition: "0% 0%", backgroundRepeat: "no-repeat",
    });
    const px = await sampler(await probe(node, 200, 200), PALETTE);
    expect(px(25, 25)).toBe("rouge");
    expect(px(75, 25)).toBe("blanc");
    expect(px(150, 150)).toBe("fond");
  });

  it("50% 50% : les deux axes sont mis à l'échelle INDÉPENDAMMENT (déformation attendue)", async () => {
    // Cadre 300×200 : taille = 150×100 (50% de chaque dimension du cadre) — scaleX=1.5, scaleY=1,
    // donc une déformation non uniforme si satori applique bien les pourcentages par axe (mesuré : OUI).
    const node = bgNode({ w: 300, h: 200 }, "#0000FF", {
      backgroundImage: `url(${witnessDataUri})`, backgroundSize: "50% 50%",
      backgroundPosition: "0% 0%", backgroundRepeat: "no-repeat",
    });
    const px = await sampler(await probe(node, 300, 200), PALETTE);
    expect(px(25, 25)).toBe("rouge");
    expect(px(100, 25)).toBe("blanc");
    expect(px(200, 25)).toBe("fond");
    expect(px(25, 150)).toBe("fond");
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// background-repeat
// ────────────────────────────────────────────────────────────────────────────────────────────────
describe("Satori 0.29 — background-repeat", () => {
  it("repeat : image 100×100 dans un cadre 200×200 → le rouge apparaît dans les 4 tuiles", async () => {
    const node = bgNode(200, "#0000FF", {
      backgroundImage: `url(${witnessDataUri})`, backgroundSize: "100px 100px",
      backgroundPosition: "0% 0%", backgroundRepeat: "repeat",
    });
    const px = await sampler(await probe(node, 200, 200), PALETTE);
    expect(px(25, 25)).toBe("rouge");
    expect(px(125, 25)).toBe("rouge");
    expect(px(25, 125)).toBe("rouge");
    expect(px(125, 125)).toBe("rouge");
    expect(px(75, 75)).toBe("blanc"); // témoin : coin non-rouge d'une tuile
  });

  it("repeat-x : répétition horizontale seule — rien sous la ligne d'image", async () => {
    const node = bgNode(200, "#0000FF", {
      backgroundImage: `url(${witnessDataUri})`, backgroundSize: "100px 100px",
      backgroundPosition: "0% 0%", backgroundRepeat: "repeat-x",
    });
    const px = await sampler(await probe(node, 200, 200), PALETTE);
    expect(px(25, 25)).toBe("rouge");
    expect(px(125, 25)).toBe("rouge");
    expect(px(25, 150)).toBe("fond");
    expect(px(125, 150)).toBe("fond");
  });

  it("repeat-y : répétition verticale seule — rien à droite de la colonne d'image", async () => {
    const node = bgNode(200, "#0000FF", {
      backgroundImage: `url(${witnessDataUri})`, backgroundSize: "100px 100px",
      backgroundPosition: "0% 0%", backgroundRepeat: "repeat-y",
    });
    const px = await sampler(await probe(node, 200, 200), PALETTE);
    expect(px(25, 25)).toBe("rouge");
    expect(px(25, 125)).toBe("rouge");
    expect(px(150, 25)).toBe("fond");
    expect(px(150, 125)).toBe("fond");
  });

  it("no-repeat : témoin — une seule copie, le reste du cadre est le fond", async () => {
    const node = bgNode(200, "#0000FF", {
      backgroundImage: `url(${witnessDataUri})`, backgroundSize: "100px 100px",
      backgroundPosition: "0% 0%", backgroundRepeat: "no-repeat",
    });
    const px = await sampler(await probe(node, 200, 200), PALETTE);
    expect(px(25, 25)).toBe("rouge");
    expect(px(75, 25)).toBe("blanc");
    expect(px(150, 150)).toBe("fond");
    expect(px(25, 150)).toBe("fond");
  });

  // MESURÉ (satori 0.29) : `space` et `round` ne sont pas des valeurs reconnues de
  // `background-repeat` — satori retombe silencieusement sur un comportement `no-repeat` (UNE seule
  // copie, ancrée en haut-gauche, aucune tuile ni espacement). Vérifié en inspectant le SVG produit
  // (le `<pattern>` a `width="100%" height="100%"`, la même signature que `no-repeat` explicite, très
  // différente du `<pattern width="100" height="100">` à taille fixe qu'émet `repeat`) ET en pixels
  // (grille de sonde 10px : la même tuile unique apparaît, tout le reste est le fond). Aucune levée
  // d'exception — c'est le piège exact que documentent les tests clipPath : « ça n'a pas levé » ne
  // prouve rien, seul le pixel le fait.
  it.skip("Satori 0.29 : `space` n'est pas rendu — retombe sur `no-repeat` (voir rapport)", async () => {
    // Attente CSS-CORRECTE (2 tuiles par axe sur 250px, espace de 50px réparti entre elles) —
    // ce test resterait rouge si on l'exécutait ; conservé tel quel pour documenter ce qui MANQUE.
    const node = bgNode(250, "#0000FF", {
      backgroundImage: `url(${witnessDataUri})`, backgroundSize: "100px 100px",
      backgroundRepeat: "space",
    });
    const px = await sampler(await probe(node, 250, 250), PALETTE);
    expect(px(25, 25)).toBe("rouge");
    expect(px(175, 25)).toBe("rouge");
    expect(px(175, 175)).toBe("rouge");
    expect(px(125, 25)).toBe("fond"); // bande d'espacement horizontale
    expect(px(125, 125)).toBe("fond"); // croisement des deux bandes
  });

  it("TÉMOIN : `space` mesuré — se comporte EXACTEMENT comme `no-repeat` (une seule copie)", async () => {
    const node = bgNode(250, "#0000FF", {
      backgroundImage: `url(${witnessDataUri})`, backgroundSize: "100px 100px",
      backgroundRepeat: "space",
    });
    const px = await sampler(await probe(node, 250, 250), PALETTE);
    expect(px(25, 25)).toBe("rouge");
    expect(px(75, 25)).toBe("blanc");
    expect(px(175, 25)).toBe("fond"); // CSS-correct attendrait « rouge » ici (2ᵉ tuile) — c'est le fond
    expect(px(200, 200)).toBe("fond");
  });

  it.skip("Satori 0.29 : `round` n'est pas rendu — retombe sur `no-repeat` (voir rapport)", async () => {
    // Attente CSS-CORRECTE (2 tuiles par axe sur 220px, redimensionnées à 110px sans espace).
    const node = bgNode(220, "#0000FF", {
      backgroundImage: `url(${witnessDataUri})`, backgroundSize: "100px 100px",
      backgroundRepeat: "round",
    });
    const px = await sampler(await probe(node, 220, 220), PALETTE);
    expect(px(25, 25)).toBe("rouge");
    expect(px(135, 25)).toBe("rouge");
    expect(px(25, 135)).toBe("rouge");
    expect(px(135, 135)).toBe("rouge");
    expect(px(90, 90)).toBe("blanc");
  });

  it("TÉMOIN : `round` mesuré — se comporte EXACTEMENT comme `no-repeat` (une seule copie)", async () => {
    const node = bgNode(220, "#0000FF", {
      backgroundImage: `url(${witnessDataUri})`, backgroundSize: "100px 100px",
      backgroundRepeat: "round",
    });
    const px = await sampler(await probe(node, 220, 220), PALETTE);
    expect(px(25, 25)).toBe("rouge");
    expect(px(75, 25)).toBe("blanc");
    expect(px(135, 25)).toBe("fond"); // CSS-correct attendrait « rouge » ici (2ᵉ tuile redimensionnée)
    expect(px(200, 200)).toBe("fond");
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// background-position — cadre 200×200, image 100×100 (`background-size: 100px 100px`, `no-repeat`).
//
// MESURÉ (satori 0.29), en inspectant le `<pattern x= y=>` produit ET en pixels : le décalage d'un
// pourcentage est calculé comme `taille du CADRE × pourcentage`, PAS `(cadre − image) × pourcentage`
// (la formule CSS — https://www.w3.org/TR/css-backgrounds-3/#the-background-position). À 0 % les
// deux formules coïncident (décalage nul, d'où le premier cas ci-dessous, seul à passer). Pire : à
// 100 %, le décalage calculé (200px) égale exactement la PÉRIODE du motif SVG que satori utilise pour
// simuler `no-repeat` (période = taille du cadre) — le décalage « boucle » silencieusement et
// l'image réapparaît à sa position 0 %, comme si `background-position: 100% 100%` n'avait aucun
// effet. `50 %` et `100 %` sont donc marqués `it.skip` (attente CSS-correcte conservée, pour
// documenter ce qui manque) et chacun a un TÉMOIN qui affirme le comportement RÉELLEMENT observé.
//
// CONTOURNEMENT VÉRIFIÉ : une position exprimée en PIXELS (calculée nous-mêmes en JS, ex.
// `"50px 0px"`) EST honorée correctement par satori — seule la résolution du POURCENTAGE est en
// cause, pas le mécanisme de décalage lui-même. Voir §0 plus bas et le rapport, section
// recommandation.
// ────────────────────────────────────────────────────────────────────────────────────────────────
describe("Satori 0.29 — background-position", () => {
  it("0% 0% : image collée au coin haut-gauche du cadre", async () => {
    const node = bgNode(200, "#0000FF", {
      backgroundImage: `url(${witnessDataUri})`, backgroundSize: "100px 100px",
      backgroundPosition: "0% 0%", backgroundRepeat: "no-repeat",
    });
    const px = await sampler(await probe(node, 200, 200), PALETTE);
    expect(px(25, 25)).toBe("rouge");
    expect(px(150, 150)).toBe("fond");
  });

  it.skip("Satori 0.29 : `50% 50%` ne centre pas l'image — voir rapport (décalage = cadre×pct, pas (cadre−image)×pct)", async () => {
    // Attente CSS-CORRECTE (décalage (200-100)*0.5=50,50 → image en [50,150)²) — resterait rouge.
    const node = bgNode(200, "#0000FF", {
      backgroundImage: `url(${witnessDataUri})`, backgroundSize: "100px 100px",
      backgroundPosition: "50% 50%", backgroundRepeat: "no-repeat",
    });
    const px = await sampler(await probe(node, 200, 200), PALETTE);
    expect(px(60, 60)).toBe("rouge");
    expect(px(10, 10)).toBe("fond");
    expect(px(190, 190)).toBe("fond");
  });

  it("TÉMOIN : `50% 50%` mesuré — décalage RÉEL de 100,100 (= cadre×0,5, pas (cadre−image)×0,5)", async () => {
    const node = bgNode(200, "#0000FF", {
      backgroundImage: `url(${witnessDataUri})`, backgroundSize: "100px 100px",
      backgroundPosition: "50% 50%", backgroundRepeat: "no-repeat",
    });
    const px = await sampler(await probe(node, 200, 200), PALETTE);
    expect(px(120, 120)).toBe("rouge"); // CSS-correct attendrait « fond » ici
    expect(px(10, 10)).toBe("fond");
    expect(px(190, 190)).toBe("blanc"); // CSS-correct attendrait « fond » ici aussi
  });

  it.skip("Satori 0.29 : `100% 100%` ne colle pas l'image au coin bas-droit — voir rapport (boucle sur la période)", async () => {
    // Attente CSS-CORRECTE (décalage (200-100)*1=100,100... non : décalage=100 ancre le coin BAS-DROIT
    // de l'image sur le coin BAS-DROIT du cadre, donc image en [100,200)²) — resterait rouge.
    const node = bgNode(200, "#0000FF", {
      backgroundImage: `url(${witnessDataUri})`, backgroundSize: "100px 100px",
      backgroundPosition: "100% 100%", backgroundRepeat: "no-repeat",
    });
    const px = await sampler(await probe(node, 200, 200), PALETTE);
    expect(px(125, 125)).toBe("rouge");
    expect(px(25, 25)).toBe("fond");
  });

  it("TÉMOIN : `100% 100%` mesuré — BOUCLE sur la période du motif, redevient identique à 0% 0%", async () => {
    // Décalage calculé = 200×1 = 200 = exactement la période du <pattern> satori (= taille du cadre,
    // le mécanisme qui simule `no-repeat`) → le décalage boucle modulo 200 et retombe sur 0. Le rouge
    // réapparaît donc là où `position: 0% 0%` le peindrait, pas dans le coin bas-droit.
    const node = bgNode(200, "#0000FF", {
      backgroundImage: `url(${witnessDataUri})`, backgroundSize: "100px 100px",
      backgroundPosition: "100% 100%", backgroundRepeat: "no-repeat",
    });
    const px = await sampler(await probe(node, 200, 200), PALETTE);
    expect(px(25, 25)).toBe("rouge"); // CSS-correct attendrait « fond » ici
    expect(px(125, 125)).toBe("fond"); // CSS-correct attendrait « rouge » ici
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// background-blend-mode — sonde sur le quadrant ROUGE de l'image (Cs=(1,0,0)) contre un fond gris
// clair connu (Cb=(200,200,200)=0,7843), formules W3C compositing (multiply/screen/overlay).
// Les quatre résultats ANALYTIQUES sont mutuellement séparés de bien plus que TOLERANCE=24 :
//   normal   → (255,  0,  0)   [le fond n'intervient pas]
//   multiply → (200,  0,  0)   [Cb·Cs]
//   screen   → (255,200,200)   [Cb+Cs−Cb·Cs]
//   overlay  → (255,145,145)   [Cb>0,5 → 1−2(1−Cb)(1−Cs)]
//
// MESURÉ (satori 0.29) : `backgroundBlendMode` N'EST PAS IMPLÉMENTÉ, quelle que soit la valeur —
// `multiply`/`screen`/`overlay`/`darken`/`lighten` peignent TOUS exactement (255,0,0), identique à
// `normal` : le fond n'entre JAMAIS dans le calcul, satori se contente de peindre l'image par-dessus
// le fond sans jamais lire la propriété. Vérifié aussi avec `mixBlendMode` (même résultat) et avec
// deux couleurs de fond différentes pour écarter un bogue de lecture de couleur plutôt que de mode.
// Aucune levée d'exception nulle part — la propriété est silencieusement ignorée.
// ────────────────────────────────────────────────────────────────────────────────────────────────
describe("Satori 0.29 — background-blend-mode", () => {
  const BG = "#C8C8C8"; // (200,200,200)
  const NORMAL: [number, number, number] = [255, 0, 0];
  const ANALYTIQUE: Record<string, [number, number, number]> = {
    multiply: [200, 0, 0], screen: [255, 200, 200], overlay: [255, 145, 145],
  };

  it("normal : le pixel rouge n'est pas modifié par le fond (témoin de référence)", async () => {
    const node = bgNode(100, BG, {
      backgroundImage: `url(${witnessDataUri})`, backgroundSize: "100px 100px",
      backgroundPosition: "0% 0%", backgroundRepeat: "no-repeat", backgroundBlendMode: "normal",
    });
    const rgb = await rgbAt(await probe(node, 100, 100), 25, 25);
    for (let k = 0; k < 3; k++) expect(Math.abs(rgb[k] - NORMAL[k])).toBeLessThanOrEqual(TOLERANCE);
  });

  for (const mode of ["multiply", "screen", "overlay"] as const) {
    it.skip(`Satori 0.29 : \`${mode}\` n'est pas rendu — attente CSS-correcte ${ANALYTIQUE[mode].join(",")}, voir rapport`, async () => {
      const node = bgNode(100, BG, {
        backgroundImage: `url(${witnessDataUri})`, backgroundSize: "100px 100px",
        backgroundPosition: "0% 0%", backgroundRepeat: "no-repeat", backgroundBlendMode: mode,
      });
      const rgb = await rgbAt(await probe(node, 100, 100), 25, 25);
      const attendu = ANALYTIQUE[mode];
      for (let k = 0; k < 3; k++) expect(Math.abs(rgb[k] - attendu[k])).toBeLessThanOrEqual(TOLERANCE);
    });

    it(`TÉMOIN : \`${mode}\` mesuré — identique à \`normal\`, le fond n'intervient jamais`, async () => {
      const node = bgNode(100, BG, {
        backgroundImage: `url(${witnessDataUri})`, backgroundSize: "100px 100px",
        backgroundPosition: "0% 0%", backgroundRepeat: "no-repeat", backgroundBlendMode: mode,
      });
      const rgb = await rgbAt(await probe(node, 100, 100), 25, 25);
      for (let k = 0; k < 3; k++) expect(Math.abs(rgb[k] - NORMAL[k])).toBeLessThanOrEqual(TOLERANCE);
    });
  }
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// §0 — LA SOUPAPE : cover via CSS background ÉGALE-T-IL cover via <img objectFit> ? Décide
// chemin-unique (Tâche 3) vs soupape à deux chemins. Cadre CARRÉ 200×200 pour une image CARRÉE
// 100×100 : `cover` s'y réduit à une mise à l'échelle uniforme ×2 sans recadrage, ce qui isole la
// question « les deux moteurs de mise à l'échelle (sharp vs satori/resvg) s'accordent-ils ? » de
// toute différence d'algorithme de recadrage (sharp resize position:"attention" vs CSS 50% 50%).
//
// MESURÉ : avec `background-position: "50% 50%"` — LA VALEUR LITTÉRALEMENT PROPOSÉE PAR LE BRIEF —
// les deux chemins NE S'ACCORDENT PAS DU TOUT : le bogue de pourcentage documenté ci-dessus
// (describe "background-position") décale l'image de 100px sur chaque axe, ce qui, combiné à la
// boucle de période à 200px que ce même bogue produit pour `objectFit`… non — `objectFit` n'est PAS
// concerné (il ne passe jamais par `background-position`, prepareImage rend déjà l'image à la taille
// EXACTE du cadre). Seul le chemin CSS est décalé : le rouge, attendu en haut-gauche, apparaît en
// BAS-DROIT (diagonale inversée) — la classification catégorielle rouge/blanc DIVERGE aux 4 coins.
// Premier test ci-dessous : `it.skip`, documente cette divergence avec l'attente CSS-correcte.
//
// CONTOURNEMENT VÉRIFIÉ (second test, PASSE) : puisque le bogue n'affecte QUE la résolution du
// pourcentage — pas le mécanisme de décalage lui-même (vérifié : une valeur en PIXELS est honorée
// littéralement) — calculer l'offset nous-mêmes en JS et émettre `backgroundPosition` en pixels
// (ex. `"0px 0px"` ici, puisque `cover` sur des aspects identiques ne recadre rien) fait ACCORDER les
// deux chemins aux points intérieurs, dans TOLERANCE=24. Seuls les pixels À LA FRONTIÈRE même du
// quadrant (99/101, sur cette image test à bord dur, sans aucun anticrénelage naturel) restent hors
// tolérance — deux moteurs de mise à l'échelle différents (sharp vs satori/resvg) ne suréchantillonnent
// pas le bord identiquement ; une vraie photo, sans arête à 100 % de contraste, ne le montrerait pas.
// ────────────────────────────────────────────────────────────────────────────────────────────────
describe("Satori 0.29 — §0 : cover via CSS égale-t-il cover via objectFit ?", () => {
  async function objectFitBytes(): Promise<Uint8Array> {
    // LE CHEMIN DE PRODUCTION RÉEL : renderScene() -> prepareImage (sharp resize fit:cover) ->
    // element.ts#imageNode (<img objectFit:cover>) -> satori -> resvg -> sharp jpeg.
    const scene: Scene = {
      schemaVersion: 1,
      canvas: { width: 200, height: 200, background: "#FFFFFF" },
      layers: [{
        id: "img", name: "image", visible: true, locked: false,
        frame: { x: 0, y: 0, w: 200, h: 200 },
        type: "image", source: { kind: "url", url: `${base}/witness.png` }, fit: "cover",
      } as ImageLayer],
    };
    return (await renderScene({ scene, values: {}, fetchImpl: fixtureFetch })).bytes;
  }

  it.skip("Satori 0.29 : `background-position: 50% 50%` (tel que proposé par le brief) NE S'ACCORDE PAS avec objectFit — voir rapport", async () => {
    const objectFitOut = await objectFitBytes();
    // LE NOUVEAU CHEMIN, construit à la main (interdiction de toucher element.ts) mais rejouant
    // l'étape 5 de renderScene() à l'identique (probe()) — position en POURCENTAGE, comme le brief.
    const cssNode = bgNode(200, "#FFFFFF", {
      backgroundImage: `url(${witnessDataUri})`, backgroundSize: "cover",
      backgroundPosition: "50% 50%", backgroundRepeat: "no-repeat",
    });
    const cssBytes = await probe(cssNode, 200, 200);
    const a = await sampler(objectFitOut, { rouge: RED, blanc: WHITE });
    const b = await sampler(cssBytes, { rouge: RED, blanc: WHITE });
    for (const [x, y] of [[25, 25], [175, 25], [25, 175], [175, 175]] as [number, number][]) {
      expect(b(x, y)).toBe(a(x, y));
    }
  });

  it("TÉMOIN : mesuré — à 50% 50%, le rouge est en BAS-DROIT côté CSS, HAUT-GAUCHE côté objectFit", async () => {
    const objectFitOut = await objectFitBytes();
    const cssNode = bgNode(200, "#FFFFFF", {
      backgroundImage: `url(${witnessDataUri})`, backgroundSize: "cover",
      backgroundPosition: "50% 50%", backgroundRepeat: "no-repeat",
    });
    const cssBytes = await probe(cssNode, 200, 200);
    const a = await sampler(objectFitOut, { rouge: RED, blanc: WHITE });
    const b = await sampler(cssBytes, { rouge: RED, blanc: WHITE });
    expect(a(25, 25)).toBe("rouge");
    expect(b(25, 25)).toBe("blanc"); // CSS-correct (et objectFit) : rouge
    expect(a(175, 175)).toBe("blanc");
    expect(b(175, 175)).toBe("rouge"); // CSS-correct (et objectFit) : blanc
  });

  it("CONTOURNEMENT : position en PIXELS (calculée par nous, pas par satori) fait accorder les deux chemins", async () => {
    const objectFitOut = await objectFitBytes();
    // `cover` sur des aspects identiques (image et cadre carrés) ne recadre rien : l'offset
    // CSS-correct est 0,0 — on l'émet ici en pixels plutôt qu'en pourcentage.
    const cssNode = bgNode(200, "#FFFFFF", {
      backgroundImage: `url(${witnessDataUri})`, backgroundSize: "cover",
      backgroundPosition: "0px 0px", backgroundRepeat: "no-repeat",
    });
    const cssBytes = await probe(cssNode, 200, 200);

    // Classification catégorielle aux 4 coins (loin de toute frontière) : doit s'accorder.
    const a = await sampler(objectFitOut, { rouge: RED, blanc: WHITE });
    const b = await sampler(cssBytes, { rouge: RED, blanc: WHITE });
    const coins: [number, number][] = [[25, 25], [175, 25], [25, 175], [175, 175]];
    for (const [x, y] of coins) expect(b(x, y)).toBe(a(x, y));

    // Écart numérique canal par canal, aux mêmes 4 coins — la question du brief est « égale-t-il DANS
    // UNE TOLÉRANCE STRICTE », pas seulement « du même côté ». Les pixels à la frontière du quadrant
    // (99/101) sont volontairement EXCLUS ici : sur cette image témoin à bord dur (100% de contraste,
    // sans anticrénelage naturel), les deux moteurs de rééchantillonnage (sharp vs satori/resvg)
    // divergent au bord même bien plus que TOLERANCE — mesuré, documenté dans le rapport — ce qui
    // n'est pas représentatif d'une vraie photo.
    for (const [x, y] of coins) {
      const pa = await rgbAt(objectFitOut, x, y);
      const pb = await rgbAt(cssBytes, x, y);
      for (let k = 0; k < 3; k++) expect(Math.abs(pa[k] - pb[k])).toBeLessThanOrEqual(TOLERANCE);
    }
  });
});
