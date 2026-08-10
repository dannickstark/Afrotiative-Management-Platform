import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, socialChannelSettings } from "@/db";
import { LinkedInClient, LinkedInApiError } from "@/lib/diffusion/linkedin/rest-client";
import { LinkedInChannel, mapLinkedInApiError } from "@/lib/diffusion/linkedin/linkedin";
import { setChannelCredentialsCore, deleteChannelCredentialsCore } from "@/lib/diffusion/settings-core";

// Task 3 (D7) — LinkedIn REST client. Client-only: no adapter, no credential reading, no DB
// (SocialChannel wiring is Task 4). Every test runs against a Bun.serve fake, never the real
// network — same pattern as tests/diffusion-facebook.test.ts, but `fakeLinkedIn` here must be able
// to stand in for BOTH of LinkedIn's hosts (the API base AND the separate dms-uploads upload host,
// see spec §3.1), which is why putBytes's test spins up its own second Bun.serve instance rather
// than reusing `fakeLinkedIn`'s server.

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

// Tracks every server this file starts so afterEach can always stop them, even on a failing
// assertion mid-test — no fixture (DB or otherwise) survives past its own test.
let servers: ReturnType<typeof Bun.serve>[] = [];

function fakeLinkedIn(handler: (req: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ port: 0, fetch: handler });
  servers.push(server);
  return { url: `http://localhost:${server.port}` };
}

afterEach(() => {
  for (const server of servers) server.stop(true);
  servers = [];
});

