import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { db, articles, wpCategories, renderTemplates, renderTemplateVersions, renders, distributions, articleRevisions, socialChannelSettings, alerts } from "@/db";
import { eq, and, inArray } from "drizzle-orm";
import sharp from "sharp";
import { triggerDiffusionTick, reclaimStalePendingDistributions } from "@/lib/diffusion/scheduler";
import { getChannelSettings, setLastAutoSendAt } from "@/lib/diffusion/settings-core";
import { SOCIAL_CHANNELS, type SocialChannel, type SendInput, type SendResult } from "@/lib/diffusion/channels";
import { MemoryRenderStore } from "@/lib/studio/store";
import { FB_TEMPLATE } from "@/db/studio-templates";
import type { Channel } from "@/lib/studio";
import { initScheduler, triggerScheduledDiffusionTick, getDiffusionSchedulerJob } from "@/lib/pipeline/scheduler";

// ─────────────────────────────────────────────────────────────────────────────
// triggerDiffusionTick (D1 §5, Task 9) — real Neon DB + a Bun.serve fake image host, same overall
// shape as tests/diffusion-send.test.ts. Two dedicated channels ("x", "whatsapp"): neither has a
// starter render_templates row seeded by db/studio-templates.ts (only facebook/instagram do), and
// every render_templates row this file creates is scoped to a FRESH per-run categoryId — never a
// static (channel, null) scope — so there is nothing here to register in tests/studio-fixtures.ts's
// registry (its own rule: a fresh categoryId is "structurally collision-free", exactly the
// (article_image, null, <categoryId>) precedent documented there).
//
// `now` is anchored far in the future (2099) for every test that calls selectNextArticle indirectly
// (i.e. every test except "not-due", whose article is never even queried) — same reasoning as
// tests/diffusion-schedule.test.ts: selectNextArticle picks the globally-oldest eligible article
// across the WHOLE articles table, and this dev DB has real seed/demo published articles that would
// otherwise leak in as false candidates.
// ─────────────────────────────────────────────────────────────────────────────

const CH_A = "x" as const;
const CH_B = "whatsapp" as const;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const FAR_FUTURE = new Date(2099, 0, 15, 12, 0, 0, 0);

let server: ReturnType<typeof Bun.serve>;
let categoryId: string;
let templateIdA: string;
let templateIdB: string;
let imageUrl: string;

let createdArticleIds: string[] = [];

async function createArticle(offsetDays: number, title: string): Promise<string> {
  const [row] = await db.insert(articles).values({
    title, bodyHtml: "<p>Contenu.</p>", status: "published",
    publishedAt: new Date(FAR_FUTURE.getTime() - offsetDays * DAY_MS),
    categoryId, featuredImageUrl: imageUrl,
  }).returning({ id: articles.id });
  createdArticleIds.push(row.id);
  return row.id;
}

async function deleteChannelSettings() {
  await db.delete(socialChannelSettings).where(inArray(socialChannelSettings.channel, [CH_A, CH_B]));
}

// DELETE-then-INSERT, not a bare insert: several tests call this TWICE for the same channel (an
// initial setup, then a "reset" mid-test to simulate the channel becoming healthy again) — a bare
// insert would hit social_channel_settings' primary key (channel) on the second call.
async function insertChannelSettings(channel: Channel, overrides: Partial<typeof socialChannelSettings.$inferInsert> = {}) {
  await db.delete(socialChannelSettings).where(eq(socialChannelSettings.channel, channel));
  await db.insert(socialChannelSettings).values({
    channel, enabled: true, captionMaxChars: SOCIAL_CHANNELS[channel].captionLimits.default,
    autoEnabled: true, autoIntervalHours: 6, autoMaxBacklogDays: 30,
    // 0/0 is schedule-core.ts's documented "open all day" degenerate case — removes the window
    // from consideration entirely so these tests exercise only isDue's INTERVAL logic, not the
    // window (already covered on its own in tests/diffusion-schedule.test.ts).
    autoWindowStartHour: 0, autoWindowEndHour: 0,
    lastAutoSendAt: null,
    ...overrides,
  });
}

async function distributionsFor(articleId: string, channel: Channel) {
  return db.select().from(distributions).where(and(eq(distributions.articleId, articleId), eq(distributions.channel, channel)));
}

