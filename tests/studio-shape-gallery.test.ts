import { describe, expect, it } from "bun:test";
import { SHAPE_TILES, shapeTilesFor, buildShapeLayer, recentTilesFor, withRecentShape } from "@/lib/studio/shape-gallery";
import { parseScene, SHAPE_KINDS } from "@/lib/studio/scene";
import { descriptorFor, shapeLabel } from "@/lib/studio/shapes";
import { CONTEXT_TOKENS, TEMPLATE_CONTEXTS, type TemplateContext } from "@/lib/studio/tokens";

// tests/studio-shape-gallery.test.ts — Tâche 4 (U1, spec §3), révisé après revue (voir
// task-4-report.md, section « Fix report » pour le détail des trois Important corrigés).
//
// Écarts corrigés par rapport au brief verbatim, documentés ici plutôt que reproduits
// silencieusement (même discipline que tests/studio-dynamic-text.test.ts pour la Tâche 3) :
//
// 1. Le brief construit la scène de test avec `JSON.stringify({ version: 1, ... })`. Comme pour la
//    Tâche 3 : `parseScene(input: unknown)` fait directement `sceneSchema.safeParse(input)` (jamais
//    `JSON.parse`), et la clé réelle du schéma est `schemaVersion`, pas `version` (scene.ts). Corrigé
//    vers un objet direct avec `schemaVersion: 1` et un `canvas.background` (requis par scene.ts,
//    absent du brief).
// 2. Le titre du second test du brief (« offers no tile for a shape the schema rejects ») ne
//    correspond pas à ce que son corps vérifie : il construit et valide le calque de CHAQUE tuile,
//    ce qui teste en réalité que toute tuile produit un calque que le schéma ACCEPTE (rect ET qr) —
//    pas qu'une forme rejetée n'a pas de tuile (ça, c'est déjà entièrement couvert par le premier
//    test, une égalité d'ensembles dans les deux sens). Renommé pour décrire ce qui est vraiment
//    vérifié.
// 3. Revue Tâche 4, Important 1 — le garde-fou de complétude compare désormais SHAPE_TILES à
//    SHAPE_KINDS (lib/studio/scene.ts), LA source canonique consommée par z.enum côté schéma —
//    jamais une copie manuscrite dans ce fichier. Voir le second describe ci-dessous pour la preuve
//    que ce garde-fou échoue vraiment quand on étend le VRAI schéma sans ajouter de tuile.
// 4. Revue Tâche 4, Important 2 — buildShapeLayer et le catalogue de tuiles sont désormais
//    CONTEXTUELS (shapeTilesFor(context)) : la tuile QR se lie à `article.url` quand ce jeton est
//    légal ici (spec §4, dernière phrase), et se grise avec une raison française sinon — même
//    discipline que dynamic-text.ts pour les lignes de Texte dynamique.
describe("shape gallery — completeness guard (dérivé du schéma réel)", () => {
  // C'est le garde-fou qui rend U3 impossible à demi-livrer : ajouter une forme au schéma sans lui
  // donner de tuile laisserait un designer sans aucun moyen de l'insérer. `SHAPE_KINDS` (scene.ts)
  // EST le schéma — z.enum(SHAPE_KINDS) le consomme directement — donc ce test échoue dès que
  // quelqu'un étend scene.ts sans toucher shape-gallery.ts, sans qu'aucune copie manuscrite
  // n'intervienne des deux côtés de la comparaison. Égalité d'ensembles dans LES DEUX SENS : couvre
  // aussi le sens inverse, une tuile qui prétendrait offrir une forme que le schéma ne connaît pas.
  it("offers a tile for every shape the schema accepts — and no tile for a shape it doesn't", () => {
    const tileShapes: string[] = SHAPE_TILES.filter((t) => t.kind === "shape").map((t) => t.shape as string);
    expect([...tileShapes].sort()).toEqual([...SHAPE_KINDS].sort());
  });
});

