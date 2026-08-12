/**
 * U4 Tâche 2 — garde-fou structurel (anti-vacuité). `colorFieldsOf` doit énumérer EXACTEMENT les
 * champs-couleur d'un calque — ni plus (un champ non-couleur comme `text.content` ne doit JAMAIS
 * apparaître), ni moins (un champ-couleur oublié par le marcheur doit rougir CE test, pas dériver
 * en silence dans tokens.ts/values.ts).
 *
 * Mutation à l'appui (voir task-2-report.md) :
 *   (a) ajouter un NOUVEAU champ `hexColor` à un schéma de calque SANS toucher le marcheur → ce test
 *       rougit (colorFieldsOf trouve un chemin de plus que ce que buildShapeLayer/buildTextLayer
 *       attendaient — voir le rapport pour la preuve exacte).
 *   (b) un marcheur qui OUBLIE un cas (ex. ne descend plus dans `union`) → ce test rougit aussitôt
 *       (les chemins de `fill`/`shadow.color`/`stroke.color` disparaissent des tableaux attendus).
 */
import { test, expect } from "bun:test";
import {
  colorFieldsOf,
  parseScene,
  type Layer,
  type Scene,
} from "../lib/studio/scene";

const base = (id: string) => ({
  id,
  name: id,
  visible: true,
  locked: false,
  frame: { x: 0, y: 0, w: 100, h: 100 },
});

// Chaque calque est validé par le schéma AVANT d'être introspecté (scène réelle, pas objet nu) —
// même discipline que le spike (tests/studio-color-introspection-spike.test.ts).
function validated(l: Layer): Layer {
  const scene: Scene = {
    schemaVersion: 1,
    canvas: { width: 200, height: 200, background: "#ffffff" },
    layers: [l],
  };
  return parseScene(scene).layers[0];
}

// Forme : remplissage SOLIDE + bordure + ombre — trois couleurs, aucune sous un tableau.
function buildShapeLayer(): Layer {
  return validated({
    ...base("s"),
    type: "shape",
    shape: "rect",
    fill: "#00ff00",
    border: { width: 2, color: "#abcdef" },
    shadow: { x: 0, y: 2, blur: 4, color: "#123456" },
  });
}

// Texte : contenu (NON-couleur, témoin anti-vacuité) + couleur + ombre + contour.
function buildTextLayer(): Layer {
  return validated({
    ...base("t"),
    type: "text",
    content: "Bonjour",
    font: { family: "Inter", size: 24, weight: 400 },
    color: "#ffffff",
    align: "left",
    vAlign: "top",
    lineHeight: 1.2,
    shadow: { x: 1, y: 1, blur: 2, color: "#000000" },
    stroke: { width: 1, color: "#ff0000" },
  });
}

test("colorFieldsOf enumerates every colour field and no other", () => {
  const shape = buildShapeLayer();
  expect(colorFieldsOf(shape).map((f) => f.path).sort())
    .toEqual(["border.color", "fill", "shadow.color"]);

  const text = buildTextLayer();
  expect(colorFieldsOf(text).map((f) => f.path).sort())
    .toEqual(["color", "shadow.color", "stroke.color"]);

  // Anti-vacuité : le contenu du texte n'est PAS une couleur.
  expect(colorFieldsOf(text).map((f) => f.path)).not.toContain("content");
});

test("colorFieldsOf lit la valeur de chaque champ, pas seulement son chemin", () => {
  const shape = buildShapeLayer();
  const byPath = Object.fromEntries(colorFieldsOf(shape).map((f) => [f.path, f.get()]));
  expect(byPath).toEqual({ fill: "#00ff00", "border.color": "#abcdef", "shadow.color": "#123456" });
});

test("un calque forme à remplissage DÉGRADÉ énumère un chemin par arrêt", () => {
  const gradientShape = validated({
    ...base("g"),
    type: "shape",
    shape: "rect",
    fill: { angle: 90, stops: [{ color: "#000000", at: 0 }, { color: "#ffffff", at: 1 }] },
  });
  expect(colorFieldsOf(gradientShape).map((f) => f.path).sort()).toEqual([
    "fill.stops.0.color",
    "fill.stops.1.color",
  ]);
});

test("un calque QR énumère fg et bg — aucune enveloppe entre les deux", () => {
  const qr = validated({ ...base("q"), type: "qr", slot: "code", fg: "#000000", bg: "#ffffff", margin: 2 });
  expect(colorFieldsOf(qr).map((f) => f.path).sort()).toEqual(["bg", "fg"]);
});

test("un calque image SANS overlay n'énumère aucune couleur — l'optionnel absent n'invente rien", () => {
  const image = validated({ ...base("i"), type: "image", source: { kind: "slot", slot: "hero" }, fit: "contain" });
  expect(colorFieldsOf(image)).toEqual([]);
});
