import { describe, it, expect } from "bun:test";
import { extractImages } from "@/lib/extract/images";

describe("extractImages", () => {
  it("collects og:image and reasonable inline imgs, absolutized", () => {
    const html = `<html><head><meta property="og:image" content="/hero.jpg"></head>
      <body><img src="https://cdn.x/a.png" width="800"><img src="/spacer.gif" width="1"></body></html>`;
    const imgs = extractImages(html, "https://example.com/article");
    expect(imgs).toContain("https://example.com/hero.jpg");
    expect(imgs).toContain("https://cdn.x/a.png");
    expect(imgs.some((u) => u.includes("spacer.gif"))).toBe(false); // 1px filtered
  });

  it("filters .svg images", () => {
    const html = `<html><body><img src="https://cdn.x/logo.svg" width="500"><img src="https://cdn.x/photo.jpg" width="500"></body></html>`;
    const imgs = extractImages(html, "https://example.com/article");
    expect(imgs.some((u) => u.includes("logo.svg"))).toBe(false);
    expect(imgs).toContain("https://cdn.x/photo.jpg");
  });

  it("caps output at 8 images", () => {
    const imgs = Array.from({ length: 12 }, (_, i) => `<img src="https://cdn.x/${i}.jpg" width="500">`).join("");
    const html = `<html><body>${imgs}</body></html>`;
    const result = extractImages(html, "https://example.com/article");
    expect(result.length).toBeLessThanOrEqual(8);
  });

  it("returns an empty array when there is nothing usable", () => {
    const html = `<html><head></head><body><img src="/spacer.gif" width="1"></body></html>`;
    const imgs = extractImages(html, "https://example.com/article");
    expect(imgs).toEqual([]);
  });
});
