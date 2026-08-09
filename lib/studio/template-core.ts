// lib/studio/template-core.ts — le SEUL chemin d'écriture vers render_templates /
// render_template_versions (avec le semeur db/studio-templates.ts, qui suit la même discipline).
//
// Ce module N'A PAS de directive "use server" et n'est donc PAS appelable directement depuis le
// client : c'est délibéré. Tout export d'un module "use server" est une Server Action appelable
// SANS authentification propre (voir le commentaire en tête de lib/actions/taxonomy-actions.ts) —
// exporter les écritures brutes ci-dessous depuis lib/actions/studio-actions.ts en ferait un chemin
// d'écriture non gardé. lib/actions/studio-actions.ts est donc la SEULE porte : chaque fonction
// *Core d'ici n'est appelée qu'après requireUser() + requirePermission().
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db, renderTemplates, renderTemplateVersions } from "@/db";
import { parseScene, SceneError, type Scene } from "./scene";
import { validateScene, TEMPLATE_CONTEXTS, type TemplateContext } from "./tokens";
import { FORMAT_PRESETS, FORMAT_KEYS } from "./formats";

export type ActionResult<T extends object = object> =
  ({ ok: true } & T) | { ok: false; message: string };

// ─────────────────────────────────────────────────────────────────────────────
// Portée : render_templates_scope est un index UNIQUE PARTIEL sur
// (context, channel, category_id) WHERE archived = false, NULLS NOT DISTINCT
// (db/migrations/0015_slow_selene.sql — voir aussi lib/studio/resolve.ts et
// db/studio-templates.ts, qui reproduisent la même requête). NULL est le cas COURANT (portée par
// défaut), pas un cas particulier : isNull(...) plutôt qu'une égalité est donc systématique
// ci-dessous, comme partout ailleurs dans lib/studio/.
async function findScopeConflict(
  context: string,
  channel: string | null,
  categoryId: string | null,
): Promise<{ id: string; name: string } | null> {
  const [row] = await db
    .select({ id: renderTemplates.id, name: renderTemplates.name })
    .from(renderTemplates)
    .where(and(
      eq(renderTemplates.context, context),
      channel === null ? isNull(renderTemplates.channel) : eq(renderTemplates.channel, channel),
      categoryId === null ? isNull(renderTemplates.categoryId) : eq(renderTemplates.categoryId, categoryId),
      eq(renderTemplates.archived, false),
    ))
    .limit(1);
  return row ?? null;
}

// Canevas + UN calque texte, sans jeton : une scène qui ne référence aucun {{jeton}} passe
// validateScene() pour N'IMPORTE QUEL contexte (extractTokens ne trouve rien à vérifier) — c'est
// ce qui rend ce germe valide quel que soit le contexte choisi à la création, sans avoir à
// dupliquer cette fonction par contexte.
function seedScene(width: number, height: number): Scene {
  return parseScene({
    schemaVersion: 1,
    canvas: { width, height, background: "#0B0B0B" },
    layers: [{
      id: "title", name: "Titre", visible: true, locked: false,
      frame: { x: 40, y: 40, w: Math.max(width - 80, 1), h: Math.min(height - 80, 160) },
      type: "text", content: "Nouveau gabarit",
      font: { family: "Noto Sans", size: 48, weight: 700 },
      color: "#FFFFFF", align: "left", vAlign: "top", lineHeight: 1.2,
    }],
  });
}

// ─────────────────────────────────────────────────────────────────────────────
export const createTemplateSchema = z.object({
  name: z.string().trim().min(1, "Le nom du gabarit est requis."),
  context: z.enum(TEMPLATE_CONTEXTS),
  // Texte libre, PAS l'enum Channel : render_templates.channel est une colonne text() sans
  // contrainte (db/schema.ts), et resolveTemplate()/db/studio-templates.ts typent déjà `channel`
  // en string | null pour la même raison — seul renderForArticle (un CALLSITE précis, où un
  // littéral figé dans le code risquait une faute de frappe silencieuse) resserre le type en
  // Channel. Ici la contrainte réelle est portée par l'UI (un <select> alimenté par CHANNELS,
  // Tâche 9) ; imposer l'enum Zod ici casserait par ailleurs le canal synthétique
  // "test-*" que tests/studio-fixtures.ts prescrit pour isoler les portées de test.
  channel: z.string().trim().min(1, "Canal invalide.").nullable(),
  categoryId: z.string().uuid("Catégorie invalide.").nullable(),
  format: z.enum(FORMAT_KEYS),
});
export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;

