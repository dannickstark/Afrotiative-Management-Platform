import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, socialChannelSettings } from "@/db";
import { setChannelCredentialsCore, deleteChannelCredentialsCore } from "@/lib/diffusion/settings-core";
import { testFacebookConnection, testInstagramConnection } from "@/lib/diffusion/meta/connection-test";

// Task 5 (D2+D3) — "Tester la connexion" testable core. Same shape/precedent as
// tests/diffusion-facebook.test.ts's Layer 1 (a Bun.serve fake Graph API, injectable base URL, no
// real network) — the brief's own required tests: exactly one HTTP call, and that call is never a
// publish (never /photos, /media, or /media_publish).
const SAVED_KEY = process.env.CREDENTIALS_ENCRYPTION_KEY;
const VALID_KEY = randomBytes(32).toString("base64");

async function clearCredentials(channel: "facebook" | "instagram") {
  await deleteChannelCredentialsCore(channel);
  await db.delete(socialChannelSettings).where(eq(socialChannelSettings.channel, channel));
}

describe("testFacebookConnection — fake Graph API (Task 5), no real network", () => {
  let server: ReturnType<typeof Bun.serve>;
  let base: string;
  let requestCount = 0;
  let lastMethod = "";
  let lastPath = "";
  let lastQuery: URLSearchParams | null = null;
  let failWith: { status: number; body: unknown } | null = null;

  beforeAll(() => {
    process.env.CREDENTIALS_ENCRYPTION_KEY = VALID_KEY;
    server = Bun.serve({
      port: 0,
      fetch(req) {
        requestCount++;
        const url = new URL(req.url);
        lastMethod = req.method;
        lastPath = url.pathname;
        lastQuery = url.searchParams;
        if (failWith) return Response.json(failWith.body, { status: failWith.status });
        return Response.json({ id: "112233445566778", name: "Afrotiative Media" });
      },
    });
    base = `http://localhost:${server.port}`;
  });

  afterAll(async () => {
    server.stop(true);
    await clearCredentials("facebook");
    if (SAVED_KEY === undefined) delete process.env.CREDENTIALS_ENCRYPTION_KEY;
    else process.env.CREDENTIALS_ENCRYPTION_KEY = SAVED_KEY;
  });

  afterEach(async () => {
    requestCount = 0;
    lastMethod = "";
    lastPath = "";
    lastQuery = null;
    failWith = null;
    await clearCredentials("facebook");
  });

  it("missing credentials: refuses BEFORE any HTTP call — the fake Graph server receives zero requests", async () => {
    const result = await testFacebookConnection({ baseUrl: base });
    expect(result.ok).toBe(false);
    expect(result.detail.toLowerCase()).toContain("identifiants");
    expect(requestCount).toBe(0);
  });

  it("success: makes EXACTLY ONE GET call to /{pageId} (never a publish call), and names the Page reached", async () => {
    await setChannelCredentialsCore("facebook", { pageId: "112233445566778", pageAccessToken: "tok-abc-123" });
    const result = await testFacebookConnection({ baseUrl: base });

    expect(result.ok).toBe(true);
    expect(requestCount).toBe(1); // exactly one HTTP call
    expect(lastMethod).toBe("GET"); // never a POST — no publish
    expect(lastPath).toBe("/112233445566778");
    expect(lastPath).not.toContain("/photos"); // the brief's "no publish" requirement, made concrete
    expect(lastQuery?.get("fields")).toBe("id,name");
    expect(lastQuery?.get("access_token")).toBe("tok-abc-123");
    // "show which channel/account it actually reached" (brief) — not a bare green tick.
    expect(result.detail).toContain("Afrotiative Media");
    expect(result.detail).toContain("112233445566778");
  });

  it("an expired-token error (code 190) surfaces the SAME actionable message the real adapter produces", async () => {
    await setChannelCredentialsCore("facebook", { pageId: "112233445566778", pageAccessToken: "expired-tok" });
    failWith = {
      status: 401,
      body: { error: { message: "Error validating access token: Session has expired", type: "OAuthException", code: 190, error_subcode: 463 } },
    };
    const result = await testFacebookConnection({ baseUrl: base });
    expect(result.ok).toBe(false);
    expect(requestCount).toBe(1); // still exactly one call — the failure is a Graph response, not a retry
    expect(result.detail.toLowerCase()).toMatch(/expir/);
    expect(result.detail).toContain("/settings/social/facebook");
    expect(result.detail).not.toContain("expired-tok"); // never a credential in the message
  });

  it("a non-190 Graph error becomes ok:false without ever including the access token", async () => {
    await setChannelCredentialsCore("facebook", { pageId: "112233445566778", pageAccessToken: "SECRET-TOKEN-SHOULD-NEVER-APPEAR" });
    failWith = { status: 400, body: { error: { message: "Unsupported get request.", type: "GraphMethodException", code: 100 } } };
    const result = await testFacebookConnection({ baseUrl: base });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("Unsupported get request.");
    expect(result.detail).not.toContain("SECRET-TOKEN-SHOULD-NEVER-APPEAR");
  });
});

