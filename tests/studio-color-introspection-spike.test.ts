/**
 * U4 Tâche 1 — SPIKE (enregistrement, pas fonctionnalité). Preuve que l'introspection du schéma Zod
 * v4 énumère les champs COULEUR d'un calque, pour chaque type de calque et à travers chaque enveloppe
 * que le schéma pose (`z.object`, `z.discriminatedUnion`, `z.union`, `z.array`, `z.optional`), SANS
 * liste écrite à la main. Technique retenue : `z.registry` + marqueur sur `hexColor`, marcheur
 * `colorFieldPaths`. Ce fichier EST la trace du spike ; la Tâche 2 bâtira dessus.
 *
 * Chaque calque ci-dessous passe d'abord par `parseScene` : on n'énumère que des scènes VALIDES, et
 * cela ancre les chemins attendus sur des données réelles (nombre d'arrêts, options présentes).
 */
import { test, expect } from "bun:test";
import {
  colorFieldPaths,
  sceneColorFieldPaths,
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

// Un calque texte AVEC ombre + contour : trois couleurs, dont deux sous des `.optional()`.
const textLayer: Layer = {
  ...base("t1"),
  type: "text",
  content: "Bonjour",
  font: { family: "Inter", size: 24, weight: 400 },
  color: "#ffffff",
  align: "left",
  vAlign: "top",
  lineHeight: 1.2,
  shadow: { x: 1, y: 1, blur: 2, color: "#000000" },
  stroke: { width: 1, color: "#ff0000" },
};

// Un calque forme à remplissage DÉGRADÉ : la couleur est sous `z.union` puis `z.array` (deux arrêts).
const shapeGradient: Layer = {
  ...base("s1"),
  type: "shape",
  shape: "rect",
  fill: { angle: 90, stops: [{ color: "#000000", at: 0 }, { color: "#ffffff", at: 1 }] },
  shadow: { x: 0, y: 0, blur: 4, color: "#123456" },
  border: { width: 2, color: "#abcdef" },
};

// Un calque forme à remplissage SOLIDE : `fill` matche la branche `hexColor` de l'union → feuille.
const shapeSolid: Layer = {
  ...base("s2"),
  type: "shape",
  shape: "ellipse",
  fill: "#00ff00",
  shadow: { x: 0, y: 0, blur: 4, color: "#123456" },
  border: { width: 2, color: "#abcdef" },
};

const qrLayer: Layer = {
  ...base("q1"),
  type: "qr",
  slot: "code",
  fg: "#000000",
  bg: "#ffffff",
  margin: 2,
};

const imageLayer: Layer = {
  ...base("i1"),
  type: "image",
  source: { kind: "asset", assetId: "a1" },
  fit: "cover",
  overlay: "#00000080",
};

// Chaque calque est validé par le schéma AVANT d'être introspecté (scène réelle, pas objet nu).
function validated(l: Layer): Layer {
  const scene: Scene = {
    schemaVersion: 1,
    canvas: { width: 200, height: 200, background: "#ffffff" },
    layers: [l],
  };
  return parseScene(scene).layers[0];
}

test("le marqueur survit à `.refine()` — un hexColor NU, sans enveloppe, est reconnu", () => {
  // La brique de base, isolée : les champs `fg`/`bg` du QR sont `hexColor` posé DIRECTEMENT dans un
  // objet — aucune option, aucune union, aucune array par-dessus. Que le marcheur les trouve prouve
  // que le marqueur `.register()` a bien survécu au `.refine()` (Zod v4 n'enveloppe pas : il ajoute
  // un check au même nœud string). Les tests suivants ajoutent, une à une, les enveloppes.
  expect(colorFieldPaths(validated(qrLayer))).toEqual(["fg", "bg"]);
});

test("texte + ombre + contour → color, shadow.color, stroke.color", () => {
  expect(colorFieldPaths(validated(textLayer))).toEqual(["color", "shadow.color", "stroke.color"]);
});

test("forme, remplissage dégradé → fill.stops.0.color, fill.stops.1.color, shadow.color, border.color", () => {
  expect(colorFieldPaths(validated(shapeGradient))).toEqual([
    "fill.stops.0.color",
    "fill.stops.1.color",
    "shadow.color",
    "border.color",
  ]);
});

test("forme, remplissage solide → fill, shadow.color, border.color", () => {
  expect(colorFieldPaths(validated(shapeSolid))).toEqual(["fill", "shadow.color", "border.color"]);
});

test("image → overlay", () => {
  expect(colorFieldPaths(validated(imageLayer))).toEqual(["overlay"]);
});

test("une image SANS overlay → aucune couleur (l'optionnel absent n'invente pas de chemin)", () => {
  const noOverlay: Layer = { ...base("i2"), type: "image", source: { kind: "slot", slot: "hero" }, fit: "contain" };
  expect(colorFieldPaths(validated(noOverlay))).toEqual([]);
});

test("niveau scène → canvas.background s'énumère aussi", () => {
  const scene: Scene = {
    schemaVersion: 1,
    canvas: { width: 200, height: 200, background: "#eeeeee" },
    layers: [textLayer],
  };
  const paths = sceneColorFieldPaths(parseScene(scene));
  expect(paths).toContain("canvas.background");
  expect(paths).toContain("layers.0.color");
});
