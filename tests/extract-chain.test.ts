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

// Plan: pipeline-autopublish-and-crawl4ai-images, Task 3 — Crawl4AI wired into the extract chain
// both as a provider (jina/firecrawl/crawl4ai/readability) and as the second leg of image
// backfill (backfillCandidateImages). Crawl4AI is external infra (a hosted Railway box), just like
// jina/firecrawl, so it never fetches `url` directly from OUR server — safe for untrusted
// web-search URLs (externalOnly). Every fetch here is dispatched by URL: `https://r.jina.ai/*` for
// jina, `<CRAWL4AI_API_URL>/crawl` for Crawl4AI, and the bare page URL for the raw-fetch backfill —
// an unmocked URL throws, which is how the externalOnly test proves the raw page fetch never
// happens (same no-raw-fetch technique as tests/extract-ssrf.test.ts).
describe("extract chain — crawl4ai provider + image backfill (Task 3)", () => {
  const original = {
    EXTRACT_ORDER: process.env.EXTRACT_ORDER,
    JINA_API_KEY: process.env.JINA_API_KEY,
    FIRECRAWL_API_KEY: process.env.FIRECRAWL_API_KEY,
    CRAWL4AI_API_URL: process.env.CRAWL4AI_API_URL,
    CRAWL4AI_API_TOKEN: process.env.CRAWL4AI_API_TOKEN,
  };

  const CRAWL4AI_URL = "https://fake-crawl4ai.test";
  const CRAWL4AI_TOKEN = "test-token";

  afterEach(() => {
    for (const [k, v] of Object.entries(original)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  function crawl4aiFixture(images: { src: string }[], text = "Contenu Crawl4AI détaillé pour le test. ".repeat(10)) {
    return {
      success: true,
      results: [
        {
          url: "irrelevant",
          success: true,
          metadata: { title: "Titre Crawl4AI" },
          markdown: { raw_markdown: text, fit_markdown: "" },
          media: { images: images.map((i) => ({ src: i.src, width: 400, score: 1 })) },
        },
      ],
    };
  }

  function urlOf(input: string | URL | Request): string {
    return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  }

  it("crawl4ai participates in the chain when jina/firecrawl are unavailable and crawl4ai is configured", async () => {
    process.env.EXTRACT_ORDER = "jina,firecrawl,crawl4ai,readability";
    delete process.env.JINA_API_KEY;
    delete process.env.FIRECRAWL_API_KEY;
    process.env.CRAWL4AI_API_URL = CRAWL4AI_URL;
    process.env.CRAWL4AI_API_TOKEN = CRAWL4AI_TOKEN;

    const { extract } = await import("@/lib/extract/index");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const u = urlOf(input);
      if (u === `${CRAWL4AI_URL}/crawl`) {
        return new Response(JSON.stringify(crawl4aiFixture([{ src: "https://x/photo.jpg" }])), { status: 200 });
      }
      throw new Error(`fetch inattendu vers ${u}`);
    }) as typeof fetch;

    try {
      const r = await extract("https://example.com/article");
      expect(r.via).toBe("crawl4ai");
      expect(r.text.length).toBeGreaterThan(100);
      expect(r.images).toEqual(["https://x/photo.jpg"]);
      expect(r.attempts).toEqual([
        { provider: "jina", ok: false, reason: "pas de clé Jina" },
        { provider: "firecrawl", ok: false, reason: "pas de clé Firecrawl" },
        { provider: "crawl4ai", ok: true },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("skips crawl4ai with a clear reason when it is in the order but unconfigured", async () => {
    process.env.EXTRACT_ORDER = "crawl4ai,readability";
    delete process.env.CRAWL4AI_API_URL;
    delete process.env.CRAWL4AI_API_TOKEN;

    const { extract } = await import("@/lib/extract/index");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const html = `<html><head><title>T</title></head><body><article><p>${"contenu de repli ".repeat(30)}</p></article></body></html>`;
      return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
    }) as typeof fetch;

    try {
      const r = await extract("https://example.com/article");
      expect(r.via).toBe("readability");
      expect(r.attempts[0]).toEqual({ provider: "crawl4ai", ok: false, reason: "pas de config Crawl4AI" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("feed mode: raw image backfill finds nothing, falls through to crawl4ai for images", async () => {
    process.env.EXTRACT_ORDER = "jina,readability";
    process.env.JINA_API_KEY = "jina-key";
    delete process.env.FIRECRAWL_API_KEY;
    process.env.CRAWL4AI_API_URL = CRAWL4AI_URL;
    process.env.CRAWL4AI_API_TOKEN = CRAWL4AI_TOKEN;

    const { extract } = await import("@/lib/extract/index");
    const pageUrl = "https://example.com/no-images-in-raw-html";
    let rawFetchCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const u = urlOf(input);
      if (u.startsWith("https://r.jina.ai/")) {
        return new Response("Contenu Jina sans images. ".repeat(30), { status: 200 });
      }
      if (u === pageUrl) {
        rawFetchCalls++;
        return new Response("<html><body><p>aucune image ici</p></body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      if (u === `${CRAWL4AI_URL}/crawl`) {
        return new Response(JSON.stringify(crawl4aiFixture([{ src: "https://x/from-crawl4ai.jpg" }])), { status: 200 });
      }
      throw new Error(`fetch inattendu vers ${u}`);
    }) as typeof fetch;

    try {
      const r = await extract(pageUrl);
      expect(r.via).toBe("jina");
      expect(rawFetchCalls).toBe(1); // raw backfill IS attempted first in feed mode
      expect(r.images).toEqual(["https://x/from-crawl4ai.jpg"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("externalOnly mode: never raw-fetches the page directly; crawl4ai still supplies images", async () => {
    process.env.EXTRACT_ORDER = "jina,firecrawl,crawl4ai,readability";
    process.env.JINA_API_KEY = "jina-key";
    delete process.env.FIRECRAWL_API_KEY;
    process.env.CRAWL4AI_API_URL = CRAWL4AI_URL;
    process.env.CRAWL4AI_API_TOKEN = CRAWL4AI_TOKEN;

    const { extract } = await import("@/lib/extract/index");
    const pageUrl = "https://untrusted.example.com/web-search-hit";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const u = urlOf(input);
      if (u.startsWith("https://r.jina.ai/")) {
        return new Response("Contenu Jina externe sans images. ".repeat(30), { status: 200 });
      }
      if (u === `${CRAWL4AI_URL}/crawl`) {
        return new Response(JSON.stringify(crawl4aiFixture([{ src: "https://x/external-crawl4ai.jpg" }])), { status: 200 });
      }
      // Any other fetch — in particular a direct fetch of `pageUrl` itself — is exactly the SSRF
      // surface externalOnly exists to avoid for untrusted web-search URLs.
      throw new Error(`fetch inattendu vers ${u} (surface SSRF potentielle)`);
    }) as typeof fetch;

    try {
      const r = await extract(pageUrl, { externalOnly: true });
      expect(r.via).toBe("jina");
      expect(r.images).toEqual(["https://x/external-crawl4ai.jpg"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("when crawl4ai is not configured, behavior is unchanged: no crawl4ai calls, externalOnly still makes no raw fetch", async () => {
    process.env.EXTRACT_ORDER = "jina,firecrawl,crawl4ai,readability";
    process.env.JINA_API_KEY = "jina-key";
    delete process.env.FIRECRAWL_API_KEY;
    delete process.env.CRAWL4AI_API_URL;
    delete process.env.CRAWL4AI_API_TOKEN;

    const { extract } = await import("@/lib/extract/index");
    const pageUrl = "https://untrusted.example.com/no-crawl4ai-configured";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const u = urlOf(input);
      if (u.startsWith("https://r.jina.ai/")) {
        return new Response("Contenu Jina, pas de Crawl4AI configuré. ".repeat(30), { status: 200 });
      }
      // No CRAWL4AI_API_URL/TOKEN set → crawl4ai must never be called, and externalOnly must
      // still skip the raw fetch of pageUrl. Any other fetch is a bug.
      throw new Error(`fetch inattendu vers ${u}`);
    }) as typeof fetch;

    try {
      const r = await extract(pageUrl, { externalOnly: true });
      expect(r.via).toBe("jina");
      expect(r.images).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("when crawl4ai wins the chain but returns 0 images, extract() does NOT re-crawl for image backfill (Finding 3)", async () => {
    process.env.EXTRACT_ORDER = "jina,firecrawl,crawl4ai,readability";
    delete process.env.JINA_API_KEY;
    delete process.env.FIRECRAWL_API_KEY;
    process.env.CRAWL4AI_API_URL = CRAWL4AI_URL;
    process.env.CRAWL4AI_API_TOKEN = CRAWL4AI_TOKEN;

    const { extract } = await import("@/lib/extract/index");
    let crawl4aiCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const u = urlOf(input);
      if (u === `${CRAWL4AI_URL}/crawl`) {
        crawl4aiCalls++;
        // Crawl4AI wins the chain (text ok) but comes back with 0 images.
        return new Response(JSON.stringify(crawl4aiFixture([])), { status: 200 });
      }
      throw new Error(`fetch inattendu vers ${u}`);
    }) as typeof fetch;

    try {
      const r = await extract("https://example.com/article");
      expect(r.via).toBe("crawl4ai");
      expect(r.images).toEqual([]);
      // Exactly one /crawl call: the winning extract() attempt. backfillCandidateImages must skip
      // the second crawl4aiImages() call it would otherwise make, since crawl4ai already ran and
      // already came back with 0 images for this same URL.
      expect(crawl4aiCalls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("hasExternalExtractor() is true when only crawl4ai is configured and in extractOrder", async () => {
    const { hasExternalExtractor } = await import("@/lib/extract/index");
    delete process.env.JINA_API_KEY;
    delete process.env.FIRECRAWL_API_KEY;
    process.env.CRAWL4AI_API_URL = CRAWL4AI_URL;
    process.env.CRAWL4AI_API_TOKEN = CRAWL4AI_TOKEN;

    process.env.EXTRACT_ORDER = "crawl4ai,readability";
    expect(hasExternalExtractor()).toBe(true);

    // Creds present but crawl4ai excluded from the order → not ready.
    process.env.EXTRACT_ORDER = "readability";
    expect(hasExternalExtractor()).toBe(false);
  });
});
