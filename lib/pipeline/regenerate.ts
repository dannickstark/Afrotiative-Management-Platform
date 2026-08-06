import type { ArticleDraft } from "@/lib/ai/schema";
import type { RegenerateFieldsInput } from "@/lib/validation";
import { db, articles, articleTags, articleEmbeddings, articleRevisions } from "@/db";
import { eq } from "drizzle-orm";
import { sanitizeArticleHtml } from "@/lib/sanitize";
import { embed } from "@/lib/embeddings";
import { decideCluster } from "@/lib/pipeline/cluster";
import { computeArticleScore } from "@/lib/pipeline/score";
import { resolveCategoryId, insertTags } from "@/lib/pipeline/stages";

// Pure: given a freshly generated draft + the checked fields, return the exact article-column patch
// (only the checked SCALAR columns), the raw body to sanitize+write (or null), the category NAME to
// resolve (or null), and the tags to replace (or null). No DB/DOM — the caller sanitizes the body and
// resolves the category id. Keeping this pure makes the "only checked fields change" contract
// directly unit-testable.
export function selectRegenerationColumns(draft: ArticleDraft, fields: RegenerateFieldsInput): {
  columns: Partial<{ title: string; excerpt: string; featuredImageUrl: string | null; imageCredit: string | null; imageSourceUrl: string | null }>;
  bodyHtml: string | null;
  categoryName: string | null;
  tags: string[] | null;
  bodyChanged: boolean;
} {
  const columns: Record<string, unknown> = {};
  if (fields.title) columns.title = draft.title;
  if (fields.excerpt) columns.excerpt = draft.excerpt;
  if (fields.image) {
    columns.featuredImageUrl = draft.featuredImageUrl ?? null;
    columns.imageCredit = draft.imageCredit ?? null;
    columns.imageSourceUrl = draft.imageSourceUrl ?? null;
  }
  return {
    columns,
    bodyHtml: fields.body ? draft.bodyHtml : null,
    categoryName: fields.category ? draft.category : null,
    tags: fields.tags ? draft.tags : null,
    bodyChanged: fields.body,
  };
}

const FIELD_LABELS: Record<keyof RegenerateFieldsInput, string> = {
  title: "titre", body: "corps", excerpt: "extrait", category: "catégorie", tags: "tags", image: "image",
};

// DB core: applies a subset of a freshly generated draft to an existing article. Selective UPDATE
// (only the checked columns), one article_revisions row snapshotting the prior title+body for
// traceability/rollback, and — only when the body itself changed — a fresh embedding + cluster
// decision + quality score (re-embedding on unrelated field changes, e.g. title-only, would be
// wasted work and could even reclassify the cluster off a body that didn't move). Runs the
// selective UPDATE + revision insert + tag replace + embedding upsert in one transaction so a
// partial write (e.g. tags replaced but article row unchanged) can never happen.
export async function applyRegeneration(input: {
  articleId: string;
  prior: { title: string; bodyHtml: string; featuredImageUrl: string | null };
  draft: ArticleDraft;
  fields: RegenerateFieldsInput;
  sourceCount: number;
  categoryNames: string[];
  actorId: string | null;
  revisionAction?: string; // "régénéré par IA" (default) | "amélioré par IA" (improveWithAi)
}): Promise<void> {
  const { articleId, prior, draft, fields, sourceCount, categoryNames, actorId, revisionAction = "régénéré par IA" } = input;
  const sel = selectRegenerationColumns(draft, fields);

  // Category (read-only lookup) + body sanitize happen outside the tx.
  const categoryId = sel.categoryName !== null ? await resolveCategoryId(sel.categoryName, categoryNames) : undefined;
  const sanitizedBody = sel.bodyHtml !== null ? sanitizeArticleHtml(sel.bodyHtml) : null;

  // Re-derive embedding/cluster/score ONLY when the body changed (see plan constraint).
  let vector: number[] | null = null, clusterId: string | undefined, score: number | undefined;
  if (sel.bodyChanged && sanitizedBody !== null) {
    const embedTitle = fields.title ? draft.title : prior.title;
    vector = (await embed(`${embedTitle}\n${sanitizedBody}`)).vector;
    const cluster = await decideCluster(vector);
    clusterId = cluster.clusterId ?? undefined;
    score = computeArticleScore({
      sourceCount,
      bestScore: cluster.bestScore,
      bodyHtml: sel.bodyHtml!, // pre-sanitize body per computeArticleScore's contract — non-null: bodyChanged implies bodyHtml was set (selectRegenerationColumns)
      hasImage: fields.image ? !!draft.featuredImageUrl : !!prior.featuredImageUrl,
      confidence: draft.confidence,
    });
  }

  const fieldList = (Object.keys(fields) as (keyof RegenerateFieldsInput)[]).filter((k) => fields[k]).map((k) => FIELD_LABELS[k]).join(", ");

  await db.transaction(async (tx) => {
    // ONE revision = snapshot (prior title+body) + traceability (fields). Insert BEFORE the update.
    await tx.insert(articleRevisions).values({
      articleId, actorId, action: revisionAction,
      detail: `Champs : ${fieldList}.\n— Titre précédent : ${prior.title}\n— Corps précédent :\n${prior.bodyHtml}`,
    });

    await tx.update(articles).set({
      ...sel.columns,
      ...(sanitizedBody !== null ? { bodyHtml: sanitizedBody } : {}),
      ...(categoryId !== undefined ? { categoryId } : {}),
      ...(clusterId !== undefined ? { clusterId } : {}),
      ...(score !== undefined ? { score } : {}),
      status: "pending", confidenceFlags: draft.confidence, aiAuthor: true, updatedAt: new Date(),
    }).where(eq(articles.id, articleId));

    if (sel.tags !== null) {
      // insertTags ONLY inserts (confirmed in stages.ts) — clear the old rows first so tags are replaced.
      await tx.delete(articleTags).where(eq(articleTags.articleId, articleId));
      await insertTags(tx, articleId, sel.tags);
    }
    if (vector !== null) {
      await tx.insert(articleEmbeddings).values({ articleId, embedding: vector })
        .onConflictDoUpdate({ target: articleEmbeddings.articleId, set: { embedding: vector } });
    }
  });
}
