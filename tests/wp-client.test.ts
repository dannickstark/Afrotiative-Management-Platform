import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { WordPressClient, WordPressError, decodeWpEntities } from "@/lib/wp/client";

describe("decodeWpEntities", () => {
  it("decodes named, decimal, and hex HTML entities WP emits in term names", () => {
    expect(decodeWpEntities("Bourse &amp; Marchés")).toBe("Bourse & Marchés");
    expect(decodeWpEntities("Fusions &amp; Acquisitions")).toBe("Fusions & Acquisitions");
    expect(decodeWpEntities("L&#8217;introduction")).toBe("L'introduction"); // curly apostrophe → '
    expect(decodeWpEntities("A &#38; B")).toBe("A & B"); // decimal &#38; → &
    expect(decodeWpEntities("A &#x26; B")).toBe("A & B"); // hex &#x26; → &
    expect(decodeWpEntities("plain text")).toBe("plain text"); // no entities → unchanged
  });
});

// Each captured request records the method, path, query, auth header, the full header set, and
// (when present) the raw request body as BOTH bytes and parsed JSON. Tests assert on these so a
// regression in the request SHAPE — JSON-wrapping the media bytes, dropping Content-Disposition,
// a wrong Content-Type, a malformed post/term JSON body, a double-create — fails loudly instead
// of sliding past canned responses.
type Captured = {
  method: string;
  path: string;
  search: string;
  auth: string | null;
  headers: Record<string, string>;
  bodyBytes?: Uint8Array;
  json?: any;
};

let server: any;
let base: string;
const calls: Captured[] = [];

async function capture(req: Request, url: URL): Promise<Captured> {
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => (headers[k] = v));
  const c: Captured = {
    method: req.method,
    path: url.pathname,
    search: url.search,
    auth: req.headers.get("authorization"),
    headers,
  };
  if (req.method === "POST") {
    const buf = new Uint8Array(await req.arrayBuffer());
    c.bodyBytes = buf;
    const ct = req.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      try {
        c.json = JSON.parse(new TextDecoder().decode(buf));
      } catch {
        /* not JSON — leave undefined */
      }
    }
  }
  return c;
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const c = await capture(req, url);
      calls.push(c);

      if (url.pathname.endsWith("/users/me")) {
        // A distinct fake auth header simulates an invalid Application Password.
        if (req.headers.get("authorization") === "Basic bad") return new Response("Unauthorized", { status: 401 });
        return Response.json({ id: 1, name: "bot" });
      }

      if (url.pathname.endsWith("/tags") && req.method === "GET") return Response.json([]); // none exist
      if (url.pathname.endsWith("/tags") && req.method === "POST") return Response.json({ id: 42, name: c.json?.name });

      if (url.pathname.endsWith("/categories") && req.method === "GET") {
        const q = url.searchParams.get("search") || "";
        if (q === "BOOM") return new Response("Erreur interne", { status: 500 });
        if (q.toLowerCase() === "existing") return Response.json([{ id: 5, name: "Existing" }]);
        // WordPress returns entity-encoded term names; the client must decode before matching.
        if (q.toLowerCase() === "fusions & acquisitions")
          return Response.json([{ id: 8, name: "Fusions &amp; Acquisitions" }]);
        return Response.json([]);
      }
      if (url.pathname.endsWith("/categories") && req.method === "POST") {
        return Response.json({ id: 55, name: c.json?.name });
      }

      if (url.pathname.endsWith("/media") && req.method === "POST")
        return Response.json({ id: 99, source_url: `${base}/img.jpg` });

      if (url.pathname.endsWith("/posts") && req.method === "POST") return Response.json({ id: 7, link: `${base}/?p=7` });

      const postIdMatch = url.pathname.match(/\/posts\/(\d+)$/);
      if (postIdMatch && req.method === "POST") {
        const id = Number(postIdMatch[1]);
        return Response.json({ id, link: `${base}/?p=${id}` });
      }
      if (postIdMatch && req.method === "DELETE") {
        return Response.json({ id: Number(postIdMatch[1]), status: "trash" });
      }

      return new Response("not found", { status: 404 });
    },
  });
  base = `http://localhost:${server.port}`;
});
afterAll(() => server.stop(true));

function client() {
  return new WordPressClient({ baseUrl: base, user: "bot", appPassword: "x", authHeader: "Basic eA==" });
}

