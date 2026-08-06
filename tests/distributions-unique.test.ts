import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { db, articles, distributions } from "@/db";
import { eq } from "drizzle-orm";

// ─────────────────────────────────────────────────────────────────────────────
// distributions_one_wordpress_per_article (db/schema.ts) — a partial unique index on
// distributions.article_id WHERE channel = 'wordpress'. Guards the upsertDistribution invariant
// (lib/wp/publish.ts): at most one 'wordpress' distribution row per article, preventing a
// theoretical race-created duplicate that would double a row in the /published list. Partial, so
// other channels (e.g. a future 'facebook' distribution) are NOT constrained — an article can
// have many non-wordpress rows alongside its single wordpress one.
// Network-free: real Neon DB only, no external HTTP.
describe("distributions_one_wordpress_per_article (partial unique index)", () => {
  let articleId: string;

  beforeAll(async () => {
    const [article] = await db.insert(articles).values({
      title: "Article de test (index unique distributions)", bodyHtml: "<p>Contenu de test.</p>",
      status: "approved",
    }).returning();
    articleId = article.id;
  });

  afterAll(async () => {
    // FK order: distributions first, then the article (distributions.article_id references
    // articles.id — matches the cleanup convention in tests/wp-publish.test.ts).
    if (articleId) {
      await db.delete(distributions).where(eq(distributions.articleId, articleId));
      await db.delete(articles).where(eq(articles.id, articleId));
    }
  });

  it("rejects a second 'wordpress' distribution row for the same article (SQLSTATE 23505)", async () => {
    await db.insert(distributions).values({ articleId, channel: "wordpress", status: "sent", externalId: "123" });

    // Drizzle wraps the pg error in DrizzleQueryError, so the SQLSTATE is on `.cause`.
    let code: string | undefined;
    try {
      await db.insert(distributions).values({ articleId, channel: "wordpress", status: "pending" });
    } catch (e) {
      code = (e as { code?: string }).code ?? (e as { cause?: { code?: string } }).cause?.code;
    }
    expect(code).toBe("23505");

    // Still exactly one wordpress row for this article — the rejected insert left no trace.
    const wpRows = await db.select().from(distributions).where(eq(distributions.articleId, articleId));
    expect(wpRows.filter((d) => d.channel === "wordpress")).toHaveLength(1);
  });

  it("allows a non-'wordpress' channel row for the same article (partial index doesn't block other channels)", async () => {
    const [row] = await db.insert(distributions).values({ articleId, channel: "facebook", status: "sent" }).returning();
    expect(row.channel).toBe("facebook");

    const rows = await db.select().from(distributions).where(eq(distributions.articleId, articleId));
    expect(rows.map((d) => d.channel).sort()).toEqual(["facebook", "wordpress"]);
  });
});
