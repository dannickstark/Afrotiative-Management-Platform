import { describe, it, expect, mock, afterAll } from "bun:test";
import { can } from "@/lib/rbac";
import { LOCK_TTL_MS, isLockActive } from "@/lib/lock";
import { db, articles, articleRevisions, wpCategories, user } from "@/db";
import { eq, inArray } from "drizzle-orm";
import { faker } from "@faker-js/faker";

describe("article action rules", () => {
  it("only editor/admin may approve/reject/regenerate", () => {
    for (const a of ["approve", "reject", "regenerate"] as const) {
      expect(can("journalist", "article", a)).toBe(false);
      expect(can("editor", "article", a)).toBe(true);
    }
  });
  it("lock older than TTL is inactive", () => {
    expect(isLockActive(new Date(Date.now() - LOCK_TTL_MS - 1000))).toBe(false);
    expect(isLockActive(new Date())).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// fixArticleFields — starts with requireUser() → next/headers() and ends with
// revalidatePath() → next/cache, neither of which works outside a real Next.js request/render
// scope under plain `bun test` (same constraint documented at length in
// tests/queue-actions.test.ts). Same recipe as that file: capture the REAL exports as plain
// values first, register mock.module() stubs, dynamically `import()` article-actions.ts so its
// own static imports resolve against the mocks, and restore the real exports in afterAll so
// nothing leaks into files that run later in the same `bun test` process.
const { requireUser: realRequireUser, getSession: realGetSession } = await import("@/lib/session");
const { revalidatePath: realRevalidatePath, revalidateTag: realRevalidateTag } = await import("next/cache");

const [seededAdmin] = await db.select({ id: user.id, role: user.role }).from(user).where(eq(user.email, "admin@afrotiative.com"));
if (!seededAdmin) throw new Error("Seed manquant : admin@afrotiative.com introuvable (bun run db:seed).");

const FAKE_ADMIN = {
  id: seededAdmin.id, name: "Test Admin", email: "admin@afrotiative.com",
  role: seededAdmin.role, banned: false, image: null,
};

mock.module("@/lib/session", () => ({
  getSession: realGetSession,
  requireUser: async () => FAKE_ADMIN,
}));
mock.module("next/cache", () => ({
  revalidatePath: () => {},
  revalidateTag: realRevalidateTag,
}));

const { fixArticleFields } = await import("@/lib/actions/article-actions");

// Self-cleaning DB fixtures (real Neon dev DB) — every article created via seedArticle, and the
// one category seeded for these tests, are deleted in afterAll below; article_sources/
// article_tags/article_revisions cascade with the article.
const createdArticleIds: string[] = [];

async function seedArticle(overrides: Partial<typeof articles.$inferInsert>): Promise<string> {
  const [row] = await db.insert(articles).values({
    title: faker.lorem.sentence(),
    bodyHtml: "<p>Corps de test.</p>",
    generatedAt: new Date(),
    status: "pending",
    ...overrides,
  }).returning({ id: articles.id });
  createdArticleIds.push(row.id);
  return row.id;
}

const [seededCategory] = await db.insert(wpCategories).values({
  name: "FixArticleFieldsTest", slug: "fixarticlefieldstest",
}).returning({ id: wpCategories.id });
const existingCategoryId = seededCategory.id;

afterAll(async () => {
  mock.module("@/lib/session", () => ({ getSession: realGetSession, requireUser: realRequireUser }));
  mock.module("next/cache", () => ({ revalidatePath: realRevalidatePath, revalidateTag: realRevalidateTag }));
  if (createdArticleIds.length) await db.delete(articles).where(inArray(articles.id, createdArticleIds));
  await db.delete(wpCategories).where(eq(wpCategories.id, existingCategoryId));
});

describe("fixArticleFields", () => {
  it("écrit les champs et recalcule les informations manquantes", async () => {
    const id = await seedArticle({ status: "pending", categoryId: null, featuredImageUrl: null });
    const res = await fixArticleFields({
      id,
      categoryId: existingCategoryId,
      featuredImageUrl: "https://www.agenceecofin.com/img/p.jpg",
      imageCredit: "Ecofin",
      imageSourceUrl: "https://www.agenceecofin.com/a/1",
    });
    expect(res.ok).toBe(true);
    expect(res.missingFields).not.toContain("categoryId");
    expect(res.missingFields).not.toContain("featuredImageUrl");
    expect(res.missingFields).not.toContain("imageCredit");

    const [row] = await db.select({ missingFields: articles.missingFields, imageCredit: articles.imageCredit })
      .from(articles).where(eq(articles.id, id));
    expect(row.imageCredit).toBe("Ecofin");
    expect(row.missingFields).toEqual(res.missingFields);
  });

  it("consigne une révision « informations complétées »", async () => {
    const id = await seedArticle({ status: "pending" });
    await fixArticleFields({ id, imageCredit: "Ecofin" });
    const revs = await db.select().from(articleRevisions).where(eq(articleRevisions.articleId, id));
    expect(revs.some((r) => r.action === "informations complétées")).toBe(true);
  });

  it("refuse une URL d'image non sûre", async () => {
    const id = await seedArticle({ status: "pending" });
    await expect(
      fixArticleFields({ id, featuredImageUrl: "http://localhost/secret.png" }),
    ).rejects.toThrow();
  });

  it("refuse une URL syntaxiquement invalide", async () => {
    const id = await seedArticle({ status: "pending" });
    await expect(fixArticleFields({ id, featuredImageUrl: "pas une url" })).rejects.toThrow();
  });

  it("n'écrase pas un champ non fourni", async () => {
    const id = await seedArticle({ status: "pending", imageCredit: "Crédit initial" });
    await fixArticleFields({ id, imageSourceUrl: "https://ex.com/a" });
    const [row] = await db.select({ imageCredit: articles.imageCredit })
      .from(articles).where(eq(articles.id, id));
    expect(row.imageCredit).toBe("Crédit initial");
  });
});
