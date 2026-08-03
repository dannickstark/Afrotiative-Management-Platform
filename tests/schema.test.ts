import { describe, it, expect, afterAll } from "bun:test";
import { db, feeds } from "@/db";
import { eq } from "drizzle-orm";

describe("schema", () => {
  const marker = "TEST_FEED_ZZZ";
  afterAll(async () => { await db.delete(feeds).where(eq(feeds.name, marker)); });

  it("inserts and reads a feed round-trip", async () => {
    const [row] = await db.insert(feeds)
      .values({ name: marker, feedUrl: "https://example.com/rss" })
      .returning();
    expect(row.id).toBeTruthy();
    expect(row.active).toBe(true);
    expect(row.lastFetchStatus).toBe("never");
  });
});