describe("shape gallery — buildShapeLayer", () => {
  it("builds, for every tile, a layer the real schema accepts", () => {
    for (const tile of SHAPE_TILES) {
      const layer = buildShapeLayer(tile, { width: 1200, height: 630 }, "social_post");
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
      const l = buildShapeLayer(t, { width: 1080, height: 1080 }, "social_post");
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
        const l = buildShapeLayer(t, canvas, "social_post");
        expect(l.frame.x).toBeGreaterThanOrEqual(0);
        expect(l.frame.y).toBeGreaterThanOrEqual(0);
        expect(l.frame.x + l.frame.w).toBeLessThanOrEqual(canvas.width);
        expect(l.frame.y + l.frame.h).toBeLessThanOrEqual(canvas.height);
      }
    }
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────────
  // U3 Tâche 3 — CE QU'EST UNE « LIGNE », géométriquement, et ce que ça change à l'insertion.
  //
  // Décision documentée dans la description de la forme (lib/studio/shapes.ts, descripteur `line`) :
  // une ligne est un RECTANGLE FIN NON PIVOTÉ — son épaisseur EST la hauteur de son cadre — et une
  // diagonale s'obtient en la faisant tourner (mécanisme 4 de la sonde, mesuré de bout en bout par
  // renderScene()). Conséquence ici : la galerie ne peut pas l'insérer dans le cadre CARRÉ des autres
  // formes, sans quoi elle serait indiscernable d'un rectangle au moment même de l'insertion.
  // ───────────────────────────────────────────────────────────────────────────────────────────────
  describe("l'insertion respecte la forme insérée (barre fine contre carré)", () => {
    const canvases = [{ width: 1200, height: 630 }, { width: 1080, height: 1080 }, { width: 1080, height: 1920 }];

    it("il existe au moins une forme fine et au moins une qui ne l'est pas", () => {
      // ANTI-VACUITÉ des deux boucles ci-dessous.
      const fines = SHAPE_KINDS.filter((k) => descriptorFor(k).thin);
      expect(fines.length).toBeGreaterThan(0);
      expect(fines.length).toBeLessThan(SHAPE_KINDS.length);
    });

    it("une forme FINE est insérée comme une barre — large, et d'une épaisseur qui reste visible", () => {
      for (const kind of SHAPE_KINDS.filter((k) => descriptorFor(k).thin)) {
        const tile = SHAPE_TILES.find((t) => t.kind === "shape" && t.shape === kind)!;
        for (const canvas of canvases) {
          const l = buildShapeLayer(tile, canvas, "social_post");
          // Une barre : nettement plus large que haute (au moins 5:1) …
          expect(`${kind}@${canvas.width}x${canvas.height} w/h>=5 : ${l.frame.w / l.frame.h >= 5}`)
            .toBe(`${kind}@${canvas.width}x${canvas.height} w/h>=5 : true`);
          // … mais JAMAIS d'épaisseur nulle ou sous-pixel : « une ligne a une vraie hauteur » (brief),
          // et le schéma exige d'ailleurs h > 0 (frame.h .positive()).
          expect(l.frame.h).toBeGreaterThanOrEqual(2);
        }
      }
    });

    it("une forme NON fine reste insérée dans un cadre carré, comme avant cette tâche", () => {
      for (const kind of SHAPE_KINDS.filter((k) => !descriptorFor(k).thin)) {
        const tile = SHAPE_TILES.find((t) => t.kind === "shape" && t.shape === kind)!;
        for (const canvas of canvases) {
          const l = buildShapeLayer(tile, canvas, "social_post");
          expect(`${kind}@${canvas.width}x${canvas.height} carré : ${l.frame.w === l.frame.h}`)
            .toBe(`${kind}@${canvas.width}x${canvas.height} carré : true`);
        }
      }
    });

    it("toute forme insérée reste DANS le canevas, y compris la barre", () => {
      // Le test « lands inside the canvas » plus haut couvre déjà SHAPE_TILES ; celui-ci le refait en
      // itérant SHAPE_KINDS pour que la garde reste vraie forme par forme, cadre spécial compris.
      for (const kind of SHAPE_KINDS) {
        const tile = SHAPE_TILES.find((t) => t.kind === "shape" && t.shape === kind)!;
        for (const canvas of canvases) {
          const l = buildShapeLayer(tile, canvas, "social_post");
          expect(l.frame.x).toBeGreaterThanOrEqual(0);
          expect(l.frame.y).toBeGreaterThanOrEqual(0);
          expect(l.frame.x + l.frame.w).toBeLessThanOrEqual(canvas.width);
          expect(l.frame.y + l.frame.h).toBeLessThanOrEqual(canvas.height);
        }
      }
    });

    it("chaque tuile de forme insère EXACTEMENT la forme qu'elle annonce", () => {
      // La fonction de choix « quelle tuile insère quelle forme » — celle que le plan nomme
      // explicitement (« which shape does this gallery tile insert »). Balayée sur les huit formes
      // plutôt que sur la seule tuile rectangle, qui ne pouvait rien révéler.
      for (const kind of SHAPE_KINDS) {
        const tile = SHAPE_TILES.find((t) => t.kind === "shape" && t.shape === kind)!;
        const l = buildShapeLayer(tile, { width: 1200, height: 630 }, "social_post");
        expect(l.type).toBe("shape");
        if (l.type === "shape") expect(`${tile.id} -> ${l.shape}`).toBe(`${tile.id} -> ${kind}`);
        expect(l.name).toBe(shapeLabel(kind));
      }
    });
  });

  it("builds a plain layer with no special status — a normal shape/qr layer", () => {
    const rect = buildShapeLayer(SHAPE_TILES.find((t) => t.id === "rect")!, { width: 1200, height: 630 }, "social_post");
    expect(rect.type).toBe("shape");
    if (rect.type === "shape") expect(rect.shape).toBe("rect");

    const qr = buildShapeLayer(SHAPE_TILES.find((t) => t.id === "qr")!, { width: 1200, height: 630 }, "social_post");
    expect(qr.type).toBe("qr");
  });
});

// Revue Tâche 4, Important 2 : spec §4, dernière phrase — « article.url is offered under Éléments
// as a QR tile rather than as text, matching how the QR layer actually works ». Par la même
// construction que chaque ligne du tableau §4 (« Row -> Inserts: layer bound to token »), ça décrit
// un calque QR LIÉ à article.url — pas un calque QR avec un `slot` placeholder qui ne correspond à
// aucun jeton réel (ce que la version d'origine posait, byte-identique au calque générique
// pré-existant editor-state.ts:createLayer, et que validateScene refuse aussitôt).
describe("shape gallery — the QR tile binds to article.url, context-aware", () => {
  it("article.url is legal only in social_post — sanity check against the canonical map", () => {
    const legalIn = TEMPLATE_CONTEXTS.filter((c) => CONTEXT_TOKENS[c].includes("article.url"));
    expect(legalIn).toEqual(["social_post"]);
  });

  it("marks the QR tile available, with no reason, where article.url is legal", () => {
    const rows = shapeTilesFor("social_post");
    const qr = rows.find((r) => r.id === "qr")!;
    expect(qr.available).toBe(true);
    expect(qr.reason).toBeUndefined();
  });

  it("greys the QR tile with a French reason where article.url is illegal", () => {
    const illegalContexts: TemplateContext[] = TEMPLATE_CONTEXTS.filter((c) => c !== "social_post");
    expect(illegalContexts.length).toBeGreaterThan(0); // sanity: such contexts really exist
    for (const ctx of illegalContexts) {
      const qr = shapeTilesFor(ctx).find((r) => r.id === "qr")!;
      expect(qr.available).toBe(false);
      expect(qr.reason).toBeTruthy();
      expect(qr.reason).not.toMatch(/^[a-z_.]+$/); // a sentence, not a key
    }
  });

  it("the rectangle tile is always available, regardless of context", () => {
    for (const ctx of TEMPLATE_CONTEXTS) {
      const rect = shapeTilesFor(ctx).find((r) => r.id === "rect")!;
      expect(rect.available).toBe(true);
      expect(rect.reason).toBeUndefined();
    }
  });

  it("builds a QR layer bound to article.url when the context makes it legal", () => {
    const qrTile = SHAPE_TILES.find((t) => t.id === "qr")!;
    const layer = buildShapeLayer(qrTile, { width: 1200, height: 630 }, "social_post");
    expect(layer.type).toBe("qr");
    if (layer.type === "qr") expect(layer.slot).toBe("article.url");
  });

  it("every row in every context carries a French label distinct from its id", () => {
    for (const ctx of TEMPLATE_CONTEXTS) {
      for (const r of shapeTilesFor(ctx)) {
        expect(r.label).toBeTruthy();
        expect(r.label).not.toBe(r.id);
      }
    }
  });
});

describe("shape gallery — recents (« Utilisés récemment »)", () => {
  const rows = shapeTilesFor("social_post"); // both tiles available in this context

  it("resolves ids to tiles, most-recent-first", () => {
    const tiles = recentTilesFor(rows, ["qr", "rect"]);
    expect(tiles.map((t) => t.id)).toEqual(["qr", "rect"]);
  });

  it("ignores an id that no longer matches any tile, rather than throwing", () => {
    expect(() => recentTilesFor(rows, ["ghost-shape", "rect"])).not.toThrow();
    expect(recentTilesFor(rows, ["ghost-shape", "rect"]).map((t) => t.id)).toEqual(["rect"]);
  });

  it("caps the displayed list at six even if more ids are stored", () => {
    // Repeats the two real tile ids to simulate a long history without inventing fake shapes.
    const long = Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? "rect" : "qr"));
    const tiles = recentTilesFor(rows, long);
    expect(tiles.length).toBeLessThanOrEqual(6);
  });

  it("a recent tile resolved in a context where it's now unavailable comes back greyed", () => {
    // The QR tile was used before (stored id "qr"), but the panel has since been reopened on a
    // template whose context makes article.url illegal — the recent tile must still resolve, just
    // disabled, rather than silently vanishing or (worse) pretending to be available.
    const quoteCardRows = shapeTilesFor("quote_card");
    const tiles = recentTilesFor(quoteCardRows, ["qr"]);
    expect(tiles).toHaveLength(1);
    expect(tiles[0].available).toBe(false);
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
