import { JSDOM } from "jsdom";

export function extractImages(html: string, baseUrl: string): string[] {
  const doc = new JSDOM(html, { url: baseUrl }).window.document;
  const out = new Set<string>();
  const abs = (u: string | null | undefined) => {
    try {
      return u ? new URL(u, baseUrl).href : null;
    } catch {
      return null;
    }
  };

  const og = doc.querySelector('meta[property="og:image"]')?.getAttribute("content");
  const ogAbs = abs(og);
  if (ogAbs) out.add(ogAbs);

  doc.querySelectorAll("img").forEach((img) => {
    const w = parseInt(img.getAttribute("width") || "0", 10);
    const src = abs(img.getAttribute("src"));
    if (src && (w === 0 || w >= 200) && !/\.svg($|\?)/i.test(src)) out.add(src);
  });

  return [...out].slice(0, 8);
}
