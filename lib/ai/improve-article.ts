import { generateText } from "ai";
import { buildModel, buildOpenRouterModel } from "./providers";
import { getPipelineConfig } from "@/lib/config/pipeline-config";
import { runWithOpenRouterPool } from "./with-token-pool";
import { truncateDetail } from "./detail";
import type { AiFailureReason } from "./failure-message";

export type ImproveInput = { title: string; bodyHtml: string; instruction?: string };

// Exported for unit testing (like buildArticlePrompt in generate-article.ts).
export function buildImprovePrompt(input: ImproveInput): string {
  const lines = [
    "Tu es rédacteur en chef pour Afrotiative, média économique panafricain francophone.",
    "Améliore le CORPS HTML de l'article ci-dessous : clarté, style, structure (sous-titres <h2>/<h3> pertinents).",
    "IMPÉRATIF : conserve TOUS les faits, chiffres, noms et citations — n'invente rien, n'ajoute aucune source ni section « Sources ».",
    "Réponds UNIQUEMENT avec le HTML du corps amélioré : pas de préambule, pas de balises <html>/<body>, pas de bloc de code Markdown.",
  ];
  if (input.instruction?.trim()) lines.push(`Consigne supplémentaire de l'éditeur : ${input.instruction.trim()}`);
  lines.push(`\nTitre : ${input.title}\n\nCorps actuel :\n${input.bodyHtml}`);
  return lines.join("\n");
}

// Mirrors generateArticle's provider loop. Returns via:"mock" with the body UNCHANGED when no
// provider is configured or all fail — the caller (improveWithAi) refuses to persist a mock result.
// Flaky here mirrors the OLD "empty output → next provider" check (line below): an empty/blank
// body is not usable, so it should trigger rotation to the next pooled OpenRouter token rather
// than being accepted as-is.
const isFlaky = (text: string): boolean => text.trim().length === 0;

export async function improveArticleBody(
  input: ImproveInput,
): Promise<{ bodyHtml: string; via: string; failure?: AiFailureReason; failureDetail?: string }> {
  const cfg = getPipelineConfig();

  // Même logique de mémorisation que generateArticle (lib/ai/generate-article.ts) : seuls les
  // fournisseurs RÉELLEMENT tentés (pool interrogé, ou modèle construit) mettent à jour ces
  // variables ; la dernière raison rencontrée l'emporte.
  let failure: AiFailureReason | undefined;
  let failureDetail: string | undefined;

  for (const name of cfg.llmOrder) {
    if (name === "openrouter") {
      // Même raisonnement que generate-article.ts : la clé d'environnement n'est plus le critère
      // d'entrée. Des jetons saisis dans Réglages → Jetons OpenRouter suffisent, donc on interroge
      // TOUJOURS le pool (il charge la base et n'ajoute OPENROUTER_API_KEY qu'en secours) plutôt que
      // de sauter OpenRouter dès que l'environnement est nu.
      const r = await runWithOpenRouterPool(async (apiKey) => {
        const model = buildOpenRouterModel(cfg, apiKey);
        const { text } = await generateText({ model, prompt: buildImprovePrompt(input) });
        return text.trim();
      }, isFlaky);
      if (r.ok) return { bodyHtml: r.value, via: "openrouter" };
      // Pool vide ET aucune clé d'environnement = rien n'est configuré, aucun jeton n'a été essayé :
      // on ne mémorise aucune raison pour que le message final reste « Aucun fournisseur IA
      // configuré ». Avec cfg.openrouter défini, `empty_pool` est en revanche une vraie anomalie.
      if (r.reason === "empty_pool" && !cfg.openrouter) continue;
      failure = r.reason;
      failureDetail = r.detail;
      continue;
    }

    const model = buildModel(name, cfg);
    if (!model) continue;
    let lastError: unknown;
    let sawEmptyOutput = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { text } = await generateText({ model, prompt: buildImprovePrompt(input) });
        const body = text.trim();
        if (body.length > 0) return { bodyHtml: body, via: name };
        sawEmptyOutput = true;
        break; // empty output → next provider
      } catch (e) {
        console.warn(`[improve] fournisseur ${name} a échoué: ${(e as Error).message}`);
        lastError = e;
        if (attempt === 1) break;
      }
    }
    // Sortie vide → "flaky" (même sens que la prédicat isFlaky ci-dessus, côté pool) ; les 2
    // tentatives qui jettent → "error" + message de la dernière exception normalisé par le helper
    // partagé lib/ai/detail.ts (clés caviardées, troncature à 200 caractères).
    if (sawEmptyOutput) {
      failure = "flaky";
      failureDetail = undefined;
    } else {
      failure = "error";
      failureDetail = truncateDetail(lastError);
    }
  }
  return { bodyHtml: input.bodyHtml, via: "mock", failure: failure ?? "unconfigured", failureDetail };
}
