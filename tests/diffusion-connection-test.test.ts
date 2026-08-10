import { describe, it, expect, beforeAll, afterAll, afterEach, mock } from "bun:test";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, socialChannelSettings, user } from "@/db";
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
  let lastAuthHeader: string | null = null;
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
        lastAuthHeader = req.headers.get("authorization");
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
    lastAuthHeader = null;
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
    // Review finding (Important 3): the token travels as an Authorization: Bearer header now, NOT
    // a query-string parameter — asserting BOTH halves (absent from the query AND present in the
    // header, with the exact value) is what makes this test actually fail if a token reappeared in
    // a GET URL, rather than merely "not testing the header at all".
    expect(lastQuery?.get("access_token")).toBeNull();
    expect(lastAuthHeader).toBe("Bearer tok-abc-123");
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

  // Review finding (Important 1): getDecryptedCredentials (settings-core.ts) calls decryptSecret
  // (lib/diffusion/crypto.ts), which THROWS DecryptionFailedError when CREDENTIALS_ENCRYPTION_KEY
  // has been rotated without re-entering credentials — a scenario this same diff's own
  // DEPLOYMENT.md/.env.example text explicitly warns operators never to do, but documents as a
  // real production risk. Before the fix, that throw was NOT caught by testFacebookConnection
  // (only the GraphClient.get call was inside try/catch) — this test reproduces it by writing
  // credentials under VALID_KEY, then swapping in a DIFFERENT, validly-shaped 32-byte key before
  // reading them back, so decryptSecret's GCM auth-tag check fails exactly like a real rotation
  // would. If the fix regresses, `await testFacebookConnection(...)` below rejects and this test
  // fails with an uncaught exception, not a normal assertion failure.
  it("a rotated/wrong encryption key: ok:false with a French message, never a thrown error — zero HTTP calls", async () => {
    await setChannelCredentialsCore("facebook", { pageId: "112233445566778", pageAccessToken: "tok-abc-123" });
    process.env.CREDENTIALS_ENCRYPTION_KEY = randomBytes(32).toString("base64"); // simulates rotation
    try {
      const result = await testFacebookConnection({ baseUrl: base });
      expect(result.ok).toBe(false);
      expect(result.detail.toLowerCase()).toContain("déchiffr"); // French, names the real failure
      expect(requestCount).toBe(0); // the failure happens before any Graph call is ever made
    } finally {
      process.env.CREDENTIALS_ENCRYPTION_KEY = VALID_KEY; // restore — afterEach doesn't touch this var
    }
  });
});