beforeAll(async () => {
  await deleteChannelSettings();

  const png = await sharp({ create: { width: 200, height: 200, channels: 3, background: { r: 20, g: 60, b: 120 } } }).png().toBuffer();
  server = Bun.serve({ port: 0, fetch: () => new Response(png, { headers: { "content-type": "image/png" } }) });
  imageUrl = `http://127.0.0.1:${server.port}/photo.png`;

  const [cat] = await db.insert(wpCategories).values({
    name: "Test Diffusion Scheduler", slug: `test-diffusion-scheduler-${Date.now()}`, color: "#334455",
  }).returning();
  categoryId = cat.id;

  async function makeTemplate(channel: Channel): Promise<string> {
    const [t] = await db.insert(renderTemplates).values({
      name: `Test — post social ${channel}`, context: "social_post", channel, categoryId,
      format: "fb_link", width: 1200, height: 630, scene: FB_TEMPLATE,
    }).returning();
    await db.insert(renderTemplateVersions).values({ templateId: t.id, version: 1, scene: FB_TEMPLATE });
    await db.update(renderTemplates).set({ publishedVersion: 1 }).where(eq(renderTemplates.id, t.id));
    return t.id;
  }
  templateIdA = await makeTemplate(CH_A);
  templateIdB = await makeTemplate(CH_B);
});

afterAll(async () => {
  server?.stop(true);
  if (templateIdA) await db.delete(renderTemplates).where(eq(renderTemplates.id, templateIdA));
  if (templateIdB) await db.delete(renderTemplates).where(eq(renderTemplates.id, templateIdB));
  if (categoryId) await db.delete(wpCategories).where(eq(wpCategories.id, categoryId));
  await deleteChannelSettings();
});

afterEach(async () => {
  if (createdArticleIds.length) {
    // alerts.entityId is NOT a foreign key (db/schema.ts's own comment — history must outlive the
    // entity), so it does not cascade-delete with the article the way distributions/articleRevisions
    // do — clean it up explicitly, for the Important-2 "diffusion_blocked" tests below.
    await db.delete(alerts).where(inArray(alerts.entityId, createdArticleIds));
    await db.delete(renders).where(inArray(renders.subjectId, createdArticleIds));
    await db.delete(articles).where(inArray(articles.id, createdArticleIds)); // cascades distributions + articleRevisions
  }
  createdArticleIds = [];
  await deleteChannelSettings();
});

describe("triggerDiffusionTick — un canal dû envoie exactement un article", () => {
  it("sends the eligible article and persists lastAutoSendAt", async () => {
    await insertChannelSettings(CH_A);
    const articleId = await createArticle(1, "Article — canal dû");

    const before = await getChannelSettings(CH_A);
    expect(before.lastAutoSendAt).toBeNull();

    await triggerDiffusionTick({ now: FAR_FUTURE, channels: [CH_A], renderStore: new MemoryRenderStore(), fetchImpl: fetch });

    const rows = await distributionsFor(articleId, CH_A);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("sent");
    expect(rows[0].triggeredBy).toBe("scheduled");
    expect(rows[0].actorId).toBeNull();

    const after = await getChannelSettings(CH_A);
    expect(after.lastAutoSendAt).not.toBeNull();
    expect(after.lastAutoSendAt!.getTime()).toBe(FAR_FUTURE.getTime());
  }, 20000); // real render + send round-trip over the network Neon connection — see the other DB-heavy tests in this file for the same convention (tests/pipeline-web-search.test.ts etc.)
});

