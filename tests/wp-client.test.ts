import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { WordPressClient, WordPressError } from "@/lib/wp/client";

let server: any;
let base: string;
const calls: any[] = [];
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      calls.push({ method: req.method, path: url.pathname, search: url.search, auth: req.headers.get("authorization") });

      if (url.pathname.endsWith("/users/me")) {
        // A distinct fake auth header simulates an invalid Application Password.
        if (req.headers.get("authorization") === "Basic bad") return new Response("Unauthorized", { status: 401 });
        return Response.json({ id: 1, name: "bot" });
      }

      if (url.pathname.endsWith("/tags") && req.method === "GET") return Response.json([]); // none exist
      if (url.pathname.endsWith("/tags") && req.method === "POST") return Response.json({ id: 42, name: "BRVM" });

      if (url.pathname.endsWith("/categories") && req.method === "GET") {
        const q = url.searchParams.get("search") || "";
        if (q === "BOOM") return new Response("Erreur interne", { status: 500 });
        if (q.toLowerCase() === "existing") return Response.json([{ id: 5, name: "Existing" }]);
        return Response.json([]);
      }
      if (url.pathname.endsWith("/categories") && req.method === "POST") {
        const body = (await req.json()) as { name: string };
        return Response.json({ id: 55, name: body.name });
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
  it("resolveOrCreateTag creates when absent and returns id", async () => {
    expect(await client().resolveOrCreateTag("BRVM")).toBe(42);
  });

  it("resolveOrCreateCategory returns the existing id on an exact case-insensitive match", async () => {
    expect(await client().resolveOrCreateCategory("existing")).toBe(5);
  });

  it("resolveOrCreateCategory creates when absent and returns the new id", async () => {
    expect(await client().resolveOrCreateCategory("Nouvelle Catégorie")).toBe(55);
  });

  it("uploadMedia posts binary and returns attachment id + sourceUrl", async () => {
    const r = await client().uploadMedia(new Uint8Array([1, 2, 3]), "img.jpg", "image/jpeg");
    expect(r.id).toBe(99);
    expect(r.sourceUrl).toBe(`${base}/img.jpg`);
  });

  it("createPost returns the new post id and link", async () => {
    const r = await client().createPost({
      title: "T",
      content: "<p>x</p>",
      status: "publish",
      categories: [3],
      tags: [42],
      featured_media: 99,
      excerpt: "e",
    });
    expect(r.id).toBe(7);
    expect(r.link).toBe(`${base}/?p=7`);
  });

  it("updatePost POSTs to /posts/{id} and returns id + link", async () => {
    const r = await client().updatePost(123, { title: "Updated" });
    expect(r.id).toBe(123);
    expect(r.link).toBe(`${base}/?p=123`);
  });

  it("setPostStatus('trash') sends DELETE /posts/{id}", async () => {
    await client().setPostStatus(123, "trash");
    const last = calls.at(-1);
    expect(last.method).toBe("DELETE");
    expect(last.path.endsWith("/posts/123")).toBe(true);
  });

  it("setPostStatus('draft') POSTs {status} to /posts/{id}", async () => {
    await client().setPostStatus(123, "draft");
    const last = calls.at(-1);
    expect(last.method).toBe("POST");
    expect(last.path.endsWith("/posts/123")).toBe(true);
  });

  it("every request carries the configured Authorization header", async () => {
    await client().testConnection();
    const last = calls.at(-1);
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
