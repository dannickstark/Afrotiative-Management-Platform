import { describe, it, expect } from "bun:test";
import { resolveTokens, MissingTokensError } from "@/lib/studio/values";
import { extractTokens } from "@/lib/studio/tokens";
import type { Scene } from "@/lib/studio/scene";

// `scene` ci-dessous est un `const` de niveau module PARTAGÉ entre tous les `it()` de ce fichier.
// Si resolveTokens mutait un champ imbriqué, un test antérieur pourrait corrompre silencieusement
// ce fixture AVANT que "ne mute jamais la scène d'entrée" ne prenne son instantané "before" — ce
// test comparerait alors un état déjà corrompu à lui-même et passerait à tort. On gèle donc
// récursivement le fixture : toute tentative de mutation lève une TypeError immédiate, quel que
// soit l'ordre d'exécution des tests.
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

const base = { visible: true, locked: false, frame: { x: 0, y: 0, w: 100, h: 100 } };
const font = { family: "Noto Sans", size: 32, weight: 400 };

const scene: Scene = deepFreeze({
  schemaVersion: 1,
  canvas: { width: 1200, height: 675, background: "#000000" },
  layers: [
    { ...base, id: "img", name: "", type: "image", source: { kind: "slot", slot: "article.image" }, fit: "cover" },
    { ...base, id: "txt", name: "", type: "text", content: "{{article.title}} · {{category.name}}",
      font, color: "{{category.color}}", align: "left", vAlign: "top", lineHeight: 1.2 },
    { ...base, id: "bar", name: "", type: "shape", shape: "rect", fill: "{{category.color}}" },
  ],
});

const values = {
  "article.image": "https://cdn.test/photo.jpg",
  "article.title": "Le cacao camerounais",
  "category.name": "Agribusiness",
  "category.color": "#1B7F4A",
} as const;

describe("resolveTokens", () => {
  it("remplace les jetons dans le texte, la couleur et la source d'image", () => {
    const out = resolveTokens(scene, values);
    const img = out.layers[0];
    const txt = out.layers[1];
    const bar = out.layers[2];
    if (img.type !== "image" || txt.type !== "text" || bar.type !== "shape") throw new Error("types");
    expect(img.source).toEqual({ kind: "url", url: "https://cdn.test/photo.jpg" });
    expect(txt.content).toBe("Le cacao camerounais · Agribusiness");
    expect(txt.color).toBe("#1B7F4A");
    expect(bar.fill).toBe("#1B7F4A");
  });

  it("ne mute jamais la scène d'entrée", () => {
    const before = JSON.stringify(scene);
    resolveTokens(scene, values);
    expect(JSON.stringify(scene)).toBe(before);
  });

  it("lève MissingTokensError en nommant TOUS les jetons manquants, triés", () => {
    try {
      resolveTokens(scene, { "article.title": "x" });
      throw new Error("aurait dû lever");
    } catch (e) {
      expect(e).toBeInstanceOf(MissingTokensError);
      // Comparaison directe, SANS appeler .sort() sur le résultat : un .sort() ici masquerait un
      // bug de tri (l'implémentation doit déjà renvoyer un tableau trié, pas seulement le bon
      // ensemble de jetons dans un ordre quelconque).
      expect((e as MissingTokensError).tokens).toEqual(["article.image", "category.color", "category.name"]);
      // Le message affiché au rédacteur doit nommer les TROIS jetons manquants, pas seulement le
      // premier.
      expect((e as MissingTokensError).message).toContain("article.image");
      expect((e as MissingTokensError).message).toContain("category.color");
      expect((e as MissingTokensError).message).toContain("category.name");
    }
  });

  it("résout un jeton dans CHAQUE champ porteur de jeton (round-trip avec extractTokens, à l'exception documentée du slot QR)", () => {
    // Une scène qui met un jeton dans les onze emplacements substituables listés dans le brief,
    // PLUS un calque QR (dont le slot n'est jamais substitué par resolveTokens — voir plus bas).
    // Si resolveTokens oublie un seul des onze champs substituables, extractTokens(resolveTokens(...))
    // le signalera : c'est la garantie structurelle que les deux fonctions ne peuvent pas diverger.
    // Ce fixture est aussi gelé : resolveTokens doit produire une scène entièrement NOUVELLE,
    // y compris pour ce calque QR et ces dégradés, sans jamais toucher `full` lui-même.
    const full: Scene = deepFreeze({
      schemaVersion: 1,
      canvas: { width: 1200, height: 675, background: "{{category.color}}" },
      layers: [
        {
          ...base, id: "img", name: "", type: "image",
          source: { kind: "slot", slot: "article.image" },
          fit: "cover",
          overlay: "{{category.color}}",
        },
        {
          ...base, id: "txt", name: "", type: "text",
          content: "{{article.title}}",
          font,
          color: "{{category.color}}",
          align: "left", vAlign: "top", lineHeight: 1.2,
          shadow: { x: 1, y: 1, blur: 2, color: "{{article.byline}}" },
          stroke: { width: 1, color: "{{source.names}}" },
        },
        {
          ...base, id: "shape-solid", name: "", type: "shape", shape: "rect",
          fill: "{{category.color}}",
          border: { width: 1, color: "{{article.byline}}" },
        },
        {
          ...base, id: "shape-gradient", name: "", type: "shape", shape: "rect",
          fill: {
            angle: 45,
            stops: [
              { color: "{{category.color}}", at: 0 },
              { color: "{{article.byline}}", at: 1 },
            ],
          },
        },
        {
          ...base, id: "qr", name: "", type: "qr",
          slot: "article.url",
          fg: "{{category.color}}",
          bg: "{{article.byline}}",
          margin: 1,
        },
      ],
    });

    const fullValues = {
      "article.image": "https://cdn.test/photo.jpg",
      "article.title": "Titre",
      "category.color": "#1B7F4A",
      "article.byline": "Par la rédaction",
      "source.names": "Le Monde, Reuters",
      "article.url": "https://example.com/article",
    } as const;

    const resolved = resolveTokens(full, fullValues);

    // qrLayer.slot reste un identifiant de jeton non substitué : c'est render.ts qui le
    // transformera en bitmap QR plus tard, pas resolveTokens. C'est la SEULE exception documentée
    // dans le brief — extractTokens le signale toujours, résolu ou non, puisque ce champ n'est
    // jamais entouré de « {{ }} » : il EST le jeton.
    const remaining = extractTokens(resolved);
    expect(remaining).toEqual([{ token: "article.url", expected: "url", where: "calque « qr »" }]);

    // Le vrai contrat : à l'exception de ce seul cas documenté, plus aucun jeton détectable —
    // texte, image, couleur unie, dégradé, ombre, contour, bordure et arrière-plan de canevas
    // sont TOUS résolus. Si resolveTokens en oublie un, cette liste ne serait pas vide.
    expect(remaining.filter((u) => u.expected !== "url")).toEqual([]);
  });
});
