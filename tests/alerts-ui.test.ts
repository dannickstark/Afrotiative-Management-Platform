import { describe, it, expect, afterEach, beforeAll, afterAll } from "bun:test";
import { db, alerts, pipelineSettings } from "@/db";
import { and, eq, inArray } from "drizzle-orm";
import { can } from "@/lib/rbac";
import { getUnreadAlertCount, getRecentAlerts, getUnreadAlerts } from "@/lib/queries/alerts";
import { persistPipelineSettings } from "@/lib/pipeline/settings-write";
import type { PipelineSettings } from "@/lib/queries/settings";

// SP9b — in-app alerting surface: queries (lib/queries/alerts.ts) + actions
// (lib/actions/alert-actions.ts). Real Neon dev DB, self-cleaning (own rows only — never touches
// unrelated alert history, same discipline as tests/alerts.test.ts (SP9a)).

describe("getUnreadAlertCount / getRecentAlerts (lib/queries/alerts.ts)", () => {
  const createdIds: string[] = [];

  afterEach(async () => {
    if (createdIds.length > 0) {
      await db.delete(alerts).where(inArray(alerts.id, createdIds));
      createdIds.length = 0;
    }
  });

  it("getUnreadAlertCount counts only unread rows (a read alert doesn't move it)", async () => {
    const baseline = await getUnreadAlertCount();

    const [unread] = await db.insert(alerts).values({
      type: "run_failed", title: "SP9b test unread", detail: "détail", read: false,
    }).returning();
    createdIds.push(unread.id);
    expect(await getUnreadAlertCount()).toBe(baseline + 1);

    const [readRow] = await db.insert(alerts).values({
      type: "feed_dark", title: "SP9b test read", detail: "détail", read: true,
    }).returning();
    createdIds.push(readRow.id);
    expect(await getUnreadAlertCount()).toBe(baseline + 1); // the read row must not count
  });

  it("getRecentAlerts orders newest first", async () => {
    const now = Date.now();
    const rows = await db.insert(alerts).values([
      { type: "run_failed", title: "SP9b order oldest", detail: "d", createdAt: new Date(now - 3000) },
      { type: "run_failed", title: "SP9b order middle", detail: "d", createdAt: new Date(now - 2000) },
      { type: "feed_dark", title: "SP9b order newest", detail: "d", createdAt: new Date(now - 1000) },
    ]).returning();
    createdIds.push(...rows.map((r) => r.id));

    // A generous limit so all three of ours are guaranteed to be present regardless of how much
    // other (real or other-test) alert history exists; filtered to our own unique title prefix so
    // the ordering assertion is immune to concurrent contamination from other suites/dev activity.
    const ours = (await getRecentAlerts(500)).filter((a) => a.title.startsWith("SP9b order"));
    expect(ours.map((a) => a.title)).toEqual(["SP9b order newest", "SP9b order middle", "SP9b order oldest"]);
  });

  it("getRecentAlerts respects the limit parameter", async () => {
    // The real dev DB already has plenty of alert history (seed + other suites), so asking for 2
    // must always come back capped at 2 regardless of total row count.
    const capped = await getRecentAlerts(2);
    expect(capped.length).toBeLessThanOrEqual(2);
  });

  it("getRecentAlerts defaults to limit=20 when called with no argument", async () => {
    const defaulted = await getRecentAlerts();
    expect(defaulted.length).toBeLessThanOrEqual(20);
  });

  // SP9b Finding 2 — the dashboard banner must use the SAME unread source as the bell badge, so it
  // reads getUnreadAlerts() (WHERE read=false) rather than filtering getRecentAlerts()'s top-N.
  it("getUnreadAlerts returns ONLY unread rows, newest first", async () => {
    const now = Date.now();
    const rows = await db.insert(alerts).values([
      { type: "run_failed", title: "SP9b unread older", detail: "d", read: false, createdAt: new Date(now - 2000) },
      { type: "feed_dark", title: "SP9b unread newer", detail: "d", read: false, createdAt: new Date(now - 1000) },
      { type: "run_failed", title: "SP9b already read", detail: "d", read: true, createdAt: new Date(now - 500) },
    ]).returning();
    createdIds.push(...rows.map((r) => r.id));

    const ours = (await getUnreadAlerts(500)).filter((a) => a.title.startsWith("SP9b unread"));
    // the read row must be absent; the two unread ones present, newest first
    expect(ours.map((a) => a.title)).toEqual(["SP9b unread newer", "SP9b unread older"]);
    expect(ours.every((a) => a.read === false)).toBe(true);
  });

  it("getUnreadAlerts never returns a read row, and respects its limit", async () => {
    const capped = await getUnreadAlerts(2);
    expect(capped.length).toBeLessThanOrEqual(2);
    expect(capped.every((a) => a.read === false)).toBe(true);
  });

  // The invariant SP9b Finding 2 is really about: the banner's count (getUnreadAlertCount) and its
  // list source (getUnreadAlerts) agree — the list is a prefix of the counted set, never a filtered
  // slice of a mixed read/unread window that could undercount.
  it("getUnreadAlerts count-vs-list stays consistent with getUnreadAlertCount", async () => {
    const rows = await db.insert(alerts).values([
      { type: "run_failed", title: "SP9b consistency 1", detail: "d", read: false },
      { type: "feed_dark", title: "SP9b consistency 2", detail: "d", read: false },
    ]).returning();
    createdIds.push(...rows.map((r) => r.id));

    const count = await getUnreadAlertCount();
    const list = await getUnreadAlerts(count); // ask for exactly `count` — must return exactly that many
    expect(list.length).toBe(count);
    expect(list.every((a) => a.read === false)).toBe(true);
  });
});