describe("triggerDiffusionTick — un canal non dû n'envoie rien", () => {
  it("does nothing when the interval hasn't elapsed — no distributions row, lastAutoSendAt untouched", async () => {
    const recentSend = new Date(FAR_FUTURE.getTime() - 1 * HOUR_MS); // 1h ago, interval is 6h
    await insertChannelSettings(CH_A, { lastAutoSendAt: recentSend, autoIntervalHours: 6 });
    const articleId = await createArticle(1, "Article — canal non dû");

    await triggerDiffusionTick({ now: FAR_FUTURE, channels: [CH_A], renderStore: new MemoryRenderStore(), fetchImpl: fetch });

    const rows = await distributionsFor(articleId, CH_A);
    expect(rows).toHaveLength(0);

    const after = await getChannelSettings(CH_A);
    expect(after.lastAutoSendAt!.getTime()).toBe(recentSend.getTime()); // untouched — a no-op tick never consumes anything
  });

  it("does nothing for a channel with autoEnabled: false, even with an eligible article and no lastAutoSendAt", async () => {
    await insertChannelSettings(CH_A, { autoEnabled: false, lastAutoSendAt: null });
    const articleId = await createArticle(1, "Article — auto désactivé");

    await triggerDiffusionTick({ now: FAR_FUTURE, channels: [CH_A], renderStore: new MemoryRenderStore(), fetchImpl: fetch });

    expect(await distributionsFor(articleId, CH_A)).toHaveLength(0);
  });

  // D1 final review, Important 3: enabled:false + autoEnabled:true is reachable (two uncoupled
  // switches on the same form) — before this fix, the tick only checked autoEnabled, so it still
  // selected a candidate, persisted lastAutoSendAt, and made a real (paid) caption LLM call, only
  // to be refused by sendToChannelCore's OWN `enabled` check every single time. Checking both
  // settings here closes that off before any of that work starts.
  it("does nothing when the channel is manually disabled (enabled:false), even though autoEnabled is on — no candidate selected at all", async () => {
    await insertChannelSettings(CH_A, { enabled: false, autoEnabled: true, autoIntervalHours: 6, lastAutoSendAt: null });
    const articleId = await createArticle(1, "Article — canal désactivé manuellement");

    await triggerDiffusionTick({ now: FAR_FUTURE, channels: [CH_A], renderStore: new MemoryRenderStore(), fetchImpl: fetch });

    expect(await distributionsFor(articleId, CH_A)).toHaveLength(0);
    // lastAutoSendAt untouched — the `enabled` check happens BEFORE isDue/selectNextArticle are
    // even reached, so this tick never "used" its interval at all.
    const after = await getChannelSettings(CH_A);
    expect(after.lastAutoSendAt).toBeNull();
  });
});

describe("triggerDiffusionTick — deux tics consécutifs n'envoient pas deux fois", () => {
  // The sharpest test in this file: TWO eligible articles are available, on DIFFERENT calendar
  // days (offset 2 vs offset 1), so a broken guard wouldn't just "resend the same article" — it
  // would send the SECOND one on the second tick, an easy way for a weaker assertion (e.g. "the
  // first-picked article isn't sent twice") to pass by accident while double-sending is still
  // happening. Asserting the TOTAL sent count stays at 1, and that the other article specifically
  // was never touched, catches that.
  //
  // `moreRecentDay` (offset 1) is picked FIRST, not `olderDay` (offset 2) — day-desc, D1 final
  // review Important 1: the more recent calendar day outranks an older one regardless of which
  // has the earlier raw publishedAt. (Before that fix, a single ascending-publishedAt sort would
  // have picked olderDay first instead — this test would have needed the opposite assertion.)
  it("the second tick (same `now`) sends nothing more — total stays at exactly 1 sent article", async () => {
    await insertChannelSettings(CH_A, { autoIntervalHours: 6, lastAutoSendAt: null });
    const olderDay = await createArticle(2, "Article — jour plus ancien");
    const moreRecentDay = await createArticle(1, "Article — jour plus récent");

    await triggerDiffusionTick({ now: FAR_FUTURE, channels: [CH_A], renderStore: new MemoryRenderStore(), fetchImpl: fetch });
    const afterFirst = await distributionsFor(moreRecentDay, CH_A);
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0].status).toBe("sent");
    expect(await distributionsFor(olderDay, CH_A)).toHaveLength(0); // not yet — only one candidate is due per tick

    // Second tick, SAME instant — a slow/duplicated fire, or a naive re-poll.
    await triggerDiffusionTick({ now: FAR_FUTURE, channels: [CH_A], renderStore: new MemoryRenderStore(), fetchImpl: fetch });

    expect(await distributionsFor(moreRecentDay, CH_A)).toHaveLength(1); // still just the one row
    expect(await distributionsFor(olderDay, CH_A)).toHaveLength(0); // the other article was NEVER picked up
  }, 20000); // two full tick round-trips over the network Neon connection
});

