import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { readabilityFromHtml } from "@/lib/extract/readability";

describe("readabilityFromHtml", () => {
  it("extracts article text + title + images from HTML", () => {
    const html = `<html><head><title>La BRVM</title><meta property="og:image" content="https://x/h.jpg"></head>
      <body><article><h1>La BRVM franchit un record</h1>
      <p>${"La bourse régionale progresse fortement. ".repeat(20)}</p></article></body></html>`;
    const e = readabilityFromHtml(html, "https://example.com/a");
    expect(e.text.length).toBeGreaterThan(100);
    expect(e.images).toContain("https://x/h.jpg");
    expect(e.via).toBe("readability");
  });

  it("falls back to a main-content selector when Readability finds too little text", () => {
    // Deliberately minimal/malformed markup Readability's heuristics may reject as an
    // article, but which still has a <main> we can fall back to.
    const html = `<html><body><main>${"Contenu principal du site. ".repeat(20)}</main></body></html>`;
    const e = readabilityFromHtml(html, "https://example.com/b");
    expect(e.text.length).toBeGreaterThan(100);
    expect(e.via).toBe("readability");
  });
});

describe("extract chain (network-free)", () => {
  // Only touch the vars the chain reads; restore exactly these afterwards. `bun test` shares
  // one process (and one process.env) across the whole run, so a wholesale env snapshot/restore
  // here would risk clobbering unrelated state other test files depend on.
  const original = {
    EXTRACT_ORDER: process.env.EXTRACT_ORDER,
    JINA_API_KEY: process.env.JINA_API_KEY,
    FIRECRAWL_API_KEY: process.env.FIRECRAWL_API_KEY,
  };

  beforeEach(() => {
    process.env.EXTRACT_ORDER = "jina,firecrawl,readability";
    delete process.env.JINA_API_KEY;
    delete process.env.FIRECRAWL_API_KEY;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(original)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("skips jina/firecrawl for missing keys and logs a reason, then falls through to readability", async () => {
    const { extract } = await import("@/lib/extract/index");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      const html = `<html><head><title>T</title></head><body><article><p>${"contenu de test ".repeat(30)}</p></article></body></html>`;
      return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
    }) as typeof fetch;

    try {
      const r = await extract("https://example.com/article");
      expect(r.via).toBe("readability");
      expect(r.attempts).toEqual([
        { provider: "jina", ok: false, reason: "pas de clé Jina" },
        { provider: "firecrawl", ok: false, reason: "pas de clé Firecrawl" },
        { provider: "readability", ok: true },
      ]);
      expect(r.text.length).toBeGreaterThan(100);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("terminates with via='none' and all attempts failed when every provider is unavailable/erroring", async () => {
    process.env.EXTRACT_ORDER = "jina,firecrawl";
    const { extract } = await import("@/lib/extract/index");
    const r = await extract("https://example.com/article");
    expect(r.via).toBe("none");
    expect(r.text).toBe("");
    expect(r.attempts.every((a) => !a.ok)).toBe(true);
  });
});
