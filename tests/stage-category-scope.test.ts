import { describe, it, expect, afterAll } from "bun:test";
import { db, articles, clusters } from "@/db";
import { eq, like } from "drizzle-orm";
import { isInCategoryScope, stageSources, type SourceInput } from "@/lib/pipeline/stages";

// TASK A2 — "filter output": a run scoped to selected categories keeps only articles the AI
// classifies into those categories; everything else is skipped BEFORE any DB write. Categories are
// WordPress-synced (wpCategories) and the AI outputs a category NAME (draft.category) during
// synthesis — so the scope check is a pure string-set membership test, isInCategoryScope, which is
// this file's primary target.

describe("isInCategoryScope (pure)", () => {
  it("scope=null means unrestricted — always true, even for a null/undefined category", () => {
    expect(isInCategoryScope("Sport", null)).toBe(true);
    expect(isInCategoryScope("Économie", null)).toBe(true);
    expect(isInCategoryScope(null, null)).toBe(true);
    expect(isInCategoryScope(undefined, null)).toBe(true);
  });

  it("a category outside a non-null scope is false", () => {
    const scope = new Set(["Sport"]);
    expect(isInCategoryScope("Économie", scope)).toBe(false);
  });

  it("a category inside a non-null scope is true", () => {
    const scope = new Set(["Sport"]);
    expect(isInCategoryScope("Sport", scope)).toBe(true);
  });

  it("a null/undefined category is out of scope whenever the scope is restricted", () => {
    const scope = new Set(["Sport"]);
    expect(isInCategoryScope(null, scope)).toBe(false);
    expect(isInCategoryScope(undefined, scope)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration: drive the REAL stageSources() network-free. No provider credentials are configured
// in the test environment (test-setup.ts strips every *_API_KEY before any test runs), so
// generateArticle()/embed() always land on their deterministic mock fallback — see
// tests/auto-publish-run.test.ts's own extensive comment on why this is the established
// network-free pattern in this repo, and why a real LLM round-trip is neither needed nor wanted
// here. lib/ai/mock.ts's mockGenerateArticle sets `draft.category = categories[0]` deterministically
// (repairDraft, in lib/pipeline/completeness.ts, never touches category — "La catégorie n'est
// JAMAIS devinée" — so it stays exactly what the mock produced). That determinism is what lets this
// test assert the OUT-of-scope branch without any mocking framework: pass categoryNames with the
// mock's guaranteed pick ("Sport") first, then scope the run to a DIFFERENT category ("Économie")
// only.
//
// decideCluster() (lib/pipeline/cluster.ts) still issues a real, read-only SELECT against the dev
// DB even on this path — there is no way to avoid that inside stageSources itself — but it never
// INSERTs, so this test needs no DB fixture/teardown of its own. The decisive assertion is that NO
// article row is ever created for this run's unique mock title.

const SOURCES: SourceInput[] = [
  { mediaName: "Média Test A2", url: "https://src.example/a2-scope-test", text: "Texte de test pour la portée de catégorie A2, suffisamment long." },
];

describe("stageSources (network-free, mock fallback) — category scope enforcement", () => {
  // Populated only by the in-scope test below (the out-of-scope test never reaches persistArticle,
  // so it never creates a row to clean up).
  const createdArticleIds: string[] = [];
  const createdClusterIds: string[] = [];

  afterAll(async () => {
    if (createdArticleIds.length > 0) {
      // Cascades article_sources/article_tags/article_embeddings/article_revisions — same idiom as
      // tests/auto-publish-run.test.ts.
      await db.delete(articles).where(eq(articles.id, createdArticleIds[0]));
    }
    for (const clusterId of createdClusterIds) {
      const stillUsed = await db.select({ id: articles.id }).from(articles).where(eq(articles.clusterId, clusterId)).limit(1);
      if (stillUsed.length === 0) await db.delete(clusters).where(eq(clusters.id, clusterId));
    }
  });

  it("skips a story classified outside the run's category scope: articleId null, 'Hors catégorie sélectionnée (ignoré)' step, no DB write, no 'Dépôt en revue' step", async () => {
    const categoryNames = ["Sport", "Économie"]; // mock deterministically picks categoryNames[0] = "Sport"
    const categoryScope = new Set(["Économie"]); // scope excludes "Sport"

    const { articleId, steps, skipped } = await stageSources(SOURCES, categoryNames, {}, undefined, undefined, categoryScope);

    expect(articleId).toBeNull();
    // TASK A-STATS — this is the field executeRun (lib/pipeline/run.ts) reads to keep a category
    // filter-out from being tallied/alerted as a story failure (see classifyRunOutcome there).
    expect(skipped).toBe(true);
    expect(steps.some((s) => s.name === "Hors catégorie sélectionnée (ignoré)" && s.status === "success")).toBe(true);
    expect(steps.some((s) => s.name === "Dépôt en revue")).toBe(false);

    // Belt-and-suspenders: the mock title is deterministic from the source text above, so confirm
    // no article row was ever inserted for this run — the skip happened strictly before any write.
    const rows = await db.select({ id: articles.id }).from(articles).where(like(articles.title, "%portée de catégorie A2%"));
    expect(rows).toHaveLength(0);
  });

  it("stages normally (does not skip, does write to the DB) when the story's category IS in scope", async () => {
    const categoryNames = ["Sport", "Économie"]; // mock picks "Sport"
    const categoryScope = new Set(["Sport"]); // scope includes "Sport"

    const { articleId, steps, skipped } = await stageSources(SOURCES, categoryNames, {}, undefined, undefined, categoryScope);
    expect(articleId).not.toBeNull();
    createdArticleIds.push(articleId!);

    expect(skipped).toBeUndefined(); // TASK A-STATS — falsy on every non-skip return path
    expect(steps.some((s) => s.name === "Hors catégorie sélectionnée (ignoré)")).toBe(false);
    expect(steps.some((s) => s.name === "Dépôt en revue" && s.status === "success")).toBe(true);

    const [row] = await db.select().from(articles).where(eq(articles.id, articleId!));
    if (row.clusterId) createdClusterIds.push(row.clusterId);
  });
});
