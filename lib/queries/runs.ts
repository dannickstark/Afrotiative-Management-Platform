import { db, pipelineRuns, pipelineSteps, rawItems, articles } from "@/db";
import { eq, inArray, asc, gte, sql } from "drizzle-orm";
import { reclaimStaleRuns } from "@/lib/pipeline/overlap";

// SP5 Task 4: the live panel's "active run" now includes a paused run (holding the
// pipeline_runs_one_running slot, same as "running" — see db/schema.ts/lib/pipeline/overlap.ts),
// so it can display its progress-so-far and offer Resume (Task 5).
const ACTIVE_STATUSES = ["running", "paused"] as const;

export type Step = {
  id: string; name: string; status: string; rawItemId: string | null;
  errorMessage: string | null; errorTechnical: string | null; durationMs: number | null;
};

/**
 * Pure grouping helper for the run-detail view: splits a run's steps into feed-/run-level steps
 * (no rawItemId) and per-item groups (attributed via rawItemId), joined against a title/url map.
 * Kept pure (no DB access) so it's unit-testable without a database.
 */
export function groupSteps(steps: Step[], meta: Map<string, { title: string; url: string }>) {
  const feedSteps = steps.filter((s) => !s.rawItemId);
  const order: string[] = [];
  const byItem = new Map<string, Step[]>();
  for (const s of steps) {
    if (!s.rawItemId) continue;
    if (!byItem.has(s.rawItemId)) { byItem.set(s.rawItemId, []); order.push(s.rawItemId); }
    byItem.get(s.rawItemId)!.push(s);
  }
  const items = order.map((rawItemId) => ({
    rawItemId,
    title: meta.get(rawItemId)?.title ?? "(élément inconnu)",
    url: meta.get(rawItemId)?.url ?? "",
    steps: byItem.get(rawItemId)!,
    hasFailure: byItem.get(rawItemId)!.some((s) => s.status === "failed"),
  }));
  return { feedSteps, items };
}

export async function getRunDetail(runId: string) {
  const [run] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId));
  if (!run) return null;
  const steps = (await db.select({
    id: pipelineSteps.id, name: pipelineSteps.name, status: pipelineSteps.status, rawItemId: pipelineSteps.rawItemId,
    errorMessage: pipelineSteps.errorMessage, errorTechnical: pipelineSteps.errorTechnical, durationMs: pipelineSteps.durationMs,
  }).from(pipelineSteps).where(eq(pipelineSteps.runId, runId))) as Step[];
  const itemIds = [...new Set(steps.filter((s) => s.rawItemId).map((s) => s.rawItemId!))];
  const meta = new Map<string, { title: string; url: string }>();
  if (itemIds.length) {
    const rows = await db.select({ id: rawItems.id, title: rawItems.rawTitle, url: rawItems.url })
      .from(rawItems).where(inArray(rawItems.id, itemIds));
    for (const r of rows) meta.set(r.id, { title: r.title ?? "(sans titre)", url: r.url });
  }
  return { run, ...groupSteps(steps, meta) };
}
export type RunDetail = NonNullable<Awaited<ReturnType<typeof getRunDetail>>>;

/**
 * The single currently-active run (or null) — status "running" OR "paused" (SP5 Task 4), with its
 * progress fields and steps-so-far grouped like getRunDetail. Reclaims stale runs first, so a dead
 * "running" row is finalized (→ returns null) rather than shown as forever-running; a "paused" row
 * is never reclaimed (reclaimStaleRuns only ever targets "running" — pause is an intentional
 * parked state, not staleness) and is returned here so the live panel can show its progress and
 * offer Resume. Polled ~1.5s by the live panel.
 */
