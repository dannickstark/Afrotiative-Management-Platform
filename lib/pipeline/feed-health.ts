import { db, feeds, rawItems } from "@/db";
import { and, eq, gte, sql } from "drizzle-orm";

// ---- SP8: real feed-health tracking ----
// feeds.lastFetchAt / lastFetchStatus / itemsCaptured7d already existed and were already DISPLAYED
// in components/settings/feeds-table.tsx, but nothing wrote them except db/seed.ts — the health
// shown on /settings/feeds was fake/stale. This module makes it real: deriveFeedHealth is a pure
// state-derivation function (unit-tested, no I/O); updateFeedHealth is the DB-writing helper the
// runner's phase-1 feed-read loop (lib/pipeline/run.ts's executeRun) calls after every feed parse
// attempt, success or failure.

export type FeedFetchOutcome = "success" | "failure";

export type FeedHealth = "healthy" | "degraded" | "failing" | "idle";

// The minimal subset of a `feeds` row deriveFeedHealth needs. `Feed` (lib/queries/settings.ts) is
// a structural superset of this, so a real row satisfies it directly — kept minimal here so pure
// unit tests (tests/feed-health.test.ts) can build fixtures without a real DB row.
export type FeedHealthInput = {
  active: boolean;
  lastFetchStatus: "ok" | "error" | "never";
  consecutiveFailures: number;
  itemsCaptured7d: number;
};

/**
 * Derives a single at-a-glance health state for a feed — pure, no I/O. Thresholds (SP8 plan),
 * checked in this order (each returns as soon as it matches):
 *
 *  1. `idle`     — never yet successfully/unsuccessfully read (`lastFetchStatus === "never"`), OR
 *                  the admin turned it off (`active === false`). Checked FIRST and wins over every
 *                  other signal: an inactive feed isn't "failing" just because it failed before it
 *                  was switched off — it's simply not being watched right now.
 *  2. `failing`  — the most recent read errored (`lastFetchStatus === "error"`), OR it has failed
 *                  3+ times in a row (`consecutiveFailures >= 3`). The streak alone is decisive
 *                  even in the (should-not-happen-in-practice, but defensive) case where the
 *                  status field disagrees — a feed that failed 3 times straight is failing.
 *  3. `degraded` — recovering-but-shaky: 1-2 consecutive failures, OR the last read succeeded but
 *                  captured ZERO items in the last 7 days (works, but has gone quiet — often the
 *                  first visible sign of a source going stale/dead before it starts erroring).
 *  4. `healthy`  — none of the above: reads succeed and items keep showing up.
 */
export function deriveFeedHealth(feed: FeedHealthInput): FeedHealth {
  if (!feed.active || feed.lastFetchStatus === "never") return "idle";
  if (feed.lastFetchStatus === "error" || feed.consecutiveFailures >= 3) return "failing";
  if (feed.consecutiveFailures >= 1 || feed.itemsCaptured7d === 0) return "degraded";
  return "healthy";
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Best-effort feed-health writer. Called from executeRun's phase-1 feed-read loop right after each
 * feed's parseFeed() attempt resolves (success or throw), from INSIDE that feed's existing
 * try/catch — the call site wraps this in its OWN try/catch on top (per the SP8 plan's
 * constraint: "a health-update failure must NEVER fail the run"), so this function itself does
 * NOT swallow its errors — it stays a plain, directly-testable/assertable DB write.
 *
 * `"success"`: sets `lastFetchAt = now`, `lastFetchStatus = "ok"`, resets `consecutiveFailures` to
 * 0, and RECOMPUTES `itemsCaptured7d` as `count(raw_items) where feed_id = ? and fetched_at >=
 * now() - 7 days`.
 *
 * NOTE on timing: this recompute runs in phase 1, BEFORE this run's own new items are recorded —
 * recordRawItem() happens later, per-story, in phase 2 (only for candidates that survive dedup +
 * grouping). So a run's own newly-captured items are reflected starting from the NEXT run's phase
 * 1, not this one. This is a one-run lag, not a bug: raw_items persists across runs, so the count
 * self-corrects on the very next read of this feed.
 *
 * `"failure"`: sets `lastFetchAt = now`, `lastFetchStatus = "error"`, and increments
 * `consecutiveFailures` ATOMICALLY in SQL (`consecutive_failures + 1`, not read-then-write) so a
 * concurrent update can't lose an increment. `itemsCaptured7d` is left untouched — a failed read
 * captured nothing new to recompute from.
 */
export async function updateFeedHealth(feedId: string, outcome: FeedFetchOutcome): Promise<void> {
  const now = new Date();
  if (outcome === "success") {
    const itemsCaptured7d = await db.$count(
      rawItems,
      and(eq(rawItems.feedId, feedId), gte(rawItems.fetchedAt, new Date(Date.now() - SEVEN_DAYS_MS))),
    );
    await db.update(feeds).set({
      lastFetchAt: now, lastFetchStatus: "ok", consecutiveFailures: 0, itemsCaptured7d,
    }).where(eq(feeds.id, feedId));
  } else {
    await db.update(feeds).set({
      lastFetchAt: now, lastFetchStatus: "error",
      consecutiveFailures: sql`${feeds.consecutiveFailures} + 1`,
    }).where(eq(feeds.id, feedId));
  }
}
