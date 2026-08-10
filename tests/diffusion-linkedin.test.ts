import { describe, test, expect, afterEach } from "bun:test";
import { LinkedInClient, LinkedInApiError } from "@/lib/diffusion/linkedin/rest-client";

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
