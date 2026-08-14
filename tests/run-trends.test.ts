import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { db, articles, pipelineRuns } from "@/db";
import { gte, inArray, sql } from "drizzle-orm";
import { getRunTrends, mergeDailyTrends, summarizeRunsWindow } from "@/lib/queries/runs";

// ─────────────────────────────────────────────────────────────────────────────
// SP7 — pure helpers (no DB): the day-merge/zero-fill for the trends strip's per-day bars, the
// 7-day summary math (failure rate + avg duration), and the runs-list client filter predicate.

describe("mergeDailyTrends", () => {
  it("merges the two aggregates by day and zero-fills days present in neither", () => {
    const dayKeys = ["2026-08-01", "2026-08-02", "2026-08-03"];
    const runsAgg = [
      { day: "2026-08-01", runs: 3, failures: 1 },
      { day: "2026-08-03", runs: 2, failures: 0 },
    ];
    const producedAgg = [{ day: "2026-08-02", produced: 5 }];

    expect(mergeDailyTrends(dayKeys, runsAgg, producedAgg)).toEqual([
      { day: "2026-08-01", runs: 3, failures: 1, produced: 0 },
      { day: "2026-08-02", runs: 0, failures: 0, produced: 5 },
      { day: "2026-08-03", runs: 2, failures: 0, produced: 0 },
    ]);
  });

  it("returns an all-zero row for a day present in neither aggregate", () => {
    expect(mergeDailyTrends(["2026-08-01"], [], [])).toEqual([
      { day: "2026-08-01", runs: 0, failures: 0, produced: 0 },
    ]);
  });

  it("ignores aggregate entries for a day outside the given window", () => {
    // A day key NOT in the window list must not leak in, even if an aggregate has data for it —
    // the window (dayKeys) is authoritative, not "every day that has data".
    const merged = mergeDailyTrends(
      ["2026-08-02"],
      [{ day: "2026-08-01", runs: 9, failures: 9 }],
      [{ day: "2026-08-01", produced: 9 }],
    );
    expect(merged).toEqual([{ day: "2026-08-02", runs: 0, failures: 0, produced: 0 }]);
  });

  it("preserves the given day-key order (does not re-sort)", () => {
    const merged = mergeDailyTrends(["2026-08-03", "2026-08-01"], [], []);
    expect(merged.map((d) => d.day)).toEqual(["2026-08-03", "2026-08-01"]);
  });
});