describe("triggerDiffusionTick — lastAutoSendAt persisté, un redémarrage simulé ne produit pas de rafale", () => {
  it("a fresh settings read (simulating a new process) still reflects the persisted value and blocks a burst", async () => {
    await insertChannelSettings(CH_A, { autoIntervalHours: 6, lastAutoSendAt: null });
    const articleId = await createArticle(1, "Article — persistance redémarrage");

    await triggerDiffusionTick({ now: FAR_FUTURE, channels: [CH_A], renderStore: new MemoryRenderStore(), fetchImpl: fetch });
    expect(await distributionsFor(articleId, CH_A)).toHaveLength(1);

    // getChannelSettings has no in-memory cache — this IS a fresh DB read, exactly what a newly
    // booted process would see after a restart.
    const persisted = await getChannelSettings(CH_A);
    expect(persisted.lastAutoSendAt).not.toBeNull();
    expect(persisted.lastAutoSendAt!.getTime()).toBe(FAR_FUTURE.getTime());

    // "Restart" = a brand-new triggerDiffusionTick call with no carried-over in-process state
    // (there is none to carry — every value it used came straight from this same DB read).
    await triggerDiffusionTick({ now: FAR_FUTURE, channels: [CH_A], renderStore: new MemoryRenderStore(), fetchImpl: fetch });
    expect(await distributionsFor(articleId, CH_A)).toHaveLength(1); // still just 1 — no burst
  }, 20000); // two full tick round-trips over the network Neon connection
});

