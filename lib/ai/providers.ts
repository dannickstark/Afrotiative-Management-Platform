import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel } from "ai";
import type { PipelineConfig } from "@/lib/config/pipeline-config";

// Builds an OpenRouter LanguageModel for a specific API key, decoupled from cfg.openrouter.apiKey —
// lets callers (e.g. the token-pool rotation runner) swap in a pooled key per attempt while reusing
// cfg's baseUrl/model. Same construction as the "openrouter" case below, just with `apiKey` injected.
export function buildOpenRouterModel(cfg: PipelineConfig, apiKey: string): LanguageModel {
  // supportsStructuredOutputs: true switches the request from bare `response_format: json_object`
  // (which OpenAI-family backends reject unless the literal word "json" is in the prompt, and which
  // drops our schema entirely) to `json_schema` mode, which actually sends the schema to the model.
  return createOpenAICompatible({ name: "openrouter", baseURL: cfg.openrouter!.baseUrl!, apiKey, supportsStructuredOutputs: true })(cfg.openrouter!.model);
}

export function buildModel(name: string, cfg: PipelineConfig): LanguageModel | null {
  switch (name) {
    case "openrouter":
      if (!cfg.openrouter) return null;
      return buildOpenRouterModel(cfg, cfg.openrouter.apiKey);
    case "omniroute":
      if (!cfg.omniroute) return null;
      // OmniRoute defaults to SSE + may route to a reasoning model — generateObject is non-streaming, which forces this path.
      return createOpenAICompatible({ name: "omniroute", baseURL: cfg.omniroute.baseUrl!, apiKey: cfg.omniroute.apiKey, supportsStructuredOutputs: true })(cfg.omniroute.model);
    case "anthropic": return cfg.anthropic ? createAnthropic({ apiKey: cfg.anthropic.apiKey })(cfg.anthropic.model) : null;
    case "openai": return cfg.openai ? createOpenAI({ apiKey: cfg.openai.apiKey })(cfg.openai.model) : null;
    case "google": return cfg.google ? createGoogleGenerativeAI({ apiKey: cfg.google.apiKey })(cfg.google.model) : null;
    default: return null;
  }
}
