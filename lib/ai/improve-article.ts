import { generateText } from "ai";
import { buildModel } from "./providers";
import { getPipelineConfig } from "@/lib/config/pipeline-config";

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
export async function improveArticleBody(input: ImproveInput): Promise<{ bodyHtml: string; via: string }> {
  const cfg = getPipelineConfig();
  for (const name of cfg.llmOrder) {
    const model = buildModel(name, cfg);
    if (!model) continue;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { text } = await generateText({ model, prompt: buildImprovePrompt(input) });
        const body = text.trim();
        if (body.length > 0) return { bodyHtml: body, via: name };
        break; // empty output → next provider
      } catch (e) {
        console.warn(`[improve] fournisseur ${name} a échoué: ${(e as Error).message}`);
        if (attempt === 1) break;
      }
    }
  }
  return { bodyHtml: input.bodyHtml, via: "mock" };
}
