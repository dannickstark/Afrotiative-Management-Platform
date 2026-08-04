import { describe, it, expect } from "bun:test";
import { can } from "@/lib/rbac";
// validateFeedInput lives in lib/validation.ts, not lib/actions/feed-actions.ts — see the comment
// on lib/actions/feed-actions.ts: that module needs a file-level "use server" directive so
// components/settings/feed-sheet.tsx (a Client Component) can import its actions directly, and
// Next.js only allows async-function exports from such a module. A synchronous helper like this
// one has to live in a plain module instead (verified against `bun run build`).
import { validateFeedInput } from "@/lib/validation";
import { db, feeds } from "@/db";
import { eq } from "drizzle-orm";

describe("feed actions", () => {
  it("only editor/admin manage feeds", () => {
    expect(can("editor", "feed", "manage")).toBe(true);
    expect(can("journalist", "feed", "manage")).toBe(false);
  });
  it("validates feed input (url required)", () => {
    expect(validateFeedInput({ name: "X", feedUrl: "not-a-url", active: true }).ok).toBe(false);
    expect(validateFeedInput({ name: "X", feedUrl: "https://x.com/feed", active: true }).ok).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Self-cleaning DB integration test (real Neon DB). The server actions themselves
// require a real session via requireUser(), so — per the task brief and the pattern
// established in tests/reprocess.test.ts — this exercises the exact drizzle paths
// createFeed/toggleFeed/deleteFeed use, on a temp row only (never touches seed data).
describe("feed actions: create → toggle → delete (DB round-trip)", () => {
  it("inserts, toggles active, then deletes a temp feed", async () => {
    let feedId: string | null = null;
    try {
      const [inserted] = await db.insert(feeds).values({
        name: "Flux de test (feed-actions)",
        feedUrl: "https://example.com/test-feed.xml",
        siteUrl: "https://example.com",
        active: true,
      }).returning();
      feedId = inserted.id;
      expect(inserted.active).toBe(true);
      expect(inserted.lastFetchStatus).toBe("never");

      await db.update(feeds).set({ active: false }).where(eq(feeds.id, feedId));
      const [toggled] = await db.select().from(feeds).where(eq(feeds.id, feedId));
      expect(toggled.active).toBe(false);

      await db.delete(feeds).where(eq(feeds.id, feedId));
      const remaining = await db.select().from(feeds).where(eq(feeds.id, feedId));
      expect(remaining.length).toBe(0);
      feedId = null; // already deleted — nothing left for the finally block to clean up
    } finally {
      if (feedId) await db.delete(feeds).where(eq(feeds.id, feedId));
    }
  });
});
