import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { db, articles, articleSources, articleTags, articleRevisions, articleEmbeddings, wpCategories, clusters } from "@/db";
import { eq, inArray, desc } from "drizzle-orm";
import { regenerateFieldsSchema, improveInputSchema } from "@/lib/validation";
import { selectRegenerationColumns, applyRegeneration } from "@/lib/pipeline/regenerate";
import type { ArticleDraft } from "@/lib/ai/schema";

const draft: ArticleDraft = {
  title: "Nouveau titre", bodyHtml: "<p>Nouveau corps.</p>", excerpt: "Nouvel extrait",
  category: "Économie", tags: ["brvm", "bourse"],
  featuredImageUrl: "https://img/x.jpg", imageCredit: "Crédit", imageSourceUrl: "https://src/x",
  confidence: { categoryUncertain: false, imageMissing: false, clusterUncertain: false },
};
const ALL = { title: true, body: true, excerpt: true, category: true, tags: true, image: true };

describe("regenerateFieldsSchema / improveInputSchema", () => {
  it("requires at least one field", () => {
    expect(regenerateFieldsSchema.safeParse({ title: false, body: false, excerpt: false, category: false, tags: false, image: false }).success).toBe(false);
    expect(regenerateFieldsSchema.safeParse({ ...ALL, body: false }).success).toBe(true);
  });
  it("bounds the improve instruction length", () => {
    expect(improveInputSchema.safeParse({ instruction: "x".repeat(501) }).success).toBe(false);
    expect(improveInputSchema.safeParse({}).success).toBe(true);
  });
});

describe("selectRegenerationColumns", () => {
  it("with all fields checked, returns every column + body + category + tags", () => {
    const s = selectRegenerationColumns(draft, ALL);
    expect(s.columns.title).toBe("Nouveau titre");
    expect(s.columns.excerpt).toBe("Nouvel extrait");
    expect(s.columns.featuredImageUrl).toBe("https://img/x.jpg");
    expect(s.bodyHtml).toBe("<p>Nouveau corps.</p>");
    expect(s.bodyChanged).toBe(true);
    expect(s.categoryName).toBe("Économie");
    expect(s.tags).toEqual(["brvm", "bourse"]);
  });
  it("with only image checked, touches ONLY the image columns", () => {
    const s = selectRegenerationColumns(draft, { title: false, body: false, excerpt: false, category: false, tags: false, image: true });
    expect(s.columns).toEqual({ featuredImageUrl: "https://img/x.jpg", imageCredit: "Crédit", imageSourceUrl: "https://src/x" });
    expect(s.bodyHtml).toBeNull();
    expect(s.bodyChanged).toBe(false);
    expect(s.categoryName).toBeNull();
    expect(s.tags).toBeNull();
  });
});

