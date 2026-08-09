import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { inArray, eq } from "drizzle-orm";
import { db, renderAssets } from "@/db";
import { DbAssetLoader } from "@/lib/studio/asset-loader";
import { renderScene, RenderError } from "@/lib/studio/render";
import type { AssetLoader } from "@/lib/studio/fonts";
import type { Scene } from "@/lib/studio/scene";

// tests/studio-asset-loader.test.ts — Tâche 12. DbAssetLoader parle à un VRAI Postgres (comme le
// reste de la suite studio-*.test.ts DB-backed), mais jamais à un vrai R2 : la colonne `url` des
// lignes seedées ci-dessous pointe vers un serveur Bun.serve() local, pas vers un bucket réel — même
// recette que tests/studio-render.test.ts / tests/studio-preview.test.ts pour rester hors ligne sans
// avoir besoin d'injecter un fetchImpl (DbAssetLoader n'a d'ailleurs PAS de garde SSRF à contourner :
// contrairement à prepareImage, l'URL vient toujours d'une ligne qu'ON a écrite, jamais d'un jeton
// fourni par un tiers — voir la note du module).
let server: ReturnType<typeof Bun.serve>;
let base: string;
let fontRequestCount = 0;
let fontBytes: Buffer;

beforeAll(async () => {
  fontBytes = await readFile(join(process.cwd(), "lib/studio/fonts/NotoSans-Regular.ttf"));
  server = Bun.serve({
    port: 0,
    fetch() {
      fontRequestCount++;
      return new Response(new Uint8Array(fontBytes), { headers: { "content-type": "font/ttf" } });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

const assetIds: string[] = [];
let fontAssetId: string;
let imageAssetId: string;

beforeAll(async () => {
  const [fontRow] = await db.insert(renderAssets).values({
    kind: "font", name: "Police de test", storageKey: "assets/test/police-de-test.ttf",
    url: `${base}/police-de-test.ttf`, mime: "font/ttf", bytes: fontBytes.byteLength,
    fontFamily: "Police de test", fontWeight: 600, fontStyle: "normal",
  }).returning({ id: renderAssets.id });
  fontAssetId = fontRow!.id;
  assetIds.push(fontAssetId);

  const [imgRow] = await db.insert(renderAssets).values({
    kind: "image", name: "Logo de test", storageKey: "assets/test/logo.png",
    url: "https://cdn.test.invalid/logo.png", mime: "image/png", bytes: 1234, width: 200, height: 200,
  }).returning({ id: renderAssets.id });
  imageAssetId = imgRow!.id;
  assetIds.push(imageAssetId);
});

afterAll(async () => {
  if (assetIds.length > 0) await db.delete(renderAssets).where(inArray(renderAssets.id, assetIds));
});

const UNKNOWN_ID = "00000000-0000-0000-0000-000000000000";

// ─────────────────────────────────────────────────────────────────────────────
describe("DbAssetLoader.font()", () => {
  it("un asset police fait l'aller-retour : nom, graisse, style ET octets réels (vrai TTF)", async () => {
    const loader = new DbAssetLoader();
    const font = await loader.font(fontAssetId);
    expect(font).not.toBeNull();
    if (!font) return;
    expect(font.name).toBe("Police de test");
    expect(font.weight).toBe(600);
    expect(font.style).toBe("normal");
    expect(font.data.byteLength).toBe(fontBytes.byteLength);
    // Pas seulement "des octets" — la signature TrueType réelle, même vérification que
    // tests/studio-fonts.test.ts sur loadFallbackFonts.
    const header = new Uint8Array(font.data, 0, 4);
    expect(Array.from(header)).toEqual([0x00, 0x01, 0x00, 0x00]);
  });

  it("un identifiant INCONNU renvoie null — ne lève JAMAIS", async () => {
    const loader = new DbAssetLoader();
    await expect(loader.font(UNKNOWN_ID)).resolves.toBeNull();
  });

  it("un identifiant d'IMAGE demandé comme police renvoie null (mauvais type, pas une exception)", async () => {
    const loader = new DbAssetLoader();
    await expect(loader.font(imageAssetId)).resolves.toBeNull();
  });

  // Exigé par le brief Tâche 12 : "the in-process cache serves a second call without a second
  // fetch" — compte les VRAIES requêtes HTTP reçues par le serveur fixture, pas un simple nombre
  // d'appels à loader.font() (qui vaudrait toujours 2, cache ou pas) : c'est ce qui distingue un
  // cache réel d'un cache absent.
  it("le cache en mémoire sert un second appel sans second téléchargement réseau", async () => {
    fontRequestCount = 0;
    const loader = new DbAssetLoader();
    await loader.font(fontAssetId);
    await loader.font(fontAssetId);
    expect(fontRequestCount).toBe(1);
  });

  // Sabotage-check documenté : la garantie ci-dessus serait vraie PAR CONSTRUCTION si font()
  // renvoyait toujours null sans jamais appeler fetch (fontRequestCount resterait à 0, pas à 1) —
  // ce test distingue "mis en cache après un premier appel réussi" de "jamais appelé du tout".
  it("le compteur vaut bien 1, pas 0 : le premier appel a réellement déclenché un téléchargement", async () => {
    fontRequestCount = 0;
    const loader = new DbAssetLoader();
    const font = await loader.font(fontAssetId);
    expect(font).not.toBeNull();
    expect(fontRequestCount).toBe(1);
  });

  it("deux INSTANCES distinctes ne partagent PAS leur cache (portée par instance, pas par process)", async () => {
    fontRequestCount = 0;
    await new DbAssetLoader().font(fontAssetId);
    await new DbAssetLoader().font(fontAssetId);
    expect(fontRequestCount).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("DbAssetLoader.imageUrl()", () => {
  it("renvoie l'URL publique d'un asset image", async () => {
    const loader = new DbAssetLoader();
    await expect(loader.imageUrl(imageAssetId)).resolves.toBe("https://cdn.test.invalid/logo.png");
  });

  it("un identifiant INCONNU renvoie null", async () => {
    const loader = new DbAssetLoader();
    await expect(loader.imageUrl(UNKNOWN_ID)).resolves.toBeNull();
  });

  it("un identifiant de POLICE demandé comme image renvoie null (mauvais type)", async () => {
    const loader = new DbAssetLoader();
    await expect(loader.imageUrl(fontAssetId)).resolves.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Le correctif de fuite différé (brief Tâche 12) : lib/studio/render.ts enveloppe désormais
// l'appel à assets.imageUrl() dans un try/catch qui produit une RenderError française, exactement
// comme les trois autres frontières natives du fichier (satori/resvg/sharp, qrcode). Avant ce
// correctif, un magasin REJETANT laissait son message anglais brut remonter tel quel — reproduit
// ici avec un AssetLoader qui rejette délibérément, pour un calque IMAGE (pas police : imageUrl(),
// pas font() — la fuite visée est spécifiquement celle-là).
describe("renderScene — magasin d'assets REJETANT sur imageUrl() : plus de fuite anglaise brute (Tâche 12)", () => {
  const rejectingLoader: AssetLoader = {
    async font() { return null; },
    async imageUrl(): Promise<string | null> { throw new Error("R2 GetObject failed: connection reset by peer"); },
  };

  function assetImageScene(): Scene {
    return {
      schemaVersion: 1,
      canvas: { width: 300, height: 200, background: "#000000" },
      layers: [{
        id: "logo", name: "Logo", visible: true, locked: false,
        frame: { x: 0, y: 0, w: 300, h: 200 }, type: "image",
        source: { kind: "asset", assetId: "logo-1" }, fit: "cover",
      }],
    };
  }

  it("produit une RenderError française avec `cause`, jamais le message natif anglais", async () => {
    const err = await renderScene({ scene: assetImageScene(), values: {}, assets: rejectingLoader }).catch((e) => e);
    expect(err).toBeInstanceOf(RenderError);
    const message = (err as RenderError).message;
    // Sabotage-check : sans le correctif, err.message CONTIENDRAIT exactement ce texte (le message
    // brut de la promesse rejetée remonterait tel quel via le catch générique de l'appelant) — ces
    // deux assertions négatives échoueraient si la fuite réapparaissait.
    expect(message).not.toContain("connection reset");
    expect(message).not.toContain("R2 GetObject");
    expect(message.length).toBeGreaterThan(0);
    expect((err as Error & { cause?: unknown }).cause).toBeInstanceOf(Error);
  });

  it("un magasin qui rejette sur font() (pas imageUrl) reste, lui, la dégradation TOLÉRÉE — pas une régression du comportement existant", async () => {
    const fontRejecting: AssetLoader = {
      async font(): Promise<null> { throw new Error("timeout"); },
      async imageUrl() { return null; },
    };
    const textScene: Scene = {
      schemaVersion: 1,
      canvas: { width: 300, height: 200, background: "#000000" },
      layers: [{
        id: "t", name: "Titre", visible: true, locked: false,
        frame: { x: 10, y: 10, w: 280, h: 180 }, type: "text", content: "Bonjour",
        font: { assetId: "asset-1", family: "Police Perso", size: 40, weight: 400 },
        color: "#FFFFFF", align: "left", vAlign: "top", lineHeight: 1.2,
      }],
    };
    const out = await renderScene({ scene: textScene, values: {}, assets: fontRejecting });
    expect(out.degraded).toBe(true);
  });
});
