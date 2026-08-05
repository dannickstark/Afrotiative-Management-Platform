import { describe, it, expect, afterEach } from "bun:test";
import { db, alerts } from "@/db";
import { and, eq, inArray } from "drizzle-orm";
import { can } from "@/lib/rbac";
import { getUnreadAlertCount, getRecentAlerts } from "@/lib/queries/alerts";

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
