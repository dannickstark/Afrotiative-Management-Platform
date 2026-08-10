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
import { IG_TEMPLATE } from "@/db/studio-templates";
import { InstagramChannel, mapInstagramGraphError } from "@/lib/diffusion/meta/instagram";
import { GraphApiError } from "@/lib/diffusion/meta/graph-client";
import { SOCIAL_CHANNELS, type SocialChannel } from "@/lib/diffusion/channels";

// Task 3 (D3) — Instagram adapter. Same two-layer split as tests/diffusion-facebook.test.ts:
//  1. InstagramChannel.send() directly against a Bun.serve fake Graph API — full control over the
//     container's status_code sequence (FINISHED immediately / stuck IN_PROGRESS / ERROR / EXPIRED),
//     which the DB-level layer below cannot cheaply exercise for every branch.
//  2. sendToChannelCore + a real-registry-shaped channelOverride — proves the brief's DB-level claim
//     ("the two-step happy path publishes and records externalId") against an actual distributions row.
//
// A no-op sleepImpl is injected everywhere below (InstagramChannelConfig.sleepImpl) — this is what
// lets the IN_PROGRESS→FINISHED and timeout tests run in milliseconds instead of paying the real
// poll interval, while still exercising the EXACT same poll loop code path (attempt count, "stop at
// FINISHED/ERROR/EXPIRED, else keep going") production runs. A separate test below asserts the real
// sleepImpl actually gets awaited between attempts (proving the loop is not a tight busy-loop) using
// a COUNTING (not no-op) spy.

const CHANNEL = "instagram" as const;
const SAVED_KEY = process.env.CREDENTIALS_ENCRYPTION_KEY;
const VALID_KEY = randomBytes(32).toString("base64");
const noSleep = async () => {}; // instant — see header comment

