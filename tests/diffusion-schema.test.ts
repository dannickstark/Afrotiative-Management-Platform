import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { db, articles, distributions } from "@/db";
import { and, eq } from "drizzle-orm";
import { can } from "@/lib/rbac";

// ─────────────────────────────────────────────────────────────────────────────
// RBAC — resource "social" (D1 §1/§6): admin gets read/manage/send, editor gets read/send but NOT
// manage (settings stay admin-only — the editor only diffuses from the article page), journalist
// gets none. Pure can() checks — a guarded "use server" action can't be exercised under `bun test`
// (requireUser() needs next/headers, unavailable outside a request — same constraint documented in
// lib/pipeline/settings-write.ts and exercised the same way in tests/studio-rbac.test.ts).
// ─────────────────────────────────────────────────────────────────────────────
describe('can() — ressource "social"', () => {
  it("admin a les trois droits", () => {
    expect(can("admin", "social", "read")).toBe(true);
    expect(can("admin", "social", "manage")).toBe(true);
    expect(can("admin", "social", "send")).toBe(true);
  });

  it("éditeur : read + send, mais pas manage", () => {
    expect(can("editor", "social", "read")).toBe(true);
    expect(can("editor", "social", "send")).toBe(true);
    expect(can("editor", "social", "manage")).toBe(false);
  });

  it("journaliste : aucun des trois droits", () => {
    expect(can("journalist", "social", "read")).toBe(false);
    expect(can("journalist", "social", "manage")).toBe(false);
    expect(can("journalist", "social", "send")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// distributions_one_active_per_article_channel (db/schema.ts) — a partial unique index on
// (article_id, channel) WHERE channel <> 'wordpress' AND status IN ('pending','sent'). This is D1
// §1's hard guarantee: an article never leaves twice, in flight, on the same non-WordPress channel
// — whichever insert wins a race, the loser hits SQLSTATE 23505. Network-free: real Neon DB only.
// ─────────────────────────────────────────────────────────────────────────────
describe("distributions_one_active_per_article_channel (partial unique index)", () => {
  let articleId: string;

  beforeAll(async () => {
    const [article] = await db.insert(articles).values({
      title: "Article de test (index unique diffusion sociale)", bodyHtml: "<p>Contenu de test.</p>",
      status: "approved",
    }).returning();
    articleId = article.id;
  });

  afterAll(async () => {
    if (articleId) {
      await db.delete(distributions).where(eq(distributions.articleId, articleId));
      await db.delete(articles).where(eq(articles.id, articleId));
    }
  });

  it("rejects a second 'pending' row for the same (article, non-wordpress channel) — SQLSTATE 23505", async () => {
    await db.insert(distributions).values({ articleId, channel: "facebook", status: "pending" });

    let code: string | undefined;
    try {
      await db.insert(distributions).values({ articleId, channel: "facebook", status: "pending" });
    } catch (e) {
      code = (e as { code?: string }).code ?? (e as { cause?: { code?: string } }).cause?.code;
    }
    expect(code).toBe("23505");

    const rows = await db.select().from(distributions)
      .where(and(eq(distributions.articleId, articleId), eq(distributions.channel, "facebook")));
    expect(rows).toHaveLength(1); // the rejected insert left no trace
  });

  it("allows a 'wordpress' row alongside the 'facebook' row for the same article (partial index scopes to non-wordpress)", async () => {
    const [row] = await db.insert(distributions).values({ articleId, channel: "wordpress", status: "sent" }).returning();
    expect(row.channel).toBe("wordpress");

    const rows = await db.select().from(distributions).where(eq(distributions.articleId, articleId));
    expect(rows.map((d) => d.channel).sort()).toEqual(["facebook", "wordpress"]);
  });

  it("a 'failed' row does not block a retry — a fresh 'pending' insert for the same (article, channel) succeeds", async () => {
    const [article2] = await db.insert(articles).values({
      title: "Article de test (retry après échec)", bodyHtml: "<p>Contenu de test.</p>", status: "approved",
    }).returning();
    try {
      await db.insert(distributions).values({ articleId: article2.id, channel: "x", status: "failed", attempts: 1, lastError: "Erreur simulée." });

      // Would throw SQLSTATE 23505 if the index counted the failed row toward the slot.
      const [retry] = await db.insert(distributions).values({ articleId: article2.id, channel: "x", status: "pending" }).returning();
      expect(retry.status).toBe("pending");

      const rows = await db.select().from(distributions).where(eq(distributions.articleId, article2.id));
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.status).sort()).toEqual(["failed", "pending"]);
    } finally {
      await db.delete(distributions).where(eq(distributions.articleId, article2.id));
      await db.delete(articles).where(eq(articles.id, article2.id));
    }
  });

  it("two 'pending'/'sent' rows for the same (article, channel) are rejected in either order (sent-then-pending too)", async () => {
    const [article3] = await db.insert(articles).values({
      title: "Article de test (sent puis pending)", bodyHtml: "<p>Contenu de test.</p>", status: "approved",
    }).returning();
    try {
      await db.insert(distributions).values({ articleId: article3.id, channel: "instagram", status: "sent", externalId: "abc" });

      let code: string | undefined;
      try {
        await db.insert(distributions).values({ articleId: article3.id, channel: "instagram", status: "pending" });
      } catch (e) {
        code = (e as { code?: string }).code ?? (e as { cause?: { code?: string } }).cause?.code;
      }
      expect(code).toBe("23505");
    } finally {
      await db.delete(distributions).where(eq(distributions.articleId, article3.id));
      await db.delete(articles).where(eq(articles.id, article3.id));
    }
  });
});
