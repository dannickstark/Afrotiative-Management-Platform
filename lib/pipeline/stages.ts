import {
  db, articles, articleSources, articleTags, articleEmbeddings, articleRevisions, clusters, wpCategories, wpTags,
} from "@/db";
import { eq } from "drizzle-orm";
import { extract, extractExternal } from "@/lib/extract";
import { embed } from "@/lib/embeddings";
import { decideCluster } from "./cluster";
import { generateArticle, type ArticleDraft } from "@/lib/ai";
import { sanitizeArticleHtml } from "@/lib/sanitize";
import { computeArticleScore } from "./score";
import { withTimeout } from "./timeout";
import { getPipelineSettings } from "@/lib/queries/settings";
import { shouldAutoPublish, type AutoPublishConfidence } from "./auto-publish";
import {
  repairDraft, checkCompleteness, sortMissingFields, BLOCKING_FIELDS, type MissingField,
} from "./completeness";
import type { RawItem } from "@/lib/rss/parse-feed";

// SP6 — the 3 auto-publish knobs stageSources needs, in the shape lib/pipeline/auto-publish.ts's
// shouldAutoPublish() expects. Threaded from the caller (executeRun already reads
// getPipelineSettings() once per run and passes settings.perOperationTimeoutMs the same way — see
// that call site in lib/pipeline/run.ts) rather than re-read here on every story; stageSources
// falls back to reading settings itself (below) only when a caller omits it, exactly like timeoutMs.
export type AutoPublishCfg = { enabled: boolean; scoreThreshold: number; minSources: number };

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
export type SourceInput = {
  mediaName: string; url: string; text: string; images?: string[];
  origin?: "feed" | "web";
};

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
 * Human-review gate (non-negotiable): the created article ALWAYS has aiAuthor=true, and its status
 * is "pending" UNLESS it qualifies for SP6's gated auto-publish exception (default OFF; see
 * lib/pipeline/auto-publish.ts's shouldAutoPublish — score ≥ threshold, ≥N sources, image present,
 * no low-confidence flags), in which case status is "approved" + scheduledAt=now instead: this
 * function itself still never PUBLISHES anything (that's still only ever publishDueArticles(),
 * unchanged, per lib/wp/publish-due.ts), it only ever decides which status row to insert. A
 * failure at any stage aborts (articleId: null) and returns whatever steps ran so far; it never
 * throws, so the caller can always move on to the next story/item.
 *
 * `timeoutMs` (SP5 Task 2) bounds each of the 4 stages below via withTimeout — omit it to read
 * settings.perOperationTimeoutMs directly (the sensible default for a caller outside executeRun,
 * e.g. reprocessRawItem via stageItem below); executeRun always passes its own already-loaded
 * settings value explicitly rather than re-reading on every story. `autoPublishCfg` (SP6) is
 * threaded the same way — omit it to read settings.{autoPublishEnabled,scoreThreshold,
 * autoPublishMinSources} directly.
 */