describe("triggerDiffusionTick — un échec d'envoi ne bloque pas le planificateur", () => {
  it("a failing channel doesn't stop a healthy channel in the SAME tick, and the call itself never throws", async () => {
    // Deliberately DIFFERENT offsets, not just different titles: selectNextArticle has no built-in
    // notion of "this article belongs to that channel's test", and day-desc ordering (D1 final
    // review, Important 1) means CH_B's WIDE 150-day backlog would otherwise ALSO see
    // failingArticle (offset 1, "yesterday" — a more recent day than healthyArticle's offset 100)
    // and prefer it over healthyArticle, since nothing about `articles` itself is channel-scoped
    // (found live — see this test's own report entry, both under the original ascending-sort
    // design and again under the day-desc one). A pre-existing 'sent' row for failingArticle on
    // CH_B SPECIFICALLY (not CH_A) closes that off the same way any other already-handled
    // candidate would be excluded — CH_A's own selection is untouched, since exclusion is always
    // per-channel. That leaves each channel with EXACTLY one eligible candidate, deterministically:
    // failingArticle for CH_A (its 5-day backlog doesn't reach healthyArticle at offset 100 at
    // all), healthyArticle for CH_B (failingArticle is excluded there by the row below).
    await insertChannelSettings(CH_A, { autoIntervalHours: 6, autoMaxBacklogDays: 5, lastAutoSendAt: null }); // will fail
    await insertChannelSettings(CH_B, { autoIntervalHours: 6, autoMaxBacklogDays: 150, lastAutoSendAt: null }); // will succeed
    const failingArticle = await createArticle(1, "Article — échec d'envoi simulé");
    const healthyArticle = await createArticle(100, "Article — envoi sain");
    await db.insert(distributions).values({
      articleId: failingArticle, channel: CH_B, status: "sent", sentAt: new Date(), externalId: "test-isolation-pre-existing",
    });

    const failingChannel: SocialChannel = {
      ...SOCIAL_CHANNELS[CH_A],
      send: async (_input: SendInput): Promise<SendResult> => ({ ok: false, message: "Erreur simulée (test)." }),
    };

    await expect(triggerDiffusionTick({
      now: FAR_FUTURE, channels: [CH_A, CH_B],
      channelOverrides: { [CH_A]: failingChannel },
      renderStore: new MemoryRenderStore(), fetchImpl: fetch,
    })).resolves.toBeUndefined();

    const failed = await distributionsFor(failingArticle, CH_A);
    expect(failed).toHaveLength(1);
    expect(failed[0].status).toBe("failed");
    expect(failed[0].lastError).toBe("Erreur simulée (test).");
    expect(failed[0].attempts).toBe(1);

    const sent = await distributionsFor(healthyArticle, CH_B);
    expect(sent).toHaveLength(1);
    expect(sent[0].status).toBe("sent");

    // lastAutoSendAt is set BEFORE sending regardless of outcome — the failing channel's next due
    // moment is still a full interval away, not immediately retried on every subsequent tick.
    expect((await getChannelSettings(CH_A)).lastAutoSendAt!.getTime()).toBe(FAR_FUTURE.getTime());

    // A LATER, separate call — proves the scheduler itself isn't wedged by the prior failure, not
    // just that the loop happened to continue within one call. offset 0 ("today"), a MORE RECENT
    // calendar day than failingArticle's (offset 1, "yesterday" — still sitting there 'failed',
    // which does NOT exclude it, by design): day-desc ordering (D1 final review, Important 1)
    // means this is unambiguously the next candidate for CH_A, regardless of raw timestamp — an
    // offset further back (e.g. offset 3) would instead have left failingArticle itself as the
    // priority pick here (its day is more recent), which would still prove the point but less
    // cleanly (it would exercise a RETRY of the earlier failure, not a fresh candidate).
    const laterArticle = await createArticle(0, "Article — tic suivant, canal sain");
    await insertChannelSettings(CH_A, { autoIntervalHours: 6, autoMaxBacklogDays: 30, lastAutoSendAt: null }); // reset A, now healthy (no override)
    await triggerDiffusionTick({ now: FAR_FUTURE, channels: [CH_A], renderStore: new MemoryRenderStore(), fetchImpl: fetch });
    const laterRows = await distributionsFor(laterArticle, CH_A);
    expect(laterRows).toHaveLength(1);
    expect(laterRows[0].status).toBe("sent");
  }, 20000); // three tick round-trips (two channels + a later separate call) over the network Neon connection

  // The sabotage-resistant version of the test above: an `{ok:false}` return from send() never
  // throws, so the previous test would pass IDENTICALLY even with the per-channel try/catch in
  // triggerDiffusionTick deleted outright — it doesn't actually exercise that guard. A channel
  // adapter that THROWS (a real bug, a network library raising instead of rejecting cleanly) is the
  // case that guard exists for: send-core.ts's own step 5 call to `socialChannel.send` is not
  // itself wrapped in try/catch, so the exception propagates out of sendToChannelCore, out of
  // tickChannel, and would abort the whole triggerDiffusionTick loop (never reaching CH_B, and
  // rejecting the call itself) WITHOUT that guard.
  it("a channel whose send() THROWS does not stop another channel, and the tick itself never rejects", async () => {
    await insertChannelSettings(CH_A, { autoIntervalHours: 6, autoMaxBacklogDays: 5, lastAutoSendAt: null });
    await insertChannelSettings(CH_B, { autoIntervalHours: 6, autoMaxBacklogDays: 150, lastAutoSendAt: null });
    const throwingArticle = await createArticle(1, "Article — send() lève une exception");
    const healthyArticle = await createArticle(100, "Article — envoi sain (throw voisin)");
    // Same cross-channel isolation as the test above, same reason (day-desc ordering, Important 1,
    // would otherwise let CH_B's wide backlog prefer throwingArticle over healthyArticle).
    await db.insert(distributions).values({
      articleId: throwingArticle, channel: CH_B, status: "sent", sentAt: new Date(), externalId: "test-isolation-pre-existing",
    });

    const throwingChannel: SocialChannel = {
      ...SOCIAL_CHANNELS[CH_A],
      send: async () => { throw new Error("Bug simulé (test) — send() qui lève au lieu de renvoyer {ok:false}."); },
    };

    await expect(triggerDiffusionTick({
      now: FAR_FUTURE, channels: [CH_A, CH_B],
      channelOverrides: { [CH_A]: throwingChannel },
      renderStore: new MemoryRenderStore(), fetchImpl: fetch,
    })).resolves.toBeUndefined(); // the call itself never rejects

    // CH_B was still reached and still sent successfully — the throw on CH_A didn't abort the loop.
    const sent = await distributionsFor(healthyArticle, CH_B);
    expect(sent).toHaveLength(1);
    expect(sent[0].status).toBe("sent");

    // CH_A's row is left exactly where send-core.ts's own documented gap says it would be: stuck
    // at 'pending' (step 4 already committed before step 5 threw) — this is precisely what
    // reclaimStalePendingDistributions exists to recover, later.
    const stuck = await distributionsFor(throwingArticle, CH_A);
    expect(stuck).toHaveLength(1);
    expect(stuck[0].status).toBe("pending");
  }, 20000); // full render + send round-trip over the network Neon connection
});

