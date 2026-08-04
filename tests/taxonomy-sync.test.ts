import { describe, it, expect, beforeAll, afterAll } from "bun:test";
// diffTaxonomy lives in lib/taxonomy-diff.ts and the DB-upsert core (applyTaxonomySync) in
// lib/taxonomy-sync-core.ts — NEITHER in lib/actions/taxonomy-actions.ts. That module carries a
// file-level "use server" directive, which (a) only permits async-function exports and (b) makes
// EVERY export a callable Server Action with no auth of its own — so the pure helper and the raw
// DB-writer are deliberately kept out of it (the writer would otherwise be an unauthenticated
// write path; the guarded syncTaxonomyFromWordPress action wraps it). Same structural fix as SP5's
// publishDueArticles and Tasks 2–3's validateFeedInput/generateTempPassword.
import { diffTaxonomy } from "@/lib/taxonomy-diff";
import { applyTaxonomySync } from "@/lib/taxonomy-sync-core";
import { getWpConfig } from "@/lib/wp/config";
import { WordPressClient } from "@/lib/wp/client";
import { db, wpCategories, wpTags } from "@/db";
import { eq, inArray, like } from "drizzle-orm";

describe("diffTaxonomy", () => {
  it("splits WP terms into inserts (new names) and updates (existing names)", () => {
    const existing = [{ name: "Économie", wpId: null as number | null }];
    const wp = [{ id: 5, name: "Économie" }, { id: 8, name: "Finance" }];
    const d = diffTaxonomy(existing, wp);
    expect(d.updates).toEqual([{ name: "Économie", wpId: 5 }]);
    expect(d.inserts).toEqual([{ name: "Finance", wpId: 8 }]);
  });

  it("matches names case-insensitively", () => {
    const existing = [{ name: "BRVM", wpId: 1 }];
    const wp = [{ id: 9, name: "brvm" }];
    const d = diffTaxonomy(existing, wp);
    expect(d.updates).toEqual([{ name: "brvm", wpId: 9 }]);
    expect(d.inserts).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration: a Bun.serve FAKE WordPress + real WP env pointing at it, exercising the exact
// getWpConfig -> WordPressClient -> applyTaxonomySync path syncTaxonomyFromWordPress uses,
// against the REAL wp_categories/wp_tags tables (real Neon DB). syncTaxonomyFromWordPress itself
// isn't called directly because it starts with requireUser(), which needs a real Next.js request
// context unavailable under plain `bun test` (same constraint noted across the suite).
//
// FULLY SELF-CLEANING — it NEVER mutates a seeded row, so no `bun run db:seed` is required to
// recover from it. The mechanism: the test inserts its OWN rows with unique `ZZZTEST_…` names
// (placeholder wpIds), and the fake WP returns ONLY those test names — an EXISTING one (proves the
// placeholder wpId → real wpId update lands on the SAME row) and a NEW one (proves insert). Since
// the upsert is insert/update-by-name only and the WP response contains no seeded name, every
// seeded row is left untouched (asserted below). afterAll deletes ALL `ZZZTEST_…` rows — both the
// ones this test inserted and the one the sync inserted.
// ─────────────────────────────────────────────────────────────────────────────
const ENV_KEYS = ["WP_BASE_URL", "WP_USER", "WP_APP_PASSWORD"] as const;
const savedWpEnv: Record<string, string | undefined> = {};

const CAT_EXISTING = "ZZZTEST_CAT_EXISTING";
const CAT_NEW = "ZZZTEST_CAT_NEW";
const TAG_EXISTING = "ZZZTEST_TAG_EXISTING";
const TAG_NEW = "ZZZTEST_TAG_NEW";
const PLACEHOLDER_WPID = 999001; // stand-in for a seeded/stale id; the sync must replace it

describe("taxonomy sync (fake WP + real DB, fully self-cleaning)", () => {
  let server: ReturnType<typeof Bun.serve>;
  let seededCatSnapshot: { id: string; name: string; wpId: number | null; articleCount: number }[] = [];
  let seededTagSnapshot: { id: string; name: string; wpId: number | null; articleCount: number }[] = [];

  beforeAll(async () => {
    for (const k of ENV_KEYS) savedWpEnv[k] = process.env[k];

    // Pre-sweep any stray ZZZTEST_ rows from a prior aborted run so the seeded snapshot below is
    // clean and the inserts don't duplicate (idempotent setup).
    await db.delete(wpCategories).where(like(wpCategories.name, "ZZZTEST\\_%"));
    await db.delete(wpTags).where(like(wpTags.name, "ZZZTEST\\_%"));

    // Snapshot the seeded rows so we can prove none of them changed after the sync.
    seededCatSnapshot = await db
      .select({ id: wpCategories.id, name: wpCategories.name, wpId: wpCategories.wpId, articleCount: wpCategories.articleCount })
      .from(wpCategories);
    seededTagSnapshot = await db
      .select({ id: wpTags.id, name: wpTags.name, wpId: wpTags.wpId, articleCount: wpTags.articleCount })
      .from(wpTags);

    // Insert our own EXISTING test rows (unique names, placeholder wpIds) — these are the rows the
    // sync must UPDATE in place (placeholder -> real WP id), never duplicate.
    await db.insert(wpCategories).values({ name: CAT_EXISTING, slug: "zzztest-cat-existing", wpId: PLACEHOLDER_WPID, articleCount: 0 });
    await db.insert(wpTags).values({ name: TAG_EXISTING, slug: "zzztest-tag-existing", wpId: PLACEHOLDER_WPID, articleCount: 0 });

    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        // Fake WP returns ONLY test-named terms — so the sync can never touch a seeded row.
        if (url.pathname.endsWith("/categories") && req.method === "GET") {
          return Response.json([
            { id: 5001, name: CAT_EXISTING, count: 99 }, // matches our test row -> UPDATE (real id replaces placeholder)
            { id: 5002, name: CAT_NEW, count: 7 }, // no match -> INSERT
          ]);
        }
        if (url.pathname.endsWith("/tags") && req.method === "GET") {
          return Response.json([
            { id: 6001, name: TAG_EXISTING, count: 55 }, // matches our test row -> UPDATE
            { id: 6002, name: TAG_NEW, count: 3 }, // no match -> INSERT
          ]);
        }
        return new Response("not found", { status: 404 });
      },
    });
    const base = `http://localhost:${server.port}`;
    process.env.WP_BASE_URL = base;
    process.env.WP_USER = "bot-test";
    process.env.WP_APP_PASSWORD = "app pass test";
  });

  afterAll(async () => {
    server.stop(true);
    // Delete ALL rows this suite is responsible for: the EXISTING rows it inserted AND the NEW rows
    // the sync inserted — matched by name, so nothing is left behind even if an assertion failed
    // mid-test. No `bun run db:seed` required.
    await db.delete(wpCategories).where(inArray(wpCategories.name, [CAT_EXISTING, CAT_NEW]));
    await db.delete(wpTags).where(inArray(wpTags.name, [TAG_EXISTING, TAG_NEW]));
    // Belt-and-suspenders: sweep any stray ZZZTEST_ row (e.g. a duplicate from a prior aborted run).
    await db.delete(wpCategories).where(like(wpCategories.name, "ZZZTEST\\_%"));
    await db.delete(wpTags).where(like(wpTags.name, "ZZZTEST\\_%"));
    for (const k of ENV_KEYS) {
      if (savedWpEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedWpEnv[k];
    }
  });

  it("fetches only test-named categories from the fake WP", async () => {
    const cfg = getWpConfig();
    expect(cfg).not.toBeNull();
    const wpCats = await new WordPressClient(cfg!).getCategories();
    expect(wpCats).toEqual([
      { id: 5001, name: CAT_EXISTING, count: 99 },
      { id: 5002, name: CAT_NEW, count: 7 },
    ]);
  });

  it("updates the test EXISTING category's placeholder wpId (same row) and inserts the NEW one", async () => {
    const [existingBefore] = await db.select().from(wpCategories).where(eq(wpCategories.name, CAT_EXISTING));
    expect(existingBefore).toBeDefined();
    expect(existingBefore.wpId).toBe(PLACEHOLDER_WPID);

    const wpCats = await new WordPressClient(getWpConfig()!).getCategories();
    // Pass the FULL table as `existing`, exactly as syncTaxonomyFromWordPress does — this is what
    // proves the seeded rows (present in `existing`, absent from the WP response) stay untouched.
    const existing = await db
      .select({ id: wpCategories.id, name: wpCategories.name, wpId: wpCategories.wpId })
      .from(wpCategories);
    const result = await applyTaxonomySync(existing, wpCats, {
      insert: (rows) => db.insert(wpCategories).values(rows),
      update: (id, patch) => db.update(wpCategories).set(patch).where(eq(wpCategories.id, id)),
    });
    expect(result).toEqual({ inserted: 1, updated: 1 });

    const [existingAfter] = await db.select().from(wpCategories).where(eq(wpCategories.name, CAT_EXISTING));
    expect(existingAfter.id).toBe(existingBefore.id); // SAME row updated, not duplicated
    expect(existingAfter.wpId).toBe(5001); // placeholder replaced by the real WP id
    expect(existingAfter.articleCount).toBe(99);
    const dupes = await db.select().from(wpCategories).where(eq(wpCategories.name, CAT_EXISTING));
    expect(dupes).toHaveLength(1);

    const [newCat] = await db.select().from(wpCategories).where(eq(wpCategories.name, CAT_NEW));
    expect(newCat).toBeDefined();
    expect(newCat.wpId).toBe(5002);
    expect(newCat.articleCount).toBe(7);
  });

  it("updates the test EXISTING tag's placeholder wpId (same row) and inserts the NEW one", async () => {
    const [existingBefore] = await db.select().from(wpTags).where(eq(wpTags.name, TAG_EXISTING));
    expect(existingBefore).toBeDefined();
    expect(existingBefore.wpId).toBe(PLACEHOLDER_WPID);

    const wpTagsList = await new WordPressClient(getWpConfig()!).getTags();
    const existing = await db.select({ id: wpTags.id, name: wpTags.name, wpId: wpTags.wpId }).from(wpTags);
    const result = await applyTaxonomySync(existing, wpTagsList, {
      insert: (rows) => db.insert(wpTags).values(rows),
      update: (id, patch) => db.update(wpTags).set(patch).where(eq(wpTags.id, id)),
    });
    expect(result).toEqual({ inserted: 1, updated: 1 });

    const [existingAfter] = await db.select().from(wpTags).where(eq(wpTags.name, TAG_EXISTING));
    expect(existingAfter.id).toBe(existingBefore.id);
    expect(existingAfter.wpId).toBe(6001);
    expect(existingAfter.articleCount).toBe(55);

    const [newTag] = await db.select().from(wpTags).where(eq(wpTags.name, TAG_NEW));
    expect(newTag).toBeDefined();
    expect(newTag.wpId).toBe(6002);
    expect(newTag.articleCount).toBe(3);
  });

  it("leaves every seeded taxonomy row untouched (no seed corruption)", async () => {
    // The two syncs above have run; the seeded rows must be byte-for-byte what they were before.
    const catsNow = new Map(
      (await db
        .select({ id: wpCategories.id, name: wpCategories.name, wpId: wpCategories.wpId, articleCount: wpCategories.articleCount })
        .from(wpCategories)).map((r) => [r.id, r]),
    );
    for (const before of seededCatSnapshot) {
      expect(catsNow.get(before.id)).toEqual(before); // wpId + articleCount + name unchanged
    }
    const tagsNow = new Map(
      (await db
        .select({ id: wpTags.id, name: wpTags.name, wpId: wpTags.wpId, articleCount: wpTags.articleCount })
        .from(wpTags)).map((r) => [r.id, r]),
    );
    for (const before of seededTagSnapshot) {
      expect(tagsNow.get(before.id)).toEqual(before);
    }
  });
});