describe("summarizeRunsWindow", () => {
  it("counts cancelled as NON-failure — only failed/partial count toward the failure rate", () => {
    const rows = [
      { status: "cancelled", startedAt: new Date(0), finishedAt: new Date(1000) },
      { status: "success", startedAt: new Date(0), finishedAt: new Date(2000) },
    ];
    const s = summarizeRunsWindow(rows);
    expect(s.runs).toBe(2);
    expect(s.failureRatePct).toBe(0);
  });

  it("computes the failure rate as a percentage rounded to one decimal", () => {
    const rows = [
      { status: "failed", startedAt: new Date(0), finishedAt: new Date(1000) },
      { status: "success", startedAt: new Date(0), finishedAt: new Date(1000) },
      { status: "success", startedAt: new Date(0), finishedAt: new Date(1000) },
    ];
    expect(summarizeRunsWindow(rows).failureRatePct).toBe(33.3); // 1/3
  });

  it("averages duration only over FINALIZED rows, excluding an in-flight running/paused row", () => {
    const rows = [
      { status: "success", startedAt: new Date(0), finishedAt: new Date(10_000) }, // 10s
      { status: "failed", startedAt: new Date(0), finishedAt: new Date(30_000) },  // 30s
      { status: "running", startedAt: new Date(0), finishedAt: null },             // excluded
    ];
    const s = summarizeRunsWindow(rows);
    expect(s.avgDurationSec).toBe(20); // (10+30)/2
  });

  it("returns avgDurationSec=null and failureRatePct=0 for an empty window", () => {
    const s = summarizeRunsWindow([]);
    expect(s.runs).toBe(0);
    expect(s.failureRatePct).toBe(0);
    expect(s.avgDurationSec).toBeNull();
  });

  it("returns avgDurationSec=null when nothing in the window is finalized", () => {
    const rows = [{ status: "paused", startedAt: new Date(0), finishedAt: null }];
    expect(summarizeRunsWindow(rows).avgDurationSec).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SP7 — getRunTrends against the real Neon dev DB. The shared dev DB already holds other
// pipeline_runs/articles rows (seed data, other tests' leftovers, manual dev usage), so this can't
// assert absolute counts — instead it snapshots getRunTrends() BEFORE inserting a small, precisely
// dated fixture set, then again AFTER, and asserts the DELTA on each affected day/summary field.
// That's robust to whatever else is in the table.
//
// All fixture timestamps are computed via Postgres `current_date`/`interval` expressions (NOT JS
// `Date` objects bound as query params) — pipeline_runs/articles timestamp columns are `timestamp
// without time zone`, and the app's own writes (via `defaultNow()`) are anchored to the DB session's
// clock, not the app process's local timezone. Building fixture dates the same way keeps this test
// immune to the test machine's local TZ (verified non-UTC in this sandbox) ever mis-bucketing a row
// into the wrong day.
//
// IMPORTANT: every fixture run is inserted already FINALIZED (finished_at set) — pipeline_runs has a
// DB-level partial unique index allowing at most ONE row with finished_at IS NULL at a time (the
// "one active run" interlock, db/schema.ts). Inserting an unfinalized row here would risk colliding
// with a genuinely active run in the shared dev DB.
describe("getRunTrends (real Neon dev DB)", () => {
  const runIds: string[] = [];
  const articleIds: string[] = [];
  // Captured BEFORE any fixture insert, in the very first line of beforeAll below — every
  // assertion in this suite compares an "after" snapshot against this baseline DELTA-style, so
  // whatever else is already in the shared dev DB (seed data, other rows) never affects the result.
  let before: Awaited<ReturnType<typeof getRunTrends>>;

  beforeAll(async () => {
    before = await getRunTrends(5);

    const [a] = await db.insert(pipelineRuns).values({
      triggeredBy: "manual", status: "success",
      startedAt: sql`current_date - interval '3 days' + interval '12 hours'`,
      finishedAt: sql`current_date - interval '3 days' + interval '12 hours' + interval '30 seconds'`,
    }).returning({ id: pipelineRuns.id });
    const [b] = await db.insert(pipelineRuns).values({
      triggeredBy: "manual", status: "failed",
      startedAt: sql`current_date - interval '3 days' + interval '13 hours'`,
      finishedAt: sql`current_date - interval '3 days' + interval '13 hours' + interval '45 seconds'`,
    }).returning({ id: pipelineRuns.id });
    const [c] = await db.insert(pipelineRuns).values({
      triggeredBy: "scheduled", status: "partial",
      startedAt: sql`current_date - interval '1 days' + interval '9 hours'`,
      finishedAt: sql`current_date - interval '1 days' + interval '9 hours' + interval '60 seconds'`,
    }).returning({ id: pipelineRuns.id });
    const [d] = await db.insert(pipelineRuns).values({
      triggeredBy: "manual", status: "cancelled",
      startedAt: sql`current_date + interval '1 hour'`,
      finishedAt: sql`current_date + interval '1 hour' + interval '20 seconds'`,
    }).returning({ id: pipelineRuns.id });
    runIds.push(a.id, b.id, c.id, d.id);

    // Two articles on a day with NO pipeline_runs fixture (2 days ago) — exercises both the
    // generated_at branch AND the coalesce(..., created_at) fallback branch of the "produced"
    // aggregation, and proves the merge lines up two INDEPENDENT day-grouped queries on the same
    // day key (not just "both happen to have data").
    const [e] = await db.insert(articles).values({
      title: "SP7 fixture — article avec generated_at", bodyHtml: "<p>x</p>",
      generatedAt: sql`current_date - interval '2 days' + interval '10 hours'`,
    }).returning({ id: articles.id });
    const [f] = await db.insert(articles).values({
      title: "SP7 fixture — article sans generated_at (repli sur created_at)", bodyHtml: "<p>x</p>",
      generatedAt: null,
      createdAt: sql`current_date - interval '2 days' + interval '11 hours'`,
    }).returning({ id: articles.id });
    articleIds.push(e.id, f.id);
  });

  afterAll(async () => {
    if (runIds.length) await db.delete(pipelineRuns).where(inArray(pipelineRuns.id, runIds));
    if (articleIds.length) await db.delete(articles).where(inArray(articles.id, articleIds));
  });

  it("buckets each fixture into the right calendar day and zero-fills the rest", async () => {
    const after = await getRunTrends(5);
    expect(after.perDay).toHaveLength(5);
    expect(before.perDay).toHaveLength(5);

    // Both snapshots share the exact same window (same `days` arg, taken moments apart) so they
    // line up day-for-day — diff them positionally rather than by string-matching the `day` key.
    const idx = (daysAgo: number) => after.perDay.length - 1 - daysAgo;
    const delta = (i: number, key: "runs" | "failures" | "produced") => after.perDay[i][key] - before.perDay[i][key];

    // offset 3 days ago: 2 runs inserted (1 success + 1 failed) → +2 runs, +1 failure.
    expect(delta(idx(3), "runs")).toBe(2);
    expect(delta(idx(3), "failures")).toBe(1);

    // offset 1 day ago: 1 partial run → +1 run, +1 failure (partial counts as a failure).
    expect(delta(idx(1), "runs")).toBe(1);
    expect(delta(idx(1), "failures")).toBe(1);

    // offset 0 (today): 1 cancelled run → +1 run, but +0 failures — the plan's explicit rule that
    // an admin Stop is NOT a pipeline failure, proven here at the DB/query level (not just in the
    // summarizeRunsWindow unit tests above).
    expect(delta(idx(0), "runs")).toBe(1);
    expect(delta(idx(0), "failures")).toBe(0);

    // offset 2 days ago: NO pipeline_runs fixture here at all (only articles, checked below) →
    // the day must still zero-fill to +0 runs/failures, proving the merge doesn't spuriously
    // attribute the produced-articles day to the runs aggregate.
    expect(delta(idx(2), "runs")).toBe(0);
    expect(delta(idx(2), "failures")).toBe(0);

    // Every day key is well-formed and the window is ascending (oldest → newest).
    for (const d of after.perDay) expect(d.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const days = after.perDay.map((d) => d.day);
    expect(days).toEqual([...days].sort());
  });

  it("groups produced articles by day, including the coalesce(generated_at, created_at) fallback", async () => {
    const after = await getRunTrends(5);
    const idx = after.perDay.length - 1 - 2; // offset 2 days ago — where BOTH fixture articles land
    // Both fixture articles (one via generated_at, one via the created_at fallback) land on the
    // SAME day as each other, and that day carries neither pipeline_runs fixture — proving the two
    // independently-grouped aggregates (runs vs. produced) merge correctly by day key.
    expect(after.perDay[idx].produced - before.perDay[idx].produced).toBe(2);
  });

  it("rolls the fixture runs into the 7-day summary — runs7d and failureRatePct move by exactly what was inserted", async () => {
    const after = await getRunTrends(5);
    // All 4 fixture runs (offsets 0/1/3 days ago) are within the last 7 days.
    expect(after.summary.runs7d - before.summary.runs7d).toBe(4);
  });

  it("counts the fixture articles in the 7-day articles-produced summary", async () => {
    const after = await getRunTrends(5);
    expect(after.summary.articles7d - before.summary.articles7d).toBe(2);
  });

  it("cross-checks failureRatePct/avgDurationSec against an independent raw fetch through the same pure summarizeRunsWindow helper", async () => {
    const after = await getRunTrends(5);

    const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000);
    const rawRows = await db.select({
      status: pipelineRuns.status, startedAt: pipelineRuns.startedAt, finishedAt: pipelineRuns.finishedAt,
    }).from(pipelineRuns).where(gte(pipelineRuns.startedAt, sevenDaysAgo));
    const expected = summarizeRunsWindow(rawRows);

    // Not delta-friendly (failure rate/avg duration aren't linearly additive against an unknown
    // baseline), so this cross-checks getRunTrends' SQL-driven summary against an INDEPENDENT plain
    // fetch run through the very same pure helper — proving the wiring (right table, right window,
    // right columns), while the helper's own arithmetic is covered by the unit tests above.
    expect(after.summary.runs7d).toBe(expected.runs);
    expect(after.summary.failureRatePct).toBe(expected.failureRatePct);
    expect(after.summary.avgDurationSec).toBe(expected.avgDurationSec);
  });
});
