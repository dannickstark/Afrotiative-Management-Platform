import { db, feeds, pipelineRuns, pipelineSteps, wpCategories } from "@/db";
import { eq, inArray } from "drizzle-orm";
import { parseFeed } from "@/lib/rss/parse-feed";
import { isSeen, recordRawItem } from "./dedup";
import { stageSources, type SourceInput } from "./stages";
import { withTimeout } from "./timeout";
import { extract, extractExternal, hasExternalExtractor } from "@/lib/extract";
import { embed, cosine } from "@/lib/embeddings";
import { hasRunningRun } from "./overlap";
import { getPipelineSettings } from "@/lib/queries/settings";
import { searchRelated } from "@/lib/search";
import type { RawItem } from "@/lib/rss/parse-feed";

// A same-story group can in principle grow past any sane article/prompt size (a viral story might
// match dozens of candidates in one run) — cap how many of its members actually become
// article_sources rows. Members beyond the cap are still recordRawItem()'d (marked seen, per the
// dedup-tension fix below) but are never extracted/synthesized — "capped as sources, not dropped
// from dedup".
const STORY_GROUP_CAP = 6;

export type RunTrigger = "manual" | "scheduled";
export type RunStatus = "success" | "partial" | "failed" | "skipped";
export type RunResult = { runId: string | null; status: RunStatus; produced: number };

