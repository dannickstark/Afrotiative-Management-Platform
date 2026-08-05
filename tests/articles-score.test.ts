import { describe, it, expect } from "bun:test";
import { db, articles } from "@/db";
import { eq } from "drizzle-orm";

// SP4 Task 1 — round-trips articles.score, the additive nullable column that SP4 Task 4's
// computeArticleScore() feeds and SP6's auto-publish gate later reads.
describe("articles.score column", () => {
  it("round-trips an integer score and defaults to null when omitted", async () => {
    const [withScore] = await db.insert(articles).values({
      title: "Article de test — score",
      bodyHtml: "<p>Contenu.</p>",
      score: 82,
    }).returning();

    try {
      expect(withScore.score).toBe(82);

      const [reloaded] = await db.select().from(articles).where(eq(articles.id, withScore.id));
      expect(reloaded.score).toBe(82);

      await db.update(articles).set({ score: 41 }).where(eq(articles.id, withScore.id));
      const [updated] = await db.select().from(articles).where(eq(articles.id, withScore.id));
      expect(updated.score).toBe(41);
    } finally {
      await db.delete(articles).where(eq(articles.id, withScore.id));
    }

    const [withoutScore] = await db.insert(articles).values({
      title: "Article de test — score absent",
      bodyHtml: "<p>Contenu.</p>",
    }).returning();
    try {
      expect(withoutScore.score).toBeNull();
    } finally {
      await db.delete(articles).where(eq(articles.id, withoutScore.id));
    }
  });
});
