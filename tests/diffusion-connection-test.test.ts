import { describe, it, expect, beforeAll, afterAll, afterEach, mock } from "bun:test";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, socialChannelSettings, user } from "@/db";
import { setChannelCredentialsCore, deleteChannelCredentialsCore } from "@/lib/diffusion/settings-core";
import {
  testFacebookConnection, testInstagramConnection, testLinkedInConnection,
} from "@/lib/diffusion/connection-test";

// Task 5 (D2+D3), extended Task 6 (D7) — "Tester la connexion" testable core. Same shape/precedent
// as tests/diffusion-facebook.test.ts's/diffusion-linkedin.test.ts's Layer 1 (a Bun.serve fake API,
// injectable base URL, no real network) — the brief's own required tests: exactly one HTTP call,
// and that call is never a publish (never /photos, /media, /media_publish, /rest/images or
// /rest/posts).
//
// Task 6 — this file's import moved from "@/lib/diffusion/meta/connection-test" to
// "@/lib/diffusion/connection-test": see that module's own header comment for the judgement call
// (the file no longer belongs under meta/ once it also covers LinkedIn).
const SAVED_KEY = process.env.CREDENTIALS_ENCRYPTION_KEY;
const VALID_KEY = randomBytes(32).toString("base64");

async function clearCredentials(channel: "facebook" | "instagram" | "linkedin") {
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
// Task 6 (D7) — testLinkedInConnection: same "Tester la connexion" shape as the two describe blocks
// above, against a fake LinkedIn REST API (Bun.serve, injectable base URL). The fake server tracks
// EVERY request it receives (requestCount, lastMethod, pathsCalled) — not a client-side flag —
// specifically so "exactly one GET and no post" is verified from the server's own record of what
// actually hit the wire: this is the property the task brief calls out as the one most likely to
// pass on a lie ("would your test fail if the code posted?").
// ─────────────────────────────────────────────────────────────────────────────
describe("testLinkedInConnection — fake LinkedIn API (Task 6), no real network", () => {
  let server: ReturnType<typeof Bun.serve>;
  let base: string;
  let requestCount = 0;
  let lastMethod = "";
  let pathsCalled: string[] = [];
  let lastAuthHeader: string | null = null;
  let failWith: { status: number; body: unknown } | null = null;

  const ORG_URN = "urn:li:organization:79988552";
  const ACCESS_TOKEN = "tok-li-abc";

  beforeAll(() => {
    process.env.CREDENTIALS_ENCRYPTION_KEY = VALID_KEY;
    server = Bun.serve({
      port: 0,
      fetch(req) {
        requestCount++;
        const url = new URL(req.url);
        lastMethod = req.method;
        pathsCalled.push(url.pathname);
        lastAuthHeader = req.headers.get("authorization");
        if (failWith) return Response.json(failWith.body, { status: failWith.status });
        // GET /rest/organizations/{id} — verified shape (2026-08-10) against LinkedIn's own current
        // Organization Lookup API docs: `id` (numeric) and `localizedName` are both non-admin-only
        // fields returned by this endpoint.
        return Response.json({ id: 79988552, localizedName: "Afrotiative Media" });
      },
    });
    base = `http://localhost:${server.port}`;
  });

  afterAll(async () => {
    server.stop(true);
    await clearCredentials("linkedin");
    if (SAVED_KEY === undefined) delete process.env.CREDENTIALS_ENCRYPTION_KEY;
    else process.env.CREDENTIALS_ENCRYPTION_KEY = SAVED_KEY;
  });

  afterEach(async () => {
    requestCount = 0;
    lastMethod = "";
    pathsCalled = [];
    lastAuthHeader = null;
    failWith = null;
    await clearCredentials("linkedin");
  });

  it("missing credentials: refuses BEFORE any HTTP call — the fake LinkedIn server receives zero requests", async () => {
    const result = await testLinkedInConnection({ baseUrl: base });
    expect(result.ok).toBe(false);
    expect(result.detail.toLowerCase()).toContain("identifiants");
    expect(requestCount).toBe(0);
  });

  // The brief's own literal test, expanded to a full assertion (its second snippet's "if (res.ok)"
  // was elided pseudocode, not a conditional the real test should keep — see the task's own
  // Self-Review note that an elided sibling states the assertion in prose). This is the test that
  // must fail if the implementation ever posted: it reads requestCount/lastMethod/pathsCalled from
  // the FAKE SERVER's own record, not from anything the client under test reports about itself.
  it("makes EXACTLY ONE GET call to /rest/organizations/{id} (never a post), and names the organization reached", async () => {
    await setChannelCredentialsCore("linkedin", { organizationUrn: ORG_URN, accessToken: ACCESS_TOKEN });
    const result = await testLinkedInConnection({ baseUrl: base });

    expect(result.ok).toBe(true);
    expect(requestCount).toBe(1); // exactly one HTTP call
    expect(lastMethod).toBe("GET"); // never a POST — no publish
    expect(pathsCalled).toEqual(["/rest/organizations/79988552"]);
    expect(pathsCalled).not.toContain("/rest/posts"); // never the publish endpoint
    expect(pathsCalled.some((p) => p.includes("/rest/images"))).toBe(false); // never the upload endpoints either
    expect(lastAuthHeader).toBe("Bearer tok-li-abc");
    // "show which channel/account it actually reached" (brief) — not a bare green tick.
    expect(result.detail).toContain("Afrotiative");
    expect(result.detail).toContain(ORG_URN);
    // Honest about what the test does NOT prove (task brief) — a green result must not read as a
    // guarantee that publishing itself would succeed.
    expect(result.detail).toContain("w_organization_social");
  });

  it("an organizationUrn not shaped like urn:li:organization:<id>: ok:false BEFORE any HTTP call", async () => {
    await setChannelCredentialsCore("linkedin", { organizationUrn: "not-a-urn", accessToken: ACCESS_TOKEN });
    const result = await testLinkedInConnection({ baseUrl: base });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("not-a-urn");
    expect(requestCount).toBe(0);
  });

  it("an expired-token error (401) surfaces the SAME actionable message the real adapter produces", async () => {
    await setChannelCredentialsCore("linkedin", { organizationUrn: ORG_URN, accessToken: "expired-tok" });
    failWith = { status: 401, body: { message: "The token used in the request has expired", status: 401 } };
    const result = await testLinkedInConnection({ baseUrl: base });
    expect(result.ok).toBe(false);
    expect(requestCount).toBe(1); // still exactly one call — the failure is an API response, not a retry
    expect(result.detail.toLowerCase()).toMatch(/expir/);
    expect(result.detail).toContain("/settings/social/linkedin");
    expect(result.detail).not.toContain("expired-tok"); // never a credential in the message
  });

  it("a 403 (missing scope or not a Page ADMIN) becomes ok:false without ever including the access token", async () => {
    await setChannelCredentialsCore("linkedin", { organizationUrn: ORG_URN, accessToken: "SECRET-TOKEN-SHOULD-NEVER-APPEAR" });
    failWith = { status: 403, body: { message: "Not enough permissions to access the organization", status: 403 } };
    const result = await testLinkedInConnection({ baseUrl: base });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("403");
    expect(result.detail).not.toContain("SECRET-TOKEN-SHOULD-NEVER-APPEAR");
  });

  // Same review finding (Important 1, D2+D3) and same fix, mirrored a third time for
  // testLinkedInConnection — see the Facebook describe block above for the full explanation.
  it("a rotated/wrong encryption key: ok:false with a French message, never a thrown error — zero HTTP calls", async () => {
    await setChannelCredentialsCore("linkedin", { organizationUrn: ORG_URN, accessToken: ACCESS_TOKEN });
    process.env.CREDENTIALS_ENCRYPTION_KEY = randomBytes(32).toString("base64"); // simulates rotation
    try {
      const result = await testLinkedInConnection({ baseUrl: base });
      expect(result.ok).toBe(false);
      expect(result.detail.toLowerCase()).toContain("déchiffr"); // French, names the real failure
      expect(requestCount).toBe(0); // the failure happens before any LinkedIn call is ever made
    } finally {
      process.env.CREDENTIALS_ENCRYPTION_KEY = VALID_KEY; // restore — afterEach doesn't touch this var
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// lib/actions/diffusion-settings-actions.ts's testChannelConnection — the guarded Server Action
// that fronts testFacebookConnection/testInstagramConnection/testLinkedInConnection above. Minor 10
// (final review): this is the one genuinely NEW network entry point this sub-project adds (every
// export of a "use server" module is an unauthenticated Server Action per
// lib/actions/taxonomy-actions.ts's own comment) — an unguarded version would be a Graph/LinkedIn
// proxy / credential-validity oracle for anyone who could call it. Had NO test at all before this
// fix. Same mock.module recipe as tests/diffusion-crypto.test.ts's own guarded-action describe
// block (capture the real session/cache exports, mock requireUser to a seeded admin/editor,
// dynamically import the action module so its static imports resolve against the mocks, restore in
// afterAll).
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
  // every channel besides facebook/instagram/linkedin still has no real adapter — StubChannel only,
  // no API client to test at all) — an admin, so this exercises the branch itself, not the RBAC
  // guard. Task 6 (D7): this used to name "linkedin" as the example stub channel; LinkedIn now has a
  // real branch (testLinkedInConnection, tested below), so "whatsapp" — still genuinely stub-only
  // per lib/diffusion/setup-guide.ts's own placeholder — takes its place as the example.
  it("a channel with no real adapter yet (e.g. whatsapp) returns the honest stub message, without attempting any HTTP call", async () => {
    const result = await testChannelConnection("whatsapp");
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("Aucun test de connexion disponible");
  });

  // Task 6 (D7) — linkedin now routes through testLinkedInConnection (lib/diffusion/connection-
  // test.ts), not the stub branch. This exercises exactly the Server Action's routing, via the same
  // zero-HTTP-call "missing credentials" path testLinkedInConnection already covers directly —
  // WITHOUT this test itself being able to inject a fake base URL (testChannelConnection calls
  // testLinkedInConnection() with the production default, `https://api.linkedin.com`). That makes
  // the explicit clearCredentials("linkedin") below load-bearing, not decorative: this file's own
  // "No real network calls in tests" constraint depends on nothing being stored for linkedin at the
  // moment this runs, and the suite's own documented cross-file ordering interference (this task's
  // brief) means that can't be assumed just because THIS describe block never writes them — a stray
  // row left by another file (or by this file's dedicated LinkedIn describe block above, if a prior
  // assertion there threw before its own afterEach ran) would otherwise make this call hit the real
  // internet.
  it("linkedin routes through testLinkedInConnection, not the stub branch", async () => {
    await clearCredentials("linkedin");
    const result = await testChannelConnection("linkedin");
    expect(result.ok).toBe(false);
    expect(result.detail).not.toContain("Aucun test de connexion disponible");
    expect(result.detail.toLowerCase()).toContain("identifiants");
  });
});
