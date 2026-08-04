import type { Extracted } from "./index";

export async function jinaExtract(url: string, apiKey: string): Promise<Extracted> {
  const res = await fetch(`https://r.jina.ai/${url}`, {
    headers: { Authorization: `Bearer ${apiKey}`, "X-Return-Format": "markdown" },
  });
  if (!res.ok) throw new Error(`Jina Reader ${res.status}`);
  const md = await res.text();
  if (md.trim().length < 100) throw new Error("Jina Reader: contenu trop court");
  // Jina Reader returns clean markdown but no image list; the chain backfills
  // candidate images from a raw fetch of the page when this comes back empty.
  return { title: "", text: md.slice(0, 20000), images: [], via: "jina" };
}
