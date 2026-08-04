import {
  db, articles, articleSources, articleTags, articleEmbeddings, clusters, wpCategories, wpTags,
} from "@/db";
import { eq } from "drizzle-orm";
import { extract } from "@/lib/extract";
import { embed } from "@/lib/embeddings";
import { decideCluster } from "./cluster";
import { generateArticle } from "@/lib/ai";
import type { RawItem } from "@/lib/rss/parse-feed";

export type StepRec = {
  name: string;
  status: "success" | "failed";
  durationMs: number;
  errorMessage?: string;
  errorTechnical?: string;
};

// The transaction handle type db.transaction() hands its callback — used so insertTags can
// participate in the same transaction as the article/sources/embedding inserts below.
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Stages one RSS item into a `pending` article awaiting human review.
 * Pipeline: extraction → embedding → clustering → génération IA → dépôt en revue.
 * Human-review gate (non-negotiable): the created article always has status "pending" and
 * aiAuthor=true — this function never publishes anything.
 * A failure at any stage aborts the item (articleId: null) and returns whatever steps ran so
 * far; it never throws, so the caller (runPipeline) can always move on to the next item.
 */
export async function stageItem(
  item: RawItem,
  mediaName: string,
  categoryNames: string[]
): Promise<{ articleId: string | null; steps: StepRec[] }> {
  const steps: StepRec[] = [];
  const timed = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const t0 = Date.now();
    try {
      const r = await fn();
      steps.push({ name, status: "success", durationMs: Date.now() - t0 });
      return r;
    } catch (e) {
      steps.push({
        name, status: "failed", durationMs: Date.now() - t0,
        errorMessage: humanError(name, e as Error), errorTechnical: (e as Error).stack,
      });
      throw e;
    }
  };

  try {
    // Extraction total failure is a HARD abort, not a degraded-success: if every provider fell
    // through (via "none") or the resulting text is effectively empty, generating an article
    // from it would hallucinate content from nothing. Throw so the step is recorded FAILED and
    // the item is aborted (articleId: null) rather than staged as garbage.
    const ex = await timed("Extraction du contenu", async () => {
      const r = await extract(item.url);
      const effectiveText = (r.text || item.contentSnippet).trim();
      if (r.via === "none" || effectiveText.length < 80) {
        throw new Error("Aucun contenu n'a pu être extrait de la source.");
      }
      return r;
    });
    const text = ex.text || item.contentSnippet;

    const emb = await timed("Calcul de l'embedding", () => embed(`${item.title}\n${text}`));
    const vector = emb.vector;

    const cluster = await timed("Regroupement (clustering)", () => decideCluster(vector));

    const gen = await timed("Génération IA", () => generateArticle({
      sources: [{ mediaName, url: item.url, text }],
      candidateImages: ex.images,
      categories: categoryNames,
    }));
    const draft = gen.draft;

    // A provider outage forces embed()/generateArticle() onto their mock fallbacks. Rather than
    // let a degraded run look identical to a healthy one, flag the article so human reviewers see
    // it wasn't produced under normal conditions. Mock embeddings also make clustering meaningless.
    const confidence: NonNullable<typeof draft.confidence> & { aiDegraded?: boolean } = { ...draft.confidence };
    if (gen.via === "mock") confidence.aiDegraded = true;
    if (emb.via === "mock") { confidence.aiDegraded = true; confidence.clusterUncertain = true; }
    if (gen.via === "mock" || emb.via === "mock") {
      console.warn(`[pipeline] article dégradé (embed=${emb.via}, génération=${gen.via}) pour ${item.url}`);
    }

    const articleId = await timed("Dépôt en revue", async () => {
      // Read-only lookup — no write dependency, so it can run outside the transaction below.
      const catId = await resolveCategoryId(draft.category, categoryNames);

      // Everything that writes rows for this article is transactional: if any insert in this
      // block fails (e.g. insertTags), the whole thing rolls back rather than leaving a
      // half-written "pending" article (missing its sources/embedding/tags) silently sitting
      // in the human review queue while the caller believes staging failed (articleId: null).
      return db.transaction(async (tx) => {
        let clusterId = cluster.clusterId;
        if (!clusterId) {
          const [c] = await tx.insert(clusters).values({ label: draft.title.slice(0, 80) }).returning({ id: clusters.id });
          clusterId = c.id;
        }

        const [a] = await tx.insert(articles).values({
          title: draft.title,
          bodyHtml: draft.bodyHtml,
          excerpt: draft.excerpt,
          status: "pending",
          aiAuthor: true,
          categoryId: catId,
          featuredImageUrl: draft.featuredImageUrl,
          imageCredit: draft.imageCredit,
          imageSourceUrl: draft.imageSourceUrl,
          clusterId,
          confidenceFlags: confidence,
          generatedAt: new Date(),
        }).returning({ id: articles.id });

        await tx.insert(articleSources).values({ articleId: a.id, mediaName, url: item.url });
        await tx.insert(articleEmbeddings).values({ articleId: a.id, embedding: vector });
        await insertTags(tx, a.id, draft.tags);

        return a.id;
      });
    });

    return { articleId, steps };
  } catch {
    return { articleId: null, steps };
  }
}

function humanError(step: string, e: Error): string {
  return `${step} a échoué : ${e.message}`; // plain French, no stack (stack goes in errorTechnical)
}

// Resolves a WordPress category name to its mirrored wp_categories.id. Returns null when the
// name isn't one of the allowed categoryNames (defensive — the generateArticle schema already
// constrains draft.category to this list) or has no matching row in wp_categories.
async function resolveCategoryId(categoryName: string, categoryNames: string[]): Promise<string | null> {
  if (!categoryNames.includes(categoryName)) return null;
  const [row] = await db.select({ id: wpCategories.id }).from(wpCategories)
    .where(eq(wpCategories.name, categoryName)).limit(1);
  return row?.id ?? null;
}

// Inserts one article_tags row per generated tag, flagging isNew=true for any tag name not
// already present in the wp_tags mirror (case-insensitive, since the LLM's casing may differ
// from the WordPress-stored term name).
async function insertTags(tx: Tx, articleId: string, tags: string[]): Promise<void> {
  if (tags.length === 0) return;
  const existing = await tx.select({ name: wpTags.name }).from(wpTags);
  const existingLower = new Set(existing.map((t) => t.name.toLowerCase()));
  await tx.insert(articleTags).values(
    tags.map((tagName) => ({ articleId, tagName, isNew: !existingLower.has(tagName.toLowerCase()) }))
  );
}
