import { db, feeds, pipelineRuns, pipelineSteps, wpCategories } from "@/db";
import { eq, inArray } from "drizzle-orm";
import { parseFeed } from "@/lib/rss/parse-feed";
import { isSeen, recordRawItem } from "./dedup";
import { stageItem } from "./stages";
import { getPipelineConfig } from "@/lib/config/pipeline-config";
import type { RawItem } from "@/lib/rss/parse-feed";

export type RunTrigger = "manual" | "scheduled";
export type RunStatus = "success" | "partial" | "failed";
export type RunResult = { runId: string; status: RunStatus; produced: number };

type StepRow = {
  runId: string;
  name: string;
  status: "success" | "failed" | "partial";
  durationMs: number | null;
  errorMessage?: string;
  errorTechnical?: string;
};

/**
 * Runs one full pipeline pass: reads active feeds (or a caller-supplied subset), dedups their
 * items, and stages up to `maxItemsPerRun` NEW items into `pending` articles awaiting human
 * review. Never publishes anything itself — `published` is always tallied as 0.
 *
 * Overlap safety: this function does NOT check hasRunningRun() itself. Callers (the
 * manual-trigger action / scheduled endpoint) must call hasRunningRun() BEFORE invoking
 * runPipeline — the very first thing runPipeline does is insert the "running" pipeline_runs
 * row that a subsequent hasRunningRun() call would (correctly) detect.
 *
 * A feed that fails to parse, or an item that fails to stage, is recorded as a failed
 * pipeline_steps row and the run continues with the next feed/item — it never aborts the
 * whole run. Hitting the item cap is recorded explicitly (never a silent truncation).
 */
export async function runPipeline(opts: { triggeredBy: RunTrigger; feedIds?: string[] }): Promise<RunResult> {
  const cfg = getPipelineConfig();

  const [run] = await db.insert(pipelineRuns)
    .values({ triggeredBy: opts.triggeredBy, status: "running" })
    .returning({ id: pipelineRuns.id });
  const runId = run.id;

  const targetFeeds = opts.feedIds !== undefined
    ? (opts.feedIds.length > 0 ? await db.select().from(feeds).where(inArray(feeds.id, opts.feedIds)) : [])
    : await db.select().from(feeds).where(eq(feeds.active, true));

  const categoryRows = await db.select({ name: wpCategories.name }).from(wpCategories);
  const categoryNames = categoryRows.map((c) => c.name);

  const stepRows: StepRow[] = [];
  let feedsRead = 0;
  let feedsFailed = 0;
  let newItems = 0;
  let produced = 0;
  let itemFailures = 0;
  let capHit = false;
  let itemsSkippedInCurrentFeed = 0;
  let feedsNotRead = 0;

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
      const seen = await isSeen(feed.id, item);
      if (seen) continue;

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

  if (stepRows.length > 0) await db.insert(pipelineSteps).values(stepRows);

  const allFeedsFailed = targetFeeds.length > 0 && feedsFailed === targetFeeds.length;
  const status: RunStatus =
    produced === 0 || allFeedsFailed ? "failed"
    : feedsFailed > 0 || itemFailures > 0 || capHit ? "partial"
    : "success";

  await db.update(pipelineRuns)
    .set({ status, feedsRead, newItems, published: 0, finishedAt: new Date() })
    .where(eq(pipelineRuns.id, runId));

  return { runId, status, produced };
}