describe("testInstagramConnection — fake Graph API (Task 5), no real network", () => {
  let server: ReturnType<typeof Bun.serve>;
  let base: string;
  let requestCount = 0;
  let lastMethod = "";
  let lastPath = "";
  let lastQuery: URLSearchParams | null = null;
  let lastAuthHeader: string | null = null;
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
        lastAuthHeader = req.headers.get("authorization");
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
    lastAuthHeader = null;
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
    // Review finding (Important 3) — see the Facebook describe block above for the full rationale;
    // same two-sided assertion here (absent from the query, present in the header).
    expect(lastQuery?.get("access_token")).toBeNull();
    expect(lastAuthHeader).toBe("Bearer tok-ig-456");
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

  // Same review finding (Important 1) and same fix, mirrored for testInstagramConnection — see the
  // Facebook describe block above for the full explanation.
  it("a rotated/wrong encryption key: ok:false with a French message, never a thrown error — zero HTTP calls", async () => {
    await setChannelCredentialsCore("instagram", { igUserId: "17841400000000000", pageAccessToken: "tok-ig-456" });
    process.env.CREDENTIALS_ENCRYPTION_KEY = randomBytes(32).toString("base64"); // simulates rotation
    try {
      const result = await testInstagramConnection({ baseUrl: base });
      expect(result.ok).toBe(false);
      expect(result.detail.toLowerCase()).toContain("déchiffr");
      expect(requestCount).toBe(0);
    } finally {
      process.env.CREDENTIALS_ENCRYPTION_KEY = VALID_KEY;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// lib/actions/diffusion-settings-actions.ts's testChannelConnection — the guarded Server Action
// that fronts testFacebookConnection/testInstagramConnection above. Minor 10 (final review): this
// is the one genuinely NEW network entry point this sub-project adds (every export of a "use
// server" module is an unauthenticated Server Action per lib/actions/taxonomy-actions.ts's own
// comment) — an unguarded version would be a Graph proxy / credential-validity oracle for anyone
// who could call it. Had NO test at all before this fix. Same mock.module recipe as
// tests/diffusion-crypto.test.ts's own guarded-action describe block (capture the real
// session/cache exports, mock requireUser to a seeded admin/editor, dynamically import the action
// module so its static imports resolve against the mocks, restore in afterAll).
// ─────────────────────────────────────────────────────────────────────────────
const { requireUser: realRequireUser, getSession: realGetSession } = await import("@/lib/session");
const { revalidatePath: realRevalidatePath, revalidateTag: realRevalidateTag } = await import("next/cache");

const [seededAdmin] = await db.select({ id: user.id, role: user.role })
  .from(user).where(eq(user.email, "admin@afrotiative.com"));
if (!seededAdmin) throw new Error("Seed manquant : admin@afrotiative.com introuvable (bun run db:seed).");
const FAKE_ADMIN = {
  id: seededAdmin.id, name: "Test Admin", email: "admin@afrotiative.com",
  role: seededAdmin.role, banned: false, image: null,
};

const [seededEditor] = await db.select({ id: user.id, role: user.role })
  .from(user).where(eq(user.email, "editor@afrotiative.com"));
if (!seededEditor) throw new Error("Seed manquant : editor@afrotiative.com introuvable (bun run db:seed).");
const FAKE_EDITOR = {
  id: seededEditor.id, name: "Test Éditeur", email: "editor@afrotiative.com",
  role: seededEditor.role, banned: false, image: null,
};

mock.module("@/lib/session", () => ({ getSession: realGetSession, requireUser: async () => FAKE_ADMIN }));
mock.module("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: realRevalidateTag }));

const { testChannelConnection } = await import("@/lib/actions/diffusion-settings-actions");

describe("testChannelConnection (guarded Server Action) — Minor 10", () => {
  afterAll(() => {
    mock.module("@/lib/session", () => ({ getSession: realGetSession, requireUser: realRequireUser }));
    mock.module("next/cache", () => ({ revalidatePath: realRevalidatePath, revalidateTag: realRevalidateTag }));
  });

  // RBAC guard — same pattern as tests/diffusion-crypto.test.ts:369-376's "an editor (no
  // social:manage) is refused". Without this, testChannelConnection would be an unauthenticated
  // Graph proxy: anyone able to call the Server Action could probe whether ANY stored credential on
  // ANY channel still authenticates against Meta, with no role check at all.
  it("an editor (no social:manage) is refused", async () => {
    mock.module("@/lib/session", () => ({ getSession: realGetSession, requireUser: async () => FAKE_EDITOR }));
    try {
      await expect(testChannelConnection("facebook")).rejects.toThrow();
    } finally {
      mock.module("@/lib/session", () => ({ getSession: realGetSession, requireUser: async () => FAKE_ADMIN }));
    }
  });

  // Other-channel stub branch (lib/actions/diffusion-settings-actions.ts's testChannelConnection:
  // every channel besides facebook/instagram still has no real adapter — StubChannel only, no Graph
  // client to test at all) — an admin, so this exercises the branch itself, not the RBAC guard.
  it("a channel with no real adapter yet (e.g. linkedin) returns the honest stub message, without attempting any Graph call", async () => {
    const result = await testChannelConnection("linkedin");
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("Aucun test de connexion disponible");
  });
});
