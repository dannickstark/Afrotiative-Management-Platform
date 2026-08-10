import { describe, it, expect, afterEach } from "bun:test";
import { db, articles } from "@/db";
import { eq } from "drizzle-orm";
import { isDue, selectNextArticle } from "@/lib/diffusion/schedule-core";

// ─────────────────────────────────────────────────────────────────────────────
// schedule-core (D1 §5, Task 8) — pure due-check + DB-backed selection, exercised against the real
// Neon DB (same convention as tests/diffusion-settings.test.ts). Every test creates its OWN
// article(s) with a fresh UUID and cleans them up in afterEach — distributions rows cascade-delete
// with their article (db/schema.ts's onDelete: "cascade" on distributions.articleId), so deleting
// the article is enough.
// ─────────────────────────────────────────────────────────────────────────────

const CHANNEL = "facebook" as const;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// selectNextArticle picks the SINGLE globally-oldest eligible article across the whole `articles`
// table — there is no per-test namespace to scope it to. Real seed/demo data (bun run db:seed) and
// other test files' articles all sit in this SAME shared dev DB and would otherwise leak into these
// assertions as false "eligible candidates". Anchoring every selectNextArticle test's `now` far in
// the future (2099) sidesteps that cleanly: publishedAt values built relative to this anchor can
// never collide with any real-world data, which is always in the past relative to it — no need for
// fragile narrow real-time windows or per-test data cleanup of rows this file doesn't own.
const FAR_FUTURE = new Date(2099, 0, 15, 12, 0, 0, 0);

let createdArticleIds: string[] = [];

async function createArticle(opts: { publishedAt: Date; title?: string; status?: "published" | "draft" }): Promise<string> {
  const [row] = await db.insert(articles).values({
    title: opts.title ?? "Article de test",
    bodyHtml: "<p>Contenu.</p>",
    status: opts.status ?? "published",
    publishedAt: opts.status === "draft" ? null : opts.publishedAt,
  }).returning({ id: articles.id });
  createdArticleIds.push(row.id);
  return row.id;
}

async function markDistribution(articleId: string, status: "sent" | "failed") {
  const { db: dbLocal, distributions } = await import("@/db");
  await dbLocal.insert(distributions).values({
    articleId, channel: CHANNEL, status,
    ...(status === "sent" ? { sentAt: new Date(), externalId: "test-ext" } : { lastError: "Erreur simulée.", attempts: 1 }),
  });
}

afterEach(async () => {
  for (const id of createdArticleIds) {
    await db.delete(articles).where(eq(articles.id, id));
  }
  createdArticleIds = [];
});

describe("selectNextArticle — ordering (D1 §5, Task 8 — corrected by the D1 final review, Important 1)", () => {
  // The review's own required assertion, verbatim: "with articles from today and from three days
  // ago, all unsent, the next selection must be today's oldest, not the three-day-old one." Also
  // folds in the within-day tie-break (todayLate exists specifically so "today wins" can't be
  // satisfied by accident by a test with only one candidate for today).
  //
  // The ORIGINAL implementation (a single ORDER BY publishedAt ASC across the whole backlog
  // window) would have picked `threeDaysAgo` here — its publishedAt is earlier than either of
  // today's — which is exactly the inverted-priority bug this test exists to catch.
  it("today's OLDEST wins over both today's later article AND an older backlog day", async () => {
    const now = FAR_FUTURE;
    const threeDaysAgo = await createArticle({ publishedAt: new Date(now.getTime() - 3 * DAY_MS), title: "Il y a 3 jours" });
    const todayLate = await createArticle({ publishedAt: new Date(now.getTime() - 1 * HOUR_MS), title: "Aujourd'hui, plus tard" });
    const todayEarly = await createArticle({ publishedAt: new Date(now.getTime() - 3 * HOUR_MS), title: "Aujourd'hui, plus tôt" });

    const result = await selectNextArticle({ channel: CHANNEL, now, maxBacklogDays: 7 });

    expect(result).not.toBeNull();
    expect(result!.id).toBe(todayEarly);
    expect(result!.id).not.toBe(todayLate); // within-day tie-break: oldest TIME wins
    expect(result!.id).not.toBe(threeDaysAgo); // cross-day priority: today's day wins outright
  });

  it("once today is exhausted (all sent), falls back to yesterday's oldest — the day-walk still works", async () => {
    const now = FAR_FUTURE;
    const yesterdayLate = await createArticle({ publishedAt: new Date(now.getTime() - 1 * DAY_MS + 2 * HOUR_MS), title: "Hier, plus tard" });
    const yesterdayEarly = await createArticle({ publishedAt: new Date(now.getTime() - 1 * DAY_MS - 2 * HOUR_MS), title: "Hier, plus tôt" });
    const todayAlreadySent = await createArticle({ publishedAt: new Date(now.getTime() - 1 * HOUR_MS), title: "Aujourd'hui, déjà envoyé" });
    await markDistribution(todayAlreadySent, "sent");

    const result = await selectNextArticle({ channel: CHANNEL, now, maxBacklogDays: 7 });

    expect(result).not.toBeNull();
    expect(result!.id).toBe(yesterdayEarly); // yesterday's oldest, not yesterday's later article
    expect(result!.id).not.toBe(yesterdayLate);
  });
});

