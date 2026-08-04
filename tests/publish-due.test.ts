import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/publish/due/route";
import { publishDueArticles } from "@/lib/wp/publish-due";
import { db, articles, wpCategories, distributions, articleRevisions } from "@/db";
import { eq, inArray } from "drizzle-orm";

// ─────────────────────────────────────────────────────────────────────────────
// publishDueArticles (real Neon DB + a Bun.serve FAKE WordPress).
//
// The decisive assertion in this suite is the HUMAN-REVIEW GATE: a `pending` article with a
// past-due `scheduledAt` must NEVER be published by the scheduler, even though its scheduledAt
// alone would otherwise qualify it. Only `status='approved'` articles (already signed off by a
// human via the SP4 review flow) may ever be auto-published.
// ─────────────────────────────────────────────────────────────────────────────

const ENV_KEYS = ["WP_BASE_URL", "WP_USER", "WP_APP_PASSWORD"] as const;
const savedWpEnv: Record<string, string | undefined> = {};

describe("publishDueArticles — due-selection + human-review gate", () => {
  let server: ReturnType<typeof Bun.serve>;
  let base: string;

  let categoryRowId: string;
  let dueApprovedId: string; // approved + scheduledAt 1h ago -> SHOULD publish
  let futureApprovedId: string; // approved + scheduledAt 1h from now -> should NOT publish (not due yet)
  let duePendingId: string; // pending + scheduledAt 1h ago -> MUST NOT publish (human-review gate)

  beforeAll(async () => {
    for (const k of ENV_KEYS) savedWpEnv[k] = process.env[k];

    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const path = url.pathname;
        const method = req.method;

        if (path.endsWith("/categories") && method === "GET") {
          return Response.json([]); // no existing category -> forces create
        }
        if (path.endsWith("/categories") && method === "POST") {
          const body = await req.json();
          return Response.json({ id: 5101, name: body.name });
        }
        if (path.endsWith("/posts") && method === "POST") {
          return Response.json({ id: 9201, link: `${base}/?p=9201` });
        }
        const postIdMatch = path.match(/\/posts\/(\d+)$/);
        if (postIdMatch && method === "POST") {
          return Response.json({ id: Number(postIdMatch[1]), link: `${base}/?p=${postIdMatch[1]}` });
        }
        return new Response("not found", { status: 404 });
      },
    });
    base = `http://localhost:${server.port}`;
    process.env.WP_BASE_URL = base;
    process.env.WP_USER = "bot-test";
    process.env.WP_APP_PASSWORD = "app pass test";

    const [cat] = await db
      .insert(wpCategories)
      .values({ name: "Test Auto-Publish", slug: "test-auto-publish" })
      .returning();
    categoryRowId = cat.id;

    const [a] = await db
      .insert(articles)
      .values({
        title: "Article dû (approuvé, échéance passée)",
        bodyHtml: "<p>Contenu approuvé et dû.</p>",
        status: "approved",
        categoryId: cat.id,
        scheduledAt: new Date(Date.now() - 60 * 60 * 1000), // 1h ago
      })
      .returning();
    dueApprovedId = a.id;

    const [b] = await db
      .insert(articles)
      .values({
        title: "Article futur (approuvé, échéance à venir)",
        bodyHtml: "<p>Contenu approuvé, pas encore dû.</p>",
        status: "approved",
        categoryId: cat.id,
        scheduledAt: new Date(Date.now() + 60 * 60 * 1000), // 1h from now
      })
      .returning();
    futureApprovedId = b.id;

    const [c] = await db
      .insert(articles)
      .values({
        title: "Article en attente (pending, échéance passée) — porte humaine",
        bodyHtml: "<p>Ne doit jamais être publié automatiquement.</p>",
        status: "pending",
        categoryId: cat.id,
        scheduledAt: new Date(Date.now() - 60 * 60 * 1000), // 1h ago — but NOT approved
      })
      .returning();
    duePendingId = c.id;
  });

  afterAll(async () => {
    server.stop(true);
    const ids = [dueApprovedId, futureApprovedId, duePendingId];
    await db.delete(distributions).where(inArray(distributions.articleId, ids));
    await db.delete(articleRevisions).where(inArray(articleRevisions.articleId, ids));
    await db.delete(articles).where(inArray(articles.id, ids));
    await db.delete(wpCategories).where(eq(wpCategories.id, categoryRowId));

    for (const k of ENV_KEYS) {
      if (savedWpEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedWpEnv[k];
    }
  });

  it("publishes only the approved + past-due article; the future-scheduled and pending (gate) rows are untouched", async () => {
    const res = await publishDueArticles();
    expect(res).toEqual({ published: 1, failed: 0 });

    const [due] = await db.select().from(articles).where(eq(articles.id, dueApprovedId));
    expect(due.status).toBe("published");
    expect(due.publishedAt).not.toBeNull();
    const [dueDist] = await db.select().from(distributions).where(eq(distributions.articleId, dueApprovedId));
    expect(dueDist.status).toBe("sent");

    const [future] = await db.select().from(articles).where(eq(articles.id, futureApprovedId));
    expect(future.status).toBe("approved"); // untouched — scheduledAt not due yet
    expect(future.publishedAt).toBeNull();

    // THE HUMAN-REVIEW GATE: a pending article with a past-due scheduledAt is never published,
    // no matter how overdue scheduledAt is — status must be 'approved' first.
    const [pending] = await db.select().from(articles).where(eq(articles.id, duePendingId));
    expect(pending.status).toBe("pending");
    expect(pending.publishedAt).toBeNull();
    const pendingDist = await db.select().from(distributions).where(eq(distributions.articleId, duePendingId));
    expect(pendingDist).toHaveLength(0); // publishArticle was never even attempted on it
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/publish/due — bearer guard. Never an open endpoint: 401 whenever the secret is unset
// OR the supplied bearer doesn't match, regardless of whether a header was sent at all.
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/publish/due — bearer guard (never open)", () => {
  const savedSecret = process.env.PUBLISH_TRIGGER_SECRET;

  afterAll(() => {
    if (savedSecret === undefined) delete process.env.PUBLISH_TRIGGER_SECRET;
    else process.env.PUBLISH_TRIGGER_SECRET = savedSecret;
  });

  it("401s when PUBLISH_TRIGGER_SECRET is unset, even with a bearer header supplied", async () => {
    delete process.env.PUBLISH_TRIGGER_SECRET;
    const req = new NextRequest("http://localhost/api/publish/due", {
      method: "POST",
      headers: { authorization: "Bearer whatever" },
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("401s when the secret is configured but no Authorization header is supplied", async () => {
    process.env.PUBLISH_TRIGGER_SECRET = "s3cr3t-test";
    const req = new NextRequest("http://localhost/api/publish/due", { method: "POST" });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("401s when the secret is configured but the bearer value is wrong", async () => {
    process.env.PUBLISH_TRIGGER_SECRET = "s3cr3t-test";
    const req = new NextRequest("http://localhost/api/publish/due", {
      method: "POST",
      headers: { authorization: "Bearer wrong-value" },
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("200s with the publish tally when the bearer matches the configured secret", async () => {
    process.env.PUBLISH_TRIGGER_SECRET = "s3cr3t-test";
    const req = new NextRequest("http://localhost/api/publish/due", {
      method: "POST",
      headers: { authorization: "Bearer s3cr3t-test" },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    // No due articles remain at this point (previous describe's afterAll cleaned its fixtures).
    expect(await res.json()).toEqual({ published: 0, failed: 0 });
  });
});