export async function stageSources(
  sources: SourceInput[],
  categoryNames: string[],
  hooks: StageHooks = {},
  timeoutMs?: number,
  autoPublishCfg?: AutoPublishCfg,
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
    // Read settings ONCE only if either caller-supplied default is missing — when executeRun calls
    // this (both timeoutMs AND autoPublishCfg passed explicitly), this never re-reads settings,
    // preserving the "one getPipelineSettings() call per run" property already established for
    // timeoutMs. A direct caller that omits either (stageItem's own default path, or a test) gets
    // a sensible fallback for whichever one it left out.
    const settings = (timeoutMs === undefined || autoPublishCfg === undefined) ? await getPipelineSettings() : null;
    const ms = timeoutMs ?? settings!.perOperationTimeoutMs;
    const apCfg: AutoPublishCfg = autoPublishCfg ?? {
      enabled: settings!.autoPublishEnabled,
      scoreThreshold: settings!.scoreThreshold,
      minSources: settings!.autoPublishMinSources,
    };
    const candidateImages = [...new Set(uniqueSources.flatMap((s) => s.images ?? []))];

    const gen = await timedStep(steps, hooks, "Génération IA", ms, () => generateArticle({
      sources: uniqueSources.map(({ mediaName, url, text }) => ({ mediaName, url, text })),
      candidateImages,
      categories: categoryNames,
    }));
    let draft = gen.draft;

    // SP4 Task 2's sanitizer, wired here (closing that task's deferral): the AI-generated
    // bodyHtml is sanitized BEFORE it is ever embedded or persisted — a provider (or its mock
    // fallback) can echo unsafe-looking markup straight out of scraped source text, so this must
    // run before the DB insert, not after.
    const sanitized = sanitizeArticleHtml(draft.bodyHtml);

    // Étape « Vérification & complétion ». SEULE étape de cette fonction dont l'échec n'avorte
    // PAS l'article : les cinq autres relèvent leur erreur, ce qui fait sortir stageSources par
    // son catch (articleId: null). Ici, perdre une réparation ne doit jamais coûter un article —
    // on enregistre l'étape en échec (timedStep l'a déjà fait avant de relever) et on poursuit
    // avec le brouillon non réparé, dont les manques sont alors calculés sans réparation.
    //
    // Placée AVANT l'embedding pour que computeArticleScore (plus bas) voie l'article RÉPARÉ :
    // une image récupérée ici améliore réellement le score au lieu d'être pénalisée.
    //
    // Le choix d'extracteur se fait PAR SOURCE, sur la marque `origin` posée à la construction
    // (Task 4b) : une source de flux RSS (`origin: "feed"`) a déjà été récupérée par un extract()
    // brut à l'ingestion (stageItem/executeRun) — relancer cet extract() (backfill d'images inclus)
    // sur CETTE MÊME URL ici n'expose donc RIEN de nouveau ; c'est le seul fait qui justifie ce
    // choix. (Seule l'URL du FLUX lui-même — pas celle de chaque item — est fixée par la
    // configuration de l'opérateur ; l'URL de l'item est choisie par l'éditeur du flux, un tiers. Ne
    // pas lire « opérateur-configuré » comme une licence à étendre `origin: "feed"` à d'autres URLs
    // fournies par cet éditeur qui n'auraient pas, elles, déjà été extraites une première fois.)
    // Une source de recherche web (`origin: "web"`, ajoutée par SP4 Task 6b) reste une URL NON
    // DIGNE DE CONFIANCE (résultat d'un moteur de recherche tiers) : elle ne doit JAMAIS déclencher
    // de fetch en clair depuis ce serveur (ni readability, ni le backfill d'images de extract()
    // après un succès Jina/Firecrawl) — extractExternal() est alors seul autorisé, il ne touche que
    // l'infrastructure du fournisseur externe (Jina/Firecrawl). Une source sans `origin` est
    // traitée comme non fiable par défaut (voir le commentaire sur SourceRef/repairDraft).
    let missingFields: MissingField[];
    try {
      const repair = await timedStep(steps, hooks, "Vérification & complétion", ms, () =>
        repairDraft(draft, uniqueSources, categoryNames, candidateImages,
          { extract, extractExternal }),
      );
      draft = repair.draft;
      missingFields = repair.missing;
    } catch {
      missingFields = checkCompleteness(draft, uniqueSources, categoryNames);
    }

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

    const depot = await timedStep(steps, hooks, "Dépôt en revue", ms, () => persistArticle({
      draft, sanitizedBody: sanitized, vector, clusterId: cluster.clusterId, score, confidence,
      sources: uniqueSources, categoryNames, autoPublish: apCfg, missingFields,
    }));

    // SP6 — best-effort live step so the run's live view + trace show the auto-approval happened,
    // distinct from the always-present "Dépôt en revue" step above. Deliberately AFTER that step's
    // timedStep call (never wraps it): the article is already durably written (approved or
    // pending, decided inside persistArticle's own transaction) by this point, so a failure here
    // is purely an observability hiccup — it must never retroactively fail the story or flip a
    // successfully-approved article back to looking unapproved.
    if (depot.autoApproved) {
      try {
        await hooks.onStageStart?.("Publication automatique");
        const step: StepRec = {
          name: "Publication automatique", status: "success", durationMs: 0,
          errorMessage: `Score ${score} ≥ seuil ${apCfg.scoreThreshold} ; ${uniqueSources.length} source(s) ; aucune alerte de confiance.`,
        };
        steps.push(step);
        await hooks.onStageEnd?.(step);
      } catch {
        // Best-effort observability only (see comment above) — never fail the story over this.
      }
    }

    return { articleId: depot.articleId, steps };
  } catch {
    return { articleId: null, steps };
  }
}

