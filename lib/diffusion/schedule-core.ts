// lib/diffusion/schedule-core.ts — D1 §5's automatic-publication core (Task 8). Two SEPARATELY
// testable pieces, deliberately kept out of lib/diffusion/scheduler.ts (Task 9's wiring): this
// module owns the "quoi/quand" (pure due-check + candidate selection), the scheduler owns the
// "comment" (looping channels, persisting lastAutoSendAt, calling sendToChannelCore). Neither
// function here touches send-core.ts or writes anything.
import { and, asc, desc, eq, gte, inArray, lte, notExists, notInArray, sql } from "drizzle-orm";
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

export type SelectNextArticleInput = {
  channel: Channel;
  now: Date;
  maxBacklogDays: number;
  // Important 2 (2026-08-09 fix wave): candidate ids to skip even though they'd otherwise be
  // eligible — used ONLY by lib/diffusion/scheduler.ts's tickChannel to route around a candidate
  // that sendToChannelCore just refused BEFORE writing any distributions row (render failure, R2
  // unconfigured, no `social_post` template). Left out of every other caller/test — an empty/
  // omitted array is a no-op, identical to the pre-existing query.
  excludeIds?: readonly string[];
};
export type NextArticleCandidate = { id: string; publishedAt: Date; title: string };

// selectNextArticle — D1 §5's selection. `articles.status = 'published'`, `publishedAt` within
// `[now - maxBacklogDays, now]` (both bounds inclusive), no `distributions` row for THIS channel in
// status 'pending' or 'sent' (a 'failed' row does NOT exclude — a failure must stay retryable by
// the scheduler), limit 1.
//
// ORDER BY date_trunc('day', published_at) DESC, published_at ASC — the CALENDAR DAY comes first,
// most-recent day first; only WITHIN a day does time break the tie, oldest first. This is the
// user's actual rule ("choisit un article publié le jour même... du plus ancien au plus récent ;
// si tout est déjà envoyé, remonte à la veille" — README.md, docs/DEPLOYMENT.md §6.5,
// components/settings/social-channel-form.tsx): today's oldest-unsent article must outrank
// EVERY unsent article from a previous day, no matter how much earlier it was published.
//
// A single global ORDER BY publishedAt ASC (this module's original implementation) does NOT give
// that — it hands priority to whichever unsent article is oldest ACROSS THE WHOLE BACKLOG WINDOW,
// so a 3-day-old unsent article would outrank everything published today. That inverted the user's
// rule (caught in the D1 final review, 2026-08-09): today must be exhausted before yesterday is
// even considered, not "sorted after" in a single flat ordering by timestamp.
//
// NOTE on "day", precisely: `articles.published_at` is `timestamp` WITHOUT time zone (db/schema.ts),
// and this codebase's pg driver stores a JS Date's UTC digits into it verbatim (verified directly:
// inserting a local-noon Date lands as that same instant's UTC wall-clock text in the column) — so
// date_trunc('day', ...) here buckets by UTC calendar day, NOT the server process's local calendar
// day the way isWithinWindow's `now.getHours()` reads local wall time. These two ARE different
// clocks. Not fixed here: no per-tenant/per-channel timezone concept exists anywhere in this
// codebase, and the D1 final review explicitly deferred the analogous "window hours are
// server-local" looseness rather than asking for a timezone model — this ordering fix inherits
// that same accepted simplification rather than expanding its scope.
//
// Still no day-by-day LOOP: ORDER BY + LIMIT 1 gives the whole "walk back a day, then another"
// behavior in one query — reintroducing a day-by-day iteration would hand-roll, with more code and
// more room for an off-by-one, exactly what this two-key sort already gives for free.
export async function selectNextArticle(
  { channel, now, maxBacklogDays, excludeIds }: SelectNextArticleInput,
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
      excludeIds && excludeIds.length > 0 ? notInArray(articles.id, excludeIds as string[]) : undefined,
    ))
    .orderBy(desc(sql`date_trunc('day', ${articles.publishedAt})`), asc(articles.publishedAt))
    .limit(1);

  // publishedAt is nullable in the column type, but articles_published_has_date (db/schema.ts)
  // guarantees it is set whenever status = 'published' — the filter above already restricts to
  // that status, so the null case below is defensive only, never reachable in practice.
  if (!row || !row.publishedAt) return null;
  return { id: row.id, publishedAt: row.publishedAt, title: row.title };
}
