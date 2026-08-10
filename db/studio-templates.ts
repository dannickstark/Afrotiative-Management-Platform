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

// D7 (adaptateur LinkedIn) — même recette que FB_TEMPLATE : le canevas de base (1200×675) recadré
// au format "li_link" (1200×627, lib/studio/formats.ts), le bloc titre remonté d'autant pour garder
// la même marge basse proportionnelle.
export const LI_TEMPLATE = {
  ...ARTICLE_IMAGE_TEMPLATE,
  canvas: { width: 1200, height: 627, background: "#0B0B0B" },
  layers: ARTICLE_IMAGE_TEMPLATE.layers.map((l) =>
    l.id === "title" ? { ...l, frame: { x: 72, y: 317, w: 1056, h: 233 } }
      : l.id === "bg" || l.id === "frame" ? { ...l, frame: { x: 0, y: 0, w: 1200, h: 627 } }
      : l),
};

type Starter = {
  name: string; context: TemplateContext; channel: string | null; format: FormatKey; scene: unknown;
};

const STARTERS: Starter[] = [
  { name: "Image à la une — défaut", context: "article_image", channel: null, format: "website_featured", scene: ARTICLE_IMAGE_TEMPLATE },
  { name: "Facebook — défaut", context: "social_post", channel: "facebook", format: "fb_link", scene: FB_TEMPLATE },
  { name: "Instagram — défaut", context: "social_post", channel: "instagram", format: "ig_square", scene: IG_TEMPLATE },
  { name: "LinkedIn — défaut", context: "social_post", channel: "linkedin", format: "li_link", scene: LI_TEMPLATE },
];

// IDEMPOTENT et NON destructif — contrairement à db/seed.ts. Sûr à exécuter en production : un
// gabarit déjà présent sur la même portée est laissé intact, jamais écrasé.
//
// Le SELECT ci-dessous doit reproduire EXACTEMENT l'index unique de portée render_templates_scope :
// (context, channel, category_id) NULLS NOT DISTINCT, **WHERE archived = false**
// (db/migrations/0015_slow_selene.sql). Deux conditions, toutes les deux nécessaires :
//   - `isNull(renderTemplates.categoryId)` plutôt qu'une égalité : ces quatre gabarits n'ont jamais
//     de catégorie, et NULLS NOT DISTINCT traite plusieurs NULL de category_id sur la même
//     (context, channel) comme UN SEUL groupe, pas comme des lignes distinctes.
//   - `eq(renderTemplates.archived, false)` : SANS cette condition, une ligne ARCHIVÉE à cette
//     portée (par ex. un admin qui archive le gabarit de départ Facebook depuis V2) ferait
//     `existing` non vide alors que l'index unique l'ignore et laisserait une nouvelle insertion
//     passer — le script rapporterait alors « déjà présents » sans que resolveTemplate (qui EXCLUT
//     les lignes archivées) n'ait plus aucun gabarit à trouver à cette portée. Avec cette
//     condition, une portée archivée est traitée comme absente et réinstallée au prochain passage :
//     c'est ce qui rend la fonction réellement CONVERGENTE, pas seulement idempotente sur le cas
//     nominal.
// Délibérément PAS de `isNotNull(publishedVersion)` ici : si une ligne non archivée mais jamais
// publiée occupe déjà cette portée (par ex. un brouillon créé à la main depuis V2, avant toute
// publication), l'index unique l'empêchera de toute façon de coexister avec une nouvelle insertion
// — la traiter comme « absente » ferait échouer l'INSERT plus bas avec une violation de contrainte
// brute au lieu d'un skip propre. La traiter comme « présente » (skip) est le choix sûr : ce script
// ne doit jamais écraser un brouillon existant, publié ou non.
//
// Les trois écritures (insertion du gabarit, insertion de sa version publiée, pose de
// publishedVersion) sont regroupées dans UNE transaction : sans cela, un processus interrompu
// entre deux écritures laisserait une ligne à moitié créée (non archivée, publishedVersion NULL) —
// invisible à resolveTemplate MAIS occupant quand même la portée dans l'index unique, donc
// bloquant DÉFINITIVEMENT toute réinsertion future à cette portée. La transaction garantit que les
// trois écritures se produisent ensemble ou pas du tout.
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
      eq(renderTemplates.archived, false),
    )).limit(1);
    if (existing) { skipped++; continue; }

    const preset = FORMAT_PRESETS[starter.format];
    await db.transaction(async (tx) => {
      const [t] = await tx.insert(renderTemplates).values({
        name: starter.name, context: starter.context, channel: starter.channel, categoryId: null,
        format: starter.format, width: preset.width, height: preset.height, scene,
      }).returning();
      await tx.insert(renderTemplateVersions).values({ templateId: t.id, version: 1, scene });
      await tx.update(renderTemplates).set({ publishedVersion: 1 }).where(eq(renderTemplates.id, t.id));
    });
    created++;
  }

  return { created, skipped };
}

if (import.meta.main) {
  seedStudioTemplates()
    .then((r) => { console.log(`Gabarits — créés : ${r.created}, déjà présents : ${r.skipped}`); process.exit(0); })
    .catch((e) => { console.error(e); process.exit(1); });
}
