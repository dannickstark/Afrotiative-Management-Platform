import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { crawl4aiExtract, crawl4aiImages } from "@/lib/extract/crawl4ai";

const FIXTURE = JSON.parse(
  readFileSync(".superpowers/sdd/plan-publish-and-images/crawl4ai-sample.json", "utf8"),
);
const CREDS = { apiUrl: "https://afrotiative-crawl4ai.up.railway.app", apiToken: "test-token" };
const URL = "https://en.wikipedia.org/wiki/Kwame_Nkrumah";

function mockFetch(status: number, body: unknown) {
  return (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

async function withFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

describe("crawl4aiExtract (network-free, mocked fetch)", () => {
  it("parses title/text from the fixture, falling back to raw_markdown (fit_markdown is empty)", async () => {
    const e = await withFetch(mockFetch(200, FIXTURE), () => crawl4aiExtract(URL, CREDS));
    expect(e.title).toBe("Kwame Nkrumah - Wikipedia");
    expect(e.via).toBe("crawl4ai");
    expect(e.text.length).toBeGreaterThan(100);
    expect(e.text).toContain("Jump to content");
  });

  it("puts og:image first, absolutizes protocol-relative srcs, drops .svg, accepts null width, dedupes, caps at 8", async () => {
    const e = await withFetch(mockFetch(200, FIXTURE), () => crawl4aiExtract(URL, CREDS));
    expect(e.images.length).toBeLessThanOrEqual(8);
    expect(e.images[0]).toBe(
      "https://upload.wikimedia.org/wikipedia/commons/5/5c/Kwame_Nkrumah_Portrait%2C_The_National_Archives_UK.jpg?utm_source=en.wikipedia.org&utm_campaign=index&utm_content=thumbnail_unscaled",
    );
    // protocol-relative → absolutized to https:
    for (const src of e.images) expect(src.startsWith("https://")).toBe(true);
    // no bare .svg (the fixture's *.svg.png thumbnails are legitimately kept — only a literal
    // .svg extension is filtered, mirroring lib/extract/images.ts's regex).
    expect(e.images.some((u) => /\.svg($|\?)/i.test(u))).toBe(false);
    // width:null on every fixture image candidate is accepted (unknown width, not rejected)
    expect(e.images).toContain(
      "https://upload.wikimedia.org/wikipedia/commons/thumb/5/5c/Kwame_Nkrumah_Portrait%2C_The_National_Archives_UK.jpg/250px-Kwame_Nkrumah_Portrait%2C_The_National_Archives_UK.jpg?utm_source=en.wikipedia.org&utm_campaign=parser&utm_content=thumbnail",
    );
    // deduped: no duplicate entries
    expect(new Set(e.images).size).toBe(e.images.length);
    // ordered by score desc after og:image: score-5 entries appear before score-4/3 entries
    const idx250 = e.images.findIndex((u) => u.includes("250px-Kwame_Nkrumah"));
    const idx120flag = e.images.findIndex((u) => u.includes("120px-Pan-Africanism"));
    expect(idx250).toBeGreaterThanOrEqual(0);
    if (idx120flag >= 0) expect(idx250).toBeLessThan(idx120flag);
  });

  it("throws a French message when the HTTP response is not ok", async () => {
    await expect(
      withFetch(mockFetch(500, {}), () => crawl4aiExtract(URL, CREDS)),
    ).rejects.toThrow("Crawl4AI a répondu 500");
  });

  it("throws when results[] is missing or unsuccessful", async () => {
    await expect(
      withFetch(mockFetch(200, { success: true, results: [] }), () => crawl4aiExtract(URL, CREDS)),
    ).rejects.toThrow("Crawl4AI: aucun résultat");
    await expect(
      withFetch(
        mockFetch(200, { success: true, results: [{ url: URL, success: false }] }),
        () => crawl4aiExtract(URL, CREDS),
      ),
    ).rejects.toThrow("Crawl4AI: aucun résultat");
  });

  it("throws 'contenu trop court' when the markdown is under 100 chars", async () => {
    const shortFixture = {
      success: true,
      results: [
        {
          url: URL,
          success: true,
          metadata: { title: "T" },
          markdown: { raw_markdown: "trop court", fit_markdown: "" },
          media: { images: [] },
        },
      ],
    };
    await expect(
      withFetch(mockFetch(200, shortFixture), () => crawl4aiExtract(URL, CREDS)),
    ).rejects.toThrow("Crawl4AI: contenu trop court");
  });
});

describe("crawl4aiImages (never throws)", () => {
  it("returns the parsed image list on success", async () => {
    const imgs = await withFetch(mockFetch(200, FIXTURE), () => crawl4aiImages(URL, CREDS));
    expect(imgs.length).toBeGreaterThan(0);
  });

  it("returns [] when fetch rejects", async () => {
    const rejecting = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const imgs = await withFetch(rejecting, () => crawl4aiImages(URL, CREDS));
    expect(imgs).toEqual([]);
  });

  it("returns [] when the response is not ok", async () => {
    const imgs = await withFetch(mockFetch(503, {}), () => crawl4aiImages(URL, CREDS));
    expect(imgs).toEqual([]);
  });
});
