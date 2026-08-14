export type ProviderCreds = { apiKey: string; model: string; baseUrl?: string };
export type PipelineConfig = ReturnType<typeof parsePipelineConfig>;

function list(v: string | undefined, fallback: string[]): string[] {
  return v ? v.split(",").map((s) => s.trim()).filter(Boolean) : fallback;
}

export function parsePipelineConfig(env: Record<string, string | undefined>) {
  const num = (v: string | undefined, d: number) => (v && !Number.isNaN(+v) ? +v : d);
  return {
    llmOrder: list(env.LLM_ORDER, ["openrouter", "omniroute"]),
    extractOrder: list(env.EXTRACT_ORDER, ["jina", "firecrawl", "crawl4ai", "readability"]),
    searchOrder: list(env.SEARCH_ORDER, ["brave", "exa"]),
    openrouter: env.OPENROUTER_API_KEY ? { apiKey: env.OPENROUTER_API_KEY, model: env.OPENROUTER_MODEL || "openai/gpt-4o-mini", baseUrl: "https://openrouter.ai/api/v1" } : undefined,
    omniroute: env.OMNIROUTE_API_KEY && env.OMNIROUTE_BASE_URL ? { apiKey: env.OMNIROUTE_API_KEY, model: env.OMNIROUTE_MODEL || "auto/chat", baseUrl: env.OMNIROUTE_BASE_URL } : undefined,
    anthropic: env.ANTHROPIC_API_KEY ? { apiKey: env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_MODEL || "claude-3-5-haiku-latest" } : undefined,
    openai: env.OPENAI_API_KEY ? { apiKey: env.OPENAI_API_KEY, model: env.OPENAI_MODEL || "gpt-4o-mini" } : undefined,
    google: env.GOOGLE_GENERATIVE_AI_API_KEY ? { apiKey: env.GOOGLE_GENERATIVE_AI_API_KEY, model: env.GOOGLE_MODEL || "gemini-2.0-flash" } : undefined,
    jina: env.JINA_API_KEY ? { apiKey: env.JINA_API_KEY } : undefined,
    firecrawl: env.FIRECRAWL_API_KEY ? { apiKey: env.FIRECRAWL_API_KEY } : undefined,
    crawl4ai: env.CRAWL4AI_API_URL && env.CRAWL4AI_API_TOKEN ? { apiUrl: env.CRAWL4AI_API_URL, apiToken: env.CRAWL4AI_API_TOKEN } : undefined,
    embed: {
      baseUrl: env.EMBED_BASE_URL || "https://api.jina.ai/v1",
      apiKey: env.EMBED_API_KEY || env.JINA_API_KEY || "",
      model: env.EMBED_MODEL || "jina-embeddings-v3",
      dimensions: num(env.EMBED_DIMENSIONS, 1024),
    },
    // Minimum trimmed-text length (chars) a provider's result must clear to count as "strong"
    // content in the extract() chain (lib/extract/index.ts's isStrongContent). Below this, the
    // chain falls through to the next provider instead of returning immediately — real news
    // articles run into the thousands of characters, while JS-walled/bot-blocked stubs (e.g. a
    // "please enable JavaScript" page) are typically well under it.
    minContentChars: num(env.EXTRACT_MIN_CONTENT_CHARS, 500),
    clusterThreshold: num(env.CLUSTER_THRESHOLD, 0.83),
    maxItemsPerRun: num(env.MAX_ITEMS_PER_RUN, 20),
    windowHours: num(env.CLUSTER_WINDOW_HOURS, 72),
    triggerSecret: env.PIPELINE_TRIGGER_SECRET,
    // A "running" pipeline_runs row older than this is presumed abandoned by a hard process
    // kill (route maxDuration timeout, a deploy, OOM) that skipped runPipeline's try/finally —
    // reclaimStaleRuns() finalizes it to "failed" so the pipeline_runs_one_running unique index
    // doesn't block every future run forever. Default is well above the route's 5-minute cap.
    runStaleMinutes: num(env.RUN_STALE_MINUTES, 15),
  };
}

export function getPipelineConfig() { return parsePipelineConfig(process.env); }
