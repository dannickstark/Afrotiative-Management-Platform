import { z } from "zod";
import frLocale from "zod/v4/locales/fr.js";

export const SCENE_SCHEMA_VERSION = 1 as const;

// Erreur typée : tout message porté par SceneError est en français et affichable tel quel.
export class SceneError extends Error {}

// Get French error messages from Zod's locale (no global configuration)
const frenchZodMessages = frLocale().localeError;

// #RGB, #RRGGBB ou #RRGGBBAA. Les jetons ({{category.color}}) sont autorisés partout où une
// couleur est attendue — c'est tokens.ts qui vérifiera qu'ils sont légaux dans ce contexte.
const TOKEN_RE = /^\{\{\s*[a-zA-Z][\w.]*\s*\}\}$/;
const hexColor = z.string().refine(
  (v) => /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v) || v === "transparent" || TOKEN_RE.test(v),
  { message: "Couleur invalide (attendu #RGB, #RRGGBB, #RRGGBBAA, « transparent » ou un jeton)" },
);

const frame = z.object({
  x: z.number(), y: z.number(),
  w: z.number().positive(), h: z.number().positive(),
});

const layerBase = {
  id: z.string().min(1),
  name: z.string(),
  visible: z.boolean(),
  locked: z.boolean(),
  frame,
  rotation: z.number().optional(),
  opacity: z.number().min(0).max(1).optional(),
};

const imageSource = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("asset"), assetId: z.string().min(1) }),
  z.object({ kind: z.literal("slot"), slot: z.string().min(1) }),
  z.object({ kind: z.literal("url"), url: z.string().url() }),
]);

const imageLayer = z.object({
  ...layerBase,
  type: z.literal("image"),
  source: imageSource,
  fit: z.enum(["cover", "contain"]),
  radius: z.number().nonnegative().optional(),
  blur: z.number().nonnegative().max(200).optional(),
  overlay: hexColor.optional(),
});

const textLayer = z.object({
  ...layerBase,
  type: z.literal("text"),
  content: z.string(),
  font: z.object({
    assetId: z.string().optional(),
    family: z.string().min(1),
    size: z.number().positive(),
    weight: z.number().int().min(100).max(900),
    italic: z.boolean().optional(),
  }),
  color: hexColor,
  align: z.enum(["left", "center", "right"]),
  vAlign: z.enum(["top", "middle", "bottom"]),
  lineHeight: z.number().positive(),
  letterSpacing: z.number().optional(),
  maxLines: z.number().int().positive().optional(),
  autoFit: z.boolean().optional(),
  shadow: z.object({ x: z.number(), y: z.number(), blur: z.number().nonnegative(), color: hexColor }).optional(),
  stroke: z.object({ width: z.number().positive(), color: hexColor }).optional(),
});

const gradient = z.object({
  angle: z.number(),
  stops: z.array(z.object({ color: hexColor, at: z.number().min(0).max(1) })).min(2),
});

// Canonique : LA liste des formes que shapeLayer accepte aujourd'hui. lib/studio/shape-gallery.ts
// (panneau Éléments, U1 Tâche 4) itère CE TABLEAU pour son garde-fou de complétude — jamais une
// copie recopiée — pour qu'ajouter une forme ICI sans lui donner de tuile fasse échouer
// tests/studio-shape-gallery.test.ts plutôt que de laisser un designer sans moyen de l'insérer
// (revue Tâche 4, Important 1 : le garde-fou d'origine comparait deux copies manuscrites qui
// pouvaient dériver ensemble sans qu'aucun test ne le remarque).
export const SHAPE_KINDS = ["rect"] as const;

/** LA forme d'un calque forme — le type que lib/studio/shapes.ts décrit et que les deux chemins de
 * rendu consomment. Dérivé de SHAPE_KINDS, jamais recopié. */
export type ShapeKind = (typeof SHAPE_KINDS)[number];

