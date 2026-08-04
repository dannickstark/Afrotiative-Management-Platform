import { generateObject } from "ai";
import { buildArticleSchema, type ArticleDraft } from "./schema";
import { buildModel } from "./providers";
import { mockGenerateArticle } from "./mock";
import { getPipelineConfig } from "@/lib/config/pipeline-config";

export type GenerateInput = { sources: { mediaName: string; url: string; text: string }[]; candidateImages: string[]; categories: string[] };

function prompt(input: GenerateInput): string {
  const cats = input.categories.join(", ");
  const srcs = input.sources.map((s, i) => `Source ${i + 1} — ${s.mediaName} (${s.url}):\n${s.text.slice(0, 6000)}`).join("\n\n");
  return [
    "Tu es journaliste économique pour Afrotiative, média panafricain business & finance francophone.",
    "À partir des sources ci-dessous couvrant le même sujet, rédige UN article original en français, ton professionnel, factuel, sourcé.",
    `Choisis la catégorie STRICTEMENT dans cette liste: ${cats}. Si aucune ne convient, choisis la plus proche et mets confidence.categoryUncertain=true.`,
    "Propose des tags courts. Si une image candidate convient, choisis featuredImageUrl parmi les sources et renseigne imageCredit; sinon featuredImageUrl=null et confidence.imageMissing=true.",
    "Réponds uniquement via le schéma structuré demandé.",
    "\n" + srcs,
  ].join("\n");
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
          prompt: prompt(input),
          // Relaxes OpenAI-family strict json_schema validation (which rejects `format: "uri"`,
          // used by our nullable URL fields). Ignored by providers that don't recognize this key.
          providerOptions: { openaiCompatible: { strictJsonSchema: false } },
        });
        return { draft: object as ArticleDraft, via: name };
      } catch (e) {
        if (attempt === 1) break; // exhausted this provider's retries → next provider
      }
    }
  }
  return { draft: mockGenerateArticle(input), via: "mock" };
}
