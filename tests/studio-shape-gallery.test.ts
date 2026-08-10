import { describe, expect, it } from "bun:test";
import { SHAPE_TILES, buildShapeLayer, recentTilesFor, withRecentShape } from "@/lib/studio/shape-gallery";
import { parseScene } from "@/lib/studio/scene";

// tests/studio-shape-gallery.test.ts — Tâche 4 (U1, spec §3).
//
// Deux écarts corrigés par rapport au brief verbatim, documentés ici plutôt que reproduits
// silencieusement (même discipline que tests/studio-dynamic-text.test.ts pour la Tâche 3) :
//
// 1. Le brief construit la scène de test avec `JSON.stringify({ version: 1, ... })`. Comme pour la
//    Tâche 3 : `parseScene(input: unknown)` fait directement `sceneSchema.safeParse(input)` (jamais
//    `JSON.parse`), et la clé réelle du schéma est `schemaVersion`, pas `version` (scene.ts). Passer
//    une chaîne avec la mauvaise clé ferait échouer le parse pour une raison étrangère à ce test
//    (« objet attendu, chaîne reçue » puis, même corrigé en objet, « schemaVersion manquant ») —
//    corrigé vers un objet direct avec `schemaVersion: 1` et un `canvas.background` (requis par
//    scene.ts, absent du brief).
// 2. Le titre du second test du brief (« offers no tile for a shape the schema rejects ») ne
//    correspond pas à ce que son corps vérifie : il construit et valide le calque de CHAQUE tuile,
//    ce qui teste en réalité que toute tuile produit un calque que le schéma ACCEPTE (rect ET qr) —
//    pas qu'une forme rejetée n'a pas de tuile (ça, c'est déjà entièrement couvert par le premier
//    test, une égalité d'ensembles dans les deux sens). Renommé pour décrire ce qui est vraiment
//    vérifié plutôt que de laisser un titre trompeur ; l'assertion elle-même est gardée car elle est
//    réellement utile (aller-retour par le VRAI schéma, pas une simple relecture du type).
describe("shape gallery — completeness guard", () => {
  // C'est le garde-fou qui rend U3 impossible à demi-livrer : ajouter une forme au schéma sans lui
  // donner de tuile laisserait un designer sans aucun moyen de l'insérer. Égalité d'ensembles dans
  // LES DEUX SENS (pas juste "chaque forme du schéma a une tuile") : elle couvre aussi le sens
  // inverse, une tuile qui prétendrait offrir une forme que le schéma ne connaît pas.
  it("offers a tile for every shape the schema accepts — and no tile for a shape it doesn't", () => {
    const schemaShapes: string[] = ["rect"]; // à tenir à jour en même temps que scene.ts (shapeLayer.shape)
    const tileShapes: string[] = SHAPE_TILES.filter((t) => t.kind === "shape").map((t) => t.shape as string);
    expect([...tileShapes].sort()).toEqual([...schemaShapes].sort());
  });
});

describe("shape gallery — buildShapeLayer", () => {
  it("builds, for every tile, a layer the real schema accepts", () => {
    for (const tile of SHAPE_TILES) {
      const layer = buildShapeLayer(tile, { width: 1200, height: 630 });
      const scene = parseScene({
        schemaVersion: 1,
        canvas: { width: 1200, height: 630, background: "#000000" },
        layers: [layer],
      });
      expect(scene.layers).toHaveLength(1);
    }
  });

  it("every tile has a French label distinct from its id", () => {
    for (const t of SHAPE_TILES) expect(t.label).not.toBe(t.id);
  });

  it("an inserted shape lands inside the canvas — square format", () => {
    for (const t of SHAPE_TILES) {
      const l = buildShapeLayer(t, { width: 1080, height: 1080 });
      expect(l.frame.x).toBeGreaterThanOrEqual(0);
      expect(l.frame.y).toBeGreaterThanOrEqual(0);
      expect(l.frame.x + l.frame.w).toBeLessThanOrEqual(1080);
      expect(l.frame.y + l.frame.h).toBeLessThanOrEqual(1080);
    }
  });

  // Le brief ne teste que le format carré 1080×1080 — insuffisant pour prouver que frameFor est
  // vraiment relatif au canevas plutôt que codé en dur : un format très large (lien, 1200×630) et un
  // format très étroit (story, 1080×1920) sont les deux cas où une taille fixe déborderait.
  it("an inserted shape lands inside the canvas — wide and tall formats", () => {
    for (const canvas of [{ width: 1200, height: 630 }, { width: 1080, height: 1920 }]) {
      for (const t of SHAPE_TILES) {
        const l = buildShapeLayer(t, canvas);
        expect(l.frame.x).toBeGreaterThanOrEqual(0);
        expect(l.frame.y).toBeGreaterThanOrEqual(0);
        expect(l.frame.x + l.frame.w).toBeLessThanOrEqual(canvas.width);
        expect(l.frame.y + l.frame.h).toBeLessThanOrEqual(canvas.height);
      }
    }
  });

  it("builds a plain layer with no special status — a normal shape/qr layer", () => {
    const rect = buildShapeLayer(SHAPE_TILES.find((t) => t.id === "rect")!, { width: 1200, height: 630 });
    expect(rect.type).toBe("shape");
    if (rect.type === "shape") expect(rect.shape).toBe("rect");

    const qr = buildShapeLayer(SHAPE_TILES.find((t) => t.id === "qr")!, { width: 1200, height: 630 });
    expect(qr.type).toBe("qr");
  });
});

describe("shape gallery — recents (« Utilisés récemment »)", () => {
  it("resolves ids to tiles, most-recent-first", () => {
    const tiles = recentTilesFor(["qr", "rect"]);
    expect(tiles.map((t) => t.id)).toEqual(["qr", "rect"]);
  });

  it("ignores an id that no longer matches any tile, rather than throwing", () => {
    expect(() => recentTilesFor(["ghost-shape", "rect"])).not.toThrow();
    expect(recentTilesFor(["ghost-shape", "rect"]).map((t) => t.id)).toEqual(["rect"]);
  });

  it("caps the displayed list at six even if more ids are stored", () => {
    // Repeats the two real tile ids to simulate a long history without inventing fake shapes.
    const long = Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? "rect" : "qr"));
    const tiles = recentTilesFor(long);
    expect(tiles.length).toBeLessThanOrEqual(6);
  });

  it("withRecentShape moves a re-clicked tile to the front without duplicating it", () => {
    const next = withRecentShape(["qr", "rect"], "rect");
    expect(next).toEqual(["rect", "qr"]);
  });

  it("withRecentShape caps the stored list at six entries", () => {
    const start = ["a", "b", "c", "d", "e", "f"];
    const next = withRecentShape(start, "g");
    expect(next.length).toBe(6);
    expect(next[0]).toBe("g");
    expect(next).not.toContain("f");
  });
});