// Drizzle wraps driver errors in DrizzleQueryError, so the pg SQLSTATE lives on `.cause` (not the
// top-level error) — walk the cause chain to find it.
function pgErrorCode(e: unknown): string | undefined {
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur != null; i++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string") return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

// pg unique-violation SQLSTATE — raised by the pipeline_runs_one_running partial unique index
// when a second run tries to open a "running" row while one already exists.
function isUniqueViolation(e: unknown): boolean {
  return pgErrorCode(e) === "23505";
}

// Best-effort human-readable label for a web-search source when no feed name applies — the
// hostname (without a leading "www.") reads better in the references list than a raw URL. Falls
// back to the search hit's own title if the URL doesn't parse (defensive; searchRelated's hits
// always carry a real HTTP(S) URL, but this is cheap insurance against a malformed one).
function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

// Best-effort single-step insert (observability only — never block the run). Steps are now
// inserted incrementally as they happen (live progress), rather than batched at the end.
async function insertStep(row: {
  runId: string; name: string; status: "success" | "failed" | "partial";
  durationMs: number | null; errorMessage?: string; errorTechnical?: string; rawItemId?: string | null;
}): Promise<void> {
  try { await db.insert(pipelineSteps).values(row); } catch { /* observability only */ }
}

// Best-effort progress write (observability only — never fail or skew a real run). A transient DB
// error on a pure-progress UPDATE must NOT surface: inside the per-feed try it would be miscounted
// as a feed-read failure (double-counting the feed as read AND failed), and the phase-2 calls sit
// outside the per-item try, so an error there would abort the whole run as failed even if items
// already succeeded. The finalize update in executeRun's `finally` is deliberately NOT routed
// through here — that one must still propagate.
async function setProgress(runId: string, fields: Partial<{
  phase: string; feedsTotal: number; totalItems: number; processedItems: number;
  currentStage: string | null; currentItem: string | null; feedsRead: number;
}>): Promise<void> {
  try { await db.update(pipelineRuns).set(fields).where(eq(pipelineRuns.id, runId)); } catch { /* observability only */ }
}

/**
 * Opens a run row and holds the one-running slot. Returns the new run's id, or `null` if a run
 * is already active (either the app-level hasRunningRun() check, or the pipeline_runs_one_running
 * partial unique index losing a race on insert — both cases back off cleanly, never crash).
 */
export async function openRun(opts: { triggeredBy: RunTrigger; feedsTotal?: number }): Promise<string | null> {
  if (await hasRunningRun()) return null;
  try {
    const [run] = await db.insert(pipelineRuns).values({
      triggeredBy: opts.triggeredBy, status: "running",
      phase: "reading_feeds", feedsTotal: opts.feedsTotal ?? null, processedItems: 0,
    }).returning({ id: pipelineRuns.id });
    return run.id;
  } catch (e) {
    if (isUniqueViolation(e)) return null;
    throw e;
  }
}

/**
 * Two-phase execution of an already-opened run. ALWAYS finalizes the row to a terminal status —
 * a mid-run throw or process death can never strand it "running" (which would otherwise block
 * every future run via the pipeline_runs_one_running index).
 *
 * Phase 1 (reading_feeds): reads EVERY target feed — even past the item cap — so feed-health
 * signals (feedsRead) and totalItems are exact. Collects NEW candidates (dedup'd by isSeen() and
 * an intra-batch hash set) without recording them yet. The item cap (maxItemsPerRun) is enforced
 * HERE, on candidates — unchanged from before Task 6a; grouping (below) happens strictly AFTER
 * the cap, so the cap bounds how much work a run can do, not how many stories it produces.
 *
 * Grouping (SP4 Task 6a — corpus cross-check, no web search): each candidate is embedded on its
 * lightweight RSS metadata (title + snippet — cheap, no extraction/network fetch yet) and greedily
 * joined to an existing group when its cosine similarity to that group's FIRST member reaches
 * settings.clusterThreshold, else it starts a new group. This is a PURE in-memory JS cosine over
 * two same-dimension vectors — never a pgvector round-trip — because it's comparing THIS run's
 * candidates against each other, not against the persisted article corpus (that's decideCluster's
 * job, still used per-story below for cross-run cluster assignment/scoring).
 *
 * Phase 2 (processing_items): one STORY (group) per processed unit — total_items/processed_items
 * count GROUPS, not raw candidates. For every group: record EVERY member (recordRawItem) — this is
 * the dedup-tension fix: a candidate merged into a multi-source story is marked seen exactly once,
 * here, so it can never resurface as its own separate article on a later run — then extract each
 * member's content (up to STORY_GROUP_CAP; extra members are still recorded/seen but excluded from
 * extraction/synthesis) and hand the resulting sources to ONE stageSources() call, which
 * synthesizes ONE multi-source article. Live progress hooks still persist current_stage/each step
 * as they happen; current_item is the group's primary (first member's) title.
 *
 * A feed that fails to parse, or a group that fails at any stage, is recorded as a failed
 * pipeline_steps row and the run continues — a single failure never aborts the whole run.
 * Hitting the item cap is recorded explicitly (never a silent truncation).
 */
export async function executeRun(runId: string, opts: { feedIds?: string[] } = {}): Promise<RunResult> {
  let feedsRead = 0, feedsFailed = 0, newItems = 0, produced = 0, itemFailures = 0, overCap = 0;
  let capHit = false, targetFeedsLength = 0;
  let status: RunStatus = "failed";

  try {
    // Inside the try (not before it): if getPipelineSettings() ever throws, the finally below must
    // still finalize the row rather than leaving it stuck "running".
    // DB-backed (SP1): maxItemsPerRun is admin-editable at /settings/pipeline, not just env —
    // getPipelineConfig() stays for provider/secret/order config elsewhere in the pipeline.
    const settings = await getPipelineSettings();
    const targetFeeds = opts.feedIds !== undefined
      ? (opts.feedIds.length > 0 ? await db.select().from(feeds).where(inArray(feeds.id, opts.feedIds)) : [])
      : await db.select().from(feeds).where(eq(feeds.active, true));
    targetFeedsLength = targetFeeds.length;
    const categoryNames = (await db.select({ name: wpCategories.name }).from(wpCategories)).map((c) => c.name);

    await setProgress(runId, { phase: "reading_feeds", feedsTotal: targetFeedsLength });

    // ---- Phase 1: read ALL feeds, collect candidates (no recording yet) ----
    type Candidate = { item: RawItem; feedId: string; feedName: string };
    const candidates: Candidate[] = [];
    const seenHashes = new Set<string>(); // intra-batch dedup across feeds in this run

    for (const feed of targetFeeds) {
      const t0 = Date.now();
      let items: RawItem[];
      try {
        items = await parseFeed(feed.feedUrl);
        feedsRead++;
        await insertStep({ runId, name: `Lecture du flux « ${feed.name} »`, status: "success", durationMs: Date.now() - t0 });
        await setProgress(runId, { feedsRead });
      } catch (e) {
        feedsFailed++;
        await insertStep({
          runId, name: `Lecture du flux « ${feed.name} »`, status: "failed", durationMs: Date.now() - t0,
          errorMessage: `La lecture du flux « ${feed.name} » a échoué : ${(e as Error).message}`, errorTechnical: (e as Error).stack,
        });
        continue;
      }
      for (const item of items) {
        if (seenHashes.has(item.contentHash)) continue;      // duplicate within this run's batch
        if (await isSeen(feed.id, item)) continue;           // recorded by a previous run
        seenHashes.add(item.contentHash);
        if (candidates.length >= settings.maxItemsPerRun) { capHit = true; overCap++; continue; }
        candidates.push({ item, feedId: feed.id, feedName: feed.name });
      }
    }

    // ---- Story grouping (SP4 Task 6a): greedily group candidates by cosine similarity of their
    // lightweight (title+snippet) embedding to each existing group's FIRST member. A hash-based
    // mock embedder (no embed provider configured) produces uncorrelated vectors for ANY differing
    // input, so in practice — and by design in tests — only genuinely identical/near-identical
    // metadata joins a group under the mock fallback; a real semantic embedder groups true
    // same-story duplicates. groupVectors is parallel to groups (index i = groups[i]'s join target).
    type Group = { members: Candidate[] };
    const groups: Group[] = [];
    const groupVectors: number[][] = [];
    for (const c of candidates) {
      const { vector } = await embed(`${c.item.title}\n${c.item.contentSnippet}`);
      let joinedIndex = -1;
      for (let i = 0; i < groups.length; i++) {
        if (cosine(vector, groupVectors[i]) >= settings.clusterThreshold) { joinedIndex = i; break; }
      }
      if (joinedIndex >= 0) groups[joinedIndex].members.push(c);
      else { groups.push({ members: [c] }); groupVectors.push(vector); }
    }

    await setProgress(runId, { phase: "processing_items", totalItems: groups.length, processedItems: 0 });

    // ---- Phase 2: process each STORY (group) — synthesize ONE multi-source article per group ----
    let processed = 0;
    for (const group of groups) {
      const primary = group.members[0];
      await setProgress(runId, { currentItem: primary.item.title, currentStage: null });

      const inSources = group.members.slice(0, STORY_GROUP_CAP);
      const overflow = group.members.slice(STORY_GROUP_CAP);

      try {
        // Record EVERY member first (marks them seen — the dedup-tension fix: a member merged into
        // this story can never resurface as its own candidate on a later run) and take the FIRST
        // member's rawItemId as the story's single attribution key. ALL of this story's steps —
        // the one extraction step below AND the synthesis steps — are attributed to this ONE
        // primaryRawItemId, so groupSteps() (lib/queries/runs.ts) buckets the whole story as a
        // single run-detail item and the live panel renders its full 5-node stepper (rather than
        // splitting per-member and showing an extraction-only fragment for the flagship story).
        let primaryRawItemId: string | null = null;
        const memberRawIds: { m: Candidate; rawItemId: string }[] = [];
        for (const m of inSources) {
          const rawItemId = await recordRawItem(m.feedId, m.item);
          newItems++;
          if (primaryRawItemId === null) primaryRawItemId = rawItemId;
          memberRawIds.push({ m, rawItemId });
        }
        // Members beyond STORY_GROUP_CAP: still recorded/seen (dedup fix applies to every match),
        // but never extracted — "capped as sources, not dropped from dedup".
        for (const m of overflow) {
          await recordRawItem(m.feedId, m.item);
          newItems++;
        }

        // ONE "Extraction du contenu" step for the WHOLE story (exact name → maps to the stepper's
        // Extraction node), attributed to primaryRawItemId. It times ONLY member (feed-source)
        // extraction — web augmentation, when it runs, is a SEPARATE "Recherche web" step — and is
        // marked failed only if NO member yielded usable text: a single dead link in a multi-source
        // story just yields one fewer source, never a failed story.
        await setProgress(runId, { currentStage: "Extraction du contenu" });
        const t0 = Date.now();
        const sources: SourceInput[] = [];
        let lastExtractError: Error | null = null;
        for (const { m } of memberRawIds) {
          try {
            // SP5 Task 2: bounded by settings.perOperationTimeoutMs — a hung fetch/extract on one
            // member can't stall this story (let alone the whole run) forever. A timeout here is
            // caught by this same try/catch exactly like any other extraction failure: the member
            // is skipped (best-effort), never escaping to fail the group or the run.
            const r = await withTimeout(extract(m.item.url), settings.perOperationTimeoutMs, "Extraction du contenu");
            const text = (r.text || m.item.contentSnippet).trim();
            // Non-empty text only — falls back to the RSS snippet when extraction yields nothing
            // (r.via === "none" or empty body); a member with no usable text contributes no source
            // (rather than an empty article_sources row) but is still recorded/seen above.
            if (text.length > 0) sources.push({ mediaName: m.feedName, url: m.item.url, text, images: r.images });
          } catch (e) {
            lastExtractError = e as Error;
          }
        }
        // Captured HERE — before the optional web block — so the "Extraction du contenu" step's
        // duration reflects ONLY feed-source extraction (what admins expect that step to mean in
        // the run-detail sheet), not the extra latency of the "Recherche web" step.
        const memberExtractionMs = Date.now() - t0;

        if (sources.length === 0) {
          // Every member's extraction failed → the story fails exactly as in 6a. Web search is
          // ENRICHMENT/corroboration of an already-sourced story, NOT a rescue path: a story whose
          // feed sources all failed must fail, so web augmentation is deliberately NOT attempted
          // here (it lives in the else-branch below, gated on ≥1 usable member source).
          itemFailures++;
          await insertStep({
            runId, name: "Extraction du contenu", status: "failed", durationMs: memberExtractionMs,
            errorMessage: `Aucune source exploitable pour le groupe « ${primary.item.title} ».`,
            errorTechnical: lastExtractError?.stack, rawItemId: primaryRawItemId,
          });
        } else {
          await insertStep({ runId, name: "Extraction du contenu", status: "success", durationMs: memberExtractionMs, rawItemId: primaryRawItemId });

          // SP4 Task 6b — best-effort web-search ENRICHMENT of an ALREADY-sourced story. Reached
          // ONLY once ≥1 member yielded usable text (this is the else branch of the extraction
          // decision), so web coverage corroborates/tops up real feed sources and never rescues a
          // story whose feed sources all failed. Entirely opt-in (settings.webSearchEnabled) and
          // SSRF-safe: web-result URLs are UNTRUSTED (arbitrary internet, picked by a third-party
          // search API, never a feed we chose to follow), so they are ONLY ever extracted via
          // extractExternal() (jina reader / firecrawl — external infra, no SSRF surface from our
          // server) — never the direct-fetch readability path. Nothing here can fail the story or
          // the run: searchRelated() never throws by contract, every per-hit extraction is
          // individually try/caught, and the whole block is wrapped so even an unexpected throw
          // only marks this ONE observability step "failed" instead of aborting the group (the
          // member sources gathered above are untouched either way).
          if (settings.webSearchEnabled) {
            if (!hasExternalExtractor()) {
              console.warn(
                `[pipeline] recherche web ignorée pour « ${primary.item.title} » : aucun extracteur externe ` +
                `(Jina/Firecrawl) n'est configuré — les URLs web ne sont jamais récupérées directement (protection SSRF).`
              );
            } else {
              const tWeb = Date.now();
              let webAdded = 0;
              try {
                const memberUrls = new Set(inSources.map((m) => m.item.url));
                const remainingCap = STORY_GROUP_CAP - sources.length;
                if (remainingCap > 0) {
                  const hits = await searchRelated(primary.item.title, { limit: 3 });
                  for (const hit of hits) {
                    if (sources.length >= STORY_GROUP_CAP) break;
                    // Skip a web URL already covered by a member (or an earlier hit this same
                    // loop) — stageSources also dedupes by URL, but skipping here keeps the
                    // "N source(s) web ajoutée(s)" count below accurate.
                    if (memberUrls.has(hit.url) || sources.some((s) => s.url === hit.url)) continue;
                    try {
                      const r = await extractExternal(hit.url);
                      // Unlike a member's fallback to its RSS contentSnippet (a trusted feed's own
                      // description), a web hit's `snippet` is just a search-engine blurb — NOT a
                      // stand-in for the article's real content. A failed/empty extraction must
                      // skip this source outright rather than stage the search snippet as if it
                      // were extracted text.
                      const text = r.text.trim();
                      if (text.length > 0) {
                        sources.push({ mediaName: hostOf(hit.url) || hit.title, url: hit.url, text, images: r.images });
                        webAdded++;
                      }
                    } catch {
                      // Best-effort: a failed web fetch/extract just skips this one source.
                    }
                  }
                }
                await insertStep({
                  runId, name: "Recherche web", status: "success", durationMs: Date.now() - tWeb,
                  errorMessage: `${webAdded} source(s) web ajoutée(s).`, rawItemId: primaryRawItemId,
                });
              } catch (e) {
                await insertStep({
                  runId, name: "Recherche web", status: "failed", durationMs: Date.now() - tWeb,
                  errorMessage: `La recherche web a échoué : ${(e as Error).message}`,
                  errorTechnical: (e as Error).stack, rawItemId: primaryRawItemId,
                });
              }
            }
          }

          const { articleId } = await stageSources(sources, categoryNames, {
            onStageStart: (name) => setProgress(runId, { currentStage: name }),
            onStageEnd: (step) => insertStep({
              runId, name: step.name, status: step.status, durationMs: step.durationMs,
              errorMessage: step.errorMessage, errorTechnical: step.errorTechnical, rawItemId: primaryRawItemId,
            }),
          }, settings.perOperationTimeoutMs);
          if (articleId) produced++; else itemFailures++;
        }
      } catch (e) {
        itemFailures++;
        await insertStep({
          runId, name: "Traitement du groupe", status: "failed", durationMs: null,
          errorMessage: `Le traitement d'un groupe (« ${primary.item.title} ») a échoué : ${(e as Error).message}`,
          errorTechnical: (e as Error).stack,
        });
      }
      processed++;
      await setProgress(runId, { processedItems: processed });
    }

    // No silent truncation: hitting the cap gets its own visible, plain-language step.
    if (capHit) {
      await insertStep({
        runId, name: "Limite d'éléments atteinte", status: "partial", durationMs: null,
        errorMessage:
          `La limite de ${settings.maxItemsPerRun} nouveaux éléments par exécution a été atteinte : `
          + `${overCap} élément(s) supplémentaire(s) au-delà de la limite n'ont pas été traités ; ils seront repris lors d'une prochaine exécution.`,
      });
    }

    // Status tally:
    //  - failed  = every feed failed to parse, OR items were attempted and NONE succeeded.
    //  - partial = some feeds/items failed (or the cap was hit) but at least one item was produced.
    //  - success = no failures at all — including a quiet run where every item was a duplicate
    //              (itemsAttempted === 0), which must read as success, not failed.
    const itemsAttempted = produced + itemFailures;
    const allFeedsFailed = targetFeedsLength > 0 && feedsFailed === targetFeedsLength;
    const allItemsFailed = itemsAttempted > 0 && produced === 0;
    status =
      allFeedsFailed || allItemsFailed ? "failed"
      : feedsFailed > 0 || itemFailures > 0 || capHit ? "partial"
      : "success";
  } catch (e) {
    // Catastrophic error outside the per-feed/per-item guards (e.g. the feeds/category query).
    status = "failed";
    await insertStep({
      runId, name: "Exécution du pipeline", status: "failed", durationMs: null,
      errorMessage: `L'exécution du pipeline a échoué : ${(e as Error).message}`, errorTechnical: (e as Error).stack,
    });
  } finally {
    // Always land a terminal status AND clear the live pointer so a late poll can't show a stale
    // stage — this is what guarantees the row never stays "running".
    await db.update(pipelineRuns).set({
      status, feedsRead, newItems, published: 0, finishedAt: new Date(),
      phase: "finalizing", currentStage: null, currentItem: null,
    }).where(eq(pipelineRuns.id, runId));
  }

  return { runId, status, produced };
}

/**
 * Runs one full pipeline pass: opens the run (holding the one-running slot) then executes it.
 * Preserved for the cron route + manual-trigger action + existing tests — behaviourally identical
 * to the previous single-function runPipeline (same overlap safety, same always-finalize
 * guarantee), just composed from openRun + executeRun under the hood.
 */
export async function runPipeline(opts: { triggeredBy: RunTrigger; feedIds?: string[] }): Promise<RunResult> {
  const runId = await openRun({ triggeredBy: opts.triggeredBy });
  if (!runId) return { runId: null, status: "skipped", produced: 0 };
  return executeRun(runId, { feedIds: opts.feedIds });
}