describe("triggerDiffusionTick — un refus AVANT écriture ne bloque pas le canal indéfiniment (D1 final review, Important 2)", () => {
  it("skips a pre-row refusal (render failure — no distributions row written) and still sends the next healthy candidate, raising a diffusion_blocked alert", async () => {
    await insertChannelSettings(CH_A, { autoIntervalHours: 6, autoMaxBacklogDays: 30, lastAutoSendAt: null });

    // Broken candidate: same templated category CH_A already has (this file's own beforeAll), but
    // no featuredImageUrl — renderForArticle fails resolving {{article.image}}, so
    // sendToChannelCore refuses at step 3, BEFORE any distributions row is ever written
    // (send-core.ts's own documented step ordering — same technique as tests/diffusion-send.test.ts's
    // "articleRenderFails"). Its calendar day (offset 1) is MORE RECENT than the healthy
    // candidate's (offset 2), so day-desc ordering (Important 1) picks it FIRST — exactly the
    // scenario that would silently wedge this channel forever without this fix.
    const [{ id: brokenArticle }] = await db.insert(articles).values({
      title: "Article — rendu impossible (image manquante)", bodyHtml: "<p>x</p>", status: "published",
      publishedAt: new Date(FAR_FUTURE.getTime() - 1 * DAY_MS), categoryId, featuredImageUrl: null,
    }).returning({ id: articles.id });
    createdArticleIds.push(brokenArticle);

    const healthyArticle = await createArticle(2, "Article — sain, jour plus ancien");

    await triggerDiffusionTick({ now: FAR_FUTURE, channels: [CH_A], renderStore: new MemoryRenderStore(), fetchImpl: fetch });

    // The broken candidate got NO distributions row at all — the exact pre-row-refusal case.
    expect(await distributionsFor(brokenArticle, CH_A)).toHaveLength(0);

    // The healthy candidate, behind it in priority, still shipped on this SAME tick.
    const sent = await distributionsFor(healthyArticle, CH_A);
    expect(sent).toHaveLength(1);
    expect(sent[0].status).toBe("sent");

    // An operator now has a trace: an alert was raised for the skipped candidate.
    const raised = await db.select().from(alerts).where(eq(alerts.entityId, brokenArticle));
    expect(raised).toHaveLength(1);
    expect(raised[0].type).toBe("diffusion_blocked");
    expect(raised[0].detail.length).toBeGreaterThan(0);
  }, 20000);

  it("bounds how many candidates a single tick will skip — stops after 3, never sends, never hangs", async () => {
    await insertChannelSettings(CH_A, { autoIntervalHours: 6, autoMaxBacklogDays: 30, lastAutoSendAt: null });

    // FOUR broken candidates, one per calendar day (day=1 is "yesterday", ..., day=4 is "4 days
    // ago") — day-desc ordering tries them in that exact sequence, and NONE of them ever writes a
    // distributions row, so nothing here can naturally stop the loop except the
    // MAX_CANDIDATES_PER_TICK bound (lib/diffusion/scheduler.ts) itself.
    const brokenByDay: Record<number, string> = {};
    for (const day of [1, 2, 3, 4]) {
      const [{ id }] = await db.insert(articles).values({
        title: `Article — rendu impossible (jour ${day})`, bodyHtml: "<p>x</p>", status: "published",
        publishedAt: new Date(FAR_FUTURE.getTime() - day * DAY_MS), categoryId, featuredImageUrl: null,
      }).returning({ id: articles.id });
      createdArticleIds.push(id);
      brokenByDay[day] = id;
    }

    await expect(triggerDiffusionTick({
      now: FAR_FUTURE, channels: [CH_A], renderStore: new MemoryRenderStore(), fetchImpl: fetch,
    })).resolves.toBeUndefined();

    for (const day of [1, 2, 3, 4]) {
      expect(await distributionsFor(brokenByDay[day], CH_A)).toHaveLength(0); // none ever gets a row
    }

    // The 3 MOST RECENT days (1, 2, 3) were tried and alerted on; day 4 was never even reached.
    for (const day of [1, 2, 3]) {
      const rows = await db.select().from(alerts).where(eq(alerts.entityId, brokenByDay[day]));
      expect(rows).toHaveLength(1);
    }
    const untried = await db.select().from(alerts).where(eq(alerts.entityId, brokenByDay[4]));
    expect(untried).toHaveLength(0);

    // The tick still "used" this cycle — lastAutoSendAt is set even though nothing ultimately sent.
    const after = await getChannelSettings(CH_A);
    expect(after.lastAutoSendAt!.getTime()).toBe(FAR_FUTURE.getTime());
  }, 20000);
});