describe("applyRegeneration (real DB, synthetic draft)", () => {
  const catIds: string[] = [];
  let articleId = "";
  // Seed a NON-null "stale" prior cluster so the body-regen test can prove finding 2 deterministically
  // (regen must move OFF this id), not just "non-null" — which a decideCluster match would satisfy even
  // with the bug present. decideCluster never returns this id (no OTHER article + no embedding row
  // references it), so the resolved cluster is always a different, real one.
  let staleClusterId: string | null = null;
  let createdClusterId: string | null = null; // the cluster the body-regen resolves to (match OR freshly created)
  beforeAll(async () => {
    for (const n of ["RegenTest Économie", "RegenTest Sport"]) {
      const [c] = await db.insert(wpCategories).values({ name: n, slug: n.toLowerCase().replace(/\W+/g, "-") }).returning({ id: wpCategories.id });
      catIds.push(c.id);
    }
    const [stale] = await db.insert(clusters).values({ label: "RegenTest ancien cluster" }).returning({ id: clusters.id });
    staleClusterId = stale.id;
    const [a] = await db.insert(articles).values({
      title: "Ancien titre", bodyHtml: "<p>Ancien corps.</p>", excerpt: "Ancien extrait",
      status: "approved", categoryId: catIds[1], aiAuthor: true, featuredImageUrl: "https://old/i.jpg", imageCredit: "Vieux",
      clusterId: staleClusterId,
    }).returning({ id: articles.id });
    articleId = a.id;
    await db.insert(articleSources).values({ articleId, mediaName: "Ecofin", url: "https://ex/1" });
    await db.insert(articleTags).values({ articleId, tagName: "ancien", isNew: false });
  });
  afterAll(async () => {
    await db.delete(articles).where(eq(articles.id, articleId)); // cascades sources/tags/embeddings/revisions
    // Drop each cluster this test may own (the seeded stale prior, and the body-regen's resolved
    // one) ONLY if nothing else references it now that our article is gone — a shared/pre-existing
    // (matched) cluster keeps its other articles and is left intact. clusters aren't cascade-deleted.
    for (const cid of [staleClusterId, createdClusterId]) {
      if (!cid) continue;
      const stillUsed = await db.select({ id: articles.id }).from(articles).where(eq(articles.clusterId, cid)).limit(1);
      if (stillUsed.length === 0) await db.delete(clusters).where(eq(clusters.id, cid));
    }
    if (catIds.length) await db.delete(wpCategories).where(inArray(wpCategories.id, catIds));
  });

  const priorOf = async () => (await db.select().from(articles).where(eq(articles.id, articleId)))[0];

  it("overwrites ONLY the checked fields, snapshots prior title+body, sets pending", async () => {
    const before = await priorOf();
    await applyRegeneration({
      articleId, prior: { title: before.title, bodyHtml: before.bodyHtml, featuredImageUrl: before.featuredImageUrl, confidenceFlags: before.confidenceFlags },
      draft, fields: { title: true, excerpt: true, body: false, category: false, tags: false, image: false },
      sourceCount: 1, categoryNames: ["RegenTest Économie", "RegenTest Sport"], actorId: null,
    });
    const after = await priorOf();
    expect(after.title).toBe("Nouveau titre");           // regenerated
    expect(after.excerpt).toBe("Nouvel extrait");        // regenerated
    expect(after.bodyHtml).toBe("<p>Ancien corps.</p>"); // body NOT checked → unchanged
    expect(after.categoryId).toBe(catIds[1]);            // category NOT checked → unchanged
    expect(after.status).toBe("pending");
    // image NOT checked on this partial regen → confidenceFlags.imageMissing must NOT be forced to
    // the fresh draft's value (draft.confidence.imageMissing is false; this asserts it isn't
    // clobbered wholesale — the seeded article's prior flags default to {}, i.e. undefined here).
    expect(after.confidenceFlags?.imageMissing).toBe(before.confidenceFlags?.imageMissing);
    // snapshot revision carries the PRIOR title + body
    const [rev] = await db.select().from(articleRevisions).where(eq(articleRevisions.articleId, articleId)).orderBy(desc(articleRevisions.at)).limit(1);
    expect(rev.action).toBe("régénéré par IA");
    expect(rev.detail).toContain("Ancien titre");
    expect(rev.detail).toContain("Ancien corps");
  });

  it("re-embeds + re-scores when the body is regenerated", async () => {
    // NOTE: resolveCategoryId (stages.ts, unmodified) matches by EXACT name against BOTH the
    // categoryNames whitelist and wp_categories.name — draft.category ("Économie", shared with the
    // pure-selector tests above) can't resolve against the "RegenTest ..." seeded rows, and the dev
    // DB already has a real "Économie" row (from db/seed.ts) that a plain "Économie" seed name would
    // collide with. So this test overrides just the category on a draft copy to match the seeded,
    // collision-free "RegenTest Économie" name — every other field (body/tags/score) is unaffected.
    const regenDraft = { ...draft, category: "RegenTest Économie" };
    await applyRegeneration({
      articleId, prior: { title: "Nouveau titre", bodyHtml: "<p>Ancien corps.</p>", featuredImageUrl: "https://old/i.jpg", confidenceFlags: {} },
      draft: regenDraft, fields: { title: false, excerpt: false, body: true, category: true, tags: true, image: false },
      sourceCount: 1, categoryNames: ["RegenTest Économie", "RegenTest Sport"], actorId: null,
    });
    const after = await priorOf();
    expect(after.bodyHtml).toContain("Nouveau corps");    // sanitized new body
    expect(after.categoryId).toBe(catIds[0]);             // "RegenTest Économie" resolved
    expect(after.score).not.toBeNull();                   // re-scored
    // finding 2: a body regen must resolve to a REAL cluster (match OR freshly created) and MOVE OFF
    // the stale prior clusterId — never keep it while embedding/score reflect the new content.
    expect(after.clusterId).not.toBeNull();
    expect(after.clusterId).not.toBe(staleClusterId);     // moved off the stale prior cluster
    createdClusterId = after.clusterId;
    const [clusterRow] = await db.select().from(clusters).where(eq(clusters.id, after.clusterId!));
    expect(clusterRow).toBeDefined();                     // valid cluster row
    const [emb] = await db.select().from(articleEmbeddings).where(eq(articleEmbeddings.articleId, articleId));
    expect(emb).toBeDefined();                            // embedding written
    const tagRows = await db.select().from(articleTags).where(eq(articleTags.articleId, articleId));
    expect(tagRows.map((t) => t.tagName).sort()).toEqual(["bourse", "brvm"]); // tags replaced
  });
});
