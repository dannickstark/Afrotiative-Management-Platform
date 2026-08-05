import {
  db, articles, articleSources, articleTags, articleEmbeddings, clusters, wpCategories, wpTags,
} from "@/db";
import { eq } from "drizzle-orm";
import { extract } from "@/lib/extract";
import { embed } from "@/lib/embeddings";
import { decideCluster } from "./cluster";
import { generateArticle } from "@/lib/ai";
import { sanitizeArticleHtml } from "@/lib/sanitize";
import { computeArticleScore } from "./score";
import { withTimeout } from "./timeout";
import { getPipelineSettings } from "@/lib/queries/settings";
import type { RawItem } from "@/lib/rss/parse-feed";

export type StepRec = {
  name: string;
  status: "success" | "failed";
  durationMs: number;
  errorMessage?: string;
  errorTechnical?: string;
};

export type StageHooks = {
  onStageStart?: (name: string) => void | Promise<void>;
  onStageEnd?: (step: StepRec) => void | Promise<void>;
};

// One already-extracted piece of source content to synthesize into (part of) ONE article — SP4
// Task 6a's corpus cross-check unit. `images` are that source's OWN candidate images (e.g.
// ExtractResult.images from lib/extract); stageSources aggregates them across every source of a
// story before handing candidateImages to generateArticle. Optional because not every caller
// tracks per-source images.
export type SourceInput = { mediaName: string; url: string; text: string; images?: string[] };

// The transaction handle type db.transaction() hands its callback — used so insertTags can
// participate in the same transaction as the article/sources/embedding inserts below.
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Shared step-timing helper: runs `fn`, appends a StepRec to `steps` (success or failed) and
// fires the hooks around it, then rethrows on failure so the caller's own try/catch decides what
// happens next (stageSources/stageItem both abort — articleId: null — on any stage failure).
//
// SP5 Task 2: `fn()` is raced against `timeoutMs` via withTimeout — a stuck provider call (a hung
// génération/embedding/extraction request) rejects with a French timeout error instead of hanging
// this story (and the whole run) for as long as the provider takes. A timeout is just another
// failure from this function's point of view: it lands in the same catch branch below, so the
// step is recorded "failed" with the timeout message and rethrown exactly like any other error —
// no separate code path, no change to the abort/best-effort invariants.
async function timedStep<T>(
  steps: StepRec[],
  hooks: StageHooks,
  name: string,
  timeoutMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  await hooks.onStageStart?.(name);
  const t0 = Date.now();
  try {
    const r = await withTimeout(fn(), timeoutMs, name);
    const step: StepRec = { name, status: "success", durationMs: Date.now() - t0 };
    steps.push(step);
    await hooks.onStageEnd?.(step);
    return r;
  } catch (e) {
    const step: StepRec = {
      name, status: "failed", durationMs: Date.now() - t0,
      errorMessage: humanError(name, e as Error), errorTechnical: (e as Error).stack,
    };
    steps.push(step);
    await hooks.onStageEnd?.(step);
    throw e;
  }
}

/**
 * Stages N already-extracted sources — all belonging to the SAME story — into ONE `pending`
 * article awaiting human review. This is the SP4 Task 6a core: corpus cross-check synthesis.
 * Extraction itself is NOT this function's job (the caller — executeRun's per-group loop, or
 * stageItem below for the single-item path — already has `text` in hand for every source).
 * Pipeline: génération IA (cross-checks every source) → sanitize → embedding → clustering
 * (cross-run, for scoring/observability) → score → dépôt en revue.
 *
 * ORDER NOTE (vs. the pre-Task-6 single-source stageItem): embedding/clustering used to run on
 * the RAW source text BEFORE generation, because with exactly one source that text WAS the
 * article's content. With N sources there's no single coherent "pre-generation" text to embed —
 * so this embeds the GENERATED title+body instead, which requires generateArticle to run first.
 * Génération IA therefore now precedes Calcul de l'embedding/Regroupement; live.ts's ITEM_STAGES
 * was reordered to match this true chronological order (Extraction du contenu is the 1st, run by
 * the caller — see stageItem), so the live stepper renders/freezes correctly left-to-right.
 *
 * Human-review gate (non-negotiable): the created article always has status "pending" and
 * aiAuthor=true — this function never publishes anything. A failure at any stage aborts
 * (articleId: null) and returns whatever steps ran so far; it never throws, so the caller can
 * always move on to the next story/item.
 *
 * `timeoutMs` (SP5 Task 2) bounds each of the 4 stages below via withTimeout — omit it to read
 * settings.perOperationTimeoutMs directly (the sensible default for a caller outside executeRun,
 * e.g. reprocessRawItem via stageItem below); executeRun always passes its own already-loaded
 * settings value explicitly rather than re-reading on every story.
 */