describe("reclaimStalePendingDistributions — cutoff configurable via DIFFUSION_STALE_PENDING_MINUTES (D1 final review, Important 5)", () => {
  const originalEnv = process.env.DIFFUSION_STALE_PENDING_MINUTES;
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.DIFFUSION_STALE_PENDING_MINUTES;
    else process.env.DIFFUSION_STALE_PENDING_MINUTES = originalEnv;
  });

  it("honors a SHORTER cutoff from the env var — a row the default 10-minute cutoff would leave untouched gets reclaimed", async () => {
    const articleId = await createArticle(1, "Article — pending, cutoff réduit");
    const at = new Date(Date.now() - 3 * 60_000); // 3 minutes ago — inside the default 10-min window, outside a 1-min one
    await db.insert(distributions).values({ articleId, channel: CH_A, status: "pending", at, attempts: 0 });

    process.env.DIFFUSION_STALE_PENDING_MINUTES = "1";
    await reclaimStalePendingDistributions();

    const [row] = await distributionsFor(articleId, CH_A);
    expect(row.status).toBe("failed");
  });

  it("falls back to the default (10) on an invalid value — never silently disables the reaper", async () => {
    const articleId = await createArticle(1, "Article — pending, cutoff invalide");
    const staleAt = new Date(Date.now() - 20 * 60_000);
    await db.insert(distributions).values({ articleId, channel: CH_A, status: "pending", at: staleAt, attempts: 0 });

    process.env.DIFFUSION_STALE_PENDING_MINUTES = "not-a-number";
    await reclaimStalePendingDistributions();

    const [row] = await distributionsFor(articleId, CH_A);
    expect(row.status).toBe("failed"); // still reaped — an invalid value falls back to the default, not to "never reap"
  });
});

describe("reclaimStalePendingDistributions — récupère les envois bloqués (D1 §7, folded into Task 9)", () => {
  it("marks a 'pending' row older than the staleness cutoff as 'failed', with a French lastError, attempts incremented", async () => {
    const articleId = await createArticle(1, "Article — pending bloqué");
    const staleAt = new Date(Date.now() - 20 * 60_000); // 20 minutes ago — past the 10-minute cutoff
    await db.insert(distributions).values({ articleId, channel: CH_A, status: "pending", at: staleAt, attempts: 0 });

    await reclaimStalePendingDistributions();

    const [row] = await distributionsFor(articleId, CH_A);
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(1);
    expect(row.lastError).toBeTruthy();
    expect(row.lastError!.length).toBeGreaterThan(0);
  });

  it("leaves a RECENT 'pending' row untouched — a genuinely in-flight send must not be reaped", async () => {
    const articleId = await createArticle(1, "Article — pending récent");
    await db.insert(distributions).values({ articleId, channel: CH_A, status: "pending", at: new Date(), attempts: 0 });

    await reclaimStalePendingDistributions();

    const [row] = await distributionsFor(articleId, CH_A);
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(0);
    expect(row.lastError).toBeNull();
  });
});

describe("lib/pipeline/scheduler.ts — extends the same croner singleton (Task 9)", () => {
  it("initScheduler() starts the diffusion tick job, with a future nextRun()", async () => {
    await initScheduler();
    const job = getDiffusionSchedulerJob();
    expect(job).not.toBeNull();
    const next = job!.nextRun();
    expect(next).not.toBeNull();
    expect(next!.getTime()).toBeGreaterThan(Date.now());
  });

  it("triggerScheduledDiffusionTick() never throws, and resolves", async () => {
    await expect(triggerScheduledDiffusionTick()).resolves.toBeUndefined();
  });
});
