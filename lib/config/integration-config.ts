// lib/config/integration-config.ts — Task 8: the full integrations registry (5 → 13, everything
// wired into lib/config/pipeline-config.ts's provider creds plus the search/storage/email
// singletons, minus crawl4ai which isn't wired into config on this branch).
//
// Split out of lib/queries/settings.ts specifically so the cfg→"configured" mapping is a PURE
// function — no DB, no process.env read of its own — and therefore independently unit-testable
// (tests/integration-status.test.ts) without touching the shared dev DB. getIntegrationStatus()
// is the only real caller: it resolves the live PipelineConfig + the extra env-backed signals
// (search provider keys, wordpress/r2 presence) and passes them in here.
import type { PipelineConfig } from "./pipeline-config";

export type IntegrationName =
  | "openrouter" | "omniroute" | "anthropic" | "openai" | "google"
  | "jina" | "firecrawl" | "brave" | "exa" | "embeddings" | "r2" | "resend" | "wordpress";

export type IntegrationKind = "llm" | "extract" | "search" | "embeddings" | "storage" | "email" | "cms";

// "tokens" = managed via the OpenRouter token pool UI (Task 7/9 — components/settings/
// openrouter-tokens-panel.tsx), everything else is a plain env-secret ("env") the admin sets
// outside the app; its card shows status + a "défini via l'environnement" label + Tester, no form.
export type IntegrationManagement = "tokens" | "env";

export const INTEGRATION_META: Record<IntegrationName, { kind: IntegrationKind; management: IntegrationManagement }> = {
  openrouter: { kind: "llm", management: "tokens" },
  omniroute: { kind: "llm", management: "env" },
  anthropic: { kind: "llm", management: "env" },
  openai: { kind: "llm", management: "env" },
  google: { kind: "llm", management: "env" },
  jina: { kind: "extract", management: "env" },
  firecrawl: { kind: "extract", management: "env" },
  brave: { kind: "search", management: "env" },
  exa: { kind: "search", management: "env" },
  embeddings: { kind: "embeddings", management: "env" },
  r2: { kind: "storage", management: "env" },
  resend: { kind: "email", management: "env" },
  wordpress: { kind: "cms", management: "env" },
};

// Signals getIntegrationStatus() must resolve OUTSIDE PipelineConfig: the search-provider env keys
// (lib/search/index.ts reads BRAVE_SEARCH_API_KEY/EXA_API_KEY directly, they're never parsed into
// PipelineConfig), and wordpress/r2 presence (their own multi-var config getters — getWpConfig(),
// getStudioConfig() — each with their own trimming/validation, not a single env var to read here).
// Passed in explicitly rather than this function reading process.env or calling those getters
// itself, so it stays pure and deterministically testable with a fake cfg + fake extras.
export type ExtraIntegrationSignals = {
  braveApiKey: string | undefined;
  exaApiKey: string | undefined;
  resendApiKey: string | undefined;
  wordpressConfigured: boolean;
  r2Configured: boolean;
};

// PURE — maps a PipelineConfig + the extra signals above to a `configured` boolean per
// integration. No I/O of its own; see tests/integration-status.test.ts for the unit coverage.
export function computeIntegrationConfigured(
  cfg: PipelineConfig,
  extra: ExtraIntegrationSignals,
): Record<IntegrationName, boolean> {
  return {
    openrouter: !!cfg.openrouter,
    omniroute: !!cfg.omniroute,
    anthropic: !!cfg.anthropic,
    openai: !!cfg.openai,
    google: !!cfg.google,
    jina: !!cfg.jina,
    firecrawl: !!cfg.firecrawl,
    brave: !!extra.braveApiKey,
    exa: !!extra.exaApiKey,
    embeddings: !!cfg.embed?.apiKey,
    r2: extra.r2Configured,
    resend: !!extra.resendApiKey,
    wordpress: extra.wordpressConfigured,
  };
}