describe("testInstagramConnection — fake Graph API (Task 5), no real network", () => {
  let server: ReturnType<typeof Bun.serve>;
  let base: string;
  let requestCount = 0;
  let lastMethod = "";
  let lastPath = "";
  let lastQuery: URLSearchParams | null = null;
  let failWith: { status: number; body: unknown } | null = null;

  beforeAll(() => {
    process.env.CREDENTIALS_ENCRYPTION_KEY = VALID_KEY;
    server = Bun.serve({
      port: 0,
      fetch(req) {
        requestCount++;
        const url = new URL(req.url);
        lastMethod = req.method;
        lastPath = url.pathname;
        lastQuery = url.searchParams;
        if (failWith) return Response.json(failWith.body, { status: failWith.status });
        return Response.json({ id: "17841400000000000", username: "afrotiative.media" });
      },
    });
    base = `http://localhost:${server.port}`;
  });

  afterAll(async () => {
    server.stop(true);
    await clearCredentials("instagram");
    if (SAVED_KEY === undefined) delete process.env.CREDENTIALS_ENCRYPTION_KEY;
    else process.env.CREDENTIALS_ENCRYPTION_KEY = SAVED_KEY;
  });

  afterEach(async () => {
    requestCount = 0;
    lastMethod = "";
    lastPath = "";
    lastQuery = null;
    failWith = null;
    await clearCredentials("instagram");
  });

  it("missing credentials: refuses BEFORE any HTTP call — the fake Graph server receives zero requests", async () => {
    const result = await testInstagramConnection({ baseUrl: base });
    expect(result.ok).toBe(false);
    expect(result.detail.toLowerCase()).toContain("identifiants");
    expect(requestCount).toBe(0);
  });

  it("success: makes EXACTLY ONE GET call to /{igUserId} (never a container/publish call), and names the account reached", async () => {
    await setChannelCredentialsCore("instagram", { igUserId: "17841400000000000", pageAccessToken: "tok-ig-456" });
    const result = await testInstagramConnection({ baseUrl: base });

    expect(result.ok).toBe(true);
    expect(requestCount).toBe(1);
    expect(lastMethod).toBe("GET");
    expect(lastPath).toBe("/17841400000000000");
    expect(lastPath).not.toContain("/media"); // never a container create/publish call
    expect(lastQuery?.get("fields")).toBe("id,username");
    expect(lastQuery?.get("access_token")).toBe("tok-ig-456");
    expect(result.detail).toContain("afrotiative.media");
    expect(result.detail).toContain("17841400000000000");
  });

  it("an expired-token error (code 190) surfaces the SAME actionable message the real adapter produces", async () => {
    await setChannelCredentialsCore("instagram", { igUserId: "17841400000000000", pageAccessToken: "expired-tok" });
    failWith = {
      status: 401,
      body: { error: { message: "Error validating access token: Session has expired", type: "OAuthException", code: 190 } },
    };
    const result = await testInstagramConnection({ baseUrl: base });
    expect(result.ok).toBe(false);
    expect(requestCount).toBe(1);
    expect(result.detail.toLowerCase()).toMatch(/expir/);
    expect(result.detail).toContain("/settings/social/instagram");
    expect(result.detail).not.toContain("expired-tok");
  });
});
