import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import DOMPurify from "isomorphic-dompurify";
import { extractImages } from "./images";
import type { Extracted } from "./index";

export function readabilityFromHtml(html: string, url: string): Extracted {
  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document);
  const parsed = reader.parse();
  const clean = parsed?.content ? DOMPurify.sanitize(parsed.content) : "";
  const text = (parsed?.textContent ?? "").trim();
  // Readability can fail to find an <article> on some layouts; fall back to a broad
  // main-content selector so we still return something useful rather than empty text.
  const fallback =
    text.length < 100
      ? (dom.window.document.querySelector("article,main,[role=main]")?.textContent ?? "").trim()
      : text;
  return {
    title: parsed?.title ?? "",
    text: (fallback || clean).slice(0, 20000),
    images: extractImages(html, url),
    via: "readability",
  };
}

export async function readabilityExtract(url: string): Promise<Extracted> {
  const res = await fetch(url, { headers: { "user-agent": "AfrotiativeBot/1.0" } });
  const html = await res.text();
  return readabilityFromHtml(html, url);
}
