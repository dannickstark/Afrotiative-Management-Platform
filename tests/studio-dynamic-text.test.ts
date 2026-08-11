import { describe, expect, it } from "bun:test";
import { dynamicTextRowsFor, buildDynamicTextLayer, insertDynamicTextLayer } from "@/lib/studio/dynamic-text";
import { CONTEXT_TOKENS, TOKEN_KINDS, TEMPLATE_CONTEXTS, type TokenId } from "@/lib/studio/tokens";
import { parseScene, type Scene } from "@/lib/studio/scene";
import { editorReducer, initEditorState, addLayer, type EditorAction } from "@/lib/studio/editor-state";

// tests/studio-dynamic-text.test.ts — Tâche 3 (U1, spec §4).
//
// Deux écarts corrigés par rapport au brief verbatim, documentés ici plutôt que reproduits
// silencieusement (voir le rapport de la Tâche 3) :
//
// 1. Le brief cherche une ligne `tokenId === "title"` et un calque `text: "{{title}}"`. Aucun jeton
//    "title" n'existe — tokens.ts (TOKEN_KINDS/CONTEXT_TOKENS) ne connaît que "article.title", et
//    TextLayer (scene.ts) porte son texte dans le champ `content`, pas `text`. Utiliser "title"/
//    "{{title}}" tel quel produirait un calque dont le jeton ne correspond à AUCUNE valeur calculée
//    par lib/studio/bindings.ts (articleTokenValues ne connaît que "article.title") : le calque
//    "s'insérerait" mais n'afficherait jamais rien de réel. Corrigé vers le vrai TokenId
//    "article.title" et le vrai champ `content`.
// 2. Le brief construit la scène de test avec `{ version: 1, ... }` ; le schéma réel (scene.ts,
//    sceneSchema) exige `schemaVersion: 1`. Avec la mauvaise clé, parseScene refuse la scène pour
//    une raison indépendante de tout ce que ce test veut vérifier (schemaVersion manquant, pas la
//    forme du calque) — corrigé vers `schemaVersion`, la même clé que tests/studio-scene.test.ts.
// 3. Le brief enveloppe cet objet dans `JSON.stringify(...)`, mais parseScene(input: unknown) fait
//    directement `sceneSchema.safeParse(input)` — il n'appelle jamais `JSON.parse` lui-même (voir
//    scene.ts et l'usage réel dans tests/studio-scene.test.ts : `parseScene(structuredClone(valid))`,
//    jamais une chaîne). Lui passer une chaîne JSON fait échouer le parse pour une raison encore une
//    fois étrangère à ce test (« objet attendu, chaîne reçue ») — corrigé en passant l'objet direct.
//
// Un troisième écart, plus subtil, concerne le second test ci-dessous ("marks a token illegal...").
// Le brief y utilise "article.url" comme exemple de jeton "illégal dans ce contexte" — mais
// TOKEN_KINDS classe "article.url" en "url", pas "text" : dynamicTextRowsFor n'énumère QUE
// l'univers des jetons "text" (spec §4 : « offers only text-kind tokens »), donc AUCUN contexte ne
// produira jamais de ligne pour "article.url", et `row` vaudrait systématiquement `undefined` —
// même si l'implémentation ignorait totalement CONTEXT_TOKENS. Le `if (row)` du brief masque ce
// vide : le test « passerait » sans jamais exécuter ses propres assertions. Remplacé par un jeton
// texte réellement absent d'au moins un contexte ("article.byline", absent de quote_card /
// newsletter_header / recap_card), dérivé de CONTEXT_TOKENS exactement comme le brief le demandait
// en commentaire — pour de vrai, cette fois.
describe("dynamic text rows", () => {
  it("marks a token legal in this context available, with no reason", () => {
    const rows = dynamicTextRowsFor("article_image");
    const title = rows.find((r) => r.tokenId === "article.title")!;
    expect(title.available).toBe(true);
    expect(title.reason).toBeUndefined();
  });

  it("marks a token illegal in this context unavailable, with a French reason", () => {
    // article.byline is a text-kind token, absent from some contexts — assert against
    // CONTEXT_TOKENS/TOKEN_KINDS rather than hardcoding which context that is.
    const textToken: TokenId = "article.byline";
    expect(TOKEN_KINDS[textToken]).toBe("text");
    const ctx = TEMPLATE_CONTEXTS.find((c) => !CONTEXT_TOKENS[c].includes(textToken))!;
    expect(ctx).toBeTruthy(); // sanity: such a context really exists

    const row = dynamicTextRowsFor(ctx).find((r) => r.tokenId === textToken);
    expect(row).toBeDefined();
    expect(row!.available).toBe(false);
    expect(row!.reason).toBeTruthy();
    expect(row!.reason).not.toMatch(/^[a-z_.]+$/); // a sentence, not a key
  });

  it("offers only text-kind tokens — image and colour tokens are not text rows", () => {
    const rows = dynamicTextRowsFor("article_image");
    expect(rows.some((r) => r.tokenId === "article.image")).toBe(false);
    expect(rows.some((r) => r.tokenId === "category.color")).toBe(false);
  });

  it("every row in every context carries a French label distinct from its token id", () => {
    for (const ctx of TEMPLATE_CONTEXTS) {
      for (const r of dynamicTextRowsFor(ctx)) {
        expect(r.label).toBeTruthy();
        expect(r.label).not.toBe(r.tokenId);
      }
    }
  });
});

