import { describe, it, expect } from "bun:test";
import { parsePipelineConfig } from "@/lib/config/pipeline-config";

describe("parsePipelineConfig", () => {
  it("parses order lists and includes only providers with creds", () => {
    const c = parsePipelineConfig({
      LLM_ORDER: "openrouter,omniroute", EXTRACT_ORDER: "jina,firecrawl,readability",
      OPENROUTER_API_KEY: "k", OPENROUTER_MODEL: "openai/gpt-4o-mini",
      EMBED_BASE_URL: "https://api.jina.ai/v1", EMBED_API_KEY: "j", EMBED_MODEL: "jina-embeddings-v3", EMBED_DIMENSIONS: "1024",
    });
    expect(c.llmOrder).toEqual(["openrouter", "omniroute"]);
    expect(c.openrouter?.model).toBe("openai/gpt-4o-mini");
    expect(c.omniroute).toBeUndefined(); // no OMNIROUTE_* creds → not available
    expect(c.embed.dimensions).toBe(1024);
    expect(c.clusterThreshold).toBeCloseTo(0.83);
    expect(c.maxItemsPerRun).toBe(20);
  });
  it("defaults to safe values with an empty env (credential-free run)", () => {
    const c = parsePipelineConfig({});
    expect(c.extractOrder).toContain("readability");
    expect(c.openrouter).toBeUndefined();
  });
});
