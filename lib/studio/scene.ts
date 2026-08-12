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

// U4 Tâche 1 (spike) — LE registre des nœuds « couleur » du schéma. `hexColor` est le SEUL nœud
// couleur ; toute couleur de la scène est CE nœud partagé (overlay, ombre, texte, contour, arrêts de
// dégradé, remplissage, bordure, fg/bg d'un QR, fond du canevas). Le marquer une fois ici suffit :
// le registre de Zod v4 indexe par IDENTITÉ de nœud, et cette identité survit aux ENVELOPPES que le
// schéma pose par-dessus (`.optional()` → def.innerType, `z.array` → def.element, `z.union` /
// `z.discriminatedUnion` → def.options, `z.object` → def.shape) — c'est ce que la sonde a prouvé.
//
// ⚠️ ORDRE CRITIQUE — `.register()` DOIT être le DERNIER appel de la chaîne, après TOUS les
// `.refine()`/`.check()`. En Zod v4, `.refine()`/`.check()` ne mutent pas : ils CLONENT le nœud
// (`this.clone(def)` → `new inst._zod.constr(def)`, cf. core/util.js + classic/schemas.js), donc
// `z.string() !== z.string().refine(…)`. Le registre étant indexé par identité, un marqueur posé
// AVANT un `.refine()` est laissé sur l'ANCIEN objet et DISPARAÎT silencieusement du clone final :
// `colorFieldPaths` sous-compterait alors sans lever d'erreur (un chemin couleur manquant, muet).
// Ici l'ordre est correct : `.register()` s'applique à l'objet FINAL, celui que le schéma référence.
// Quiconque ajoute un champ marqué doit garder `.register()` en dernier. lib/studio reste sans base :
// `z.registry` est du pur cœur Zod, client-safe.
export const COLOR_REGISTRY = z.registry<{ color: true }>();
const hexColor = z.string().refine(
  (v) => /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v) || v === "transparent" || TOKEN_RE.test(v),
  { message: "Couleur invalide (attendu #RGB, #RRGGBB, #RRGGBBAA, « transparent » ou un jeton)" },
).register(COLOR_REGISTRY, { color: true });

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

/**
 * UNE ombre, pour un texte comme pour une forme (U3 Tâche 4).
 *
 * Extraite de `textLayer` où elle vivait en ligne, et partagée : `textLayer.shadow` devient une
 * `text-shadow` (element.ts#textStyleFor), `shapeLayer.shadow` une `box-shadow`
 * (shapes.ts#layerBoxShadow), mais ce qu'un designer RÈGLE est la même chose — un décalage, un flou,
 * une couleur — et le panneau de propriétés offre les mêmes quatre champs dans les deux cas. Deux
 * définitions jumelles auraient pu dériver (durcir l'une sans l'autre) ; tests/studio-scene.test.ts
 * épingle l'équivalence des acceptations ET des refus dans les deux sens.
 *
 * `blur` est `nonnegative()` — un flou négatif n'a pas de sens ; `x` et `y` sont signés, une ombre
 * peut porter en haut à gauche. La COULEUR passe par `hexColor`, donc un jeton `{{…}}` y est légal :
 * tokens.ts le scanne et values.ts le résout, pour la forme comme pour le texte.
 */
