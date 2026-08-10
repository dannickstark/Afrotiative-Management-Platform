import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import sharp from "sharp";
import { eq, and, inArray } from "drizzle-orm";
import {
  db, articles, wpCategories, renderTemplates, renderTemplateVersions, renders,
  distributions, articleRevisions, socialChannelSettings,
} from "@/db";
import { sendToChannelCore } from "@/lib/diffusion/send-core";
import { MemoryRenderStore } from "@/lib/studio/store";
import { setChannelCredentialsCore, deleteChannelCredentialsCore } from "@/lib/diffusion/settings-core";
import { FB_TEMPLATE } from "@/db/studio-templates";
import { FacebookChannel, mapFacebookGraphError } from "@/lib/diffusion/meta/facebook";
import { GraphApiError } from "@/lib/diffusion/meta/graph-client";
import { SOCIAL_CHANNELS, type SocialChannel } from "@/lib/diffusion/channels";

// Task 2 (D2+D3) — Facebook Page adapter. Two layers of tests, same split as tests/wp-publish.test.ts
// (fake external service, real Neon DB where a DB row is actually the thing under test):
//
//  1. FacebookChannel.send() exercised DIRECTLY against a Bun.serve fake Graph API — no `articles`
//     row involved at all, since send() itself never touches the DB (channels.ts's header comment:
//     adapters know nothing about `distributions`). This is where the "zero HTTP calls on missing
//     credentials" and exact French-message-shape assertions live.
//  2. sendToChannelCore + channelOverride: new FacebookChannel({baseUrl}) — the SAME real adapter,
//     wired through the real registry contract, to prove the brief's DB-level claims ("a successful
//     post records externalId and marks sent"; "a Graph error becomes... failed with attempts
//     incremented") against the actual `distributions` row, not just the adapter's return value.

const CHANNEL = "facebook" as const;
const SAVED_KEY = process.env.CREDENTIALS_ENCRYPTION_KEY;
const VALID_KEY = randomBytes(32).toString("base64");

async function clearCredentials() {
  await deleteChannelCredentialsCore(CHANNEL);
  await db.delete(socialChannelSettings).where(eq(socialChannelSettings.channel, CHANNEL));
}

