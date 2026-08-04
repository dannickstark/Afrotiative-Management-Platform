import { describe, it, expect, beforeAll, afterAll } from "bun:test";
// diffTaxonomy lives in lib/taxonomy-diff.ts, not lib/actions/taxonomy-actions.ts — that module
// needs a file-level "use server" directive (so components/settings/taxonomy-tables.tsx, a Client
// Component, can import syncTaxonomyFromWordPress directly), and Next.js 16 only allows
// async-function exports from such a module. A synchronous pure helper like diffTaxonomy has to
// live in a plain module instead (same fix as Task 2's validateFeedInput / Task 3's
// generateTempPassword — verified against `bun run build`).
import { diffTaxonomy } from "@/lib/taxonomy-diff";
import { applyTaxonomySync } from "@/lib/actions/taxonomy-actions";
import { getWpConfig } from "@/lib/wp/config";
import { WordPressClient } from "@/lib/wp/client";
import { db, wpCategories, wpTags } from "@/db";
import { eq } from "drizzle-orm";

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
// against the REAL wp_categories/wp_tags tables (real Neon DB) — the action itself isn't called
// directly because it starts with requireUser(), which needs a real Next.js request context
// unavailable under plain `bun test` (same constraint noted in tests/team-actions.test.ts and
// tests/feed-actions.test.ts).
//
// Uses two of the ACTUAL seeded names ("Économie" / "BRVM", db/seed.ts) as WP terms so the test
// proves the specific correctness requirement from the brief: an existing row's seeded PLACEHOLDER
// wpId (an arbitrary 1-based index from db/seed.ts, not a real WordPress id) gets REPLACED by the
// real WP id — not duplicated — plus one brand-new name each for the insert case.
// ─────────────────────────────────────────────────────────────────────────────
const ENV_KEYS = ["WP_BASE_URL", "WP_USER", "WP_APP_PASSWORD"] as const;
const savedWpEnv: Record<string, string | undefined> = {};

describe("taxonomy sync (fake WP + real DB): update seeded placeholder + insert new", () => {
  let server: ReturnType<typeof Bun.serve>;
  let insertedCategoryId: string | null = null;
  let insertedTagId: string | null = null;

  beforeAll(() => {
    for (const k of ENV_KEYS) savedWpEnv[k] = process.env[k];

    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname.endsWith("/categories") && req.method === "GET") {
          return Response.json([
            { id: 5001, name: "Économie", count: 99 }, // matches a seeded category -> UPDATE
            { id: 5002, name: "Catégorie Test Sync", count: 7 }, // no match -> INSERT
          ]);
        }
        if (url.pathname.endsWith("/tags") && req.method === "GET") {
          return Response.json([
            { id: 6001, name: "BRVM", count: 55 }, // matches a seeded tag -> UPDATE
            { id: 6002, name: "Tag Test Sync", count: 3 }, // no match -> INSERT
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
    // Self-clean the two newly-inserted temp rows.
    if (insertedCategoryId) await db.delete(wpCategories).where(eq(wpCategories.id, insertedCategoryId));
    if (insertedTagId) await db.delete(wpTags).where(eq(wpTags.id, insertedTagId));
    for (const k of ENV_KEYS) {
      if (savedWpEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedWpEnv[k];
    }
    // "Économie"/"BRVM" were mutated in place (wpId/articleCount) — restored by the caller's
    // `bun run db:seed` after the full suite runs (per task instructions), not here.
  });

  it("updates the seeded 'Économie' category's placeholder wpId and inserts the new category", async () => {
    const cfg = getWpConfig();
    expect(cfg).not.toBeNull();
    const wp = new WordPressClient(cfg!);
    const wpCats = await wp.getCategories();
    expect(wpCats).toEqual([
      { id: 5001, name: "Économie", count: 99 },
      { id: 5002, name: "Catégorie Test Sync", count: 7 },
    ]);

    const [economieBefore] = await db.select().from(wpCategories).where(eq(wpCategories.name, "Économie"));
    expect(economieBefore).toBeDefined();
    expect(economieBefore.wpId).not.toBe(5001); // still the seeded placeholder, not the real WP id

    const existing = await db
      .select({ id: wpCategories.id, name: wpCategories.name, wpId: wpCategories.wpId })
      .from(wpCategories);
    const result = await applyTaxonomySync(existing, wpCats, {
      insert: (rows) => db.insert(wpCategories).values(rows),
      update: (id, patch) => db.update(wpCategories).set(patch).where(eq(wpCategories.id, id)),
    });
    expect(result).toEqual({ inserted: 1, updated: 1 });

    const [economieAfter] = await db.select().from(wpCategories).where(eq(wpCategories.name, "Économie"));
    expect(economieAfter.wpId).toBe(5001);
    expect(economieAfter.articleCount).toBe(99);
    expect(economieAfter.id).toBe(economieBefore.id); // same row updated, not duplicated

    const allEconomie = await db.select().from(wpCategories).where(eq(wpCategories.name, "Économie"));
    expect(allEconomie).toHaveLength(1); // no duplicate created

    const [newCat] = await db.select().from(wpCategories).where(eq(wpCategories.name, "Catégorie Test Sync"));
    expect(newCat).toBeDefined();
    expect(newCat.wpId).toBe(5002);
    expect(newCat.articleCount).toBe(7);
    insertedCategoryId = newCat.id;
  });

  it("updates the seeded 'BRVM' tag's placeholder wpId and inserts the new tag", async () => {
    const cfg = getWpConfig();
    const wp = new WordPressClient(cfg!);
    const wpTagsList = await wp.getTags();

    const [brvmBefore] = await db.select().from(wpTags).where(eq(wpTags.name, "BRVM"));
    expect(brvmBefore).toBeDefined();
    expect(brvmBefore.wpId).not.toBe(6001);

    const existing = await db.select({ id: wpTags.id, name: wpTags.name, wpId: wpTags.wpId }).from(wpTags);
    const result = await applyTaxonomySync(existing, wpTagsList, {
      insert: (rows) => db.insert(wpTags).values(rows),
      update: (id, patch) => db.update(wpTags).set(patch).where(eq(wpTags.id, id)),
    });
    expect(result).toEqual({ inserted: 1, updated: 1 });

    const [brvmAfter] = await db.select().from(wpTags).where(eq(wpTags.name, "BRVM"));
    expect(brvmAfter.wpId).toBe(6001);
    expect(brvmAfter.articleCount).toBe(55);
    expect(brvmAfter.id).toBe(brvmBefore.id);

    const [newTag] = await db.select().from(wpTags).where(eq(wpTags.name, "Tag Test Sync"));
    expect(newTag).toBeDefined();
    expect(newTag.wpId).toBe(6002);
    expect(newTag.articleCount).toBe(3);
    insertedTagId = newTag.id;
  });
});