describe("the layer a click inserts", () => {
  it("is a normal text layer bound to the token, and parseScene accepts it", () => {
    const row = dynamicTextRowsFor("article_image").find((r) => r.tokenId === "article.title")!;
    const layer = buildDynamicTextLayer(row, { width: 1200, height: 630 });
    expect(layer.type).toBe("text");
    expect(layer.content).toBe("{{article.title}}");
    // it must survive the real schema, not just look right
    const scene = parseScene({
      schemaVersion: 1, canvas: { width: 1200, height: 630, background: "#000000" }, layers: [layer],
    });
    expect(scene.layers).toHaveLength(1);
  });

  it("lands inside the canvas, not off-board", () => {
    const row = dynamicTextRowsFor("article_image").find((r) => r.tokenId === "article.title")!;
    const l = buildDynamicTextLayer(row, { width: 1080, height: 1920 });
    expect(l.frame.x).toBeGreaterThanOrEqual(0);
    expect(l.frame.y).toBeGreaterThanOrEqual(0);
    expect(l.frame.x + l.frame.w).toBeLessThanOrEqual(1080);
    expect(l.frame.y + l.frame.h).toBeLessThanOrEqual(1920);
  });

  it("applies the preset's size and weight", () => {
    const row = dynamicTextRowsFor("article_image").find((r) => r.tokenId === "article.title")!;
    const l = buildDynamicTextLayer(row, { width: 1200, height: 630 });
    expect(l.font.size).toBeGreaterThan(
      buildDynamicTextLayer({ ...row, preset: "corps" }, { width: 1200, height: 630 }).font.size,
    );
  });
});

