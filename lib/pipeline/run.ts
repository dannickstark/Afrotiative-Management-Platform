import { db, feeds, pipelineRuns, pipelineSteps, wpCategories } from "@/db";
import { eq, inArray } from "drizzle-orm";
import { parseFeed } from "@/lib/rss/parse-feed";
import { isSeen, recordRawItem } from "./dedup";
import { stageItem } from "./stages";
import { hasRunningRun } from "./overlap";
import { getPipelineSettings } from "@/lib/queries/settings";
import type { RawItem } from "@/lib/rss/parse-feed";

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
 * an intra-batch hash set) without recording them yet.
 * Phase 2 (processing_items): for each candidate up to the cap — record it (this is the ONLY
 * place recordRawItem() is called, so "seen" is committed exactly for what we process; items
 * beyond the cap are never recorded and are retried on the next run), then stage it with live
 * hooks that persist current_stage and each step as they happen.
 *
 * A feed that fails to parse, or an item that fails at any stage, is recorded as a failed
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

    await setProgress(runId, { phase: "processing_items", totalItems: candidates.length, processedItems: 0 });

    // ---- Phase 2: process collected candidates ----
    let processed = 0;
    for (const c of candidates) {
      await setProgress(runId, { currentItem: c.item.title, currentStage: null });
      try {
        const rawItemId = await recordRawItem(c.feedId, c.item);
        newItems++;
        const { articleId } = await stageItem(c.item, c.feedName, categoryNames, {
          onStageStart: (name) => setProgress(runId, { currentStage: name }),
          onStageEnd: (step) => insertStep({
            runId, name: step.name, status: step.status, durationMs: step.durationMs,
            errorMessage: step.errorMessage, errorTechnical: step.errorTechnical, rawItemId,
          }),
        });
        if (articleId) produced++; else itemFailures++;
      } catch (e) {
        itemFailures++;
        await insertStep({
          runId, name: "Traitement de l'élément", status: "failed", durationMs: null,
          errorMessage: `Le traitement d'un élément (${c.item.url}) a échoué : ${(e as Error).message}`, errorTechnical: (e as Error).stack,
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
