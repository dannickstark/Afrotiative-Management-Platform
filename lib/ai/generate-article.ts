import { generateObject } from "ai";
import { buildArticleSchema, type ArticleDraft } from "./schema";
import { buildModel, buildOpenRouterModel } from "./providers";
import { mockGenerateArticle } from "./mock";
import { getPipelineConfig } from "@/lib/config/pipeline-config";
import { getPipelineSettings } from "@/lib/queries/settings";
import { runWithOpenRouterPool } from "./with-token-pool";
import { plainTextLen } from "./plain-text";
import { truncateDetail } from "./detail";
import type { AiFailureReason } from "./failure-message";

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

// PURE — the article-draft "flaky" predicate used to decide whether an OpenRouter response is
// usable or should trigger rotation to the next pooled token (lib/ai/with-token-pool.ts). Exported
// so it's unit-testable without invoking the LLM or the pool (tests/openrouter-flaky-wiring.test.ts).
export function articleIsFlaky(bodyHtml: string, minChars: number): boolean {
  return plainTextLen(bodyHtml) < minChars;
}

export async function generateArticle(
  input: GenerateInput,
): Promise<{ draft: ArticleDraft; via: string; failure?: AiFailureReason; failureDetail?: string }> {
  const cfg = getPipelineConfig();
  const schema = buildArticleSchema(input.categories);

  // Dernière raison d'échec rencontrée en parcourant llmOrder — n'enregistre que les fournisseurs
  // RÉELLEMENT tentés (jamais "openrouter non configuré" ni "provider sans modèle") ; la boucle
  // étant courte et ordonnée par préférence, la DERNIÈRE raison mémorisée l'emporte (pas besoin
  // d'agrégation de priorité côté appelant, contrairement à with-token-pool.ts).
  let failure: AiFailureReason | undefined;
  let failureDetail: string | undefined;

  for (const name of cfg.llmOrder) {
    if (name === "openrouter") {
      // La clé d'environnement n'est PLUS le critère d'entrée dans cette branche. Un opérateur peut
      // n'avoir saisi que des jetons via Réglages → Jetons OpenRouter, sans jamais définir
      // OPENROUTER_API_KEY : l'ancien garde-fou `if (!cfg.openrouter) continue` sautait alors tout
      // OpenRouter et affichait « Aucun fournisseur IA configuré » alors que des jetons parfaitement
      // valides dormaient en base — exactement le bug que cette branche corrige. On interroge donc
      // TOUJOURS le pool (lib/ai/token-pool.ts), qui charge les jetons de la base et n'ajoute la clé
      // d'environnement que comme membre de secours ; buildOpenRouterModel sait construire un modèle
      // à partir d'un jeton du pool seul (lib/ai/providers.ts).
      const settings = await getPipelineSettings();
      const isFlaky = (draft: ArticleDraft) => articleIsFlaky(draft.bodyHtml, settings.openrouterMinContentChars);
      // Rotates across every pooled token (DB-managed + the env-configured key as a fallback member —
      // see lib/ai/token-pool.ts), letting a quota error or a flaky/too-short draft on one token fall
      // through to the next rather than failing this provider outright. The generateObject call is left
      // to THROW on error (never caught here) so runWithOpenRouterPool can classify + rotate on it.
      const r = await runWithOpenRouterPool(async (apiKey) => {
        const model = buildOpenRouterModel(cfg, apiKey);
        const { object } = await generateObject({
          model,
          schema,
          prompt: buildArticlePrompt(input),
          // Relaxes OpenAI-family strict json_schema validation (which rejects `format: "uri"`,
          // used by our nullable URL fields). Ignored by providers that don't recognize this key.
          providerOptions: { openaiCompatible: { strictJsonSchema: false } },
        });
        return object as ArticleDraft;
      }, isFlaky);
      if (r.ok) return { draft: sanitizeDraft(r.value, input.candidateImages), via: "openrouter" };
      // Pool VIDE alors qu'aucune clé d'environnement n'existe = installation réellement non
      // configurée (aucun jeton en base, aucune clé) : aucun jeton n'a été essayé, ce n'est donc pas
      // un échec à mémoriser. On ne touche pas à `failure`, si bien que le retour final reste
      // "unconfigured" et l'utilisateur lit toujours « Aucun fournisseur IA configuré ». À l'inverse,
      // si cfg.openrouter EST défini, un pool vide est une vraie anomalie (tous les jetons en
      // récupération, clé d'environnement absente du pool) et se mémorise telle quelle.
      if (r.reason === "empty_pool" && !cfg.openrouter) continue;
      // Pool exhausted (every token failed/flaky) — do NOT retry openrouter again, move to the next
      // configured provider in llmOrder, same as the non-openrouter branch falling through below.
      failure = r.reason;
      failureDetail = r.detail;
      continue;
    }

    const model = buildModel(name, cfg);
    if (!model) continue;
    let lastError: unknown;
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
        lastError = e;
        if (attempt === 1) break; // exhausted this provider's retries → next provider
      }
    }
    // Les 2 tentatives ont jeté — mémorise "error" et le message de la dernière exception, normalisé
    // par le helper partagé lib/ai/detail.ts (caviardage des clés puis troncature à 200 caractères,
    // exactement comme côté pool : jamais de fragment de jeton dans failureDetail).
    failure = "error";
    failureDetail = truncateDetail(lastError);
  }
  return {
    draft: sanitizeDraft(mockGenerateArticle(input), input.candidateImages),
    via: "mock",
    failure: failure ?? "unconfigured",
    failureDetail,
  };
}
