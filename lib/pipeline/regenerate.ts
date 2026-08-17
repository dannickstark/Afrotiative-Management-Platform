import type { ArticleDraft } from "@/lib/ai/schema";
import type { RegenerateFieldsInput } from "@/lib/validation";
import { db, articles, articleTags, articleEmbeddings, articleRevisions, clusters } from "@/db";
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
  // INVARIANT « ne jamais détruire une image » : une régénération dont le brouillon n'a retenu
  // AUCUNE image (liste de candidats vide, ou choix du modèle rejeté par sanitizeDraft) ne doit pas
  // écrire null par-dessus l'image existante — c'était le bug d'une régénération « image seule »,
  // qui coûtait une génération complète pour ne faire qu'effacer l'image. Sans clé émise ici, le
  // `set({ ...sel.columns })` de l'appelant laisse simplement les trois colonnes intactes.
  if (fields.image && draft.featuredImageUrl) {
    columns.featuredImageUrl = draft.featuredImageUrl;
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
  prior: { title: string; bodyHtml: string; featuredImageUrl: string | null; confidenceFlags: typeof articles.$inferSelect.confidenceFlags };
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

  // On a PARTIAL regen the non-regenerated fields keep their PRIOR values, so the fresh draft's
  // confidence flags (computed against the whole freshly-generated draft) don't describe the
  // article as it will actually be persisted — e.g. a body-only regen of an article that HAS an
  // image re-extracts with no image and sets imageMissing:true, even though the prior image is
  // kept untouched. Merge per-field: start from the prior flags, and override a flag ONLY when
  // its corresponding field was actually regenerated. aiDegraded is left as the prior value —
  // it isn't tied to any single checked field — except when THIS regen's own embedding call
  // degrades to mock (see below), which OR-in's it fresh regardless of prior value.
  let mergedConfidence = {
    ...prior.confidenceFlags,
    ...(fields.category ? { categoryUncertain: draft.confidence.categoryUncertain } : {}),
    ...(fields.image ? { imageMissing: draft.confidence.imageMissing } : {}),
    ...(fields.body ? { clusterUncertain: draft.confidence.clusterUncertain } : {}),
  };

  // Re-derive embedding/cluster/score ONLY when the body changed (see plan constraint). The
  // effective new title (regenerated iff title is checked, else the prior one) is what we embed
  // with AND what labels a freshly-created cluster below. decideCluster is a read-only similarity
  // query so it runs here, outside the tx; but a no-match must CREATE a cluster row, which has to
  // happen inside the tx — so keep the raw decision and resolve it to a concrete id in the tx.
  const embedTitle = fields.title ? draft.title : prior.title;
  let vector: number[] | null = null;
  let cluster: Awaited<ReturnType<typeof decideCluster>> | null = null;
  let score: number | undefined;
  if (sel.bodyChanged && sanitizedBody !== null) {
    const { vector: embedVector, via: embedVia } = await embed(`${embedTitle}\n${sanitizedBody}`);
    vector = embedVector;
    // excludeArticleId: this article's OWN prior embedding row is still in the table at this point
    // (it's only overwritten inside the tx below), so without excluding it decideCluster would
    // trivially self-match (score ~1) and either re-attach to its own stale cluster or otherwise
    // skew the decision off a row that's about to be replaced.
    cluster = await decideCluster(vector, articleId);
    // Mirrors stages.ts's ingest-time degraded-run flagging: a provider outage forces embed() onto
    // its mock fallback, which makes the similarity/cluster decision meaningless — flag it so human
    // reviewers see this regen wasn't produced under normal conditions, same as a fresh ingest would.
    if (embedVia === "mock") mergedConfidence = { ...mergedConfidence, clusterUncertain: true, aiDegraded: true };
    score = computeArticleScore({
      sourceCount,
      bestScore: cluster.bestScore,
      bodyHtml: sel.bodyHtml!, // pre-sanitize body per computeArticleScore's contract — non-null: bodyChanged implies bodyHtml was set (selectRegenerationColumns)
      hasImage: fields.image ? !!draft.featuredImageUrl : !!prior.featuredImageUrl,
      confidence: mergedConfidence,
    });
  }

  const fieldList = (Object.keys(fields) as (keyof RegenerateFieldsInput)[]).filter((k) => fields[k]).map((k) => FIELD_LABELS[k]).join(", ");

  await db.transaction(async (tx) => {
    // ONE revision = snapshot (prior title+body) + traceability (fields). Insert BEFORE the update.
    await tx.insert(articleRevisions).values({
      articleId, actorId, action: revisionAction,
      detail: `Champs : ${fieldList}.\n— Titre précédent : ${prior.title}\n— Corps précédent :\n${prior.bodyHtml}`,
    });

    // Resolve the cluster to a REAL id when the body changed: attach to decideCluster's nearest
    // match, or — mirroring persistArticle (stages.ts) — create a fresh cluster row when it found
    // no match, so a regenerated body never keeps a STALE prior clusterId while its embedding/score
    // reflect the new content.
    let clusterId: string | undefined;
    if (cluster !== null) {
      clusterId = cluster.clusterId
        ?? (await tx.insert(clusters).values({ label: embedTitle.slice(0, 80) }).returning({ id: clusters.id }))[0].id;
    }

    await tx.update(articles).set({
      ...sel.columns,
      ...(sanitizedBody !== null ? { bodyHtml: sanitizedBody } : {}),
      ...(categoryId != null ? { categoryId } : {}), // != null: a checked-but-unresolved category leaves the prior one, never clears it
      ...(clusterId !== undefined ? { clusterId } : {}),
      ...(score !== undefined ? { score } : {}),
      status: "pending", confidenceFlags: mergedConfidence, aiAuthor: true, updatedAt: new Date(),
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
