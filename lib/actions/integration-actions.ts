"use server";
import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";

export type IntegrationTestResult = { ok: boolean; detail: string };

// Admin-only, FREE connectivity checks — never a token-spending LLM completion. WordPress hits
// /users/me (free), OmniRoute/OpenRouter hit /models with the bearer key (also free — listing
// models never bills), and Jina/Firecrawl just report whether a key is present (no network call
// needed to stay "free"; a lightweight reachability HEAD could be added later but must stay free).
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

    if (name === "jina") return { ok: !!cfg.jina, detail: cfg.jina ? "Clé Jina présente." : "Non configuré." };
    if (name === "firecrawl") return { ok: !!cfg.firecrawl, detail: cfg.firecrawl ? "Clé Firecrawl présente." : "Non configuré." };

    return { ok: false, detail: "Intégration inconnue." };
  } catch (e) {
    return { ok: false, detail: `Échec : ${(e as Error).message}` };
  }
}
