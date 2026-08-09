// lib/diffusion/schedule-core.ts — D1 §5's automatic-publication core (Task 8). Two SEPARATELY
// testable pieces, deliberately kept out of lib/diffusion/scheduler.ts (Task 9's wiring): this
// module owns the "quoi/quand" (pure due-check + candidate selection), the scheduler owns the
// "comment" (looping channels, persisting lastAutoSendAt, calling sendToChannelCore). Neither
// function here touches send-core.ts or writes anything.
import { and, asc, eq, gte, inArray, lte, notExists, sql } from "drizzle-orm";
import { db, articles, distributions } from "@/db";
import type { Channel } from "@/lib/studio";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export type IsDueInput = {
  now: Date;
  lastAutoSendAt: Date | null;
  autoIntervalHours: number;
  autoWindowStartHour: number;
  autoWindowEndHour: number;
};

// Window check, half-open [start, end) in the SERVER PROCESS's local time (now.getHours()) —
// nothing else in this codebase carries a per-tenant/per-channel timezone concept, so this matches
// every other hour-based check that exists today rather than inventing one just for this feature.
//
// Supports a window that WRAPS MIDNIGHT (e.g. 22 -> 6, "post overnight"): when start > end,
// "inside" means hour >= start OR hour < end, instead of the normal start <= hour < end. Decision:
// support it rather than reject it — the extra branch is trivial, and two plain hour fields give an
// admin no other way to express an overnight window. start === end is treated as "open all day"
// (not "never open") — the more useful reading of a degenerate range nobody would set on purpose.
function isWithinWindow(now: Date, startHour: number, endHour: number): boolean {
  const hour = now.getHours();
  if (startHour === endHour) return true;
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  return hour >= startHour || hour < endHour;
}

// isDue — D1 §5's échéance check, PURE (no DB, no I/O). Outside the window, returns false WITHOUT
// even looking at lastAutoSendAt/autoIntervalHours — the caller (lib/diffusion/scheduler.ts) only
// ever persists a new lastAutoSendAt when it actually attempts a send, so a tick this function
// refuses never consumes the interval (spec §5: "un média ne poste pas à 4h du matin").
export function isDue(input: IsDueInput): boolean {
  const { now, lastAutoSendAt, autoIntervalHours, autoWindowStartHour, autoWindowEndHour } = input;
  if (!isWithinWindow(now, autoWindowStartHour, autoWindowEndHour)) return false;
  if (lastAutoSendAt === null) return true;
  return now.getTime() - lastAutoSendAt.getTime() >= autoIntervalHours * HOUR_MS;
}

export type SelectNextArticleInput = { channel: Channel; now: Date; maxBacklogDays: number };
export type NextArticleCandidate = { id: string; publishedAt: Date; title: string };

// selectNextArticle — D1 §5's selection. `articles.status = 'published'`, `publishedAt` within
// `[now - maxBacklogDays, now]` (both bounds inclusive), no `distributions` row for THIS channel in
// status 'pending' or 'sent' (a 'failed' row does NOT exclude — a failure must stay retryable by
// the scheduler), ordered by `publishedAt` ASCENDING, limit 1.
//
// That ascending sort IS the user's rule ("du plus ancien au plus récent... s'il n'y a plus rien
// pour aujourd'hui, il regarde les articles de la veille, et ainsi de suite"): an unsent article
// from yesterday has an earlier publishedAt than every one of today's, so it sorts first
// automatically — the "walk back a day, then another" behavior falls out of ORDER BY + LIMIT 1 with
// no extra code. DO NOT reintroduce day-by-day iteration (looping "check today, then yesterday,
// then...") — that would hand-roll, with more code and more room for an off-by-one, exactly what
// this single ascending sort already gives for free.
export async function selectNextArticle(
  { channel, now, maxBacklogDays }: SelectNextArticleInput,
): Promise<NextArticleCandidate | null> {
  const since = new Date(now.getTime() - maxBacklogDays * DAY_MS);

  const [row] = await db
    .select({ id: articles.id, publishedAt: articles.publishedAt, title: articles.title })
    .from(articles)
    .where(and(
      eq(articles.status, "published"),
      gte(articles.publishedAt, since),
      lte(articles.publishedAt, now),
      notExists(
        db.select({ one: sql`1` }).from(distributions).where(and(
          eq(distributions.articleId, articles.id),
          eq(distributions.channel, channel),
          inArray(distributions.status, ["pending", "sent"]),
        )),
      ),
    ))
    .orderBy(asc(articles.publishedAt))
    .limit(1);

  // publishedAt is nullable in the column type, but articles_published_has_date (db/schema.ts)
  // guarantees it is set whenever status = 'published' — the filter above already restricts to
  // that status, so the null case below is defensive only, never reachable in practice.
  if (!row || !row.publishedAt) return null;
  return { id: row.id, publishedAt: row.publishedAt, title: row.title };
}