describe("LinkedInClient (D7 Task 3) — fake REST API, no real network", () => {
  test("every request carries the version and protocol headers, and the token is never in the URL", async () => {
    const seen: { url: string; headers: Headers }[] = [];
    const srv = fakeLinkedIn((req) => {
      seen.push({ url: req.url, headers: req.headers });
      return json({ ok: 1 });
    });
    const c = new LinkedInClient({ accessToken: "tok-abc", baseUrl: srv.url, apiVersion: "202607" });
    await c.get("/rest/images/urn:li:image:1");
    expect(seen[0].headers.get("authorization")).toBe("Bearer tok-abc");
    expect(seen[0].headers.get("linkedin-version")).toBe("202607");
    expect(seen[0].headers.get("x-restli-protocol-version")).toBe("2.0.0");
    expect(seen[0].url).not.toContain("tok-abc");
  });

  test("post() exposes the x-restli-id response header", async () => {
    const srv = fakeLinkedIn(() => new Response("", { status: 201, headers: { "x-restli-id": "urn:li:share:42" } }));
    const c = new LinkedInClient({ accessToken: "t", baseUrl: srv.url });
    const res = await c.post("/rest/posts", {});
    expect(res.status).toBe(201);
    expect(res.headers.get("x-restli-id")).toBe("urn:li:share:42");
  });

  test("putBytes sends the bytes and the bearer token to an absolute URL on another host", async () => {
    let received: ArrayBuffer | null = null;
    let auth: string | null = null;
    const uploads = Bun.serve({
      port: 0,
      async fetch(req) {
        received = await req.arrayBuffer();
        auth = req.headers.get("authorization");
        return new Response("", { status: 201 });
      },
    });
    servers.push(uploads);
    const c = new LinkedInClient({ accessToken: "tok", baseUrl: "http://unused.invalid" });
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    const res = await c.putBytes(`http://localhost:${uploads.port}/dms-uploads/x`, bytes, "image/png");
    expect(res.status).toBe(201);
    expect(new Uint8Array(received!)).toEqual(new Uint8Array([1, 2, 3]));
    expect(auth!).toBe("Bearer tok"); // `!` for the same reason as `received!` above: `auth` is only
    // ever reassigned inside the fetch closure, so strict TS narrows the outer read to its `null`
    // initializer rather than the declared `string | null` — a type-only footgun, not a runtime one.
  });

  test("a LinkedIn error body becomes a typed LinkedInApiError carrying status and serviceErrorCode", async () => {
    const srv = fakeLinkedIn(() => json({ message: "…", status: 401, serviceErrorCode: 65601 }, 401));
    const c = new LinkedInClient({ accessToken: "t", baseUrl: srv.url });
    await expect(c.get("/rest/posts/1")).rejects.toMatchObject({ status: 401, serviceErrorCode: 65601 });
    await expect(c.get("/rest/posts/1")).rejects.toBeInstanceOf(LinkedInApiError);
  });

  test("apiVersion falls back to LINKEDIN_API_VERSION, then to the built-in default", async () => {
    const savedEnv = process.env.LINKEDIN_API_VERSION;
    try {
      delete process.env.LINKEDIN_API_VERSION;
      const seen: { headers: Headers }[] = [];
      const srv = fakeLinkedIn((req) => {
        seen.push({ headers: req.headers });
        return json({ ok: 1 });
      });
      const withDefault = new LinkedInClient({ accessToken: "t", baseUrl: srv.url });
      await withDefault.get("/rest/images/1");
      expect(seen[0].headers.get("linkedin-version")).toBe("202607");

      process.env.LINKEDIN_API_VERSION = "202601";
      const withEnv = new LinkedInClient({ accessToken: "t", baseUrl: srv.url });
      await withEnv.get("/rest/images/1");
      expect(seen[1].headers.get("linkedin-version")).toBe("202601");
    } finally {
      if (savedEnv === undefined) delete process.env.LINKEDIN_API_VERSION;
      else process.env.LINKEDIN_API_VERSION = savedEnv;
    }
  });

  test("putBytes also throws a typed LinkedInApiError on a non-2xx response", async () => {
    const uploads = Bun.serve({ port: 0, fetch: () => json({ message: "quota exceeded", status: 429 }, 429) });
    servers.push(uploads);
    const c = new LinkedInClient({ accessToken: "tok", baseUrl: "http://unused.invalid" });
    const bytes = new Uint8Array([1]).buffer;
    await expect(c.putBytes(`http://localhost:${uploads.port}/dms-uploads/x`, bytes, "image/png"))
      .rejects.toMatchObject({ status: 429 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Task 4 (D7) — LinkedInChannel.send(): the four-step adapter (download → initializeUpload → PUT →
// poll → post) behind lib/diffusion/channels.ts's SocialChannel interface. Same "fake LinkedIn API,
// no real network" discipline as the client tests above, reusing `fakeLinkedIn`/`json`/`servers`
// (this file's own Task 3 helpers). The fake server ALSO serves `/render.png` (LinkedIn's own paths
// AND our own render's public URL live on the SAME fake host here — see linkedInChannelFor's
// fetchImpl below for why that is safe to do under the SSRF guard only in tests, never in
// production). The upload URL, by contrast, is served from a genuinely SEPARATE Bun.serve instance
// via fakeUploadHost (below) — review Important 3: spec §3.1/§7 require the fake to prove `uploadUrl`
// is a different HOST from the API base (production: www.linkedin.com/dms-uploads/... vs
// api.linkedin.com), and linkedin.ts:289 passes it through client.putBytes VERBATIM as an absolute
// URL. Reusing the API server's own origin for uploadUrl (as an earlier draft of this file did)
// would let a future regression that silently re-joined uploadUrl onto baseUrl pass every test here
// unnoticed, since same-origin collapses exactly the distinction that matters.
// ─────────────────────────────────────────────────────────────────────────────
describe("LinkedInChannel.send — fake LinkedIn API (D7 Task 4), no real network", () => {
  const CHANNEL = "linkedin" as const;
  const SAVED_KEY = process.env.CREDENTIALS_ENCRYPTION_KEY;
  const VALID_KEY = randomBytes(32).toString("base64");
  const noSleep = async () => {};

  const ORG_URN = "urn:li:organization:42";
  const ACCESS_TOKEN = "tok-li-abc";
  const IMAGE_URN = "urn:li:image:9";
  const POST_URN = "urn:li:share:77";
  const RENDER_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]); // PNG magic bytes — the adapter only inspects content-type, never decodes the bytes, so this is enough

  async function clearLinkedInCredentials() {
    await deleteChannelCredentialsCore(CHANNEL);
    await db.delete(socialChannelSettings).where(eq(socialChannelSettings.channel, CHANNEL));
  }

  beforeAll(() => {
    process.env.CREDENTIALS_ENCRYPTION_KEY = VALID_KEY;
  });
  afterAll(async () => {
    await clearLinkedInCredentials();
    if (SAVED_KEY === undefined) delete process.env.CREDENTIALS_ENCRYPTION_KEY;
    else process.env.CREDENTIALS_ENCRYPTION_KEY = SAVED_KEY;
  });
  afterEach(async () => {
    await clearLinkedInCredentials();
  });

  // Wraps this file's own `fakeLinkedIn` (Task 3, above) to also log every request as
  // "METHOD /path?search", in arrival order — what the happy-path/order tests below assert against.
  // Task 3's `fakeLinkedIn` itself is untouched (its own tests never read `.calls`).
  function fakeLinkedInTracked(
    impl: (req: Request, u: URL) => Response | Promise<Response>,
  ): { url: string; calls: string[] } {
    const calls: string[] = [];
    const srv = fakeLinkedIn(async (req) => {
      const u = new URL(req.url);
      calls.push(`${req.method} ${u.pathname}${u.search}`);
      return impl(req, u);
    });
    return { url: srv.url, calls };
  }

  function pathsCalled(srv: { calls: string[] }): string[] {
    return srv.calls;
  }

  // `/render.png` lives on the SAME fake host as every LinkedIn endpoint — nothing requires it to be
  // on a different host (it's OUR OWN render URL, not a LinkedIn one), so colocating it here keeps
  // most tests to a single Bun.serve instance.
  function renderUrl(srv: { url: string }): string {
    return `${srv.url}/render.png`;
  }

  // A genuinely SEPARATE host for the upload URL (review Important 3 — see this describe block's
  // header comment for why same-origin was a real gap). `calls` is the SAME array the API host's own
  // tracker pushes into, when one is passed in, so ordering assertions across BOTH hosts still read
  // as one merged, real-time-ordered list — requests are always awaited sequentially by send(), never
  // concurrent, so there is no ordering race between two separate Bun.serve instances writing to the
  // same array. Always answers 201 — no adapter test here needs the PUT response body/status to vary.
  function fakeUploadHost(calls: string[] = []): { url: string; calls: string[] } {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const u = new URL(req.url);
        calls.push(`${req.method} ${u.pathname}${u.search}`);
        return new Response("", { status: 201 });
      },
    });
    servers.push(server);
    return { url: `http://localhost:${server.port}`, calls };
  }

  // fetchImpl: fetch (real global fetch, pointed at the fake server) is what lets these tests reach
  // a local Bun.serve instance for the byte download AND lifts the SSRF guard (only in combination
  // with NODE_ENV === "test" — see linkedin.ts's send(), mirroring lib/studio/images.ts's
  // prepareImage exactly). The one test that must exercise the REAL guard (the "unsafe image URL"
  // test below) deliberately does NOT go through this helper.
  function linkedInChannelFor(srv: { url: string }, overrides: Partial<{
    pollMaxAttempts: number; pollIntervalMs: number; sleepImpl: (ms: number) => Promise<void>;
  }> = {}): LinkedInChannel {
    return new LinkedInChannel({ baseUrl: srv.url, fetchImpl: fetch, sleepImpl: noSleep, ...overrides });
  }

  test("happy path: four calls in order, externalId from x-restli-id", async () => {
    const calls: string[] = [];
    // Genuinely separate host for the PUT — review Important 3 (see describe header comment). If a
    // future regression re-joined uploadUrl onto baseUrl, the PUT would hit `srv` instead (which has
    // no /dms-uploads branch below and would answer "nope"/500), and this test would fail instead of
    // passing unnoticed.
    const uploadSrv = fakeUploadHost(calls);
    const srv = fakeLinkedIn((req) => {
      const u = new URL(req.url); calls.push(`${req.method} ${u.pathname}${u.search}`);
      if (u.pathname === "/render.png") return new Response(RENDER_BYTES, { headers: { "content-type": "image/png" } });
      if (u.search.includes("initializeUpload")) return json({ value: { uploadUrl: `${uploadSrv.url}/dms-uploads/1`, image: IMAGE_URN } });
      if (u.pathname.includes("/rest/images/")) return json({ id: IMAGE_URN, status: "AVAILABLE" });
      if (u.pathname === "/rest/posts") return new Response("", { status: 201, headers: { "x-restli-id": POST_URN } });
      return new Response("nope", { status: 500 });
    });
    await setChannelCredentialsCore(CHANNEL, { organizationUrn: ORG_URN, accessToken: ACCESS_TOKEN });
    const res = await linkedInChannelFor(srv).send({ articleId: "a1", imageUrl: renderUrl(srv), caption: "Bonjour" });
    expect(res).toEqual({ ok: true, externalId: POST_URN });
    expect(calls).toEqual([
      "GET /render.png",
      "POST /rest/images?action=initializeUpload",
      "PUT /dms-uploads/1",
      `GET /rest/images/${IMAGE_URN}`,
      "POST /rest/posts",
    ]);
  });

  test("the post body carries the image urn, the caption, PUBLIC and MAIN_FEED", async () => {
    let postBody: unknown = null;
    let initBody: unknown = null;
    const uploadSrv = fakeUploadHost(); // genuinely separate host — review Important 3
    const srv = fakeLinkedIn(async (req) => {
      const u = new URL(req.url);
      if (u.pathname === "/render.png") return new Response(RENDER_BYTES, { headers: { "content-type": "image/png" } });
      if (u.search.includes("initializeUpload")) {
        initBody = await req.json();
        return json({ value: { uploadUrl: `${uploadSrv.url}/dms-uploads/1`, image: IMAGE_URN } });
      }
      if (u.pathname.includes("/rest/images/")) return json({ id: IMAGE_URN, status: "AVAILABLE" });
      if (u.pathname === "/rest/posts") {
        postBody = await req.json();
        return new Response("", { status: 201, headers: { "x-restli-id": POST_URN } });
      }
      return new Response("nope", { status: 500 });
    });
    await setChannelCredentialsCore(CHANNEL, { organizationUrn: ORG_URN, accessToken: ACCESS_TOKEN });
    const res = await linkedInChannelFor(srv).send({
      articleId: "a1", imageUrl: renderUrl(srv), caption: "Bonjour, ceci est un test.",
    });
    expect(res.ok).toBe(true);
    // Spec §3.2 step 2's exact payload shape.
    expect(initBody).toEqual({ initializeUploadRequest: { owner: ORG_URN } });
    // Spec §3.2 step 5's exact payload shape.
    expect(postBody).toEqual({
      author: ORG_URN,
      commentary: "Bonjour, ceci est un test.",
      visibility: "PUBLIC",
      distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
      content: { media: { altText: "Bonjour, ceci est un test.", id: IMAGE_URN } },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    });
    // The PUT genuinely reached the separate upload host, not the API host — review Important 3.
    expect(uploadSrv.calls).toEqual(["PUT /dms-uploads/1"]);
  });

  // Review fix, Important 2: generateCaption (spec §2) appends the article permalink at the very
  // END of the caption — "<body> <url>" — and linkedin.captionLimits.default (400) already exceeds
  // ALT_TEXT_MAX_CHARS (300), so a caption long enough to trip alt-text truncation is the COMMON
  // case. This caption is deliberately well over the cap so truncation genuinely runs, not just the
  // URL-stripping step.
  test("alt text never contains a truncated URL fragment, even when the caption (with its appended permalink) exceeds the cap", async () => {
    const words = Array.from({ length: 80 }, (_, i) => `motdelegende${i}`);
    const body = words.join(" "); // well over 300 characters on its own — see comment above
    const url = "https://exemple.test/articles/un-permalien-suffisamment-long-pour-etre-tronque-au-milieu-si-le-texte-alternatif-etait-tronque-naivement";
    const caption = `${body} ${url}`; // spec §2's shape
    expect(caption.length).toBeGreaterThan(300); // sanity: this test genuinely exercises truncation

    // `unknown`, not a concrete shape — a `let` reassigned only inside the async fetch closure below
    // narrows to `never` under strict TS control-flow analysis if given a concrete optional-chain-
    // friendly type here (see this file's own putBytes test above for the same `!`-assertion trap).
    let postBody: unknown = null;
    const uploadSrv = fakeUploadHost();
    const srv = fakeLinkedIn(async (req) => {
      const u = new URL(req.url);
      if (u.pathname === "/render.png") return new Response(RENDER_BYTES, { headers: { "content-type": "image/png" } });
      if (u.search.includes("initializeUpload")) return json({ value: { uploadUrl: `${uploadSrv.url}/dms-uploads/1`, image: IMAGE_URN } });
      if (u.pathname.includes("/rest/images/")) return json({ id: IMAGE_URN, status: "AVAILABLE" });
      if (u.pathname === "/rest/posts") {
        postBody = await req.json();
        return new Response("", { status: 201, headers: { "x-restli-id": POST_URN } });
      }
      return new Response("nope", { status: 500 });
    });
    await setChannelCredentialsCore(CHANNEL, { organizationUrn: ORG_URN, accessToken: ACCESS_TOKEN });
    const res = await linkedInChannelFor(srv).send({ articleId: "a1", imageUrl: renderUrl(srv), caption });
    expect(res.ok).toBe(true);

    const parsedBody = postBody as { content?: { media?: { altText?: string } } } | null;
    const altText = parsedBody?.content?.media?.altText ?? "";
    expect(altText.length).toBeGreaterThan(0);
    // The hard requirement: the URL must never survive truncation, partially or otherwise.
    expect(altText).not.toMatch(/https?:\/\//i);
    // Never cut mid-word either: strip the trailing ellipsis (if any) and confirm what remains is an
    // exact, whole-word-boundary PREFIX of the caption's body — a mid-word slice would not be one.
    const withoutEllipsis = altText.endsWith("…") ? altText.slice(0, -1) : altText;
    expect(body.startsWith(withoutEllipsis)).toBe(true);
    expect(withoutEllipsis.endsWith(" ")).toBe(false);
  });

  test("a timeout NEVER posts — an invisible post is worse than a failed send", async () => {
    const srv = fakeLinkedInTracked((req, u) => {
      if (u.pathname === "/render.png") return new Response(RENDER_BYTES, { headers: { "content-type": "image/png" } });
      if (u.search.includes("initializeUpload")) return json({ value: { uploadUrl: `${uploadSrv.url}/dms-uploads/1`, image: IMAGE_URN } });
      if (u.pathname.includes("/rest/images/")) return json({ id: IMAGE_URN, status: "PROCESSING" }); // never AVAILABLE
      return new Response("nope", { status: 500 });
    });
    const uploadSrv = fakeUploadHost(srv.calls); // genuinely separate host — review Important 3
    await setChannelCredentialsCore(CHANNEL, { organizationUrn: ORG_URN, accessToken: ACCESS_TOKEN });
    const res = await linkedInChannelFor(srv, { pollMaxAttempts: 3, sleepImpl: async () => {} }).send({
      articleId: "a1", imageUrl: renderUrl(srv), caption: "Bonjour",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/n'a pas fini d'être traitée|délai/i);
    expect(pathsCalled(srv)).not.toContain("POST /rest/posts");
    // Bounded — exactly pollMaxAttempts polls, never more, never fewer.
    expect(pathsCalled(srv).filter((p) => p.includes("/rest/images/"))).toHaveLength(3);
  });

  test("PROCESSING_FAILED fails immediately without posting", async () => {
    const srv = fakeLinkedInTracked((req, u) => {
      if (u.pathname === "/render.png") return new Response(RENDER_BYTES, { headers: { "content-type": "image/png" } });
      if (u.search.includes("initializeUpload")) return json({ value: { uploadUrl: `${uploadSrv.url}/dms-uploads/1`, image: IMAGE_URN } });
      if (u.pathname.includes("/rest/images/")) return json({ id: IMAGE_URN, status: "PROCESSING_FAILED" });
      return new Response("nope", { status: 500 });
    });
    const uploadSrv = fakeUploadHost(srv.calls); // genuinely separate host — review Important 3
    await setChannelCredentialsCore(CHANNEL, { organizationUrn: ORG_URN, accessToken: ACCESS_TOKEN });
    const res = await linkedInChannelFor(srv, { pollMaxAttempts: 5 }).send({
      articleId: "a1", imageUrl: renderUrl(srv), caption: "Bonjour",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.message).toContain("PROCESSING_FAILED");
      expect(res.message).toContain(IMAGE_URN);
      // The image is the problem here, not the token — must not send the operator to the settings
      // page the way the 401 mapping does (see the "401" test below).
      expect(res.message).not.toContain("/settings/social/linkedin");
    }
    expect(pathsCalled(srv)).not.toContain("POST /rest/posts");
    // Fails on the FIRST poll — not after exhausting every attempt.
    expect(pathsCalled(srv).filter((p) => p.includes("/rest/images/"))).toHaveLength(1);
  });

  test("201 without x-restli-id is a failure, not a success with an empty id", async () => {
    const uploadSrv = fakeUploadHost(); // genuinely separate host — review Important 3
    const srv = fakeLinkedIn((req) => {
      const u = new URL(req.url);
      if (u.pathname === "/render.png") return new Response(RENDER_BYTES, { headers: { "content-type": "image/png" } });
      if (u.search.includes("initializeUpload")) return json({ value: { uploadUrl: `${uploadSrv.url}/dms-uploads/1`, image: IMAGE_URN } });
      if (u.pathname.includes("/rest/images/")) return json({ id: IMAGE_URN, status: "AVAILABLE" });
      if (u.pathname === "/rest/posts") return new Response("", { status: 201 }); // no x-restli-id header
      return new Response("nope", { status: 500 });
    });
    await setChannelCredentialsCore(CHANNEL, { organizationUrn: ORG_URN, accessToken: ACCESS_TOKEN });
    const res = await linkedInChannelFor(srv).send({ articleId: "a1", imageUrl: renderUrl(srv), caption: "Bonjour" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.message).toContain("x-restli-id");
      expect(res.message).toContain(IMAGE_URN);
    }
    expect((res as { ok: boolean; externalId?: string }).externalId).toBeUndefined();
  });

  test("401 says the token expired and points at the settings page", async () => {
    const srv = fakeLinkedIn((req) => {
      const u = new URL(req.url);
      if (u.pathname === "/render.png") return new Response(RENDER_BYTES, { headers: { "content-type": "image/png" } });
      return json({ message: "invalid access token", status: 401 }, 401);
    });
    await setChannelCredentialsCore(CHANNEL, { organizationUrn: ORG_URN, accessToken: "expired-tok" });
    const res = await linkedInChannelFor(srv).send({ articleId: "a1", imageUrl: renderUrl(srv), caption: "Bonjour" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.message).toMatch(/jeton/i);
      expect(res.message).toContain("/settings/social/linkedin");
      expect(res.message).not.toContain("expired-tok"); // never a credential in the message
    }
  });

  test("403 blames the scope or Page admin rights, not the token — distinct from 401", async () => {
    const srv = fakeLinkedIn((req) => {
      const u = new URL(req.url);
      if (u.pathname === "/render.png") return new Response(RENDER_BYTES, { headers: { "content-type": "image/png" } });
      return json({ message: "ACCESS_DENIED", status: 403 }, 403);
    });
    await setChannelCredentialsCore(CHANNEL, { organizationUrn: ORG_URN, accessToken: ACCESS_TOKEN });
    const res = await linkedInChannelFor(srv).send({ articleId: "a1", imageUrl: renderUrl(srv), caption: "Bonjour" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.message.toLowerCase()).toMatch(/w_organization_social|administrateur/);
      // Distinct fix from 401 — must not tell the operator to regenerate a token, and must not
      // point at the settings page the way the 401 mapping does (see the "401" test above).
      expect(res.message).not.toContain("Générez un nouveau jeton");
      expect(res.message).not.toContain("/settings/social/linkedin");
    }
    expect(mapLinkedInApiError(new LinkedInApiError(401, {}, ""))).not.toBe(mapLinkedInApiError(new LinkedInApiError(403, {}, "")));
  });

  test("429 mentions the daily quota", async () => {
    const srv = fakeLinkedIn((req) => {
      const u = new URL(req.url);
      if (u.pathname === "/render.png") return new Response(RENDER_BYTES, { headers: { "content-type": "image/png" } });
      return json({ message: "QPS_LIMIT_EXCEEDED", status: 429 }, 429);
    });
    await setChannelCredentialsCore(CHANNEL, { organizationUrn: ORG_URN, accessToken: ACCESS_TOKEN });
    const res = await linkedInChannelFor(srv).send({ articleId: "a1", imageUrl: renderUrl(srv), caption: "Bonjour" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message.toLowerCase()).toMatch(/quota/);
  });

  // Review fix, Important 1: spec §3.2 step 1 is explicit that a 413/415 FROM LINKEDIN gets a
  // distinct French message rather than falling into the generic branch — the render/format is the
  // problem, not the token or a permission (same distinguishing principle as PROCESSING_FAILED).
  test("413 means the render is too large for LinkedIn — distinct from every other error", async () => {
    const srv = fakeLinkedIn((req) => {
      const u = new URL(req.url);
      if (u.pathname === "/render.png") return new Response(RENDER_BYTES, { headers: { "content-type": "image/png" } });
      return json({ message: "PAYLOAD_TOO_LARGE", status: 413 }, 413);
    });
    await setChannelCredentialsCore(CHANNEL, { organizationUrn: ORG_URN, accessToken: ACCESS_TOKEN });
    const res = await linkedInChannelFor(srv).send({ articleId: "a1", imageUrl: renderUrl(srv), caption: "Bonjour" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.message.toLowerCase()).toMatch(/taille|volumineux|lourd/);
      // Not a token/permission/quota message — the image itself is the problem.
      expect(res.message).not.toContain("/settings/social/linkedin");
      expect(res.message.toLowerCase()).not.toMatch(/quota|w_organization_social/);
    }
    // Distinct mapping from every other status this file exercises.
    const messages = [401, 403, 429, 413].map((status) => mapLinkedInApiError(new LinkedInApiError(status, {}, "")));
    expect(new Set(messages).size).toBe(messages.length);
  });

  test("415 means the format is not one LinkedIn accepts — distinct from every other error", async () => {
    const srv = fakeLinkedIn((req) => {
      const u = new URL(req.url);
      if (u.pathname === "/render.png") return new Response(RENDER_BYTES, { headers: { "content-type": "image/png" } });
      return json({ message: "UNSUPPORTED_MEDIA_TYPE", status: 415 }, 415);
    });
    await setChannelCredentialsCore(CHANNEL, { organizationUrn: ORG_URN, accessToken: ACCESS_TOKEN });
    const res = await linkedInChannelFor(srv).send({ articleId: "a1", imageUrl: renderUrl(srv), caption: "Bonjour" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.message.toLowerCase()).toMatch(/format/);
      expect(res.message.toLowerCase()).toMatch(/jpg|png|gif/);
      expect(res.message).not.toContain("/settings/social/linkedin");
    }
    expect(mapLinkedInApiError(new LinkedInApiError(413, {}, ""))).not.toBe(mapLinkedInApiError(new LinkedInApiError(415, {}, "")));
  });

  test("a generic LinkedIn API error becomes a French message and never leaks the access token", async () => {
    const srv = fakeLinkedIn((req) => {
      const u = new URL(req.url);
      if (u.pathname === "/render.png") return new Response(RENDER_BYTES, { headers: { "content-type": "image/png" } });
      return json({ message: "Invalid owner URN", status: 400 }, 400);
    });
    await setChannelCredentialsCore(CHANNEL, { organizationUrn: ORG_URN, accessToken: "SECRET-TOKEN-SHOULD-NEVER-APPEAR" });
    const res = await linkedInChannelFor(srv).send({ articleId: "a1", imageUrl: renderUrl(srv), caption: "Bonjour" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.message).toContain("La publication LinkedIn a échoué");
      expect(res.message).not.toContain("SECRET-TOKEN-SHOULD-NEVER-APPEAR");
    }
  });

  test("missing credentials refuse before any HTTP call", async () => {
    const srv = fakeLinkedInTracked(() => json({ ok: 1 }));
    // Credentials deliberately left unset — afterEach above clears them after every test too, so
    // this holds regardless of test order within this file.
    const res = await linkedInChannelFor(srv).send({ articleId: "a1", imageUrl: renderUrl(srv), caption: "Bonjour" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message.toLowerCase()).toContain("identifiants");
    expect(pathsCalled(srv)).toHaveLength(0);
  });

  test("an organization URN with no access token also refuses before any HTTP call", async () => {
    const srv = fakeLinkedInTracked(() => json({ ok: 1 }));
    await setChannelCredentialsCore(CHANNEL, { organizationUrn: ORG_URN }); // token deliberately omitted
    const res = await linkedInChannelFor(srv).send({ articleId: "a1", imageUrl: renderUrl(srv), caption: "Bonjour" });
    expect(res.ok).toBe(false);
    expect(pathsCalled(srv)).toHaveLength(0);
  });

  // Mirrors tests/diffusion-connection-test.test.ts:118-129 and tests/diffusion-facebook.test.ts's/
  // tests/diffusion-instagram.test.ts's own copies of the same regression test: write credentials
  // under VALID_KEY, then swap in a DIFFERENT, validly-shaped 32-byte key before sending, exactly
  // reproducing a CREDENTIALS_ENCRYPTION_KEY rotation without re-entering credentials.
  test("a rotated encryption key returns a French failure instead of throwing (D2+D3 review, Important 1)", async () => {
    const srv = fakeLinkedInTracked(() => json({ ok: 1 }));
    await setChannelCredentialsCore(CHANNEL, { organizationUrn: ORG_URN, accessToken: ACCESS_TOKEN });
    process.env.CREDENTIALS_ENCRYPTION_KEY = randomBytes(32).toString("base64"); // simulates rotation
    try {
      const res = await linkedInChannelFor(srv).send({ articleId: "a1", imageUrl: renderUrl(srv), caption: "Bonjour" });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.message).toMatch(/déchiffr/i);
      expect(pathsCalled(srv)).toHaveLength(0); // fails before ANY HTTP call, including the image download
    } finally {
      process.env.CREDENTIALS_ENCRYPTION_KEY = VALID_KEY; // restore — afterEach doesn't touch this var
    }
  });

  test("an unsafe image URL is refused before any LinkedIn call", async () => {
    const srv = fakeLinkedInTracked(() => json({ ok: 1 }));
    await setChannelCredentialsCore(CHANNEL, { organizationUrn: ORG_URN, accessToken: ACCESS_TOKEN });
    // Deliberately NOT going through linkedInChannelFor: no fetchImpl override here means the REAL
    // SSRF guard runs (isSafePublicHttpUrl) — see linkedin.ts's send()/this describe's header comment.
    const channel = new LinkedInChannel({ baseUrl: srv.url, sleepImpl: noSleep });
    const res = await channel.send({
      articleId: "a1", imageUrl: "http://169.254.169.254/latest/meta-data/", caption: "Bonjour",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message.toLowerCase()).toContain("adresse publique");
    expect(pathsCalled(srv)).toHaveLength(0);
  });

  test("a non-image content type is refused", async () => {
    const srv = fakeLinkedInTracked((req, u) => {
      if (u.pathname === "/render.png") return new Response("<html>pas une image</html>", { headers: { "content-type": "text/html" } });
      return json({ ok: 1 });
    });
    await setChannelCredentialsCore(CHANNEL, { organizationUrn: ORG_URN, accessToken: ACCESS_TOKEN });
    const res = await linkedInChannelFor(srv).send({ articleId: "a1", imageUrl: renderUrl(srv), caption: "Bonjour" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message.toLowerCase()).toContain("image exploitable");
    // Never reaches LinkedIn's own API — only the render download was attempted.
    expect(pathsCalled(srv)).toEqual(["GET /render.png"]);
  });

  test("mapLinkedInApiError handles a non-LinkedInApiError Error and an unknown thrown value too", () => {
    expect(mapLinkedInApiError(new Error("panne réseau"))).toContain("panne réseau");
    expect(mapLinkedInApiError("chaîne quelconque")).toContain("inconnue");
  });
});