export async function getActiveRun() {
  await reclaimStaleRuns();
  const [run] = await db.select().from(pipelineRuns).where(inArray(pipelineRuns.status, ACTIVE_STATUSES)).limit(1);
  if (!run) return null;
  const steps = (await db.select({
    id: pipelineSteps.id, name: pipelineSteps.name, status: pipelineSteps.status, rawItemId: pipelineSteps.rawItemId,
    errorMessage: pipelineSteps.errorMessage, errorTechnical: pipelineSteps.errorTechnical, durationMs: pipelineSteps.durationMs,
  }).from(pipelineSteps).where(eq(pipelineSteps.runId, run.id)).orderBy(asc(pipelineSteps.at))) as Step[];
  const itemIds = [...new Set(steps.filter((s) => s.rawItemId).map((s) => s.rawItemId!))];
  const meta = new Map<string, { title: string; url: string }>();
  if (itemIds.length) {
    const rows = await db.select({ id: rawItems.id, title: rawItems.rawTitle, url: rawItems.url })
      .from(rawItems).where(inArray(rawItems.id, itemIds));
    for (const r of rows) meta.set(r.id, { title: r.title ?? "(sans titre)", url: r.url });
  }
  return { run, ...groupSteps(steps, meta) };
}
export type ActiveRun = NonNullable<Awaited<ReturnType<typeof getActiveRun>>>;

// ─────────────────────────────────────────────────────────────────────────────
// SP7 — history trends strip (components/pipeline/run-trends.tsx), derived entirely from existing
// data (pipeline_runs + articles) — no migration, no new table.

export type TrendDay = { day: string; runs: number; failures: number; produced: number };
export type RunTrendsSummary = {
  runs7d: number; articles7d: number; failureRatePct: number; avgDurationSec: number | null;
};

/**
 * Pure day-merge/zero-fill: given the ordered list of day keys making up the window (oldest→newest,
 * 'YYYY-MM-DD') plus the two INDEPENDENTLY grouped aggregates (each keyed by their own 'day'),
 * produce exactly one row per day in the window, zero-filling any day absent from either aggregate.
 *
 * The day-key list is deliberately an INPUT here, not computed by this function from `new
 * Date()`/Date.now() — see getRunTrends below, which derives it from Postgres's own `current_date`
 * instead of the app process's local clock/timezone, so this function stays pure and trivially
 * unit-testable (no Date.now()/timezone dependency at all).
 */
export function mergeDailyTrends(
  dayKeys: readonly string[],
  runsAgg: readonly { day: string; runs: number; failures: number }[],
  producedAgg: readonly { day: string; produced: number }[],
): TrendDay[] {
  const runsByDay = new Map(runsAgg.map((r) => [r.day, r]));
  const producedByDay = new Map(producedAgg.map((p) => [p.day, p.produced]));
  return dayKeys.map((day) => ({
    day,
    runs: runsByDay.get(day)?.runs ?? 0,
    failures: runsByDay.get(day)?.failures ?? 0,
    produced: producedByDay.get(day) ?? 0,
  }));
}

/**
 * Pure summary math over a set of pipeline_runs rows already narrowed to a window (getRunTrends
 * below passes the last 7 days) — no DB access, so unit-testable with synthetic rows.
 *
 * `cancelled` counts as NON-failure: an admin Stop is an intentional action, not a pipeline failure
 * (per the SP7 plan) — only `failed`/`partial` count toward the failure rate. Average duration only
 * considers FINALIZED rows (finishedAt present); a still-active running/paused row (finishedAt null)
 * is excluded from the average rather than treated as zero-duration.
 */
export function summarizeRunsWindow(
  rows: readonly { status: string; startedAt: Date | string; finishedAt: Date | string | null }[],
): { runs: number; failureRatePct: number; avgDurationSec: number | null } {
  const runs = rows.length;
  const failedOrPartial = rows.filter((r) => r.status === "failed" || r.status === "partial").length;
  const failureRatePct = runs > 0 ? Math.round((failedOrPartial / runs) * 1000) / 10 : 0;
  const durations = rows
    .filter((r) => r.finishedAt !== null)
    .map((r) => (new Date(r.finishedAt!).getTime() - new Date(r.startedAt).getTime()) / 1000);
  const avgDurationSec = durations.length > 0
    ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
    : null;
  return { runs, failureRatePct, avgDurationSec };
}