export async function createTemplateCore(
  input: CreateTemplateInput,
  userId: string,
): Promise<ActionResult<{ id: string }>> {
  const conflict = await findScopeConflict(input.context, input.channel, input.categoryId);
  if (conflict) {
    return {
      ok: false,
      message: `Un gabarit occupe déjà cette portée : « ${conflict.name} ». Archivez-le ou choisissez une autre portée.`,
    };
  }

  const preset = FORMAT_PRESETS[input.format];
  const scene = seedScene(preset.width, preset.height);

  const [row] = await db.insert(renderTemplates).values({
    name: input.name, context: input.context, channel: input.channel, categoryId: input.categoryId,
    format: input.format, width: preset.width, height: preset.height, scene, createdBy: userId,
  }).returning({ id: renderTemplates.id });

  return { ok: true, id: row.id };
}

// ─────────────────────────────────────────────────────────────────────────────
export async function renameTemplateCore(id: string, name: string): Promise<ActionResult> {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, message: "Le nom du gabarit est requis." };

  const [existing] = await db.select({ id: renderTemplates.id }).from(renderTemplates)
    .where(eq(renderTemplates.id, id)).limit(1);
  if (!existing) return { ok: false, message: "Gabarit introuvable." };

  await db.update(renderTemplates).set({ name: trimmed, updatedAt: new Date() })
    .where(eq(renderTemplates.id, id));
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Dupliquer réutilise la portée EXACTE de la source par défaut. Or cette portée est, par
// construction, déjà occupée dès que la source elle-même n'est pas archivée (elle EST la ligne non
// archivée à cette portée) — findScopeConflict() la trouvera donc elle-même dans ce cas, sans
// traitement spécial : pas besoin de distinguer "conflit avec la source" de "conflit avec un autre
// gabarit", le même repli s'applique. Si la source est archivée, sa portée est déjà libre (l'index
// unique ignore les lignes archivées) et la copie s'y installe directement, non archivée.
export async function duplicateTemplateCore(
  id: string,
  userId: string,
): Promise<{ ok: true; id: string; message?: string } | { ok: false; message: string }> {
  const [source] = await db.select().from(renderTemplates).where(eq(renderTemplates.id, id)).limit(1);
  if (!source) return { ok: false, message: "Gabarit introuvable." };

  let channel = source.channel;
  let categoryId = source.categoryId;
  let message: string | undefined;

  const conflict = await findScopeConflict(source.context, channel, categoryId);
  if (conflict) {
    channel = null;
    categoryId = null;
    const fallbackConflict = await findScopeConflict(source.context, channel, categoryId);
    if (fallbackConflict) {
      return {
        ok: false,
        message:
          `Impossible de dupliquer « ${source.name} » : sa portée est occupée par « ${conflict.name} » ` +
          `et la portée par défaut du contexte l'est aussi, par « ${fallbackConflict.name} ». ` +
          `Archivez l'un des deux gabarits avant de réessayer.`,
      };
    }
    message =
      `« ${conflict.name} » occupe déjà la portée de « ${source.name} » : la copie a été créée ` +
      `sans canal ni catégorie (portée par défaut du contexte).`;
  }

  const [copy] = await db.insert(renderTemplates).values({
    name: `${source.name} (copie)`, context: source.context, channel, categoryId,
    format: source.format, width: source.width, height: source.height,
    scene: source.scene, publishedVersion: null, archived: false, createdBy: userId,
  }).returning({ id: renderTemplates.id });

  return message ? { ok: true, id: copy.id, message } : { ok: true, id: copy.id };
}

