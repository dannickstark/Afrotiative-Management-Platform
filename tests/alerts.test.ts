import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { db, alerts, feeds, rawItems, pipelineRuns, pipelineSettings } from "@/db";
import { and, eq, inArray } from "drizzle-orm";
import { createAlert } from "@/lib/alerts/notify";
import { openRun, executeRun } from "@/lib/pipeline/run";
import type { PipelineSettings } from "@/lib/queries/settings";

// pipeline_settings row id=1 is a shared, app-wide singleton (possibly holding a real
// admin-configured value) — snapshot once before this file's tests run and restore exactly
// (present with original values, or absent) once at the very end. Same pattern as
// tests/pipeline-settings.test.ts / tests/pipeline-web-search.test.ts. Several tests below flip
// alertEmailEnabled/alertEmailRecipients on this row.
let settingsSnapshot: PipelineSettings | null = null;

beforeAll(async () => {
  const [row] = await db.select().from(pipelineSettings).where(eq(pipelineSettings.id, 1));
  settingsSnapshot = row ?? null;
});

afterAll(async () => {
  await db.delete(pipelineSettings).where(eq(pipelineSettings.id, 1));
  if (settingsSnapshot) await db.insert(pipelineSettings).values(settingsSnapshot);
});

async function setAlertSettings(fields: { alertEmailEnabled: boolean; alertEmailRecipients: string | null }): Promise<void> {
  await db.delete(pipelineSettings).where(eq(pipelineSettings.id, 1));
  await db.insert(pipelineSettings).values({ id: 1, maxItemsPerRun: 20, clusterThreshold: 0.83, ...fields });
}