/**
 * `perDay`: one row per day over the last `days` days (default 14) — `runs`/`failures` grouped from
 * pipeline_runs by calendar day of started_at, `produced` grouped from articles by calendar day of
 * coalesce(generated_at, created_at) (the pipeline sets generatedAt; created_at is the fallback for
 * any article without one). The two are grouped by two small SQL aggregate queries (Drizzle `sql`)
 * and merged/zero-filled in JS by the pure mergeDailyTrends helper above.
 *
 * The window's day-key list AND the calendar-day bucketing both use Postgres's own `current_date` /
 * `to_char(...)` — NOT a JS `new Date()` boundary — so this is immune to any mismatch between the
 * app process's local timezone and the DB session's timezone (the same naive-timestamp convention
 * every other pipeline_runs/articles timestamp in this app already relies on, since they're all
 * written DB-side via `defaultNow()`).
 *
 * `summary` is a rolling last-7-days window (not calendar-day bucketed): run count, articles
 * produced, failure rate, and average run duration — computed by the pure summarizeRunsWindow
 * helper above over a plain row fetch, so the arithmetic itself is unit-tested independently of the
 * DB round-trip.
 */
export async function getRunTrends(days = 14): Promise<{ perDay: TrendDay[]; summary: RunTrendsSummary }> {
  const windowDays = Math.max(1, Math.floor(days));

  const [dayKeyRows, runsAggRows, producedAggRows] = await Promise.all([
    db.execute<{ day: string }>(sql`
      select to_char((current_date - g)::date, 'YYYY-MM-DD') as day
      from generate_series(0, ${windowDays - 1}) as g
      order by day
    `),
    db.execute<{ day: string; runs: string; failures: string }>(sql`
      select to_char(${pipelineRuns.startedAt}, 'YYYY-MM-DD') as day,
             count(*) as runs,
             count(*) filter (where ${pipelineRuns.status} in ('failed', 'partial')) as failures
      from ${pipelineRuns}
      where ${pipelineRuns.startedAt} >= current_date - (${windowDays - 1} * interval '1 day')
      group by 1
    `),
    db.execute<{ day: string; produced: string }>(sql`
      select to_char(coalesce(${articles.generatedAt}, ${articles.createdAt}), 'YYYY-MM-DD') as day,
             count(*) as produced
      from ${articles}
      where coalesce(${articles.generatedAt}, ${articles.createdAt}) >= current_date - (${windowDays - 1} * interval '1 day')
      group by 1
    `),
  ]);

  const dayKeys = dayKeyRows.rows.map((r) => r.day);
  const runsAgg = runsAggRows.rows.map((r) => ({ day: r.day, runs: Number(r.runs), failures: Number(r.failures) }));
  const producedAgg = producedAggRows.rows.map((r) => ({ day: r.day, produced: Number(r.produced) }));
  const perDay = mergeDailyTrends(dayKeys, runsAgg, producedAgg);

  const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000);
  const runs7dRows = await db.select({
    status: pipelineRuns.status, startedAt: pipelineRuns.startedAt, finishedAt: pipelineRuns.finishedAt,
  }).from(pipelineRuns).where(gte(pipelineRuns.startedAt, sevenDaysAgo));
  const { runs: runs7d, failureRatePct, avgDurationSec } = summarizeRunsWindow(runs7dRows);

  const producedSince = sql`coalesce(${articles.generatedAt}, ${articles.createdAt})`;
  const articles7d = await db.$count(articles, gte(producedSince, sevenDaysAgo));

  return { perDay, summary: { runs7d, articles7d, failureRatePct, avgDurationSec } };
}