// Amendement de spec §4 (revue finale, décision produit sur mandat exprès de l'utilisateur) : ne
// griser QUE les cinq jetons nommés par le tableau §4 (article.title, article.excerpt, category.name,
// article.byline, article.date) quand ils sont illégaux ici ; omettre entièrement tout autre jeton
// texte illégal. Avant cet amendement, `dynamicTextRowsFor` grisait l'univers "text" COMPLET (14
// jetons) dans chaque contexte — jusqu'à 12 lignes grisées contre 2 utilisables pour
// `newsletter_header`. Les ensembles exacts ci-dessous sont dérivés à la main de CONTEXT_TOKENS
// (lib/studio/tokens.ts) — voir le rapport final pour le détail contexte par contexte.
describe("dynamicTextRowsFor — amendement de revue (spec §4) : ne grise QUE les cinq jetons du tableau, omet le reste", () => {
  const TABLE_TOKENS = ["article.title", "article.excerpt", "category.name", "article.byline", "article.date"] as const;

  it("n'affiche JAMAIS de ligne pour un jeton texte illégal HORS des cinq du tableau — omise, jamais grisée", () => {
    const rows = dynamicTextRowsFor("newsletter_header");
    expect(rows.some((r) => r.tokenId === "quote.text")).toBe(false);
    expect(rows.some((r) => r.tokenId === "source.names")).toBe(false);
    expect(rows.some((r) => r.tokenId === "recap.item1")).toBe(false);
  });

  it("newsletter_header : 2 lignes disponibles (edition.*) + les 5 lignes du tableau, toutes grisées ici — jamais 12/14", () => {
    const rows = dynamicTextRowsFor("newsletter_header");
    expect(rows.filter((r) => r.available).map((r) => r.tokenId).sort()).toEqual(["edition.date", "edition.title"]);
    expect(rows.filter((r) => !r.available).map((r) => r.tokenId).sort()).toEqual([...TABLE_TOKENS].sort());
    expect(rows).toHaveLength(7);
  });

  it("recap_card : 4 lignes disponibles (recap.*) + les 5 lignes du tableau, toutes grisées ici", () => {
    const rows = dynamicTextRowsFor("recap_card");
    expect(rows.filter((r) => r.available).map((r) => r.tokenId).sort())
      .toEqual(["recap.item1", "recap.item2", "recap.item3", "recap.title"]);
    expect(rows.filter((r) => !r.available).map((r) => r.tokenId).sort()).toEqual([...TABLE_TOKENS].sort());
    expect(rows).toHaveLength(9);
  });

  it("quote_card : 2 des cinq du tableau sont déjà légales ici (disponibles) ; les 3 autres sont grisées, le reste (quote.*) est aussi disponible", () => {
    const rows = dynamicTextRowsFor("quote_card");
    expect(rows.filter((r) => r.available).map((r) => r.tokenId).sort())
      .toEqual(["article.title", "category.name", "quote.attribution", "quote.text"]);
    expect(rows.filter((r) => !r.available).map((r) => r.tokenId).sort())
      .toEqual(["article.byline", "article.date", "article.excerpt"]);
    expect(rows).toHaveLength(7);
  });

  it("article_image et social_post : les cinq jetons du tableau sont déjà tous légaux ici — AUCUNE ligne grisée", () => {
    for (const ctx of ["article_image", "social_post"] as const) {
      const rows = dynamicTextRowsFor(ctx);
      expect(rows.every((r) => r.available)).toBe(true);
      expect(rows.map((r) => r.tokenId).sort()).toEqual(
        ["article.byline", "article.date", "article.excerpt", "article.title", "category.name", "source.names"].sort(),
      );
    }
  });
});

// spec §9 : « a token illegal in the context is disabled and clicking it inserts nothing » — cette
// propriété n'avait, avant ce correctif, aucun test direct : `buildDynamicTextLayer` construit
// TOUJOURS un calque, disponible ou non, si on l'appelle directement (le composant se chargeait
// jusqu'ici seul de ne jamais l'appeler pour une ligne indisponible, via l'attribut HTML `disabled`).
// `insertDynamicTextLayer` porte désormais CETTE décision, testable indépendamment du rendu.
describe("insertDynamicTextLayer — le clic n'insère JAMAIS un jeton illégal ici (spec §9)", () => {
  function emptyScene(): Scene {
    return { schemaVersion: 1, canvas: { width: 1200, height: 630, background: "#000000" }, layers: [] };
  }

  it("renvoie null pour une ligne indisponible — aucun calque à insérer", () => {
    const row = dynamicTextRowsFor("newsletter_header").find((r) => !r.available)!;
    expect(insertDynamicTextLayer(row, { width: 1200, height: 630 })).toBeNull();
  });

  it("renvoie le calque construit pour une ligne disponible", () => {
    const row = dynamicTextRowsFor("newsletter_header").find((r) => r.available)!;
    expect(insertDynamicTextLayer(row, { width: 1200, height: 630 })).not.toBeNull();
  });

  it("composé avec le VRAI réducteur : cliquer une ligne indisponible ne modifie jamais la scène", () => {
    let state = initEditorState(emptyScene());
    const dispatch = (a: EditorAction) => { state = editorReducer(state, a); };
    const row = dynamicTextRowsFor("newsletter_header").find((r) => !r.available)!;
    const layer = insertDynamicTextLayer(row, { width: 1200, height: 630 });
    if (layer) dispatch(addLayer("text", layer));
    expect(state.scene.layers).toHaveLength(0);
    expect(state.selectedId).toBeNull();
  });

  it("composé avec le VRAI réducteur : cliquer une ligne disponible insère et sélectionne le calque", () => {
    let state = initEditorState(emptyScene());
    const dispatch = (a: EditorAction) => { state = editorReducer(state, a); };
    const row = dynamicTextRowsFor("newsletter_header").find((r) => r.available)!;
    const layer = insertDynamicTextLayer(row, { width: 1200, height: 630 });
    if (layer) dispatch(addLayer("text", layer));
    expect(state.scene.layers).toHaveLength(1);
    expect(state.selectedId).toBe(state.scene.layers[0].id);
  });
});