// ─────────────────────────────────────────────────────────────────────────────
export async function archiveTemplateCore(id: string, archived: boolean): Promise<ActionResult> {
  const [existing] = await db.select().from(renderTemplates).where(eq(renderTemplates.id, id)).limit(1);
  if (!existing) return { ok: false, message: "Gabarit introuvable." };

  if (!archived) {
    // Désarchiver REPREND une portée : entre l'archivage et ce moment, un autre gabarit a pu
    // légitimement s'installer là (V1 note : "archiving frees a scope"). Sans ce contrôle,
    // l'UPDATE plus bas échouerait sur une violation brute de contrainte unique (SQLSTATE 23505)
    // au lieu d'un message français — même raisonnement que createTemplateCore.
    const conflict = await findScopeConflict(existing.context, existing.channel, existing.categoryId);
    if (conflict) {
      return {
        ok: false,
        message: `Impossible de désarchiver « ${existing.name} » : sa portée est désormais occupée par « ${conflict.name} ».`,
      };
    }
  }

  await db.update(renderTemplates).set({ archived, updatedAt: new Date() })
    .where(eq(renderTemplates.id, id));
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
function parseSceneSafely(input: unknown): { ok: true; scene: Scene } | { ok: false; message: string } {
  try {
    return { ok: true, scene: parseScene(input) };
  } catch (e) {
    return { ok: false, message: e instanceof SceneError ? e.message : "Scène invalide." };
  }
}

// Point d'entrée de l'autosauvegarde : DOUBLE validation, forme (parseScene) puis jetons
// (validateScene) — une scène structurellement valide mais qui référence un jeton hors contexte
// (par ex. article.url dans un gabarit article_image, V1 §Contraintes) est refusée ici aussi, pas
// seulement à la publication, pour que l'éditeur voie l'erreur au fil de l'eau.
export async function saveTemplateSceneCore(id: string, sceneInput: unknown): Promise<ActionResult> {
  const [existing] = await db.select({ context: renderTemplates.context }).from(renderTemplates)
    .where(eq(renderTemplates.id, id)).limit(1);
  if (!existing) return { ok: false, message: "Gabarit introuvable." };

  const parsed = parseSceneSafely(sceneInput);
  if (!parsed.ok) return parsed;

  const errors = validateScene(parsed.scene, existing.context as TemplateContext);
  if (errors.length) return { ok: false, message: errors.join(" ") };

  await db.update(renderTemplates).set({ scene: parsed.scene, updatedAt: new Date() })
    .where(eq(renderTemplates.id, id));
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Transactionnel : la leçon du semeur (db/studio-templates.ts) s'applique à l'identique — sans une
// seule transaction, un processus interrompu entre l'insertion de l'instantané et la pose de
// publishedVersion laisserait une version orpheline (jamais désignée comme publiée) ou, pire,
// publishedVersion pointant vers une version qui n'a en réalité jamais été insérée.
export async function publishTemplateCore(
  id: string,
  userId: string,
): Promise<ActionResult<{ version: number }>> {
  const [existing] = await db.select().from(renderTemplates).where(eq(renderTemplates.id, id)).limit(1);
  if (!existing) return { ok: false, message: "Gabarit introuvable." };

  const parsed = parseSceneSafely(existing.scene);
  if (!parsed.ok) return parsed;

  const errors = validateScene(parsed.scene, existing.context as TemplateContext);
  if (errors.length) return { ok: false, message: errors.join(" ") };

  const version = await db.transaction(async (tx) => {
    const [latest] = await tx.select({ version: renderTemplateVersions.version })
      .from(renderTemplateVersions)
      .where(eq(renderTemplateVersions.templateId, id))
      .orderBy(desc(renderTemplateVersions.version))
      .limit(1);
    const nextVersion = (latest?.version ?? 0) + 1;

    await tx.insert(renderTemplateVersions).values({
      templateId: id, version: nextVersion, scene: parsed.scene, publishedBy: userId,
    });
    await tx.update(renderTemplates).set({ publishedVersion: nextVersion, updatedAt: new Date() })
      .where(eq(renderTemplates.id, id));

    return nextVersion;
  });

  return { ok: true, version };
}

// ─────────────────────────────────────────────────────────────────────────────
// Copie l'instantané dans le BROUILLON uniquement. publishedVersion n'est délibérément PAS touché
// ici (spec §3 : « Republier reste un geste explicite ») — un appelant qui voudrait aussi publier
// doit enchaîner avec publishTemplate() séparément.
export async function restoreVersionCore(id: string, version: number): Promise<ActionResult> {
  const [existing] = await db.select({ id: renderTemplates.id }).from(renderTemplates)
    .where(eq(renderTemplates.id, id)).limit(1);
  if (!existing) return { ok: false, message: "Gabarit introuvable." };

  const [snapshot] = await db.select({ scene: renderTemplateVersions.scene })
    .from(renderTemplateVersions)
    .where(and(eq(renderTemplateVersions.templateId, id), eq(renderTemplateVersions.version, version)))
    .limit(1);
  if (!snapshot) return { ok: false, message: `Version ${version} introuvable pour ce gabarit.` };

  await db.update(renderTemplates).set({ scene: snapshot.scene, updatedAt: new Date() })
    .where(eq(renderTemplates.id, id));
  return { ok: true };
}