const layerShadow = z.object({
  x: z.number(), y: z.number(), blur: z.number().nonnegative(), color: hexColor,
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
  shadow: layerShadow.optional(),
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
//
// U3 Tâche 3 — la liste passe d'une forme à HUIT. L'ordre est celui de la galerie d'insertion : les
// deux formes « pleines » (rect, ellipse), le trait, puis la famille polygonale. Chaque entrée
// ajoutée ici doit, sous peine de test rouge (jamais de revue) :
//   — porter une description dans lib/studio/shapes.ts (Record<ShapeKind, …> : sinon `tsc` refuse,
//     et tests/studio-shapes.test.ts refuse aussi à l'exécution) ;
//   — porter une tuile dans lib/studio/shape-gallery.ts (garde de complétude, U1 Tâche 4) ;
//   — porter une preuve EN PIXELS dans tests/studio-shape-render.test.ts (table Record<ShapeKind, …>).
// Aucune scène déjà écrite ne change : ce n'est qu'un élargissement du z.enum.
export const SHAPE_KINDS = ["rect", "ellipse", "line", "triangle", "star", "hexagon", "arrow", "bubble"] as const;

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

/**
 * LE prédicat du rayon — celui que le schéma applique, exporté pour que l'interface le DEMANDE au
 * lieu d'en écrire une seconde version (U3 Tâche 3). Une deuxième grammaire du rayon dans un
 * composant pourrait se desserrer sans que le schéma suive : le panneau écrirait alors une scène que
 * sa propre relecture refuserait. tests/studio-scene.test.ts vérifie l'équivalence DANS LES DEUX
 * SENS avec parseScene.
 */
export function isCssRadius(value: unknown): boolean {
  return typeof value === "number"
    ? Number.isFinite(value) && value >= 0
    : typeof value === "string" && RADIUS_LENGTH_RE.test(value);
}

const cssRadius = z.custom<number | string>(
  (v) => isCssRadius(v),
  { message: "Rayon invalide (attendu un nombre de pixels ≥ 0, ou 1 à 4 longueurs en « px » ou « % » séparées par une espace, ex. « 50% »)" },
);

// Chiffres NUS (« 12 », « 12.5 ») : la forme HISTORIQUE du rayon, un nombre de pixels. Le schéma
// refuse la CHAÎNE « 12 » (RADIUS_LENGTH_RE exige une unité) — c'est donc en nombre qu'une telle
// saisie doit être stockée, et non telle quelle.
const BARE_NUMBER_RE = /^\d+(?:\.\d+)?$/;

/**
 * Le texte qu'un champ de rayon AFFICHE pour la valeur stockée (U3 Tâche 3, dette 1 du piège de la
 * Tâche 2). La valeur est montrée TELLE QU'ELLE EST : l'ancien champ numérique affichait « 0 » pour
 * un rayon « 50% », et l'écrasait au premier commit.
 */
export function formatRadius(radius: number | string | undefined): string {
  return radius === undefined ? "" : String(radius);
}

/**
 * Le rayon à STOCKER pour un texte saisi — ou `null` quand ce texte n'est pas un rayon, auquel cas
 * l'appelant ne doit RIEN écrire (le champ revient à la valeur stockée). Un repli silencieux sur 0
 * détruirait un « 50% » à la première frappe malheureuse : c'est exactement le défaut corrigé ici.
 *
 *   ""  /  "   "  /  "0"      -> `undefined` : aucun rayon (les deux chemins de rendu n'émettent
 *                                rien pour 0 comme pour l'absence — voir lib/studio/shapes.ts)
 *   "12" / "12.5"             -> 12 / 12.5, en PIXELS (forme historique)
 *   "50%" / "8px 24px"        -> la chaîne, intacte
 *   tout le reste             -> `null`, refusé
 */
export function parseRadiusInput(text: string): number | string | undefined | null {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  if (BARE_NUMBER_RE.test(trimmed)) {
    const n = Number(trimmed);
    if (!isCssRadius(n)) return null;
    // `0` et l'absence de rayon sont la MÊME chose pour les deux chemins de rendu (« un rayon de 0
    // n'arrondit rien, donc il n'émet rien », shapes.ts) — on stocke donc la forme canonique.
    return n === 0 ? undefined : n;
  }
  return isCssRadius(trimmed) ? trimmed : null;
}

const shapeLayer = z.object({
  ...layerBase,
  type: z.literal("shape"),
  shape: z.enum(SHAPE_KINDS),
  fill: z.union([hexColor, gradient]),
  radius: cssRadius.optional(),
  // L'OMBRE PORTÉE d'une forme (U3 Tâche 4). MIGRATION : champ NOUVEAU et OPTIONNEL, donc toute scène
  // déjà écrite se relit à l'identique — et une scène sans ombre ne se met pas à porter la clé (zod
  // n'invente pas `shadow: undefined`, épinglé dans tests/studio-scene.test.ts, ce qui compte pour
  // l'autosave qui compare des JSON).
  //
  // Elle n'est PAS peinte sur les formes découpées : mesuré en pixels avant d'écrire ce champ (satori
  // n'en peint aucune, le navigateur non plus — tests/studio-render-clippath.test.ts « RÉSERVE 4 »).
  // La décision vit dans lib/studio/shapes.ts#layerBoxShadow, que les DEUX chemins de rendu
  // interrogent ; la valeur stockée, elle, survit intacte à un aller-retour par une forme découpée.
  shadow: layerShadow.optional(),
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

// U4 Tâche 1 (spike) — LE marcheur candidat pour la Tâche 2. Il descend un nœud de schéma EN
// PARALLÈLE de sa valeur (il faut la valeur pour résoudre une union — quel membre a matché — et une
// array — combien d'arrêts — et une option — présente ou absente) et rend le CHEMIN de chaque nœud
// que `COLOR_REGISTRY` reconnaît. Les enveloppes traversées : `optional`/`nullable` (def.innerType),
// `object` (def.shape), `array` (def.element), `union`/`discriminatedUnion` (def.options, membre
// choisi par safeParse). `z.string` refine-é est une FEUILLE : le registre l'y arrête. On lit
// `._zod.def`, la surface d'introspection du cœur Zod v4 (typée `any` : c'est de l'interne Zod).
function collectColorPaths(node: unknown, value: unknown, path: (string | number)[], out: (string | number)[][]): void {
  const def = (node as { _zod?: { def?: Record<string, unknown> } })?._zod?.def;
  if (!def) return;
  if (COLOR_REGISTRY.has(node as z.core.$ZodType)) { out.push(path); return; }
  switch (def.type) {
    case "optional":
    case "nullable":
      if (value === undefined || value === null) return;
      collectColorPaths(def.innerType, value, path, out);
      return;
    case "object":
      for (const [key, child] of Object.entries(def.shape as Record<string, unknown>)) {
        collectColorPaths(child, (value as Record<string, unknown>)?.[key], [...path, key], out);
      }
      return;
    case "array":
      if (Array.isArray(value)) {
        value.forEach((item, i) => collectColorPaths(def.element, item, [...path, i], out));
      }
      return;
    case "union": // couvre z.union ET z.discriminatedUnion (même def.type en Zod v4)
      for (const opt of def.options as z.core.$ZodType[]) {
        if ((opt as unknown as { safeParse(v: unknown): { success: boolean } }).safeParse(value).success) {
          collectColorPaths(opt, value, path, out);
          return;
        }
      }
      return;
    default:
      return;
  }
}

/** Les chemins des champs couleur d'UN calque (ex. `["color","shadow.color","stroke.color"]`),
 *  énumérés depuis le SCHÉMA — pas d'une liste écrite à la main. Produit de la Tâche 1 pour la 2. */
export function colorFieldPaths(layerValue: Layer): string[] {
  const out: (string | number)[][] = [];
  collectColorPaths(layer, layerValue, [], out);
  return out.map((p) => p.join("."));
}

/** Idem au niveau scène — prouve que `canvas.background` s'énumère aussi (même marcheur). */
export function sceneColorFieldPaths(scene: Scene): string[] {
  const out: (string | number)[][] = [];
  collectColorPaths(sceneSchema, scene, [], out);
  return out.map((p) => p.join("."));
}

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
