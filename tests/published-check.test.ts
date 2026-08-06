import { describe, it, expect, afterAll } from "bun:test";
import { db, articles } from "@/db";
import { eq, inArray } from "drizzle-orm";

// ─────────────────────────────────────────────────────────────────────────────
// articles_published_has_date (db/schema.ts) — a CHECK constraint on articles:
// status <> 'published' OR published_at IS NOT NULL. Backs the PublishedRow.publishedAt: Date
// type + the `r.publishedAt!` non-null assertion in lib/queries/published.ts — the DB now
// guarantees any 'published' row has a date, so the app-level assertion can't be violated.
// Non-published rows (draft/pending/approved/rejected/...) are NOT constrained and legitimately
// keep published_at NULL. Network-free: real Neon DB only, no external HTTP.
describe("articles_published_has_date (CHECK constraint)", () => {
  const articleIds: string[] = [];

  afterAll(async () => {
    if (articleIds.length) await db.delete(articles).where(inArray(articles.id, articleIds));
  });

  it("rejects status='published' with published_at = NULL on insert (SQLSTATE 23514)", async () => {
    let code: string | undefined;
    try {
      await db.insert(articles).values({
        title: "CheckTest published sans date", bodyHtml: "<p>x</p>",
        status: "published", publishedAt: null,
      });
    } catch (e) {
      // Drizzle wraps the pg error in DrizzleQueryError, so the SQLSTATE is on `.cause`.
      code = (e as { code?: string }).code ?? (e as { cause?: { code?: string } }).cause?.code;
    }
    expect(code).toBe("23514");
  });

  it("rejects updating an existing article to status='published' while published_at stays NULL (SQLSTATE 23514)", async () => {
    const [row] = await db.insert(articles).values({
      title: "CheckTest pending vers published", bodyHtml: "<p>x</p>",
      status: "pending", publishedAt: null,
    }).returning({ id: articles.id });
    articleIds.push(row.id);

    let code: string | undefined;
    try {
      await db.update(articles).set({ status: "published" }).where(eq(articles.id, row.id));
    } catch (e) {
      code = (e as { code?: string }).code ?? (e as { cause?: { code?: string } }).cause?.code;
    }
    expect(code).toBe("23514");

    // The rejected update left no trace — still pending.
    const [after] = await db.select({ status: articles.status }).from(articles).where(eq(articles.id, row.id));
    expect(after.status).toBe("pending");
  });

  it("allows a 'pending' article with published_at = NULL", async () => {
    const [row] = await db.insert(articles).values({
      title: "CheckTest pending sans date", bodyHtml: "<p>x</p>",
      status: "pending", publishedAt: null,
    }).returning({ id: articles.id, status: articles.status, publishedAt: articles.publishedAt });
    articleIds.push(row.id);
    expect(row.status).toBe("pending");
    expect(row.publishedAt).toBeNull();
  });

  it("allows a 'published' article WITH a published_at", async () => {
    const publishedAt = new Date("2026-08-06T10:00:00Z");
    const [row] = await db.insert(articles).values({
      title: "CheckTest published avec date", bodyHtml: "<p>x</p>",
      status: "published", publishedAt,
    }).returning({ id: articles.id, status: articles.status, publishedAt: articles.publishedAt });
    articleIds.push(row.id);
    expect(row.status).toBe("published");
    expect(row.publishedAt).toEqual(publishedAt);
  });
});