// RESEND_API_KEY is already stripped globally by test-setup.ts's blanket `*_API_KEY` sweep, but
// snapshotted/restored here too (self-contained, order-independent — same reasoning as
// tests/search.test.ts's ORIGINAL_BRAVE_KEY / tests/resend.test.ts).
const ORIGINAL_RESEND_KEY = process.env.RESEND_API_KEY;
afterEach(() => {
  if (ORIGINAL_RESEND_KEY === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = ORIGINAL_RESEND_KEY;
});

// ─────────────────────────────────────────────────────────────────────────────
// SP9a — createAlert() exercised directly against the real Neon dev DB. Network-free by default
// (email disabled); the "email send fails" case explicitly sets a key and monkeypatches
// global.fetch so nothing here ever touches the real internet.
describe("createAlert (direct, real Neon dev DB)", () => {
  const createdIds: string[] = [];

  afterEach(async () => {
    if (createdIds.length > 0) {
      await db.delete(alerts).where(inArray(alerts.id, createdIds));
      createdIds.length = 0;
    }
  });

  it("inserts an alert row with the given fields; email disabled → no network attempted at all", async () => {
    await setAlertSettings({ alertEmailEnabled: false, alertEmailRecipients: null });
    delete process.env.RESEND_API_KEY;

    let fetchCalled = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      fetchCalled = true;
      return originalFetch(...args);
    }) as typeof fetch;

    try {
      await createAlert({ type: "run_failed", title: "SP9a titre test", detail: "SP9a détail test", entityId: null });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const rows = await db.select().from(alerts).where(eq(alerts.title, "SP9a titre test"));
    createdIds.push(...rows.map((r) => r.id));

    expect(rows.length).toBe(1);
    expect(rows[0].type).toBe("run_failed");
    expect(rows[0].detail).toBe("SP9a détail test");
    expect(rows[0].entityId).toBeNull();
    expect(rows[0].read).toBe(false);
    expect(rows[0].createdAt).not.toBeNull();
    expect(fetchCalled).toBe(false);
  });

  it("never throws even when the insert itself fails (entityId is a `uuid` column — a non-uuid string rejects)", async () => {
    await setAlertSettings({ alertEmailEnabled: false, alertEmailRecipients: null });

    let threw = false;
    try {
      await createAlert({
        type: "run_failed", title: "SP9a titre échec insert", detail: "détail", entityId: "not-a-uuid",
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);

    // The rejected insert left no row behind.
    const rows = await db.select().from(alerts).where(eq(alerts.title, "SP9a titre échec insert"));
    expect(rows.length).toBe(0);
  });

  it("never throws when the email send fails (enabled + recipients + key set, fetch mocked to reject) — the alert row is still created", async () => {
    await setAlertSettings({ alertEmailEnabled: true, alertEmailRecipients: "a@example.com" });
    process.env.RESEND_API_KEY = "test-key";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
      throw new Error("panne réseau simulée");
    }) as typeof fetch;

    let threw = false;
    try {
      await createAlert({ type: "run_failed", title: "SP9a titre échec email", detail: "détail", entityId: null });
    } catch {
      threw = true;
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(threw).toBe(false);

    const rows = await db.select().from(alerts).where(eq(alerts.title, "SP9a titre échec email"));
    createdIds.push(...rows.map((r) => r.id));
    expect(rows.length).toBe(1); // the insert (which happens BEFORE the email attempt) still landed
  });

  it("with email disabled, no send is attempted even when a key + recipients are configured", async () => {
    await setAlertSettings({ alertEmailEnabled: false, alertEmailRecipients: "a@example.com" });
    process.env.RESEND_API_KEY = "test-key";

    let fetchCalled = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      fetchCalled = true;
      return originalFetch(...args);
    }) as typeof fetch;

    try {
      await createAlert({ type: "feed_dark", title: "SP9a titre disabled", detail: "détail", entityId: null });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const rows = await db.select().from(alerts).where(eq(alerts.title, "SP9a titre disabled"));
    createdIds.push(...rows.map((r) => r.id));
    expect(rows.length).toBe(1); // the alert itself is always created regardless of email config
    expect(fetchCalled).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SP9a — run_failed trigger: executeRun's finalize (lib/pipeline/run.ts) must create exactly ONE
// run_failed alert when the run's terminal status is genuinely 'failed', and NONE for
// 'success'/'partial'/'cancelled'. Real Neon dev DB; network-free (unreachable loopback feed URLs
// force parse failures deterministically, same fixture pattern as tests/pipeline-run.test.ts and
// tests/feed-health.test.ts; zero-item local Bun.serve RSS fixtures for the success/partial cases
// so phase 2 never touches extraction/embedding/LLM providers at all).
describe("run_failed alert trigger (executeRun finalize)", () => {
  const feedIds: string[] = [];
  const runIds: string[] = [];
  const servers: ReturnType<typeof Bun.serve>[] = [];

  function zeroItemRss(title: string): ReturnType<typeof Bun.serve> {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response(
        `<?xml version="1.0"?><rss version="2.0"><channel><title>${title}</title></channel></rss>`,
        { headers: { "content-type": "application/xml" } },
      ),
    });
    servers.push(server);
    return server;
  }

  afterAll(async () => {
    for (const s of servers) s.stop(true);
    if (runIds.length > 0) {
      await db.delete(alerts).where(inArray(alerts.entityId, runIds));
      await db.delete(pipelineRuns).where(inArray(pipelineRuns.id, runIds)); // cascades pipeline_steps
    }
    if (feedIds.length > 0) {
      await db.delete(rawItems).where(inArray(rawItems.feedId, feedIds));
      await db.delete(feeds).where(inArray(feeds.id, feedIds));
    }
  });

  async function runFailedAlertsFor(runId: string) {
    return db.select().from(alerts).where(and(eq(alerts.entityId, runId), eq(alerts.type, "run_failed")));
  }

  it("a run finalizing 'failed' creates exactly ONE run_failed alert (entityId = runId)", async () => {
    const [f] = await db.insert(feeds).values({
      name: "Fixture alerts run_failed (test)", feedUrl: "http://127.0.0.1:1/rss", active: true,
    }).returning({ id: feeds.id });
    feedIds.push(f.id);

    const runId = await openRun({ triggeredBy: "manual", feedsTotal: 1 });
    expect(runId).not.toBeNull();
    runIds.push(runId!);

    const res = await executeRun(runId!, { feedIds: [f.id] });
    expect(res.status).toBe("failed"); // the only feed failed to parse → allFeedsFailed

    const found = await runFailedAlertsFor(runId!);
    expect(found.length).toBe(1);
    expect(found[0].title).toBe("Exécution du pipeline échouée");
    expect(found[0].entityId).toBe(runId);
    expect(found[0].type).toBe("run_failed");
  }, 20000);

  it("a run finalizing 'success' creates NO run_failed alert", async () => {
    const server = zeroItemRss("Fixture alerts success (test)");
    const [f] = await db.insert(feeds).values({
      name: "Fixture alerts success feed (test)", feedUrl: `http://localhost:${server.port}/feed`, active: true,
    }).returning({ id: feeds.id });
    feedIds.push(f.id);

    const runId = await openRun({ triggeredBy: "manual", feedsTotal: 1 });
    runIds.push(runId!);
    const res = await executeRun(runId!, { feedIds: [f.id] });
    expect(res.status).toBe("success"); // no feed/item failures, no cap hit — a quiet run

    expect((await runFailedAlertsFor(runId!)).length).toBe(0);
  }, 20000);

  it("a run finalizing 'partial' creates NO run_failed alert", async () => {
    const server = zeroItemRss("Fixture alerts partial ok (test)");
    const [feedOk] = await db.insert(feeds).values({
      name: "Fixture alerts partial ok feed (test)", feedUrl: `http://localhost:${server.port}/feed`, active: true,
    }).returning({ id: feeds.id });
    const [feedBad] = await db.insert(feeds).values({
      name: "Fixture alerts partial bad feed (test)", feedUrl: "http://127.0.0.1:1/rss", active: true,
    }).returning({ id: feeds.id });
    feedIds.push(feedOk.id, feedBad.id);

    const runId = await openRun({ triggeredBy: "manual", feedsTotal: 2 });
    runIds.push(runId!);
    const res = await executeRun(runId!, { feedIds: [feedOk.id, feedBad.id] });
    expect(res.status).toBe("partial"); // one feed failed, one succeeded (0 items) — not ALL failed

    expect((await runFailedAlertsFor(runId!)).length).toBe(0);
  }, 20000);

  it("a run finalizing 'cancelled' creates NO run_failed alert", async () => {
    const runId = await openRun({ triggeredBy: "manual", feedsTotal: 0 });
    expect(runId).not.toBeNull();
    runIds.push(runId!);
    // Flip cancel_requested directly on the row BEFORE executing — checkControlFlags (run.ts) reads
    // a FRESH select of this flag right after phase 1, so this reproduces a real cancelRun() call
    // without needing the full action/session plumbing.
    await db.update(pipelineRuns).set({ cancelRequested: true }).where(eq(pipelineRuns.id, runId!));

    const res = await executeRun(runId!, { feedIds: [] });
    expect(res.status).toBe("cancelled");

    expect((await runFailedAlertsFor(runId!)).length).toBe(0);
  }, 20000);
});