// sendToChannelCore's `channelOverride` is typed `SocialChannel` (key/label/context/format/
// captionLimits/credentialFields + send) — a bare `new FacebookChannel()` only has `send` and does
// NOT structurally satisfy that interface (bun test's transpile-only runtime does not catch a type
// mismatch there the way `tsc --noEmit` would, so passing one directly would silently read
// `.label` as `undefined` deep inside send-core.ts's audit-trail write — caught while writing this
// test, see the task report). This wraps the REAL registry entry (correct key/label/etc.) around
// the real adapter pointed at the fake Graph base URL — same "spread the real entry, override
// send" idiom other diffusion test files use for a partial double.
function fbOverride(baseUrl: string): SocialChannel {
  return { ...SOCIAL_CHANNELS.facebook, send: (input) => new FacebookChannel({ baseUrl }).send(input) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer 1 — FacebookChannel.send() against a fake Graph API (Bun.serve, injectable base URL).
// ─────────────────────────────────────────────────────────────────────────────
describe("FacebookChannel.send — fake Graph API (D2), no real network", () => {
  let server: ReturnType<typeof Bun.serve>;
  let base: string;
  let requestCount = 0;
  let lastPath = "";
  let lastBody: URLSearchParams | null = null;
  let failWith: { status: number; body: unknown } | null = null;

  const FIXED_PHOTO_ID = "9999999999";
  const FIXED_POST_ID = "112233445566778_9999999999";

  beforeAll(() => {
    process.env.CREDENTIALS_ENCRYPTION_KEY = VALID_KEY;
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        requestCount++;
        const url = new URL(req.url);
        lastPath = url.pathname;
        lastBody = new URLSearchParams(await req.text());
        if (failWith) return Response.json(failWith.body, { status: failWith.status });
        if (url.pathname.endsWith("/photos")) {
          return Response.json({ id: FIXED_PHOTO_ID, post_id: FIXED_POST_ID });
        }
        return new Response("not found", { status: 404 });
      },
    });
    base = `http://localhost:${server.port}`;
  });

  afterAll(async () => {
    server.stop(true);
    await clearCredentials();
    if (SAVED_KEY === undefined) delete process.env.CREDENTIALS_ENCRYPTION_KEY;
    else process.env.CREDENTIALS_ENCRYPTION_KEY = SAVED_KEY;
  });

  afterEach(async () => {
    requestCount = 0;
    lastPath = "";
    lastBody = null;
    failWith = null;
    await clearCredentials();
  });

  // The self-review's sharpest question: does this assert the fake received ZERO requests, or just
  // that the result was an error? It's the former — requestCount is a real counter incremented
  // inside the fake server's own fetch handler, not a spy the adapter could bypass by mistake.
  it("missing credentials: refuses BEFORE any HTTP call — the fake Graph server receives zero requests", async () => {
    const channel = new FacebookChannel({ baseUrl: base });
    const result = await channel.send({
      articleId: randomUUID(), imageUrl: "https://cdn.example.test/render.png", caption: "Légende de test.",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message.toLowerCase()).toContain("identifiants");
    expect(requestCount).toBe(0);
  });

  it("a Page id with no token also refuses before any HTTP call", async () => {
    await setChannelCredentialsCore(CHANNEL, { pageId: "112233445566778" }); // token deliberately omitted
    const channel = new FacebookChannel({ baseUrl: base });
    const result = await channel.send({
      articleId: randomUUID(), imageUrl: "https://cdn.example.test/render.png", caption: "x",
    });
    expect(result.ok).toBe(false);
    expect(requestCount).toBe(0);
  });

  it("successful post: POSTs url/caption/access_token to /{pageId}/photos and returns post_id as externalId", async () => {
    await setChannelCredentialsCore(CHANNEL, { pageId: "112233445566778", pageAccessToken: "tok-abc-123" });
    const channel = new FacebookChannel({ baseUrl: base });
    const result = await channel.send({
      articleId: randomUUID(), imageUrl: "https://cdn.example.test/render.png", caption: "Ma légende de test.",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.externalId).toBe(FIXED_POST_ID);
    expect(requestCount).toBe(1);
    expect(lastPath).toBe("/112233445566778/photos");
    expect(lastBody?.get("url")).toBe("https://cdn.example.test/render.png");
    expect(lastBody?.get("caption")).toBe("Ma légende de test.");
    expect(lastBody?.get("access_token")).toBe("tok-abc-123");
  });

  it("falls back to `id` when Graph omits post_id (defensive/inferred branch — see the task report)", async () => {
    await setChannelCredentialsCore(CHANNEL, { pageId: "112233445566778", pageAccessToken: "tok-abc-123" });
    const noPostIdServer = Bun.serve({
      port: 0, fetch: () => Response.json({ id: "photo-only-id" }),
    });
    try {
      const channel = new FacebookChannel({ baseUrl: `http://localhost:${noPostIdServer.port}` });
      const result = await channel.send({ articleId: randomUUID(), imageUrl: "https://x/y.png", caption: "c" });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.externalId).toBe("photo-only-id");
    } finally {
      noPostIdServer.stop(true);
    }
  });

  it("a Graph error becomes a French message and ok:false, without ever including the access token", async () => {
    await setChannelCredentialsCore(CHANNEL, { pageId: "112233445566778", pageAccessToken: "SECRET-TOKEN-SHOULD-NEVER-APPEAR" });
    failWith = { status: 400, body: { error: { message: "Invalid parameter", type: "OAuthException", code: 100, fbtrace_id: "abc123" } } };
    const channel = new FacebookChannel({ baseUrl: base });
    const result = await channel.send({ articleId: randomUUID(), imageUrl: "https://x/y.png", caption: "c" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("La publication Facebook a échoué");
      expect(result.message).toContain("Invalid parameter");
      expect(result.message).not.toContain("SECRET-TOKEN-SHOULD-NEVER-APPEAR");
    }
  });

  it("an expired-token error (code 190) produces a DISTINCT, actionable French message pointing at the settings page", async () => {
    await setChannelCredentialsCore(CHANNEL, { pageId: "112233445566778", pageAccessToken: "expired-tok" });
    failWith = {
      status: 401,
      body: { error: { message: "Error validating access token: Session has expired", type: "OAuthException", code: 190, error_subcode: 463, fbtrace_id: "xyz" } },
    };
    const channel = new FacebookChannel({ baseUrl: base });
    const result = await channel.send({ articleId: randomUUID(), imageUrl: "https://x/y.png", caption: "c" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message.toLowerCase()).toMatch(/expir/);
      expect(result.message).toContain("/settings/social/facebook");
      // Distinct from the generic-error message shape above (no "réponse inattendue"/raw Graph text).
      expect(result.message).not.toContain("Session has expired");
    }
  });

  it("mapFacebookGraphError handles a non-GraphApiError Error and an unknown thrown value too", () => {
    expect(mapFacebookGraphError(new Error("panne réseau"))).toContain("panne réseau");
    expect(mapFacebookGraphError("chaîne quelconque")).toContain("inconnue");
  });

  it("mapFacebookGraphError distinguishes code 190 from an unrelated OAuthException code", () => {
    const expired = new GraphApiError(401, { error: { message: "expired", code: 190 } }, "");
    const other = new GraphApiError(401, { error: { message: "other", code: 200 } }, "");
    expect(mapFacebookGraphError(expired)).not.toBe(mapFacebookGraphError(other));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Layer 2 — the real FacebookChannel through sendToChannelCore (real Neon DB `distributions` row).
// ─────────────────────────────────────────────────────────────────────────────
describe("FacebookChannel through sendToChannelCore (D2) — real distributions row", () => {
  let graphServer: ReturnType<typeof Bun.serve>;
  let graphBase: string;
  let imageServer: ReturnType<typeof Bun.serve>;
  let categoryId: string;
  let templateId: string;
  let articleSuccess: string;
  let articleFailure: string;
  let graphShouldFail = false;

  const FIXED_POST_ID = "998877665544332_123456789";

  beforeAll(async () => {
    process.env.CREDENTIALS_ENCRYPTION_KEY = VALID_KEY;
    await setChannelCredentialsCore(CHANNEL, { pageId: "998877665544332", pageAccessToken: "tok-integration" });

    graphServer = Bun.serve({
      port: 0,
      fetch(req) {
        if (graphShouldFail) {
          return Response.json({ error: { message: "Erreur simulée du réseau Graph.", type: "OAuthException", code: 100 } }, { status: 400 });
        }
        const url = new URL(req.url);
        if (url.pathname.endsWith("/photos")) return Response.json({ id: "photo-1", post_id: FIXED_POST_ID });
        return new Response("not found", { status: 404 });
      },
    });
    graphBase = `http://localhost:${graphServer.port}`;

    const png = await sharp({ create: { width: 400, height: 400, channels: 3, background: { r: 20, g: 60, b: 120 } } }).png().toBuffer();
    imageServer = Bun.serve({ port: 0, fetch: () => new Response(png, { headers: { "content-type": "image/png" } }) });

    const [cat] = await db.insert(wpCategories).values({
      name: "Test Diffusion Facebook", slug: `test-diffusion-facebook-${Date.now()}`, color: "#AA2244",
    }).returning();
    categoryId = cat.id;

    const [t] = await db.insert(renderTemplates).values({
      name: "Test — post Facebook", context: "social_post", channel: CHANNEL, categoryId,
      format: "fb_link", width: 1200, height: 630, scene: FB_TEMPLATE,
    }).returning();
    templateId = t.id;
    await db.insert(renderTemplateVersions).values({ templateId, version: 1, scene: FB_TEMPLATE });
    await db.update(renderTemplates).set({ publishedVersion: 1 }).where(eq(renderTemplates.id, templateId));

    const imageUrl = `http://127.0.0.1:${imageServer.port}/photo.png`;
    const publishedAt = new Date();
    const mk = (title: string) =>
      db.insert(articles).values({
        title, bodyHtml: "<p>x</p>", status: "published", publishedAt, categoryId, featuredImageUrl: imageUrl,
      }).returning();
    [{ id: articleSuccess }] = await mk("Diffusion Facebook — envoi réussi");
    [{ id: articleFailure }] = await mk("Diffusion Facebook — échec Graph");
  });

  afterAll(async () => {
    graphServer.stop(true);
    imageServer.stop(true);
    const ids = [articleSuccess, articleFailure].filter(Boolean);
    if (ids.length) {
      await db.delete(renders).where(inArray(renders.subjectId, ids));
      await db.delete(distributions).where(inArray(distributions.articleId, ids));
      await db.delete(articleRevisions).where(inArray(articleRevisions.articleId, ids));
      await db.delete(articles).where(inArray(articles.id, ids));
    }
    if (templateId) await db.delete(renderTemplates).where(eq(renderTemplates.id, templateId));
    if (categoryId) await db.delete(wpCategories).where(eq(wpCategories.id, categoryId));
    await clearCredentials();
    if (SAVED_KEY === undefined) delete process.env.CREDENTIALS_ENCRYPTION_KEY;
    else process.env.CREDENTIALS_ENCRYPTION_KEY = SAVED_KEY;
  });

  it("a successful post records externalId and marks the distribution 'sent'", async () => {
    const r = await sendToChannelCore({
      articleId: articleSuccess, channel: CHANNEL, caption: "Légende publiée.", triggeredBy: "manual", actorId: null,
      renderStore: new MemoryRenderStore(), fetchImpl: fetch, channelOverride: fbOverride(graphBase),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.externalId).toBe(FIXED_POST_ID);

    const [row] = await db.select().from(distributions)
      .where(and(eq(distributions.articleId, articleSuccess), eq(distributions.channel, CHANNEL)));
    expect(row.status).toBe("sent");
    expect(row.externalId).toBe(FIXED_POST_ID);
    expect(row.sentAt).not.toBeNull();

    const revisions = await db.select().from(articleRevisions).where(eq(articleRevisions.articleId, articleSuccess));
    expect(revisions.some((rv) => rv.action.includes("Facebook"))).toBe(true);
  });

  it("a Graph error becomes a French message, marks the distribution 'failed', and increments attempts", async () => {
    graphShouldFail = true;
    const r = await sendToChannelCore({
      articleId: articleFailure, channel: CHANNEL, caption: "Tentative en échec.", triggeredBy: "manual", actorId: null,
      renderStore: new MemoryRenderStore(), fetchImpl: fetch, channelOverride: fbOverride(graphBase),
    });
    graphShouldFail = false;

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain("La publication Facebook a échoué");

    const [row] = await db.select().from(distributions)
      .where(and(eq(distributions.articleId, articleFailure), eq(distributions.channel, CHANNEL)));
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(1);
    expect(row.lastError).toContain("La publication Facebook a échoué");
    expect(row.externalId).toBeNull();
  });
});