describe("selectNextArticle — exclusion rules (D1 §5, Task 8)", () => {
  it("excludes an article already 'sent' on this channel — picks the next-oldest instead", async () => {
    const now = FAR_FUTURE;
    const alreadySent = await createArticle({ publishedAt: new Date(now.getTime() - 2 * DAY_MS), title: "Déjà envoyé" });
    const notYetSent = await createArticle({ publishedAt: new Date(now.getTime() - 1 * DAY_MS), title: "Pas encore envoyé" });
    await markDistribution(alreadySent, "sent");

    const result = await selectNextArticle({ channel: CHANNEL, now, maxBacklogDays: 7 });

    expect(result).not.toBeNull();
    expect(result!.id).toBe(notYetSent);
  });

  it("does NOT exclude a 'failed' row — a failed send must remain retryable by the scheduler", async () => {
    const now = FAR_FUTURE;
    const failedOnce = await createArticle({ publishedAt: new Date(now.getTime() - 1 * DAY_MS), title: "Échec précédent" });
    await markDistribution(failedOnce, "failed");

    const result = await selectNextArticle({ channel: CHANNEL, now, maxBacklogDays: 7 });

    expect(result).not.toBeNull();
    expect(result!.id).toBe(failedOnce);
  });

  it("excludes an article with a 'pending' row on this channel (a send already in flight)", async () => {
    const now = FAR_FUTURE;
    const inFlight = await createArticle({ publishedAt: new Date(now.getTime() - 1 * DAY_MS), title: "En cours" });
    const { db: dbLocal, distributions } = await import("@/db");
    await dbLocal.insert(distributions).values({ articleId: inFlight, channel: CHANNEL, status: "pending" });

    const result = await selectNextArticle({ channel: CHANNEL, now, maxBacklogDays: 7 });
    expect(result).toBeNull();
  });
});

describe("selectNextArticle — maxBacklogDays boundary (D1 §5, Task 8)", () => {
  it("includes an article published EXACTLY at the maxBacklogDays boundary (inclusive lower bound)", async () => {
    const now = FAR_FUTURE;
    const atBoundary = await createArticle({ publishedAt: new Date(now.getTime() - 3 * DAY_MS) });

    const result = await selectNextArticle({ channel: CHANNEL, now, maxBacklogDays: 3 });
    expect(result).not.toBeNull();
    expect(result!.id).toBe(atBoundary);
  });

  it("excludes an article published just BEFORE the maxBacklogDays boundary", async () => {
    const now = FAR_FUTURE;
    await createArticle({ publishedAt: new Date(now.getTime() - 3 * DAY_MS - 60_000) }); // 1 min older than the cutoff

    const result = await selectNextArticle({ channel: CHANNEL, now, maxBacklogDays: 3 });
    expect(result).toBeNull();
  });

  it("excludes an article published in the future (beyond `now`, the upper bound)", async () => {
    const now = FAR_FUTURE;
    await createArticle({ publishedAt: new Date(now.getTime() + DAY_MS) });

    const result = await selectNextArticle({ channel: CHANNEL, now, maxBacklogDays: 7 });
    expect(result).toBeNull();
  });
});

