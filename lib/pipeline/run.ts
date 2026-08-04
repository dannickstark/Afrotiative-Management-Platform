import { db, feeds, pipelineRuns, pipelineSteps, wpCategories } from "@/db";
import { eq, inArray } from "drizzle-orm";
import { parseFeed } from "@/lib/rss/parse-feed";
import { isSeen, recordRawItem } from "./dedup";
import { stageItem } from "./stages";
import { hasRunningRun } from "./overlap";
import { getPipelineConfig } from "@/lib/config/pipeline-config";
import type { RawItem } from "@/lib/rss/parse-feed";

export type RunTrigger = "manual" | "scheduled";
export type RunStatus = "success" | "partial" | "failed" | "skipped";
export type RunResult = { runId: string | null; status: RunStatus; produced: number };

type StepRow = {
  runId: string;
  name: string;
  status: "success" | "failed" | "partial";
  durationMs: number | null;
  errorMessage?: string;
  errorTechnical?: string;
};

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

/**
 * Runs one full pipeline pass: reads active feeds (or a caller-supplied subset), dedups their
 * items, and stages up to `maxItemsPerRun` NEW items into `pending` articles awaiting human
 * review. Never publishes anything itself — `published` is always tallied as 0.
 *
 * Overlap safety (belt AND suspenders):
 *  - App check: returns { status: "skipped" } up front if a run is already "running".
 *  - DB interlock: the opening insert can still lose a race; the pipeline_runs_one_running
 *    partial unique index then rejects it and we return "skipped" too.
 *  - The run row is ALWAYS finalized to a terminal status in a finally block, so a mid-run
 *    throw can never leave it stuck "running" (which would otherwise block every future run).
 *
 * A feed that fails to parse, or an item that fails at any stage, is recorded as a failed
 * pipeline_steps row and the run continues — a single failure never aborts the whole run.
 * Hitting the item cap is recorded explicitly (never a silent truncation).
 */
export async function runPipeline(opts: { triggeredBy: RunTrigger; feedIds?: string[] }): Promise<RunResult> {
  const cfg = getPipelineConfig();

  // Defense-in-depth overlap check (callers are also expected to check before invoking).
  if (await hasRunningRun()) return { runId: null, status: "skipped", produced: 0 };

  // Open the run row. If a concurrent run beat us past the check above, the partial unique
  // index rejects this insert — back off cleanly rather than crashing.
  let runId: string;
  try {
    const [run] = await db.insert(pipelineRuns)
      .values({ triggeredBy: opts.triggeredBy, status: "running" })
      .returning({ id: pipelineRuns.id });
    runId = run.id;
  } catch (e) {
    if (isUniqueViolation(e)) return { runId: null, status: "skipped", produced: 0 };
    throw e;
  }

  const stepRows: StepRow[] = [];
  let feedsRead = 0;
  let feedsFailed = 0;
  let newItems = 0;
  let produced = 0;
  let itemFailures = 0;
  let capHit = false;
  let itemsSkippedInCurrentFeed = 0;
  let feedsNotRead = 0;
  let targetFeedsLength = 0;
  let status: RunStatus = "failed";

  try {
    const targetFeeds = opts.feedIds !== undefined
      ? (opts.feedIds.length > 0 ? await db.select().from(feeds).where(inArray(feeds.id, opts.feedIds)) : [])
      : await db.select().from(feeds).where(eq(feeds.active, true));
    targetFeedsLength = targetFeeds.length;

    const categoryRows = await db.select({ name: wpCategories.name }).from(wpCategories);
    const categoryNames = categoryRows.map((c) => c.name);

    for (let fi = 0; fi < targetFeeds.length; fi++) {
      if (capHit) { feedsNotRead = targetFeeds.length - fi; break; }
      const feed = targetFeeds[fi];

      const t0 = Date.now();
      let items: RawItem[];
      try {
        items = await parseFeed(feed.feedUrl);
        feedsRead++;
        stepRows.push({ runId, name: `Lecture du flux « ${feed.name} »`, status: "success", durationMs: Date.now() - t0 });
      } catch (e) {
        feedsFailed++;
        stepRows.push({
          runId, name: `Lecture du flux « ${feed.name} »`, status: "failed", durationMs: Date.now() - t0,
          errorMessage: `La lecture du flux « ${feed.name} » a échoué : ${(e as Error).message}`,
          errorTechnical: (e as Error).stack,
        });
        continue;
      }

      for (let ii = 0; ii < items.length; ii++) {
        if (newItems >= cfg.maxItemsPerRun) {
          capHit = true;
          itemsSkippedInCurrentFeed = items.length - ii;
          break;
        }
        const item = items[ii];
        // Per-item isolation: a transient DB error on the dedup/record calls (or any escape from
        // stageItem) becomes a failed step and we move on — it must NEVER escape to the run level,
        // where it would skip finalization and strand the run "running".
        try {
          if (await isSeen(feed.id, item)) continue; // duplicate — not an attempted staging
          await recordRawItem(feed.id, item);
          newItems++;

          const { articleId, steps } = await stageItem(item, feed.name, categoryNames);
          for (const s of steps) {
            stepRows.push({
              runId, name: s.name, status: s.status, durationMs: s.durationMs,
              errorMessage: s.errorMessage, errorTechnical: s.errorTechnical,
            });
          }
          if (articleId) produced++;
          else itemFailures++;
        } catch (e) {
          itemFailures++;
          stepRows.push({
            runId, name: "Traitement de l'élément", status: "failed", durationMs: null,
            errorMessage: `Le traitement d'un élément (${item.url}) a échoué : ${(e as Error).message}`,
            errorTechnical: (e as Error).stack,
          });
          continue;
        }
      }
    }

    // No silent truncation: hitting the cap gets its own visible, plain-language step.
    if (capHit) {
      stepRows.push({
        runId, name: "Limite d'éléments atteinte", status: "partial", durationMs: null,
        errorMessage:
          `La limite de ${cfg.maxItemsPerRun} nouveaux éléments par exécution a été atteinte : `
          + `${itemsSkippedInCurrentFeed} élément(s) restant(s) du flux en cours et ${feedsNotRead} flux non lu(s) `
          + "n'ont pas été traités ; ils seront repris lors d'une prochaine exécution.",
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
    stepRows.push({
      runId, name: "Exécution du pipeline", status: "failed", durationMs: null,
      errorMessage: `L'exécution du pipeline a échoué : ${(e as Error).message}`,
      errorTechnical: (e as Error).stack,
    });
  } finally {
    // Persist steps best-effort (never let a step-insert failure block finalization), then ALWAYS
    // move the run to its terminal status — this is what guarantees the row never stays "running".
    try { if (stepRows.length > 0) await db.insert(pipelineSteps).values(stepRows); } catch { /* observability only */ }
    await db.update(pipelineRuns)
      .set({ status, feedsRead, newItems, published: 0, finishedAt: new Date() })
      .where(eq(pipelineRuns.id, runId));
  }

  return { runId, status, produced };
}
