import { describe, it, expect, mock, afterAll } from "bun:test";
import { db, articles, articleRevisions, user } from "@/db";
import { eq, inArray } from "drizzle-orm";
import { faker } from "@faker-js/faker";
import { can } from "@/lib/rbac";

// ─────────────────────────────────────────────────────────────────────────────
// bulkApprove/bulkReject — like every RBAC-guarded Server Action in this app — start with
// requireUser() → next/headers(), and end with revalidatePath() → next/cache. Both need a real
// Next.js request/render scope that plain `bun test` doesn't provide: verified empirically here
// (`headers()` throws "was called outside a request scope", revalidatePath() throws "static
// generation store missing"), same underlying constraint documented across this suite for other
// RBAC-guarded actions (tests/reprocess.test.ts, tests/feed-actions.test.ts,
// tests/taxonomy-sync.test.ts, tests/team-actions.test.ts). Those files work around it by
// re-implementing the action's DB write path inline in the test. That approach doesn't fit here:
// the whole point of this task is the AGGREGATION logic INSIDE bulkApprove/bulkReject itself
// (screen-before-network, partial-success bookkeeping) — reimplementing that loop in the test
// would just exercise a hand-written duplicate, not the real thing.
//
// So this file mocks @/lib/session and next/cache instead, using the exact mock.module() recipe
// already established in tests/ai-fallback.test.ts / tests/ai-improve.test.ts: capture the REAL
// exports as plain values first (mock.module() mutates a module's exports in place, so holding a
// live namespace reference would go stale the moment we mock it — same reasoning documented in
// ai-fallback.test.ts), register the mocks, then dynamically `import()` queue-actions.ts so its
// own static imports resolve against the mocks, and restore the real exports in afterAll so
// nothing leaks into files that run later in the same `bun test` process.
//
// The mocked session needs a REAL user id: article_revisions.actor_id has a DB-level FK to
// user.id, so bulkReject's revision insert would fail on a made-up id. We use the seeded admin
// (admin@afrotiative.com — same account tests/team-actions.test.ts is careful never to mutate)
// read-only, purely as an actor reference.
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

const { bulkApprove, bulkReject } = await import("@/lib/actions/queue-actions");

// Unit-level guard: the action must refuse a journalist.
describe("queue action guards", () => {
  it("journalist cannot approve", () => { expect(can("journalist", "article", "approve")).toBe(false); });
  it("editor can approve", () => { expect(can("editor", "article", "approve")).toBe(true); });
});

// ─────────────────────────────────────────────────────────────────────────────
// Self-cleaning DB fixtures (real Neon dev DB) — every article created via seedArticle is
// deleted in afterAll below; article_sources/article_tags/article_revisions cascade with it.
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

afterAll(async () => {
  mock.module("@/lib/session", () => ({ getSession: realGetSession, requireUser: realRequireUser }));
  mock.module("next/cache", () => ({ revalidatePath: realRevalidatePath, revalidateTag: realRevalidateTag }));
  if (createdArticleIds.length) await db.delete(articles).where(inArray(articles.id, createdArticleIds));
});

describe("bulkApprove", () => {
  it("écarte AVANT tout appel réseau un article aux informations manquantes", async () => {
    // Article sans catégorie ni image → deux manques bloquants.
    const id = await seedArticle({ status: "pending", categoryId: null, featuredImageUrl: null });
    const res = await bulkApprove([id]);
    expect(res.ok).toEqual([]);
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0].message).toContain("Informations manquantes");
    expect(res.failed[0].message).toContain("Catégorie");
    expect(res.failed[0].message).toContain("Image à la une");
  });

  it("rapporte un succès partiel : les identifiants réussis et les échecs détaillés", async () => {
    const bad = await seedArticle({ status: "pending", categoryId: null, featuredImageUrl: null });
    const alsoBad = await seedArticle({ status: "pending", categoryId: null, featuredImageUrl: null });
    const res = await bulkApprove([bad, alsoBad]);
    expect(res.ok).toEqual([]);
    expect(res.failed.map((f) => f.id).sort()).toEqual([bad, alsoBad].sort());
    // Chaque échec porte le titre de son article, pas seulement son identifiant.
    for (const f of res.failed) expect(f.title.length).toBeGreaterThan(0);
  });

  it("refuse un identifiant qui n'est pas un UUID", async () => {
    await expect(bulkApprove(["pas-un-uuid"])).rejects.toThrow();
  });

  it("refuse une liste vide", async () => {
    await expect(bulkApprove([])).rejects.toThrow();
  });
});

describe("bulkReject", () => {
  it("exige un motif d'au moins 3 caractères", async () => {
    const id = await seedArticle({ status: "pending" });
    await expect(bulkReject({ ids: [id], reason: "ok" })).rejects.toThrow();
  });

  it("rejette chaque article et consigne une révision par article", async () => {
    const a = await seedArticle({ status: "pending" });
    const b = await seedArticle({ status: "pending" });
    const res = await bulkReject({ ids: [a, b], reason: "Hors ligne éditoriale" });
    expect(res.ok.sort()).toEqual([a, b].sort());
    expect(res.failed).toEqual([]);
    for (const id of [a, b]) {
      const [row] = await db.select({ status: articles.status }).from(articles).where(eq(articles.id, id));
      expect(row.status).toBe("rejected");
      const revs = await db.select().from(articleRevisions).where(eq(articleRevisions.articleId, id));
      expect(revs.some((r) => r.action === "rejeté")).toBe(true);
    }
  });
});
