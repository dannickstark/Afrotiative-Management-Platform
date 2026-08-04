import { getPipelineConfig } from "@/lib/config/pipeline-config";
import { jinaEmbed } from "./jina";
import { mockEmbed } from "./mock";
export { mockEmbed } from "./mock";

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

export async function embed(text: string): Promise<{ vector: number[]; via: string }> {
  const cfg = getPipelineConfig();
  if (cfg.embed.apiKey) {
    try { return { vector: await jinaEmbed(text, cfg.embed), via: "jina" }; } catch {}
  }
  return { vector: mockEmbed(text, cfg.embed.dimensions), via: "mock" };
}
