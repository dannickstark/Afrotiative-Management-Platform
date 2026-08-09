import { eq, and, isNull } from "drizzle-orm";
import { db, renderTemplates, renderTemplateVersions } from "./index";
import { parseScene } from "@/lib/studio/scene";
import { validateScene, type TemplateContext } from "@/lib/studio/tokens";
import { FORMAT_PRESETS, type FormatKey } from "@/lib/studio/formats";

const layer = { visible: true, locked: false };

// L'exemple de référence du programme : photo de fond floutée, voile sombre, bordure à la couleur
// de la catégorie, titre. UN gabarit pour toutes les catégories — la couleur vient de la taxonomie.
export const ARTICLE_IMAGE_TEMPLATE = {
  schemaVersion: 1 as const,
  canvas: { width: 1200, height: 675, background: "#0B0B0B" },
  layers: [
    { ...layer, id: "bg", name: "Photo de fond", frame: { x: 0, y: 0, w: 1200, h: 675 },
      type: "image" as const, source: { kind: "slot" as const, slot: "article.image" },
      fit: "cover" as const, blur: 18, overlay: "#000000A6" },
    { ...layer, id: "frame", name: "Bordure catégorie", frame: { x: 0, y: 0, w: 1200, h: 675 },
      type: "shape" as const, shape: "rect" as const, fill: "transparent",
      border: { width: 12, color: "{{category.color}}" } },
    { ...layer, id: "kicker", name: "Catégorie", frame: { x: 72, y: 72, w: 600, h: 44 },
      type: "text" as const, content: "{{category.name}}",
      font: { family: "Noto Sans", size: 28, weight: 700 },
      color: "{{category.color}}", align: "left" as const, vAlign: "top" as const, lineHeight: 1.2 },
    { ...layer, id: "title", name: "Titre", frame: { x: 72, y: 360, w: 1056, h: 240 },
      type: "text" as const, content: "{{article.title}}",
      font: { family: "Noto Sans", size: 64, weight: 700 },
      color: "#FFFFFF", align: "left" as const, vAlign: "bottom" as const,
      lineHeight: 1.1, maxLines: 3, autoFit: true },
  ],
};

export const FB_TEMPLATE = {
  ...ARTICLE_IMAGE_TEMPLATE,
  canvas: { width: 1200, height: 630, background: "#0B0B0B" },
  layers: ARTICLE_IMAGE_TEMPLATE.layers.map((l) =>
    l.id === "title" ? { ...l, frame: { x: 72, y: 320, w: 1056, h: 236 } }
      : l.id === "bg" || l.id === "frame" ? { ...l, frame: { x: 0, y: 0, w: 1200, h: 630 } }
      : l),
};

export const IG_TEMPLATE = {
  ...ARTICLE_IMAGE_TEMPLATE,
  canvas: { width: 1080, height: 1080, background: "#0B0B0B" },
  layers: ARTICLE_IMAGE_TEMPLATE.layers.map((l) => {
    // Narrowing sur l.type === "text" (plutôt qu'un cast) : c'est le discriminant réel du type
    // Layer, et c'est lui qui donne accès à `l.font` en toute sécurité.
    if (l.id === "title" && l.type === "text") {
      return { ...l, frame: { x: 72, y: 640, w: 936, h: 340 }, font: { ...l.font, size: 72 } };
    }
    if (l.id === "bg" || l.id === "frame") {
      return { ...l, frame: { x: 0, y: 0, w: 1080, h: 1080 } };
    }
    return l;
  }),
};

type Starter = {
  name: string; context: TemplateContext; channel: string | null; format: FormatKey; scene: unknown;
};

const STARTERS: Starter[] = [
  { name: "Image à la une — défaut", context: "article_image", channel: null, format: "website_featured", scene: ARTICLE_IMAGE_TEMPLATE },
  { name: "Facebook — défaut", context: "social_post", channel: "facebook", format: "fb_link", scene: FB_TEMPLATE },
  { name: "Instagram — défaut", context: "social_post", channel: "instagram", format: "ig_square", scene: IG_TEMPLATE },
];

// IDEMPOTENT et NON destructif — contrairement à db/seed.ts. Sûr à exécuter en production : un
// gabarit déjà présent sur la même portée est laissé intact, jamais écrasé.
//
// Le SELECT ci-dessous doit respecter l'index unique de portée render_templates_scope
// (context, channel, category_id) NULLS NOT DISTINCT parmi les lignes non archivées : ces trois
// gabarits n'ont jamais de catégorie (categoryId toujours NULL), donc c'est bien
// `isNull(renderTemplates.categoryId)` — et non une comparaison d'égalité — qui reproduit
// fidèlement le comportement de l'index, où plusieurs NULL de category_id sur la même
// (context, channel) sont traités comme UN SEUL groupe, pas comme des lignes distinctes.
// Exécuter cette fonction deux fois de suite doit donc trouver la ligne créée au premier passage
// et ne rien réinsérer.
export async function seedStudioTemplates(): Promise<{ created: number; skipped: number }> {
  let created = 0, skipped = 0;

  for (const starter of STARTERS) {
    const scene = parseScene(starter.scene);
    const errors = validateScene(scene, starter.context);
    if (errors.length) throw new Error(`Gabarit « ${starter.name} » invalide : ${errors.join(" ")}`);

    const [existing] = await db.select().from(renderTemplates).where(and(
      eq(renderTemplates.context, starter.context),
      starter.channel === null ? isNull(renderTemplates.channel) : eq(renderTemplates.channel, starter.channel),
      isNull(renderTemplates.categoryId),
    )).limit(1);
    if (existing) { skipped++; continue; }

    const preset = FORMAT_PRESETS[starter.format];
    const [t] = await db.insert(renderTemplates).values({
      name: starter.name, context: starter.context, channel: starter.channel, categoryId: null,
      format: starter.format, width: preset.width, height: preset.height, scene,
    }).returning();
    await db.insert(renderTemplateVersions).values({ templateId: t.id, version: 1, scene });
    await db.update(renderTemplates).set({ publishedVersion: 1 }).where(eq(renderTemplates.id, t.id));
    created++;
  }

  return { created, skipped };
}

if (import.meta.main) {
  seedStudioTemplates()
    .then((r) => { console.log(`Gabarits — créés : ${r.created}, déjà présents : ${r.skipped}`); process.exit(0); })
    .catch((e) => { console.error(e); process.exit(1); });
}