// SP6 — the transactional write behind "Dépôt en revue". Inserts the article (+ its cluster if
// new, sources, embedding, tags) and, when lib/pipeline/auto-publish.ts's shouldAutoPublish() gate
// passes, AUTO-APPROVES it instead of leaving it "pending": status becomes "approved" with
// scheduledAt=now (so the EXISTING, UNCHANGED publishDueArticles() cron — lib/wp/publish-due.ts —
// picks it up on its next run; that function still only ever selects status='approved', so this
// adds a second gated PATH to approved rather than touching its enforcement point at all) plus an
// audited article_revisions row ("publié automatiquement", actorId null = system), inserted in
// this SAME transaction so the audit row can never exist without the article it documents, or vice
// versa. A non-qualifying article is inserted exactly as before this SP: status "pending".
//
// Exported (not just inlined above) so tests/auto-publish-run.test.ts can drive BOTH directions of
// the auto-publish decision directly against the real DB with a fully crafted, non-degraded
// draft/score/confidence — proving the wiring itself (status/scheduledAt/audit-row) without needing
// a real (or elaborately faked) LLM/embedding provider round-trip merely to get a network-free
// article with aiDegraded:false (this project's network-free tests force generateArticle/embed
// onto their mock fallback, which always sets aiDegraded:true — see stages.ts's own confidence
// comment above — so driving the POSITIVE auto-approve path through the full stageSources() call
// would otherwise require fragile shared-module-registry mocking of the AI/embedding stack).
export async function persistArticle(input: {
  draft: ArticleDraft;
  sanitizedBody: string;
  vector: number[];
  clusterId: string | null;
  score: number;
  confidence: AutoPublishConfidence;
  sources: SourceInput[]; // already deduped by URL
  categoryNames: string[];
  autoPublish: AutoPublishCfg;
  missingFields: MissingField[];
}): Promise<{ articleId: string; autoApproved: boolean }> {
  const { draft, sanitizedBody, vector, score, confidence, sources, categoryNames, autoPublish } = input;

  // Read-only lookup — no write dependency, so it can run outside the transaction below.
  const catId = await resolveCategoryId(draft.category, categoryNames);

  // Réconciliation de la clé `categoryId` : checkCompleteness a travaillé sur un NOM de
  // catégorie ; sa résolution en identifiant n'a lieu qu'ici et peut échouer même sur un nom
  // plausible (aucune ligne wp_categories correspondante). C'est la SEULE clé complétée après
  // l'étape — les six autres sont figées. La liste écrite en base fait ensuite foi pour
  // l'affichage et le filtrage.
  const missingFields = catId === null
    ? sortMissingFields([...input.missingFields, "categoryId"])
    : input.missingFields;

  // The gate itself is pure and should never throw — but if it somehow did, fall back to "pending"
  // (never to "approved"): an auto-publish DECISION failure must only ever withhold the exception,
  // never grant it. This is the "best-effort, never fails the run" contract for the auto-approve
  // path specifically (the run/story-level best-effort behavior — one story's failure never
  // aborting the whole run — is unchanged, handled by executeRun's existing per-story try/catch).
  let autoApproved = false;
  try {
    autoApproved = shouldAutoPublish({
      enabled: autoPublish.enabled,
      score,
      scoreThreshold: autoPublish.scoreThreshold,
      sourceCount: sources.length,
      minSources: autoPublish.minSources,
      hasImage: !!draft.featuredImageUrl,
      confidence,
      hasBlockingGaps: missingFields.some((f) => BLOCKING_FIELDS.includes(f)),
    });
  } catch {
    autoApproved = false;
  }

  // Everything that writes rows for this article is transactional: if any insert in this block
  // fails (e.g. insertTags, or the audit revision insert below), the whole thing rolls back rather
  // than leaving a half-written article (missing its sources/embedding/tags, or auto-approved
  // without its audit trail) silently sitting in the DB while the caller believes staging failed
  // (articleId: null) — matching the existing pre-SP6 all-or-nothing behavior of this step.
  const articleId = await db.transaction(async (tx) => {
    let clusterId = input.clusterId;
    if (!clusterId) {
      const [c] = await tx.insert(clusters).values({ label: draft.title.slice(0, 80) }).returning({ id: clusters.id });
      clusterId = c.id;
    }

    const [a] = await tx.insert(articles).values({
      title: draft.title,
      bodyHtml: sanitizedBody,
      excerpt: draft.excerpt,
      status: autoApproved ? "approved" : "pending",
      aiAuthor: true,
      categoryId: catId,
      featuredImageUrl: draft.featuredImageUrl,
      imageCredit: draft.imageCredit,
      imageSourceUrl: draft.imageSourceUrl,
      clusterId,
      score,
      confidenceFlags: confidence,
      missingFields,
      generatedAt: new Date(),
      // SP6: an auto-approved article is scheduled for "now" so the existing publish-due cron
      // (unchanged — still selects only status='approved') publishes it on its next pass. A
      // non-qualifying article gets no schedule, exactly as before this SP.
      scheduledAt: autoApproved ? new Date() : null,
    }).returning({ id: articles.id });

    // ONE article_sources row PER distinct source URL — this is the multi-source synthesis
    // payoff: a 2-source story yields 2 rows here (and therefore 2 references in the published
    // post). Deduped by URL above, so no duplicate reference entries.
    await tx.insert(articleSources).values(
      sources.map((s) => ({ articleId: a.id, mediaName: s.mediaName, url: s.url }))
    );
    await tx.insert(articleEmbeddings).values({ articleId: a.id, embedding: vector });
    await insertTags(tx, a.id, draft.tags);

    if (autoApproved) {
      // The audit trail for the SP6 exception — actorId null (no human involved) makes that
      // fact visible in article_revisions itself, exactly like every other revision entry.
      await tx.insert(articleRevisions).values({
        articleId: a.id,
        actorId: null,
        action: "publié automatiquement",
        detail: `Score ${score} ≥ seuil ${autoPublish.scoreThreshold} ; ${sources.length} source(s) ; aucune alerte de confiance.`,
      });
    }

    return a.id;
  });

  return { articleId, autoApproved };
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
      [{ mediaName, url: item.url, text, images: ex.images, origin: "feed" }],
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
export async function resolveCategoryId(categoryName: string, categoryNames: string[]): Promise<string | null> {
  if (!categoryNames.includes(categoryName)) return null;
  const [row] = await db.select({ id: wpCategories.id }).from(wpCategories)
    .where(eq(wpCategories.name, categoryName)).limit(1);
  return row?.id ?? null;
}

// Inserts one article_tags row per generated tag, flagging isNew=true for any tag name not
// already present in the wp_tags mirror (case-insensitive, since the LLM's casing may differ
// from the WordPress-stored term name).
export async function insertTags(tx: Tx, articleId: string, tags: string[]): Promise<void> {
  if (tags.length === 0) return;
  const existing = await tx.select({ name: wpTags.name }).from(wpTags);
  const existingLower = new Set(existing.map((t) => t.name.toLowerCase()));
  await tx.insert(articleTags).values(
    tags.map((tagName) => ({ articleId, tagName, isNew: !existingLower.has(tagName.toLowerCase()) }))
  );
}