export async function stageSources(
  sources: SourceInput[],
  categoryNames: string[],
  hooks: StageHooks = {},
  timeoutMs?: number,
): Promise<{ articleId: string | null; steps: StepRec[] }> {
  const steps: StepRec[] = [];

  // Dedupe by URL BEFORE anything downstream: two grouped members can share a URL (e.g. the same
  // article syndicated through two feeds), which would otherwise produce duplicate reference
  // entries in the published post AND double-count corroboration in the score. Keep the FIRST
  // occurrence of each distinct URL; everything below (candidateImages, generateArticle sources,
  // sourceCount for scoring, article_sources rows) uses this de-duplicated list.
  const sourcesByUrl = new Map<string, SourceInput>();
  for (const s of sources) if (!sourcesByUrl.has(s.url)) sourcesByUrl.set(s.url, s);
  const uniqueSources = [...sourcesByUrl.values()];
  if (uniqueSources.length === 0) return { articleId: null, steps };

  try {
    const ms = timeoutMs ?? (await getPipelineSettings()).perOperationTimeoutMs;
    const candidateImages = [...new Set(uniqueSources.flatMap((s) => s.images ?? []))];

    const gen = await timedStep(steps, hooks, "Génération IA", ms, () => generateArticle({
      sources: uniqueSources.map(({ mediaName, url, text }) => ({ mediaName, url, text })),
      candidateImages,
      categories: categoryNames,
    }));
    const draft = gen.draft;

    // SP4 Task 2's sanitizer, wired here (closing that task's deferral): the AI-generated
    // bodyHtml is sanitized BEFORE it is ever embedded or persisted — a provider (or its mock
    // fallback) can echo unsafe-looking markup straight out of scraped source text, so this must
    // run before the DB insert, not after.
    const sanitized = sanitizeArticleHtml(draft.bodyHtml);

    const emb = await timedStep(steps, hooks, "Calcul de l'embedding", ms, () => embed(`${draft.title}\n${sanitized}`));
    const vector = emb.vector;

    const cluster = await timedStep(steps, hooks, "Regroupement (clustering)", ms, () => decideCluster(vector));

    // A provider outage forces generateArticle()/embed() onto their mock fallbacks. Rather than
    // let a degraded run look identical to a healthy one, flag the article so human reviewers see
    // it wasn't produced under normal conditions. Mock embeddings also make clustering meaningless.
    const confidence: NonNullable<typeof draft.confidence> & { aiDegraded?: boolean } = { ...draft.confidence };
    if (gen.via === "mock") confidence.aiDegraded = true;
    if (emb.via === "mock") { confidence.aiDegraded = true; confidence.clusterUncertain = true; }
    if (gen.via === "mock" || emb.via === "mock") {
      console.warn(`[pipeline] article dégradé (embed=${emb.via}, génération=${gen.via}) — ${uniqueSources.length} source(s)`);
    }

    // SP4 Task 4's scorer: corroboration (sourceCount — the cross-check payoff), cluster
    // cohesion (bestScore), completeness/image/category signals, minus confidence penalties.
    const score = computeArticleScore({
      sourceCount: uniqueSources.length,
      bestScore: cluster.bestScore,
      bodyHtml: sanitized,
      hasImage: !!draft.featuredImageUrl,
      confidence,
    });

    const articleId = await timedStep(steps, hooks, "Dépôt en revue", ms, async () => {
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
          bodyHtml: sanitized,
          excerpt: draft.excerpt,
          status: "pending",
          aiAuthor: true,
          categoryId: catId,
          featuredImageUrl: draft.featuredImageUrl,
          imageCredit: draft.imageCredit,
          imageSourceUrl: draft.imageSourceUrl,
          clusterId,
          score,
          confidenceFlags: confidence,
          generatedAt: new Date(),
        }).returning({ id: articles.id });

        // ONE article_sources row PER distinct source URL — this is the multi-source synthesis
        // payoff: a 2-source story yields 2 rows here (and therefore 2 references in the published
        // post). Deduped by URL above, so no duplicate reference entries.
        await tx.insert(articleSources).values(
          uniqueSources.map((s) => ({ articleId: a.id, mediaName: s.mediaName, url: s.url }))
        );
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

/**
 * Thin wrapper around stageSources() for the single-item path — kept for reprocessRawItem
 * (lib/actions/pipeline-actions.ts) and its tests, which retry ONE already-recorded raw_items row
 * outside the grouping runner. Extracts that one item's content itself (same hard-abort-on-total-
 * extraction-failure behavior as before Task 6a: if every extraction provider fails outright, the
 * item is aborted rather than staged from a bare RSS snippet — there is no second source to fall
 * back on for a lone item, unlike the group path in executeRun) then delegates génération IA
 * through dépôt en revue to stageSources with exactly one source.
 *
 * `timeoutMs` (SP5 Task 2): as with stageSources above, omit it to read
 * settings.perOperationTimeoutMs — this is the "called outside the runner" case (reprocessRawItem
 * never threads a value through), so both this function's own extraction step AND the delegated
 * stageSources call get a sensible default rather than no timeout at all.
 */
export async function stageItem(
  item: RawItem,
  mediaName: string,
  categoryNames: string[],
  hooks: StageHooks = {},
  timeoutMs?: number,
): Promise<{ articleId: string | null; steps: StepRec[] }> {
  const steps: StepRec[] = [];
  try {
    const ms = timeoutMs ?? (await getPipelineSettings()).perOperationTimeoutMs;
    // Extraction total failure is a HARD abort, not a degraded-success: if every provider fell
    // through (via "none") or the resulting text is effectively empty, generating an article
    // from it would hallucinate content from nothing. Throw so the step is recorded FAILED and
    // the item is aborted (articleId: null) rather than staged as garbage. A timeout is just
    // another failure here — it lands in this same catch (via timedStep), same abort path.
    const ex = await timedStep(steps, hooks, "Extraction du contenu", ms, async () => {
      const r = await extract(item.url);
      const effectiveText = (r.text || item.contentSnippet).trim();
      if (r.via === "none" || effectiveText.length < 80) {
        throw new Error("Aucun contenu n'a pu être extrait de la source.");
      }
      return r;
    });
    const text = ex.text || item.contentSnippet;

    const result = await stageSources(
      [{ mediaName, url: item.url, text, images: ex.images }],
      categoryNames,
      hooks,
      ms,
    );
    return { articleId: result.articleId, steps: [...steps, ...result.steps] };
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