describe("selectNextArticle — irrelevant rows never leak in", () => {
  it("ignores a non-'published' article entirely, even inside the backlog window", async () => {
    const now = FAR_FUTURE;
    await createArticle({ publishedAt: new Date(now.getTime() - DAY_MS), status: "draft" });

    const result = await selectNextArticle({ channel: CHANNEL, now, maxBacklogDays: 7 });
    expect(result).toBeNull();
  });

  it("a 'sent' row on a DIFFERENT channel does not exclude this channel's candidate", async () => {
    const now = FAR_FUTURE;
    const id = await createArticle({ publishedAt: new Date(now.getTime() - DAY_MS) });
    const { db: dbLocal, distributions } = await import("@/db");
    await dbLocal.insert(distributions).values({ articleId: id, channel: "instagram", status: "sent", sentAt: new Date(), externalId: "x" });

    const result = await selectNextArticle({ channel: CHANNEL, now, maxBacklogDays: 7 });
    expect(result).not.toBeNull();
    expect(result!.id).toBe(id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isDue — pure, no DB. Fixed calendar date (2026-01-15) constructed via the LOCAL Date
// constructor so `.getHours()` matches the hour we asked for regardless of the host machine's
// timezone — no flakiness from running in CI vs a dev laptop in a different TZ.
// ─────────────────────────────────────────────────────────────────────────────
function at(hour: number, minute = 0): Date {
  return new Date(2026, 0, 15, hour, minute, 0, 0);
}

describe("isDue — échéance (D1 §5, Task 8)", () => {
  const WINDOW = { autoWindowStartHour: 8, autoWindowEndHour: 20 }; // covers noon

  it("false when lastAutoSendAt is more recent than the interval allows", () => {
    const now = at(12, 0);
    const lastAutoSendAt = new Date(now.getTime() - 5 * HOUR_MS); // 5h ago
    expect(isDue({ now, lastAutoSendAt, autoIntervalHours: 6, ...WINDOW })).toBe(false);
  });

  it("true once the interval has fully elapsed", () => {
    const now = at(12, 0);
    const lastAutoSendAt = new Date(now.getTime() - 7 * HOUR_MS); // 7h ago, interval is 6h
    expect(isDue({ now, lastAutoSendAt, autoIntervalHours: 6, ...WINDOW })).toBe(true);
  });

  it("true immediately when lastAutoSendAt is null (never sent before) and inside the window", () => {
    const now = at(12, 0);
    expect(isDue({ now, lastAutoSendAt: null, autoIntervalHours: 6, ...WINDOW })).toBe(true);
  });

  it("outside the window: false regardless of interval, EVEN when lastAutoSendAt is null", () => {
    const now = at(21, 0); // window is 08h-20h; 21h is outside
    expect(isDue({ now, lastAutoSendAt: null, autoIntervalHours: 1, ...WINDOW })).toBe(false);
    expect(isDue({ now, lastAutoSendAt: new Date(now.getTime() - 100 * HOUR_MS), autoIntervalHours: 1, ...WINDOW })).toBe(false);
  });

  it("window wraps midnight (22h -> 6h): inside overnight, outside during the day", () => {
    const wrap = { autoWindowStartHour: 22, autoWindowEndHour: 6 };
    // Inside the wrapped window.
    expect(isDue({ now: at(23, 0), lastAutoSendAt: null, autoIntervalHours: 1, ...wrap })).toBe(true);
    expect(isDue({ now: at(2, 0), lastAutoSendAt: null, autoIntervalHours: 1, ...wrap })).toBe(true);
    expect(isDue({ now: at(22, 0), lastAutoSendAt: null, autoIntervalHours: 1, ...wrap })).toBe(true); // start hour is inclusive
    // Outside the wrapped window.
    expect(isDue({ now: at(10, 0), lastAutoSendAt: null, autoIntervalHours: 1, ...wrap })).toBe(false);
    expect(isDue({ now: at(21, 0), lastAutoSendAt: null, autoIntervalHours: 1, ...wrap })).toBe(false);
    expect(isDue({ now: at(6, 0), lastAutoSendAt: null, autoIntervalHours: 1, ...wrap })).toBe(false); // end hour is exclusive
  });
});
