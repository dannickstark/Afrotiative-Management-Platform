import { and, eq, isNull, isNotNull } from "drizzle-orm";
import { db, renderTemplates, renderTemplateVersions } from "@/db";
import { parseScene, type Scene } from "./scene";
import type { TemplateContext } from "./tokens";

export type ResolvedTemplate = {
  templateId: string;
  version: number;
  scene: Scene;
  context: TemplateContext;
  width: number;
  height: number;
};

// Le résolveur ne lit JAMAIS render_templates.scene (le brouillon) — uniquement l'instantané de la
// version publiée. C'est ce qui empêche une modification en cours de fuiter dans un post en ligne.
async function findAt(
  context: TemplateContext,
  channel: string | null,
  categoryId: string | null,
): Promise<ResolvedTemplate | null> {
  const [row] = await db
    .select({
      templateId: renderTemplates.id,
      version: renderTemplates.publishedVersion,
      width: renderTemplates.width,
      height: renderTemplates.height,
      scene: renderTemplateVersions.scene,
    })
    .from(renderTemplates)
    .innerJoin(
      renderTemplateVersions,
      and(
        eq(renderTemplateVersions.templateId, renderTemplates.id),
        eq(renderTemplateVersions.version, renderTemplates.publishedVersion),
      ),
    )
    .where(and(
      eq(renderTemplates.context, context),
      channel === null ? isNull(renderTemplates.channel) : eq(renderTemplates.channel, channel),
      categoryId === null ? isNull(renderTemplates.categoryId) : eq(renderTemplates.categoryId, categoryId),
      eq(renderTemplates.archived, false),
      isNotNull(renderTemplates.publishedVersion),
    ))
    .limit(1);

  if (!row) return null;
  return {
    templateId: row.templateId,
    version: row.version!,
    scene: parseScene(row.scene),
    context,
    width: row.width,
    height: row.height,
  };
}

// Trois niveaux de repli. Un null final n'est PAS une erreur : l'appelant utilise l'image brute.
export async function resolveTemplate(q: {
  context: TemplateContext;
  channel?: string | null;
  categoryId?: string | null;
}): Promise<ResolvedTemplate | null> {
  const channel = q.channel ?? null;
  const categoryId = q.categoryId ?? null;

  if (channel && categoryId) {
    const exact = await findAt(q.context, channel, categoryId);
    if (exact) return exact;
  }
  if (channel) {
    const byChannel = await findAt(q.context, channel, null);
    if (byChannel) return byChannel;
  }
  if (!channel && categoryId) {
    const byCategory = await findAt(q.context, null, categoryId);
    if (byCategory) return byCategory;
  }
  return findAt(q.context, null, null);
}
