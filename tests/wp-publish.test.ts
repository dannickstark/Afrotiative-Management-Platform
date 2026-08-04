import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { buildPostBody, publishArticle, unpublishArticle, republishArticle, isFetchableImageUrl } from "@/lib/wp/publish";
import { WordPressChannel } from "@/lib/wp/channel";
import { can } from "@/lib/rbac";
import {
  db, articles, articleSources, articleTags, wpCategories, wpTags, distributions, articleRevisions, user,
} from "@/db";
import { eq, and, inArray } from "drizzle-orm";

describe("RBAC guard: article:publish (approve/publish, unpublish/republish actions)", () => {
  it("editor and admin can publish; journalist cannot", () => {
    expect(can("editor", "article", "publish")).toBe(true);
    expect(can("admin", "article", "publish")).toBe(true);
    expect(can("journalist", "article", "publish")).toBe(false);
  });
});

describe("buildPostBody", () => {
  it("appends the sources footer + image credit to the article body", () => {
    const html = buildPostBody({
      bodyHtml: "<p>Corps.</p>",
      sources: [{ mediaName: "Ecofin", url: "https://x/a" }],
      imageCredit: "Financial Afrik", imageSourceUrl: "https://fa/x",
    });
    expect(html).toContain("<p>Corps.</p>");
    expect(html.toLowerCase()).toContain("sources");
    expect(html).toContain("Ecofin");
    expect(html).toContain("Financial Afrik"); // credit present
  });

  it("omits the Sources section when there are no sources, and the credit line when there is no credit", () => {
    const html = buildPostBody({ bodyHtml: "<p>Corps.</p>", sources: [], imageCredit: null, imageSourceUrl: null });
    expect(html).toBe("<p>Corps.</p>");
    expect(html.toLowerCase()).not.toContain("sources");
    expect(html.toLowerCase()).not.toContain("crédit");
  });

  it("links each source's media name to its url, and the credit to imageSourceUrl when present", () => {
    const html = buildPostBody({
      bodyHtml: "<p>Corps.</p>",
      sources: [{ mediaName: "Agence Ecofin", url: "https://www.agenceecofin.com/a" }],
      imageCredit: "Financial Afrik", imageSourceUrl: "https://www.financialafrik.com",
    });
    expect(html).toContain('<a href="https://www.agenceecofin.com/a"');
    expect(html).toContain(">Agence Ecofin</a>");
    expect(html).toContain('<a href="https://www.financialafrik.com"');
    expect(html).toContain(">Financial Afrik</a>");
  });
});