// Le rayon des coins d'une forme (U3 Tâche 2, arbitrage C — douzième défaut de plan du programme).
//
// HISTORIQUE, INCHANGÉ : un NOMBRE, en pixels. Toute scène déjà écrite se relit exactement pareil.
// NOUVEAU : une CHAÎNE CSS de une à quatre longueurs en « px » ou « % ». Parce qu'un nombre NE PEUT
// PAS exprimer une ellipse : la sonde (Tâche 1) l'a mesuré en pixels À TRAVERS renderScene() — sur
// un cadre 800×400, `radius: 200` (le plus grand rayon utile) donne un STADE, deux demi-cercles
// reliés par un rectangle, pas une ellipse. Seul `"50%"` en donne une. La Tâche 3 (ellipse) et la
// Tâche 4 (rayon par coin, « 8px 24px 8px 24px ») en dépendent toutes les deux.
//
// `z.custom` plutôt qu'un `z.union` : une union fait remonter à parseScene un `invalid_union`
// générique (« Entrée invalide ») qui n'apprend rien à un rédacteur, alors qu'un `custom` porte le
// code que parseScene sait afficher tel quel — un seul message français qui dit les DEUX formes
// acceptées.
const RADIUS_LENGTH_RE = /^\d+(?:\.\d+)?(?:px|%)(?: \d+(?:\.\d+)?(?:px|%)){0,3}$/;
const cssRadius = z.custom<number | string>(
  (v) => (typeof v === "number" ? Number.isFinite(v) && v >= 0 : typeof v === "string" && RADIUS_LENGTH_RE.test(v)),
  { message: "Rayon invalide (attendu un nombre de pixels ≥ 0, ou 1 à 4 longueurs en « px » ou « % » séparées par une espace, ex. « 50% »)" },
);

const shapeLayer = z.object({
  ...layerBase,
  type: z.literal("shape"),
  shape: z.enum(SHAPE_KINDS),
  fill: z.union([hexColor, gradient]),
  radius: cssRadius.optional(),
  border: z.object({
    width: z.number().positive(),
    color: hexColor,
    sides: z.array(z.enum(["top", "right", "bottom", "left"])).optional(),
  }).optional(),
});

const qrLayer = z.object({
  ...layerBase,
  type: z.literal("qr"),
  slot: z.string().min(1),
  fg: hexColor,
  bg: hexColor,
  margin: z.number().int().nonnegative(),
});

const layer = z.discriminatedUnion("type", [imageLayer, textLayer, shapeLayer, qrLayer]);

export const sceneSchema = z.object({
  schemaVersion: z.literal(SCENE_SCHEMA_VERSION),
  canvas: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    background: hexColor,
  }),
  // L'ORDRE EST L'ORDRE DE PEINTURE : index 0 = arrière-plan. Satori n'a pas de z-index, et une
  // liste de calques exprime déjà exactement cela.
  layers: z.array(layer),
});

export type Frame = z.infer<typeof frame>;
export type ImageSource = z.infer<typeof imageSource>;
export type ImageLayer = z.infer<typeof imageLayer>;
export type TextLayer = z.infer<typeof textLayer>;
export type Gradient = z.infer<typeof gradient>;
export type ShapeLayer = z.infer<typeof shapeLayer>;
export type QrLayer = z.infer<typeof qrLayer>;
export type Layer = z.infer<typeof layer>;
export type Scene = z.infer<typeof sceneSchema>;

// Une scène lue en base est une donnée NON FIABLE : elle a pu être écrite par une version
// antérieure du code. Tout chemin de lecture passe par ici.
export function parseScene(input: unknown): Scene {
  const parsed = sceneSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    // For custom refine() messages (already in French), use them directly.
    // For built-in Zod validations, use French locale translation.
    const message = first.code === "custom" ? first.message : frenchZodMessages(first as Parameters<typeof frenchZodMessages>[0]);
    throw new SceneError(`Scène invalide : ${first.path.join(".") || "racine"} — ${message}`);
  }
  const ids = new Set<string>();
  for (const l of parsed.data.layers) {
    if (ids.has(l.id)) throw new SceneError(`Scène invalide : identifiant de calque en double « ${l.id} ».`);
    ids.add(l.id);
  }
  return parsed.data;
}
