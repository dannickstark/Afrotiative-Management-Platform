import { describe, it, expect } from "bun:test";
import { extractTokens, validateScene, CONTEXT_TOKENS, TOKEN_KINDS } from "@/lib/studio/tokens";
import type { Scene } from "@/lib/studio/scene";

function scene(layers: Scene["layers"], background?: string): Scene {
  return { schemaVersion: 1, canvas: { width: 1200, height: 675, background: background || "#000000" }, layers };
}
const base = { visible: true, locked: false, frame: { x: 0, y: 0, w: 100, h: 100 } };
const textFont = { family: "Noto Sans", size: 32, weight: 400 };

describe("extractTokens", () => {
  it("trouve les jetons dans le texte, la couleur et la source d'image", () => {
    const s = scene([
      { ...base, id: "a", name: "", type: "image", source: { kind: "slot", slot: "article.image" }, fit: "cover" },
      { ...base, id: "b", name: "", type: "text", content: "{{article.title}} — {{category.name}}",
        font: textFont, color: "{{category.color}}", align: "left", vAlign: "top", lineHeight: 1.2 },
    ]);
    const found = extractTokens(s).map((t) => t.token).sort();
    expect(found).toEqual(["article.image", "article.title", "category.color", "category.name"]);
  });

  it("trouve les jetons dans tous les champs de couleur (canvas, overlay, shadow, stroke, qr)", () => {
    const s = scene([
      { ...base, id: "a", name: "", type: "image", source: { kind: "url", url: "https://example.com/img.png" }, fit: "cover", overlay: "{{category.color}}" },
      { ...base, id: "b", name: "", type: "text", content: "texte",
        font: textFont, color: "#000000", align: "left", vAlign: "top", lineHeight: 1.2,
        shadow: { x: 0, y: 0, blur: 5, color: "{{article.byline}}" },
        stroke: { width: 1, color: "{{source.names}}" } },
      { ...base, id: "c", name: "", type: "qr", slot: "article.url", fg: "{{article.title}}", bg: "{{quote.text}}", margin: 1 },
    ], "{{edition.title}}");
    const found = extractTokens(s).map((t) => t.token).sort();
    expect(found).toEqual([
      "article.byline", "article.title", "article.url", "category.color", "edition.title", "quote.text", "source.names",
    ]);
  });

  it("trouve aussi le jeton de la couleur d'OMBRE d'une forme (U3 Tâche 4)", () => {
    // `shapeLayer.shadow` est un champ neuf, et `usesInLayer` (tokens.ts) est une liste ÉCRITE À LA
    // MAIN de champs porteurs de couleur : un champ de couleur ajouté au schéma sans être ajouté ICI
    // laisserait passer un jeton inconnu jusqu'à satori, où il se peindrait en… rien, sans que
    // `validateScene` n'ait rien à dire. Le même oubli est possible côté resolveTokens
    // (lib/studio/values.ts), et tests/studio-values.test.ts en fait le tour par un aller-retour.
    const s = scene([
      { ...base, id: "s", name: "", type: "shape", shape: "rect", fill: "#FFFFFF",
        shadow: { x: 0, y: 2, blur: 4, color: "{{category.color}}" } },
    ]);
    expect(extractTokens(s).map((t) => t.token)).toEqual(["category.color"]);
    // Et le jeton est bien attendu comme une COULEUR : c'est ce qui fait refuser un jeton texte ici.
    expect(extractTokens(s)[0].expected).toBe("color");
  });

  it("un jeton inconnu dans l'ombre d'une forme est REFUSÉ par validateScene", () => {
    // La conséquence pratique du test précédent : sans le scan, cette scène passerait la validation et
    // partirait au rendu avec un « {{jeton.inconnu}} » en guise de couleur.
    const s = scene([
      { ...base, id: "s", name: "Fond", type: "shape", shape: "rect", fill: "#FFFFFF",
        shadow: { x: 0, y: 2, blur: 4, color: "{{jeton.inconnu}}" } },
    ]);
    const erreurs = validateScene(s, "social_post");
    expect(erreurs).toHaveLength(1);
    expect(erreurs[0]).toContain("jeton.inconnu");
    expect(erreurs[0]).toContain("Fond");
  });
});

describe("validateScene", () => {
  it("accepte un gabarit article_image sans article.url", () => {
    const s = scene([
      { ...base, id: "a", name: "", type: "image", source: { kind: "slot", slot: "article.image" }, fit: "cover" },
    ]);
    expect(validateScene(s, "article_image")).toEqual([]);
  });

  it("REFUSE article.url dans le contexte article_image", () => {
    const s = scene([
      { ...base, id: "q", name: "", type: "qr", slot: "article.url", fg: "#000000", bg: "#FFFFFF", margin: 1 },
    ]);
    const errors = validateScene(s, "article_image");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("article.url");
  });

  it("accepte article.url dans le contexte social_post", () => {
    const s = scene([
      { ...base, id: "q", name: "", type: "qr", slot: "article.url", fg: "#000000", bg: "#FFFFFF", margin: 1 },
    ]);
    expect(validateScene(s, "social_post")).toEqual([]);
  });

  it("refuse un jeton texte utilisé comme source d'image", () => {
    const s = scene([
      { ...base, id: "a", name: "", type: "image", source: { kind: "slot", slot: "article.title" }, fit: "cover" },
    ]);
    expect(validateScene(s, "social_post")[0]).toContain("texte");
  });

  it("refuse un jeton inconnu", () => {
    const s = scene([
      { ...base, id: "b", name: "", type: "text", content: "{{article.inexistant}}",
        font: textFont, color: "#FFFFFF", align: "left", vAlign: "top", lineHeight: 1.2 },
    ]);
    expect(validateScene(s, "social_post")[0]).toContain("article.inexistant");
  });

  it("chaque contexte ne déclare que des jetons connus", () => {
    for (const tokens of Object.values(CONTEXT_TOKENS)) {
      expect(tokens.length).toBeGreaterThan(0);
      for (const token of tokens) {
        expect(TOKEN_KINDS[token]).toBeDefined();
      }
    }
  });
});
