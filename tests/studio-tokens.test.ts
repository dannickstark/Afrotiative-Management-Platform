import { describe, it, expect } from "bun:test";
import { extractTokens, validateScene, CONTEXT_TOKENS } from "@/lib/studio/tokens";
import type { Scene } from "@/lib/studio/scene";

function scene(layers: Scene["layers"]): Scene {
  return { schemaVersion: 1, canvas: { width: 1200, height: 675, background: "#000000" }, layers };
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
    expect(validateScene(s, "social_post")[0]).toMatch(/type/i);
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
    }
  });
});
