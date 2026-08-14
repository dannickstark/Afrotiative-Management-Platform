"use server";
import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";

export type IntegrationTestResult = { ok: boolean; detail: string };

// Admin-only, FREE connectivity checks — never a token-spending LLM completion. WordPress hits
// /users/me (free), OmniRoute/OpenRouter hit /models with the bearer key (also free — listing
// models never bills). Every other provider (anthropic/openai/google/jina/firecrawl/brave/exa/
// embeddings/r2/resend) just reports whether its key/config is present — Task 8 deliberately
// prefers presence over a real probe for the three extra LLM providers too: none of them expose a
// bare free "list models"-style endpoint the way OpenRouter/OmniRoute do (Anthropic/OpenAI/Google
// don't reliably offer one without risking a billable call or extra per-provider SDK plumbing), so
// presence-only keeps every check here free and simple, matching the existing jina/firecrawl
// contract this file already documents.
export async function testIntegration(name: string): Promise<IntegrationTestResult> {
  const u = await requireUser();
  requirePermission(u.role, "pipeline", "configure");

  const { getPipelineConfig } = await import("@/lib/config/pipeline-config");
  const cfg = getPipelineConfig();

  try {
    if (name === "wordpress") {
      const { getWpConfig } = await import("@/lib/wp/config");
      const wc = getWpConfig();
      if (!wc) return { ok: false, detail: "Non configuré." };
      const { WordPressClient } = await import("@/lib/wp/client");
      const ok = await new WordPressClient(wc).testConnection();
      return { ok, detail: ok ? "Connexion WordPress vérifiée." : "Échec de l'authentification WordPress." };
    }

    if (name === "omniroute" || name === "openrouter") {
      const p = name === "omniroute" ? cfg.omniroute : cfg.openrouter;
      if (!p) return { ok: false, detail: "Non configuré." };
      // FREE — /models lists available models, never a token-spending completion.
      const res = await fetch(`${p.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${p.apiKey}` },
        signal: AbortSignal.timeout(15000),
      });
      return { ok: res.ok, detail: res.ok ? "Clé valide (/models)." : `HTTP ${res.status}` };
    }

    if (name === "anthropic") return { ok: !!cfg.anthropic, detail: cfg.anthropic ? "Clé Anthropic présente." : "Non configuré." };
    if (name === "openai") return { ok: !!cfg.openai, detail: cfg.openai ? "Clé OpenAI présente." : "Non configuré." };
    if (name === "google") return { ok: !!cfg.google, detail: cfg.google ? "Clé Google présente." : "Non configuré." };
    if (name === "jina") return { ok: !!cfg.jina, detail: cfg.jina ? "Clé Jina présente." : "Non configuré." };
    if (name === "firecrawl") return { ok: !!cfg.firecrawl, detail: cfg.firecrawl ? "Clé Firecrawl présente." : "Non configuré." };
    if (name === "brave") { const ok = !!process.env.BRAVE_SEARCH_API_KEY; return { ok, detail: ok ? "Clé Brave présente." : "Non configuré." }; }
    if (name === "exa") { const ok = !!process.env.EXA_API_KEY; return { ok, detail: ok ? "Clé Exa présente." : "Non configuré." }; }
    if (name === "embeddings") { const ok = !!cfg.embed?.apiKey; return { ok, detail: ok ? "Clé d'embeddings présente." : "Non configuré." }; }
    if (name === "resend") { const ok = !!process.env.RESEND_API_KEY; return { ok, detail: ok ? "Clé Resend présente." : "Non configuré." }; }
    if (name === "r2") {
      const { getStudioConfig } = await import("@/lib/studio/config");
      const ok = !!getStudioConfig();
      return { ok, detail: ok ? "Configuration R2 présente." : "Non configuré." };
    }

    return { ok: false, detail: "Intégration inconnue." };
  } catch (e) {
    return { ok: false, detail: `Échec : ${(e as Error).message}` };
  }
}
