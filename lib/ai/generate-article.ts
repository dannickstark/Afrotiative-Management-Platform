import { generateObject } from "ai";
import { buildArticleSchema, type ArticleDraft } from "./schema";
import { buildModel } from "./providers";
import { mockGenerateArticle } from "./mock";
import { getPipelineConfig } from "@/lib/config/pipeline-config";

export type GenerateInput = { sources: { mediaName: string; url: string; text: string }[]; candidateImages: string[]; categories: string[] };

// Exported (not just used internally) so it can be unit-tested (tests/ai-prompt.test.ts) without
// invoking the LLM: asserts the built string carries the subheading + cross-check instructions
// below (SP4 Task 3) rather than exercising them only indirectly through a mocked provider call.
export function buildArticlePrompt(input: GenerateInput): string {
  const cats = input.categories.join(", ");
  const imgs = input.candidateImages.length ? input.candidateImages.join(", ") : "(aucune)";
  const srcs = input.sources.map((s, i) => `Source ${i + 1} — ${s.mediaName} (${s.url}):\n${s.text.slice(0, 6000)}`).join("\n\n");
  return [
    "Tu es journaliste économique pour Afrotiative, média panafricain business & finance francophone.",
    "À partir des sources ci-dessous couvrant le même sujet, rédige UN article original en français, ton professionnel, factuel, sourcé.",
    "Structure le corps de l'article (bodyHtml) avec des sous-titres HTML <h2> et/ou <h3> pertinents et informatifs : prévois une nouvelle section, donc un nouveau sous-titre, toutes les 2 à 3 paragraphes. Évite les titres génériques (\"Introduction\", \"Conclusion\") : chaque sous-titre doit annoncer le contenu précis de sa section.",
    "Croise et exploite TOUTES les sources fournies ci-dessous, pas seulement la première : rapproche leurs informations, relève les convergences et, le cas échéant, les divergences, et attribue chaque affirmation importante à sa source (ex: \"selon Ecofin\", \"d'après Jeune Afrique\").",
    "N'ajoute JAMAIS toi-même une section \"Sources\" ou \"Références\" à la fin de l'article : une liste de sources est ajoutée automatiquement après le corps du texte, donc bodyHtml ne doit contenir que le texte de l'article (avec ses sous-titres), jamais une liste de liens ou de sources.",
    `Choisis la catégorie STRICTEMENT dans cette liste: ${cats}. Si aucune ne convient, choisis la plus proche et mets confidence.categoryUncertain=true.`,
    "Propose des tags courts.",
    `Images candidates disponibles (choisis featuredImageUrl STRICTEMENT dans cette liste, jamais une URL de source; si aucune ne convient ou la liste est vide, featuredImageUrl=null et confidence.imageMissing=true, et renseigne imageCredit uniquement si une image est choisie): ${imgs}`,
    "Réponds uniquement via le schéma structuré demandé.",
    "\n" + srcs,
  ].join("\n");
}

// Post-generation guard applied UNIFORMLY (real provider result AND mock): a featuredImageUrl
// that is not one of the supplied candidateImages is forced to null (Zod's `.url()` cannot catch
// this — it only validates URL syntax), along with its dependent image fields. The schema's image
// fields are `.nullish()` (providers often omit them outright), so the `?? null` coercions below
// also collapse `undefined` to `null` — the persisted/returned draft never carries `undefined` on
// these fields, keeping the DB insert in stages.ts clean.
function sanitizeDraft(draft: ArticleDraft, candidateImages: string[]): ArticleDraft {
  const img = draft.featuredImageUrl && candidateImages.includes(draft.featuredImageUrl) ? draft.featuredImageUrl : null;
  return {
    ...draft,
    featuredImageUrl: img,
    imageCredit: img ? (draft.imageCredit ?? null) : null,
    imageSourceUrl: img ? (draft.imageSourceUrl ?? null) : null,
    confidence: { ...draft.confidence, imageMissing: img ? draft.confidence.imageMissing : true },
  };
}

export async function generateArticle(input: GenerateInput): Promise<{ draft: ArticleDraft; via: string }> {
  const cfg = getPipelineConfig();
  const schema = buildArticleSchema(input.categories);
  for (const name of cfg.llmOrder) {
    const model = buildModel(name, cfg);
    if (!model) continue;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { object } = await generateObject({
          model,
          schema,
          prompt: buildArticlePrompt(input),
          // Relaxes OpenAI-family strict json_schema validation (which rejects `format: "uri"`,
          // used by our nullable URL fields). Ignored by providers that don't recognize this key.
          providerOptions: { openaiCompatible: { strictJsonSchema: false } },
        });
        return { draft: sanitizeDraft(object as ArticleDraft, input.candidateImages), via: name };
      } catch (e) {
        console.warn(`[pipeline] LLM provider ${name} a échoué: ${(e as Error).message}`);
        if (attempt === 1) break; // exhausted this provider's retries → next provider
      }
    }
  }
  return { draft: sanitizeDraft(mockGenerateArticle(input), input.candidateImages), via: "mock" };
}