describe("alert actions authz (pipeline:read — mirrors lib/actions/pipeline-actions.ts's read-only actions)", () => {
  it("editor and admin may view/dismiss alerts; journalist may not", () => {
    expect(can("editor", "pipeline", "read")).toBe(true);
    expect(can("admin", "pipeline", "read")).toBe(true);
    expect(can("journalist", "pipeline", "read")).toBe(false);
  });
});

// markAlertRead/markAllAlertsRead themselves start with requireUser() -> next/headers, which needs
// a real request context unavailable under plain `bun test` (same constraint documented across
// this suite — see tests/feed-actions.test.ts, tests/team-actions.test.ts, tests/queue-actions.test.ts).
// So these mirror the EXACT drizzle statements the actions run, against temp-inserted rows only.
describe("markAlertRead / markAllAlertsRead effect (mirrors lib/actions/alert-actions.ts)", () => {
  const createdIds: string[] = [];

  afterEach(async () => {
    if (createdIds.length > 0) {
      await db.delete(alerts).where(inArray(alerts.id, createdIds));
      createdIds.length = 0;
    }
  });

  it("markAlertRead flips exactly the targeted row to read, leaves a sibling unread row alone", async () => {
    const [target] = await db.insert(alerts).values({
      type: "run_failed", title: "SP9b markAlertRead target", detail: "d", read: false,
    }).returning();
    const [sibling] = await db.insert(alerts).values({
      type: "run_failed", title: "SP9b markAlertRead sibling", detail: "d", read: false,
    }).returning();
    createdIds.push(target.id, sibling.id);

    // Exactly what markAlertRead(id) does: lib/actions/alert-actions.ts.
    await db.update(alerts).set({ read: true }).where(eq(alerts.id, target.id));

    const [after] = await db.select().from(alerts).where(eq(alerts.id, target.id));
    expect(after.read).toBe(true);
    const [siblingAfter] = await db.select().from(alerts).where(eq(alerts.id, sibling.id));
    expect(siblingAfter.read).toBe(false);
  });

  it("markAllAlertsRead flips every unread row to read, leaves an already-read row untouched", async () => {
    const [unread1] = await db.insert(alerts).values({
      type: "run_failed", title: "SP9b markAll unread1", detail: "d", read: false,
    }).returning();
    const [unread2] = await db.insert(alerts).values({
      type: "feed_dark", title: "SP9b markAll unread2", detail: "d", read: false,
    }).returning();
    const [alreadyRead] = await db.insert(alerts).values({
      type: "run_failed", title: "SP9b markAll alreadyread", detail: "d", read: true,
    }).returning();
    const ids = [unread1.id, unread2.id, alreadyRead.id];
    createdIds.push(...ids);

    // markAllAlertsRead's real query is an UNSCOPED `where(read = false)` (deliberately global —
    // small team, no per-user tracking, per the SP9 plan). Running that literally here would flip
    // every unread alert in the shared real dev DB, including genuine unseen history unrelated to
    // this test. Scoped to our own temp ids instead (same reasoning/pattern as
    // tests/team-actions.test.ts's otherActiveAdmins: exercise the identical logic — bulk
    // `read=false -> true` — without touching real data outside this test's own rows).
    await db.update(alerts).set({ read: true }).where(and(eq(alerts.read, false), inArray(alerts.id, ids)));

    const rows = await db.select().from(alerts).where(inArray(alerts.id, ids));
    expect(rows.every((r) => r.read)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SP9b Finding 1 (CRITICAL) — the Alertes settings group must actually persist. This exercises the
// real write path updatePipelineSettings uses (persistPipelineSettings, lib/pipeline/settings-write.ts)
// — the action's own upsert `values` builder, where alertEmailEnabled/alertEmailRecipients were
// silently dropped — against the real Neon dev DB. The action itself can't be called here
// (requireUser() → next/headers needs a request context, unavailable under bun test — same
// constraint as the rest of the suite), so the shared helper is tested directly. pipeline_settings
// row id=1 is an app-wide singleton: snapshot once, restore exactly at the end (mirrors
// tests/alerts.test.ts and tests/pipeline-settings.test.ts).
describe("persistPipelineSettings — alert-email fields round-trip (SP9b Finding 1)", () => {
  let snapshot: PipelineSettings | null = null;

  beforeAll(async () => {
    const [row] = await db.select().from(pipelineSettings).where(eq(pipelineSettings.id, 1));
    snapshot = row ?? null;
  });

  afterAll(async () => {
    await db.delete(pipelineSettings).where(eq(pipelineSettings.id, 1));
    if (snapshot) await db.insert(pipelineSettings).values(snapshot);
  });

  const BASE = {
    maxItemsPerRun: 20,
    perOperationTimeoutMs: 300000,
    clusterThreshold: 0.83,
    scoreThreshold: 70,
    autoPublishEnabled: false,
    autoPublishMinSources: 2,
    webSearchEnabled: false,
    scheduleCron: "",
    alertEmailEnabled: false,
    alertEmailRecipients: null as string | null,
  };

  it("persists alertEmailEnabled=true + a recipients list (the exact write that was a no-op before the fix)", async () => {
    await persistPipelineSettings({ ...BASE, alertEmailEnabled: true, alertEmailRecipients: "a@example.com, b@example.com" });

    const [row] = await db.select().from(pipelineSettings).where(eq(pipelineSettings.id, 1));
    expect(row.alertEmailEnabled).toBe(true);
    expect(row.alertEmailRecipients).toBe("a@example.com, b@example.com");
  });

  it("updates BOTH fields on a subsequent save (onConflictDoUpdate path — not just the first insert)", async () => {
    // First save: enabled + recipients (row now certainly exists).
    await persistPipelineSettings({ ...BASE, alertEmailEnabled: true, alertEmailRecipients: "x@example.com" });
    // Second save: flip enabled back off + clear recipients — the exact "toggle + save" the reviewer
    // flagged as a silent no-op. onConflictDoUpdate must overwrite both columns, not leave them.
    await persistPipelineSettings({ ...BASE, alertEmailEnabled: false, alertEmailRecipients: "" });

    const [row] = await db.select().from(pipelineSettings).where(eq(pipelineSettings.id, 1));
    expect(row.alertEmailEnabled).toBe(false);
    // empty string normalizes to NULL (matches scheduleCron's handling in settings-write.ts)
    expect(row.alertEmailRecipients).toBeNull();
  });

  it("normalizes a whitespace-only recipients string to NULL", async () => {
    await persistPipelineSettings({ ...BASE, alertEmailEnabled: true, alertEmailRecipients: "   " });
    const [row] = await db.select().from(pipelineSettings).where(eq(pipelineSettings.id, 1));
    expect(row.alertEmailRecipients).toBeNull();
  });
});