async function clearCredentials() {
  await deleteChannelCredentialsCore(CHANNEL);
  await db.delete(socialChannelSettings).where(eq(socialChannelSettings.channel, CHANNEL));
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer 1 — InstagramChannel.send() against a fake Graph API (Bun.serve, injectable base URL).
// ─────────────────────────────────────────────────────────────────────────────
describe("InstagramChannel.send — fake Graph API (D3), no real network", () => {
  let server: ReturnType<typeof Bun.serve>;
  let base: string;
  let requestCount = 0;
  const requestLog: { method: string; path: string; body?: URLSearchParams }[] = [];

  const CONTAINER_ID = "ig-container-777";
  const PUBLISHED_ID = "ig-media-999";

  // Controls how the fake server answers a GET status poll: a queue of status_code values consumed
  // one per poll call; once exhausted, repeats the LAST value (so "always IN_PROGRESS" is just [ "IN_PROGRESS" ]).
  let statusQueue: string[] = ["FINISHED"];
  let statusCallIndex = 0;
  let createShouldFail: { status: number; body: unknown } | null = null;
  let publishShouldFail: { status: number; body: unknown } | null = null;

  beforeAll(() => {
    process.env.CREDENTIALS_ENCRYPTION_KEY = VALID_KEY;
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        requestCount++;
        const url = new URL(req.url);
        const method = req.method;

        if (method === "POST" && url.pathname.endsWith("/media")) {
          const body = new URLSearchParams(await req.text());
          requestLog.push({ method, path: url.pathname, body });
          if (createShouldFail) return Response.json(createShouldFail.body, { status: createShouldFail.status });
          return Response.json({ id: CONTAINER_ID });
        }
        if (method === "POST" && url.pathname.endsWith("/media_publish")) {
          const body = new URLSearchParams(await req.text());
          requestLog.push({ method, path: url.pathname, body });
          if (publishShouldFail) return Response.json(publishShouldFail.body, { status: publishShouldFail.status });
          return Response.json({ id: PUBLISHED_ID });
        }
        if (method === "GET" && url.pathname === `/${CONTAINER_ID}`) {
          requestLog.push({ method, path: url.pathname });
          const status = statusQueue[Math.min(statusCallIndex, statusQueue.length - 1)];
          statusCallIndex++;
          return Response.json({ status_code: status });
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
    requestLog.length = 0;
    statusQueue = ["FINISHED"];
    statusCallIndex = 0;
    createShouldFail = null;
    publishShouldFail = null;
    await clearCredentials();
  });

  it("missing credentials: refuses BEFORE any HTTP call — the fake Graph server receives zero requests", async () => {
    const channel = new InstagramChannel({ baseUrl: base, sleepImpl: noSleep });
    const result = await channel.send({
      articleId: randomUUID(), imageUrl: "https://cdn.example.test/render.png", caption: "Légende.",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message.toLowerCase()).toContain("identifiants");
    expect(requestCount).toBe(0);
  });

  it("an igUserId with no token also refuses before any HTTP call", async () => {
    await setChannelCredentialsCore(CHANNEL, { igUserId: "17841400000000000" });
    const channel = new InstagramChannel({ baseUrl: base, sleepImpl: noSleep });
    const result = await channel.send({ articleId: randomUUID(), imageUrl: "https://x/y.png", caption: "c" });
    expect(result.ok).toBe(false);
    expect(requestCount).toBe(0);
  });

  it("the two-step happy path (container FINISHED immediately) publishes and returns the published media id as externalId", async () => {
    await setChannelCredentialsCore(CHANNEL, { igUserId: "17841400000000000", pageAccessToken: "tok-ig-abc" });
    const channel = new InstagramChannel({ baseUrl: base, sleepImpl: noSleep });
    const result = await channel.send({
      articleId: randomUUID(), imageUrl: "https://cdn.example.test/render.png", caption: "Ma légende Instagram.",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.externalId).toBe(PUBLISHED_ID);

    expect(requestLog.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /17841400000000000/media",
      `GET /${CONTAINER_ID}`,
      "POST /17841400000000000/media_publish",
    ]);
    expect(requestLog[0].body?.get("image_url")).toBe("https://cdn.example.test/render.png");
    expect(requestLog[0].body?.get("caption")).toBe("Ma légende Instagram.");
    expect(requestLog[0].body?.get("access_token")).toBe("tok-ig-abc");
    expect(requestLog[0].body?.get("media_type")).toBeNull(); // never sent for a plain image — see instagram.ts header comment
    expect(requestLog[2].body?.get("creation_id")).toBe(CONTAINER_ID);
  });

  it("polls IN_PROGRESS a few times before FINISHED, sleeping (not busy-looping) between attempts", async () => {
    statusQueue = ["IN_PROGRESS", "IN_PROGRESS", "FINISHED"];
    await setChannelCredentialsCore(CHANNEL, { igUserId: "17841400000000000", pageAccessToken: "tok-ig-abc" });

    const sleepCalls: number[] = [];
    const channel = new InstagramChannel({
      baseUrl: base, pollIntervalMs: 5, pollMaxAttempts: 10,
      sleepImpl: async (ms) => { sleepCalls.push(ms); }, // records but does not actually wait — keeps the test fast while still proving the loop awaits something between polls
    });
    const result = await channel.send({ articleId: randomUUID(), imageUrl: "https://x/y.png", caption: "c" });
    expect(result.ok).toBe(true);

    const statusPolls = requestLog.filter((r) => r.path === `/${CONTAINER_ID}`);
    expect(statusPolls).toHaveLength(3); // IN_PROGRESS, IN_PROGRESS, FINISHED
    expect(sleepCalls).toEqual([5, 5]); // one sleep between each of the first two polls, none after the third (FINISHED)
  });

  it("a container stuck IN_PROGRESS times out with a clear French message, after the bounded number of attempts", async () => {
    statusQueue = ["IN_PROGRESS"]; // repeats forever
    await setChannelCredentialsCore(CHANNEL, { igUserId: "17841400000000000", pageAccessToken: "tok-ig-abc" });

    const sleepCalls: number[] = [];
    const channel = new InstagramChannel({
      baseUrl: base, pollIntervalMs: 5, pollMaxAttempts: 4,
      sleepImpl: async (ms) => { sleepCalls.push(ms); },
    });
    const result = await channel.send({ articleId: randomUUID(), imageUrl: "https://x/y.png", caption: "c" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message.toLowerCase()).toContain("délai");
      expect(result.message).toContain(CONTAINER_ID); // container id folded in for manual reconciliation
    }
    const statusPolls = requestLog.filter((r) => r.path === `/${CONTAINER_ID}`);
    expect(statusPolls).toHaveLength(4); // exactly pollMaxAttempts — bounded, not unbounded
    expect(sleepCalls).toHaveLength(3); // slept between attempts 1→2, 2→3, 3→4 — never after the last
    // media_publish must NEVER be called once the poll times out.
    expect(requestLog.some((r) => r.path.endsWith("/media_publish"))).toBe(false);
  });

  it("an ERROR status fails cleanly, in French, without ever calling media_publish", async () => {
    statusQueue = ["ERROR"];
    await setChannelCredentialsCore(CHANNEL, { igUserId: "17841400000000000", pageAccessToken: "tok-ig-abc" });
    const channel = new InstagramChannel({ baseUrl: base, sleepImpl: noSleep });
    const result = await channel.send({ articleId: randomUUID(), imageUrl: "https://x/y.png", caption: "c" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("ERROR");
      expect(result.message).toContain(CONTAINER_ID);
    }
    expect(requestLog.some((r) => r.path.endsWith("/media_publish"))).toBe(false);
  });

  it("an EXPIRED status fails cleanly (defensive branch, French message)", async () => {
    statusQueue = ["EXPIRED"];
    await setChannelCredentialsCore(CHANNEL, { igUserId: "17841400000000000", pageAccessToken: "tok-ig-abc" });
    const channel = new InstagramChannel({ baseUrl: base, sleepImpl: noSleep });
    const result = await channel.send({ articleId: randomUUID(), imageUrl: "https://x/y.png", caption: "c" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("EXPIRED");
  });

  it("a Graph error at container creation refuses cleanly, without ever polling or publishing", async () => {
    await setChannelCredentialsCore(CHANNEL, { igUserId: "17841400000000000", pageAccessToken: "SECRET-SHOULD-NEVER-APPEAR" });
    createShouldFail = { status: 400, body: { error: { message: "Invalid image URL", type: "OAuthException", code: 100 } } };
    const channel = new InstagramChannel({ baseUrl: base, sleepImpl: noSleep });
    const result = await channel.send({ articleId: randomUUID(), imageUrl: "https://x/y.png", caption: "c" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("La publication Instagram a échoué");
      expect(result.message).toContain("Invalid image URL");
      expect(result.message).not.toContain("SECRET-SHOULD-NEVER-APPEAR");
    }
    expect(requestLog.filter((r) => r.method === "GET")).toHaveLength(0);
    expect(requestLog.some((r) => r.path.endsWith("/media_publish"))).toBe(false);
  });

  it("an expired-token error (code 190) at container creation produces a DISTINCT, actionable French message", async () => {
    await setChannelCredentialsCore(CHANNEL, { igUserId: "17841400000000000", pageAccessToken: "expired-tok" });
    createShouldFail = { status: 401, body: { error: { message: "Session has expired", type: "OAuthException", code: 190, error_subcode: 463 } } };
    const channel = new InstagramChannel({ baseUrl: base, sleepImpl: noSleep });
    const result = await channel.send({ articleId: randomUUID(), imageUrl: "https://x/y.png", caption: "c" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message.toLowerCase()).toMatch(/expir/);
      expect(result.message).toContain("/settings/social/instagram");
    }
  });

  it("a Graph error at the media_publish step (AFTER the container reached FINISHED) folds the container id into the message", async () => {
    await setChannelCredentialsCore(CHANNEL, { igUserId: "17841400000000000", pageAccessToken: "tok-ig-abc" });
    publishShouldFail = { status: 400, body: { error: { message: "Media already published or invalid creation_id", type: "OAuthException", code: 100 } } };
    const channel = new InstagramChannel({ baseUrl: base, sleepImpl: noSleep });
    const result = await channel.send({ articleId: randomUUID(), imageUrl: "https://x/y.png", caption: "c" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("La publication Instagram a échoué");
      expect(result.message).toContain(CONTAINER_ID); // this is "record the container id as soon as it exists" in practice — see instagram.ts's header comment
    }
  });

  it("mapInstagramGraphError handles a non-GraphApiError Error and an unknown thrown value too", () => {
    expect(mapInstagramGraphError(new Error("panne réseau"))).toContain("panne réseau");
    expect(mapInstagramGraphError("chaîne quelconque")).toContain("inconnue");
  });

  it("mapInstagramGraphError distinguishes code 190 from an unrelated OAuthException code", () => {
    const expired = new GraphApiError(401, { error: { message: "expired", code: 190 } }, "");
    const other = new GraphApiError(401, { error: { message: "other", code: 200 } }, "");
    expect(mapInstagramGraphError(expired)).not.toBe(mapInstagramGraphError(other));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Layer 2 — the real InstagramChannel through sendToChannelCore (real Neon DB `distributions` row).
// ─────────────────────────────────────────────────────────────────────────────
describe("InstagramChannel through sendToChannelCore (D3) — real distributions row", () => {
  let graphServer: ReturnType<typeof Bun.serve>;
  let graphBase: string;
  let imageServer: ReturnType<typeof Bun.serve>;
  let categoryId: string;
  let templateId: string;
  let articleSuccess: string;
  let articleFailure: string;
  let graphShouldFail = false;

  const CONTAINER_ID = "ig-container-int-1";
  const PUBLISHED_ID = "ig-media-int-1";

  function igOverride(): SocialChannel {
    return {
      ...SOCIAL_CHANNELS.instagram,
      send: (input) => new InstagramChannel({ baseUrl: graphBase, sleepImpl: noSleep, pollIntervalMs: 1, pollMaxAttempts: 3 }).send(input),
    };
  }

  beforeAll(async () => {
    process.env.CREDENTIALS_ENCRYPTION_KEY = VALID_KEY;
    await setChannelCredentialsCore(CHANNEL, { igUserId: "17841400000000000", pageAccessToken: "tok-integration" });

    graphServer = Bun.serve({
      port: 0,
      async fetch(req) {
        if (graphShouldFail) {
          return Response.json({ error: { message: "Erreur simulée du réseau Graph.", type: "OAuthException", code: 100 } }, { status: 400 });
        }
        const url = new URL(req.url);
        if (req.method === "POST" && url.pathname.endsWith("/media")) return Response.json({ id: CONTAINER_ID });
        if (req.method === "GET" && url.pathname === `/${CONTAINER_ID}`) return Response.json({ status_code: "FINISHED" });
        if (req.method === "POST" && url.pathname.endsWith("/media_publish")) return Response.json({ id: PUBLISHED_ID });
        return new Response("not found", { status: 404 });
      },
    });
    graphBase = `http://localhost:${graphServer.port}`;

    const png = await sharp({ create: { width: 400, height: 400, channels: 3, background: { r: 40, g: 90, b: 160 } } }).png().toBuffer();
    imageServer = Bun.serve({ port: 0, fetch: () => new Response(png, { headers: { "content-type": "image/png" } }) });

    const [cat] = await db.insert(wpCategories).values({
      name: "Test Diffusion Instagram", slug: `test-diffusion-instagram-${Date.now()}`, color: "#22AA44",
    }).returning();
    categoryId = cat.id;

    const [t] = await db.insert(renderTemplates).values({
      name: "Test — post Instagram", context: "social_post", channel: CHANNEL, categoryId,
      format: "ig_square", width: 1080, height: 1080, scene: IG_TEMPLATE,
    }).returning();
    templateId = t.id;
    await db.insert(renderTemplateVersions).values({ templateId, version: 1, scene: IG_TEMPLATE });
    await db.update(renderTemplates).set({ publishedVersion: 1 }).where(eq(renderTemplates.id, templateId));

    const imageUrl = `http://127.0.0.1:${imageServer.port}/photo.png`;
    const publishedAt = new Date();
    const mk = (title: string) =>
      db.insert(articles).values({
        title, bodyHtml: "<p>x</p>", status: "published", publishedAt, categoryId, featuredImageUrl: imageUrl,
      }).returning();
    [{ id: articleSuccess }] = await mk("Diffusion Instagram — envoi réussi");
    [{ id: articleFailure }] = await mk("Diffusion Instagram — échec Graph");
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

  it("the two-step happy path publishes and records externalId, marking the distribution 'sent'", async () => {
    const r = await sendToChannelCore({
      articleId: articleSuccess, channel: CHANNEL, caption: "Légende Instagram publiée.", triggeredBy: "manual", actorId: null,
      renderStore: new MemoryRenderStore(), fetchImpl: fetch, channelOverride: igOverride(),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.externalId).toBe(PUBLISHED_ID);

    const [row] = await db.select().from(distributions)
      .where(and(eq(distributions.articleId, articleSuccess), eq(distributions.channel, CHANNEL)));
    expect(row.status).toBe("sent");
    expect(row.externalId).toBe(PUBLISHED_ID);
    expect(row.sentAt).not.toBeNull();

    const revisions = await db.select().from(articleRevisions).where(eq(articleRevisions.articleId, articleSuccess));
    expect(revisions.some((rv) => rv.action.includes("Instagram"))).toBe(true);
  });

  it("a Graph error becomes a French message, marks the distribution 'failed', and increments attempts", async () => {
    graphShouldFail = true;
    const r = await sendToChannelCore({
      articleId: articleFailure, channel: CHANNEL, caption: "Tentative en échec.", triggeredBy: "manual", actorId: null,
      renderStore: new MemoryRenderStore(), fetchImpl: fetch, channelOverride: igOverride(),
    });
    graphShouldFail = false;

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain("La publication Instagram a échoué");

    const [row] = await db.select().from(distributions)
      .where(and(eq(distributions.articleId, articleFailure), eq(distributions.channel, CHANNEL)));
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(1);
    expect(row.lastError).toContain("La publication Instagram a échoué");
    expect(row.externalId).toBeNull();
  });
});