describe("isFetchableImageUrl (SSRF guard on the featured-image fetch)", () => {
  it("allows a normal https URL", () => {
    expect(isFetchableImageUrl("https://example.com/photo.jpg")).toBe(true);
  });
  it("allows a normal http URL", () => {
    expect(isFetchableImageUrl("http://example.com/photo.jpg")).toBe(true);
  });
  it("rejects loopback/private hosts", () => {
    for (const url of [
      "http://localhost/photo.jpg",
      "http://127.0.0.1/photo.jpg",
      "http://127.1.2.3/photo.jpg",
      "http://[::1]/photo.jpg",
      "http://10.0.0.5/photo.jpg",
      "http://192.168.1.10/photo.jpg",
      "http://169.254.169.254/latest/meta-data/", // cloud metadata endpoint
      "http://172.16.0.1/photo.jpg",
      "http://172.31.255.255/photo.jpg",
    ]) {
      expect(isFetchableImageUrl(url)).toBe(false);
    }
  });
  it("allows a 172.x host outside the private 172.16-31 range", () => {
    expect(isFetchableImageUrl("http://172.32.0.1/photo.jpg")).toBe(true);
    expect(isFetchableImageUrl("http://172.15.0.1/photo.jpg")).toBe(true);
  });
  it("rejects non-http(s) protocols and malformed URLs", () => {
    expect(isFetchableImageUrl("file:///etc/passwd")).toBe(false);
    expect(isFetchableImageUrl("ftp://example.com/photo.jpg")).toBe(false);
    expect(isFetchableImageUrl("not a url")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration tests (real Neon DB + a Bun.serve FAKE WordPress) for publishArticle /
// unpublishArticle / republishArticle: idempotent create-vs-update, fail-soft featured image,
// hard-fail on a WP post error (article stays 'approved', distribution 'failed'), and the
// not-configured guard (no env → French message, article/db completely untouched).
// ─────────────────────────────────────────────────────────────────────────────

const ENV_KEYS = ["WP_BASE_URL", "WP_USER", "WP_APP_PASSWORD"] as const;
const savedEnv: Record<string, string | undefined> = {};

type Captured = { path: string; body: any };

describe("publishArticle / unpublishArticle / republishArticle (fake WP, real Neon)", () => {
  let server: ReturnType<typeof Bun.serve>;
  let base: string;

  // Fake-WP in-memory state
  let nextCategoryId = 5001;
  let nextTagId = 6001;
  let nextMediaId = 7001;
  const FIXED_POST_ID = 9001;
  const categoriesStore: { id: number; name: string }[] = [];
  const tagsStore: { id: number; name: string }[] = [];
  let mediaShouldFail = false;
  let postsShouldFail = false;
  const createPostCalls: Captured[] = [];
  const updatePostCalls: Captured[] = [];
  const mediaCalls: Captured[] = [];

  const FIXTURE_IMAGE_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  // A normal-looking public https URL (passes the isFetchableImageUrl SSRF guard — Fix 4), unlike
  // the fake WP server's own `base` (http://localhost:<port>), which the guard now correctly
  // rejects. The realFetch shim below serves FIXTURE_IMAGE_BYTES for this exact URL without any
  // real network call, so the featured-image tests stay deterministic and offline.
  const FIXTURE_IMAGE_URL = "https://cdn.example.test/fixture-image.jpg";
  let realFetch: typeof fetch;

  // Temp fixtures
  let categoryRowId: string;
  let notConfiguredArticleId: string;
  let articleId: string; // main article: create → update → media-fail → republish → unpublish
  let failArticleId: string; // dedicated article for the hard-WP-error path

  beforeAll(async () => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k]; // baseline: not configured

    realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === FIXTURE_IMAGE_URL) {
        return new Response(FIXTURE_IMAGE_BYTES, { headers: { "content-type": "image/jpeg" } });
      }
      return realFetch(input, init);
    }) as typeof fetch;

    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const path = url.pathname;
        const method = req.method;

        if (path === "/fixture-image.jpg") {
          return new Response(FIXTURE_IMAGE_BYTES, { headers: { "content-type": "image/jpeg" } });
        }

        if (path.endsWith("/categories") && method === "GET") {
          const q = (url.searchParams.get("search") || "").toLowerCase();
          return Response.json(categoriesStore.filter((c) => c.name.toLowerCase().includes(q)));
        }
        if (path.endsWith("/categories") && method === "POST") {
          const body = await req.json();
          const id = nextCategoryId++;
          categoriesStore.push({ id, name: body.name });
          return Response.json({ id, name: body.name });
        }

        if (path.endsWith("/tags") && method === "GET") {
          const q = (url.searchParams.get("search") || "").toLowerCase();
          return Response.json(tagsStore.filter((t) => t.name.toLowerCase().includes(q)));
        }
        if (path.endsWith("/tags") && method === "POST") {
          const body = await req.json();
          const id = nextTagId++;
          tagsStore.push({ id, name: body.name });
          return Response.json({ id, name: body.name });
        }

        if (path.endsWith("/media") && method === "POST") {
          const body = new Uint8Array(await req.arrayBuffer());
          mediaCalls.push({ path, body });
          if (mediaShouldFail) return new Response("Erreur média simulée", { status: 500 });
          const id = nextMediaId++;
          return Response.json({ id, source_url: `${base}/media/${id}.jpg` });
        }

        if (path.endsWith("/posts") && method === "POST") {
          if (postsShouldFail) return new Response("Erreur de publication simulée", { status: 500 });
          const body = await req.json();
          createPostCalls.push({ path, body });
          return Response.json({ id: FIXED_POST_ID, link: `${base}/?p=${FIXED_POST_ID}` });
        }
        const postIdMatch = path.match(/\/posts\/(\d+)$/);
        if (postIdMatch && method === "POST") {
          if (postsShouldFail) return new Response("Erreur de publication simulée", { status: 500 });
          const id = Number(postIdMatch[1]);
          const body = await req.json();
          updatePostCalls.push({ path, body });
          return Response.json({ id, link: `${base}/?p=${id}` });
        }

        return new Response("not found", { status: 404 });
      },
    });
    base = `http://localhost:${server.port}`;

    const [cat] = await db.insert(wpCategories).values({
      name: "Test Publication WP", slug: "test-publication-wp",
    }).returning();
    categoryRowId = cat.id;

    const [a1] = await db.insert(articles).values({
      title: "Article de test (non configuré)", bodyHtml: "<p>Contenu de test.</p>",
      status: "approved", categoryId: cat.id,
    }).returning();
    notConfiguredArticleId = a1.id;

    const [a2] = await db.insert(articles).values({
      title: "Article de test WP publish", bodyHtml: "<p>Contenu principal de test.</p>",
      excerpt: "Extrait de test", status: "approved", categoryId: cat.id,
      featuredImageUrl: FIXTURE_IMAGE_URL, imageCredit: "Crédit Test", imageSourceUrl: "https://example.com/credit",
      scheduledAt: new Date(Date.now() - 60 * 60 * 1000), // simulates a scheduled publish (1h ago) — must be cleared on success
    }).returning();
    articleId = a2.id;
    await db.insert(articleSources).values({ articleId, mediaName: "Source Test", url: "https://example.com/source" });
    await db.insert(articleTags).values([
      { articleId, tagName: "Tag Publish Test A", isNew: true },
      { articleId, tagName: "Tag Publish Test B", isNew: true },
    ]);

    const [a3] = await db.insert(articles).values({
      title: "Article de test (échec WP)", bodyHtml: "<p>Contenu.</p>", status: "approved", categoryId: cat.id,
      scheduledAt: new Date(Date.now() - 60 * 60 * 1000), // must survive a FAILED publish (kept for retry)
    }).returning();
    failArticleId = a3.id;
  });

  afterAll(async () => {
    server.stop(true);
    globalThis.fetch = realFetch;
    await db.delete(distributions).where(inArray(distributions.articleId, [articleId, failArticleId, notConfiguredArticleId]));
    await db.delete(articleRevisions).where(inArray(articleRevisions.articleId, [articleId, failArticleId, notConfiguredArticleId]));
    await db.delete(articleTags).where(eq(articleTags.articleId, articleId));
    await db.delete(articleSources).where(eq(articleSources.articleId, articleId));
    await db.delete(articles).where(inArray(articles.id, [articleId, failArticleId, notConfiguredArticleId]));
    await db.delete(wpCategories).where(eq(wpCategories.id, categoryRowId));
    await db.delete(wpTags).where(inArray(wpTags.name, ["Tag Publish Test A", "Tag Publish Test B"]));

    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it("not configured: returns the French message and leaves the article completely unchanged", async () => {
    const [before] = await db.select().from(articles).where(eq(articles.id, notConfiguredArticleId));

    const res = await publishArticle(notConfiguredArticleId);
    expect(res).toEqual({ ok: false, message: "WordPress non configuré." });

    const [after] = await db.select().from(articles).where(eq(articles.id, notConfiguredArticleId));
    expect(after).toEqual(before);
    const dist = await db.select().from(distributions).where(eq(distributions.articleId, notConfiguredArticleId));
    expect(dist).toHaveLength(0);
  });

  it("WordPressChannel.publish delegates to publishArticle (same not-configured guard)", async () => {
    const res = await new WordPressChannel().publish(notConfiguredArticleId);
    expect(res).toEqual({ ok: false, message: "WordPress non configuré." });
  });

  it("publishArticle creates a WP post, records distributions sent+externalId, and flips the article to published", async () => {
    process.env.WP_BASE_URL = base;
    process.env.WP_USER = "bot-test";
    process.env.WP_APP_PASSWORD = "app pass test";

    const res = await publishArticle(articleId);
    expect(res.ok).toBe(true);
    expect(res.message).toBe("Publié sur WordPress.");
    expect(res.postId).toBe(FIXED_POST_ID);

    const [dist] = await db.select().from(distributions)
      .where(and(eq(distributions.articleId, articleId), eq(distributions.channel, "wordpress")));
    expect(dist.status).toBe("sent");
    expect(dist.externalId).toBe(String(FIXED_POST_ID));

    const [art] = await db.select().from(articles).where(eq(articles.id, articleId));
    expect(art.status).toBe("published");
    expect(art.publishedAt).not.toBeNull();
    // Fix 1: a successful publish "consumes" the schedule — scheduledAt must be cleared so a
    // taken-down article can never be auto-republished off a stale past scheduledAt.
    expect(art.scheduledAt).toBeNull();

    expect(createPostCalls).toHaveLength(1);
    const created = createPostCalls[0].body;
    expect(created.title).toBe("Article de test WP publish");
    expect(created.status).toBe("publish");
    expect(created.categories).toHaveLength(1);
    expect(created.tags).toHaveLength(2); // two temp tags, both resolve-or-created
    expect(created.featured_media).toBeDefined(); // image upload succeeded

    // Category + tags backfilled onto the mirror tables
    const [catRow] = await db.select().from(wpCategories).where(eq(wpCategories.id, categoryRowId));
    expect(catRow.wpId).toBe(created.categories[0]);
    const backfilledTags = await db.select().from(wpTags).where(inArray(wpTags.name, ["Tag Publish Test A", "Tag Publish Test B"]));
    expect(backfilledTags).toHaveLength(2);
    expect(backfilledTags.every((t) => typeof t.wpId === "number")).toBe(true);
    const tagRows = await db.select().from(articleTags).where(eq(articleTags.articleId, articleId));
    expect(tagRows.every((t) => t.isNew === false)).toBe(true);

    const revisions = await db.select().from(articleRevisions).where(eq(articleRevisions.articleId, articleId));
    expect(revisions.some((r) => r.action === "publié sur WordPress")).toBe(true);
  });

  it("publishArticle called again UPDATES the same WP post — no duplicate post or distribution row", async () => {
    const res = await publishArticle(articleId);
    expect(res.ok).toBe(true);
    expect(res.postId).toBe(FIXED_POST_ID); // same post id, not a new one

    const distRows = await db.select().from(distributions)
      .where(and(eq(distributions.articleId, articleId), eq(distributions.channel, "wordpress")));
    expect(distRows).toHaveLength(1); // still exactly one distribution row
    expect(distRows[0].externalId).toBe(String(FIXED_POST_ID));

    expect(createPostCalls).toHaveLength(1); // no NEW create call
    expect(updatePostCalls.length).toBeGreaterThanOrEqual(1);
    const lastUpdate = updatePostCalls.at(-1)!;
    expect(lastUpdate.path.endsWith(`/posts/${FIXED_POST_ID}`)).toBe(true);
  });

  it("a featured-media 500 is fail-soft: the post still publishes successfully, without featured_media", async () => {
    mediaShouldFail = true;
    const res = await publishArticle(articleId);
    mediaShouldFail = false;

    expect(res.ok).toBe(true);
    expect(res.postId).toBe(FIXED_POST_ID);

    const lastUpdate = updatePostCalls.at(-1)!;
    expect(lastUpdate.body.featured_media).toBeUndefined();

    const [art] = await db.select().from(articles).where(eq(articles.id, articleId));
    expect(art.status).toBe("published"); // publish still succeeded despite the image failure

    const [dist] = await db.select().from(distributions)
      .where(and(eq(distributions.articleId, articleId), eq(distributions.channel, "wordpress")));
    expect(dist.status).toBe("sent");
  });

  it("republishArticle pushes the FULL payload (same shape as publishArticle) to the SAME post; article stays published", async () => {
    await db.update(articles).set({ title: "Titre mis à jour" }).where(eq(articles.id, articleId));

    const res = await republishArticle(articleId);
    expect(res).toEqual({ ok: true, message: "Article republié sur WordPress." });

    const lastUpdate = updatePostCalls.at(-1)!;
    expect(lastUpdate.path.endsWith(`/posts/${FIXED_POST_ID}`)).toBe(true);
    expect(lastUpdate.body.title).toBe("Titre mis à jour");
    expect(lastUpdate.body.content).toContain("<p>Contenu principal de test.</p>");
    expect(lastUpdate.body.content.toLowerCase()).toContain("sources"); // rebuilt via buildPostBody
    // Fix 3: republish now sends the SAME payload shape as publishArticle — taxonomy/featured-
    // image corrections propagate on republish too, not just title/body/excerpt edits.
    expect(lastUpdate.body.status).toBe("publish");
    expect(Array.isArray(lastUpdate.body.categories)).toBe(true);
    expect(lastUpdate.body.categories).toHaveLength(1);
    expect(typeof lastUpdate.body.categories[0]).toBe("number");
    expect(lastUpdate.body.tags).toHaveLength(2); // re-resolved tag ids
    expect(typeof lastUpdate.body.featured_media).toBe("number"); // image re-uploaded
    expect(Object.keys(lastUpdate.body).sort()).toEqual(
      ["categories", "content", "excerpt", "featured_media", "status", "tags", "title"],
    );

    const [art] = await db.select().from(articles).where(eq(articles.id, articleId));
    expect(art.status).toBe("published");
  });

  it("unpublishArticle drafts the WP post and moves the article back to approved", async () => {
    const res = await unpublishArticle(articleId);
    expect(res).toEqual({ ok: true, message: "Article dépublié de WordPress." });

    const lastUpdate = updatePostCalls.at(-1)!;
    expect(lastUpdate.path.endsWith(`/posts/${FIXED_POST_ID}`)).toBe(true);
    expect(lastUpdate.body).toEqual({ status: "draft" });

    const [art] = await db.select().from(articles).where(eq(articles.id, articleId));
    expect(art.status).toBe("approved");
    expect(art.scheduledAt).toBeNull(); // belt-and-suspenders: unpublish also clears any schedule

    const [dist] = await db.select().from(distributions)
      .where(and(eq(distributions.articleId, articleId), eq(distributions.channel, "wordpress")));
    expect(dist.externalId).toBe(String(FIXED_POST_ID)); // preserved for a future re-publish
  });

  it("on a hard WP error, the distribution is marked failed and the article stays approved (never half-published)", async () => {
    postsShouldFail = true;
    const res = await publishArticle(failArticleId);
    postsShouldFail = false;

    expect(res.ok).toBe(false);
    expect(res.message).toContain("La publication sur WordPress a échoué");

    const [art] = await db.select().from(articles).where(eq(articles.id, failArticleId));
    expect(art.status).toBe("approved");
    expect(art.publishedAt).toBeNull();
    // Fix 1 (failure side): a FAILED publish must NOT clear scheduledAt — the article stays
    // approved and due, so publishDueArticles can retry it on the next run.
    expect(art.scheduledAt).not.toBeNull();

    const [dist] = await db.select().from(distributions)
      .where(and(eq(distributions.articleId, failArticleId), eq(distributions.channel, "wordpress")));
    expect(dist.status).toBe("failed");
    expect(dist.externalId).toBeNull();
  });

  it("publishArticle rejects an article with no category, unchanged", async () => {
    const [noCatArticle] = await db.insert(articles).values({
      title: "Sans catégorie", bodyHtml: "<p>x</p>", status: "approved",
    }).returning();
    try {
      const res = await publishArticle(noCatArticle.id);
      expect(res).toEqual({ ok: false, message: "Choisissez une catégorie avant de publier." });
      const dist = await db.select().from(distributions).where(eq(distributions.articleId, noCatArticle.id));
      expect(dist).toHaveLength(0);
    } finally {
      await db.delete(articles).where(eq(articles.id, noCatArticle.id));
    }
  });

  it("publishArticle rejects a featured image without a credit, unchanged", async () => {
    const [noCreditArticle] = await db.insert(articles).values({
      title: "Sans crédit", bodyHtml: "<p>x</p>", status: "approved", categoryId: categoryRowId,
      featuredImageUrl: FIXTURE_IMAGE_URL, imageCredit: null,
    }).returning();
    try {
      const res = await publishArticle(noCreditArticle.id);
      expect(res).toEqual({ ok: false, message: "Le crédit de l'image est obligatoire." });
      const dist = await db.select().from(distributions).where(eq(distributions.articleId, noCreditArticle.id));
      expect(dist).toHaveLength(0);
    } finally {
      await db.delete(articles).where(eq(articles.id, noCreditArticle.id));
    }
  });

  it("publishArticle/republishArticle/unpublishArticle record the acting user on the article_revisions row (actorId)", async () => {
    const actorId = randomUUID();
    await db.insert(user).values({
      id: actorId, email: `actor-${actorId}@afrotiative.test`, name: "Actor Test", role: "editor", emailVerified: true,
    });
    const [row] = await db.insert(articles).values({
      title: "Article de test (actorId)", bodyHtml: "<p>Contenu.</p>", status: "approved", categoryId: categoryRowId,
    }).returning();
    const id = row.id;

    try {
      const pub = await publishArticle(id, actorId);
      expect(pub.ok).toBe(true);
      const rep = await republishArticle(id, actorId);
      expect(rep.ok).toBe(true);
      const unpub = await unpublishArticle(id, actorId);
      expect(unpub.ok).toBe(true);

      const revisions = await db.select().from(articleRevisions).where(eq(articleRevisions.articleId, id));
      expect(revisions.find((r) => r.action === "publié sur WordPress")?.actorId).toBe(actorId);
      expect(revisions.find((r) => r.action === "republié sur WordPress")?.actorId).toBe(actorId);
      expect(revisions.find((r) => r.action === "dépublié de WordPress")?.actorId).toBe(actorId);
    } finally {
      await db.delete(distributions).where(eq(distributions.articleId, id));
      await db.delete(articleRevisions).where(eq(articleRevisions.articleId, id));
      await db.delete(articles).where(eq(articles.id, id));
      await db.delete(user).where(eq(user.id, actorId));
    }
  });

  it("publishDueArticles-style call with no actor (omitted) records a null actorId — legitimate system action", async () => {
    const [row] = await db.insert(articles).values({
      title: "Article de test (sans acteur)", bodyHtml: "<p>Contenu.</p>", status: "approved", categoryId: categoryRowId,
    }).returning();
    const id = row.id;
    try {
      const res = await publishArticle(id); // no actorId argument — same call shape publishDueArticles uses
      expect(res.ok).toBe(true);
      const [revision] = await db.select().from(articleRevisions)
        .where(and(eq(articleRevisions.articleId, id), eq(articleRevisions.action, "publié sur WordPress")));
      expect(revision.actorId).toBeNull();
    } finally {
      await db.delete(distributions).where(eq(distributions.articleId, id));
      await db.delete(articleRevisions).where(eq(articleRevisions.articleId, id));
      await db.delete(articles).where(eq(articles.id, id));
    }
  });
});