describe("WordPressClient", () => {
  it("resolveOrCreateTag creates when absent, POSTing {name}, and returns id", async () => {
    expect(await client().resolveOrCreateTag("BRVM")).toBe(42);
    const post = calls.at(-1)!;
    expect(post.method).toBe("POST");
    expect(post.path.endsWith("/tags")).toBe(true);
    // Body must be exactly {name} JSON — not a wrapped/extra-field envelope.
    expect(post.json).toEqual({ name: "BRVM" });
  });

  it("resolveOrCreateCategory returns the existing id on an exact case-insensitive match WITHOUT posting", async () => {
    const before = calls.length;
    expect(await client().resolveOrCreateCategory("existing")).toBe(5);
    // Exactly one call (the GET search) — no POST-create fired.
    const made = calls.slice(before);
    expect(made).toHaveLength(1);
    expect(made[0].method).toBe("GET");
  });

  it("resolveOrCreateCategory decodes HTML entities in WP-returned names before matching (no double-create)", async () => {
    const before = calls.length;
    // WP returns "Fusions &amp; Acquisitions"; input is plain "Fusions & Acquisitions".
    expect(await client().resolveOrCreateCategory("Fusions & Acquisitions")).toBe(8);
    const made = calls.slice(before);
    expect(made).toHaveLength(1); // GET only — the decoded name matched, so no POST
    expect(made.every((m) => m.method === "GET")).toBe(true);
  });

  it("resolveOrCreateCategory creates when absent and returns the new id", async () => {
    expect(await client().resolveOrCreateCategory("Nouvelle Catégorie")).toBe(55);
    const post = calls.at(-1)!;
    expect(post.method).toBe("POST");
    expect(post.json).toEqual({ name: "Nouvelle Catégorie" });
  });

  it("uploadMedia posts the RAW BYTES (not JSON) with the right Content-Disposition + Content-Type", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const r = await client().uploadMedia(bytes, "chart.png", "image/png");
    expect(r.id).toBe(99);
    expect(r.sourceUrl).toBe(`${base}/img.jpg`);

    const post = calls.at(-1)!;
    expect(post.path.endsWith("/media")).toBe(true);
    expect(post.headers["content-disposition"]).toBe('attachment; filename="chart.png"');
    expect(post.headers["content-type"]).toBe("image/png");
    // The body is the raw bytes verbatim — same length and same content, NOT a JSON envelope.
    expect(post.bodyBytes).toBeDefined();
    expect(Array.from(post.bodyBytes!)).toEqual([1, 2, 3, 4, 5]);
    expect(post.json).toBeUndefined();
  });

  it("uploadMedia sanitizes quotes/control chars in the filename so the header can't be broken", async () => {
    await client().uploadMedia(new Uint8Array([9]), 'a"b\tc.png', "image/png");
    const post = calls.at(-1)!;
    // `"` → `_`, tab (control char) stripped → header stays well-formed and quoted.
    expect(post.headers["content-disposition"]).toBe('attachment; filename="a_bc.png"');
  });

  it("createPost sends the full post JSON body and returns id + link", async () => {
    const payload = {
      title: "T",
      content: "<p>x</p>",
      status: "publish" as const,
      categories: [3],
      tags: [42],
      featured_media: 99,
      excerpt: "e",
    };
    const r = await client().createPost(payload);
    expect(r.id).toBe(7);
    expect(r.link).toBe(`${base}/?p=7`);

    const post = calls.at(-1)!;
    expect(post.path.endsWith("/posts")).toBe(true);
    expect(post.headers["content-type"]).toContain("application/json");
    expect(post.json).toEqual(payload);
  });

  it("updatePost POSTs to /posts/{id} (path includes the id) with the partial JSON body", async () => {
    const r = await client().updatePost(123, { title: "Updated", status: "draft" });
    expect(r.id).toBe(123);
    expect(r.link).toBe(`${base}/?p=123`);

    const post = calls.at(-1)!;
    expect(post.method).toBe("POST");
    expect(post.path.endsWith("/posts/123")).toBe(true);
    expect(post.json).toEqual({ title: "Updated", status: "draft" });
  });

  it("setPostStatus('trash') sends DELETE /posts/{id}", async () => {
    await client().setPostStatus(123, "trash");
    const last = calls.at(-1)!;
    expect(last.method).toBe("DELETE");
    expect(last.path.endsWith("/posts/123")).toBe(true);
  });

  it("setPostStatus('draft') POSTs {status} to /posts/{id}", async () => {
    await client().setPostStatus(123, "draft");
    const last = calls.at(-1)!;
    expect(last.method).toBe("POST");
    expect(last.path.endsWith("/posts/123")).toBe(true);
    expect(last.json).toEqual({ status: "draft" });
  });

  it("every request carries the configured Authorization header", async () => {
    await client().testConnection();
    const last = calls.at(-1)!;
    expect(last.auth).toBe("Basic eA==");
  });

  it("testConnection is true on 200", async () => {
    expect(await client().testConnection()).toBe(true);
  });

  it("testConnection is false on 401", async () => {
    const c = new WordPressClient({ baseUrl: base, user: "bot", appPassword: "x", authHeader: "Basic bad" });
    expect(await c.testConnection()).toBe(false);
  });

  it("throws a WordPressError with status + body on a non-2xx response", async () => {
    await expect(client().resolveOrCreateCategory("BOOM")).rejects.toThrow(WordPressError);
    try {
      await client().resolveOrCreateCategory("BOOM");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(WordPressError);
      const wpErr = err as WordPressError;
      expect(wpErr.status).toBe(500);
      expect(wpErr.body).toContain("Erreur interne");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fix 1: getCategories()/getTags() must paginate past WordPress's per_page=100 cap instead of
// silently truncating a >100-term taxonomy. A separate fake WP server (distinct port/state from
// the one above) simulates a >100-term taxonomy split across 2 pages for BOTH lookup paths the
// client can use to detect "no more pages": the X-WP-TotalPages response header (categories,
// below) and the fallback "this page came back short" heuristic when that header is absent (tags,
// below) — proving both terminate correctly and return the FULL accumulated list, in original
// {id, name} shape, with no 3rd "just in case" page requested.
// ─────────────────────────────────────────────────────────────────────────────
describe("getCategories/getTags pagination (Fix 1 — no silent 100-term cap)", () => {
  let pagServer: any;
  let pagBase: string;
  const requested: { path: string; page: string | null }[] = [];

  function termPage(prefix: string, startId: number, count: number) {
    return Array.from({ length: count }, (_, i) => ({ id: startId + i, name: `${prefix} ${startId + i}` }));
  }

  beforeAll(() => {
    pagServer = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        const page = url.searchParams.get("page");
        requested.push({ path: url.pathname, page });

        // /categories: 130 terms across 2 pages (100 + 30) — WITH X-WP-TotalPages: exercises the
        // exact, header-driven termination path.
        if (url.pathname.endsWith("/categories")) {
          if (page === "1") return Response.json(termPage("Cat", 1, 100), { headers: { "X-WP-TotalPages": "2" } });
          if (page === "2") return Response.json(termPage("Cat", 101, 30), { headers: { "X-WP-TotalPages": "2" } });
          return new Response("unexpected extra page requested", { status: 400 });
        }

        // /tags: 120 terms across 2 pages (100 + 20) — NO X-WP-TotalPages header: exercises the
        // "short page" fallback heuristic.
        if (url.pathname.endsWith("/tags")) {
          if (page === "1") return Response.json(termPage("Tag", 1, 100));
          if (page === "2") return Response.json(termPage("Tag", 101, 20));
          return new Response("unexpected extra page requested", { status: 400 });
        }

        return new Response("not found", { status: 404 });
      },
    });
    pagBase = `http://localhost:${pagServer.port}`;
  });
  afterAll(() => pagServer.stop(true));

  function pagClient() {
    return new WordPressClient({ baseUrl: pagBase, user: "bot", appPassword: "x", authHeader: "Basic eA==" });
  }

  it("getCategories returns all 130 terms across 2 pages (X-WP-TotalPages path), requesting exactly pages 1 and 2", async () => {
    requested.length = 0;
    const cats = await pagClient().getCategories();
    expect(cats).toHaveLength(130);
    expect(cats[0]).toEqual({ id: 1, name: "Cat 1" });
    expect(cats.at(-1)).toEqual({ id: 130, name: "Cat 130" });
    const pages = requested.filter((r) => r.path.endsWith("/categories")).map((r) => r.page);
    expect(pages).toEqual(["1", "2"]); // no 3rd page probed once X-WP-TotalPages says 2
  });

  it("getTags returns all 120 terms across 2 pages (short-page fallback), requesting exactly pages 1 and 2", async () => {
    requested.length = 0;
    const tags = await pagClient().getTags();
    expect(tags).toHaveLength(120);
    expect(tags[0]).toEqual({ id: 1, name: "Tag 1" });
    expect(tags.at(-1)).toEqual({ id: 120, name: "Tag 120" });
    const pages = requested.filter((r) => r.path.endsWith("/tags")).map((r) => r.page);
    expect(pages).toEqual(["1", "2"]); // page 2 came back short (20 < 100) -> loop stopped there
  });
});
