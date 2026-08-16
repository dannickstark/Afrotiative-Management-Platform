import { generateObject } from "ai";
import { buildArticleSchema, ALL_DRAFT_FIELDS, type ArticleDraft, type PartialArticleDraft, type DraftFields } from "./schema";
import { buildModel, buildOpenRouterModel } from "./providers";
import { mockGenerateArticle } from "./mock";
import { getPipelineConfig } from "@/lib/config/pipeline-config";
import { getPipelineSettings } from "@/lib/queries/settings";
import { runWithOpenRouterPool } from "./with-token-pool";
import { plainTextLen } from "./plain-text";
import { truncateDetail } from "./detail";
import type { AiFailureReason } from "./failure-message";

export type GenerateInput = {
  sources: { mediaName: string; url: string; text: string }[];
  candidateImages: string[];
  categories: string[];
  // Régénération PARTIELLE (dialogue « Renvoyer à l'IA », cases décochées). Absent = ingestion :
  // tout est demandé, prompt et schéma d'origine inchangés.
  fields?: DraftFields;
  // L'article TEL QU'IL EXISTE, fourni uniquement quand `fields.body` est faux : le modèle ne
  // réécrit pas le corps, il produit des champs cohérents AVEC lui. Sans cette référence, un titre
  // régénéré à partir des seules sources dériverait du corps conservé.
  current?: { title: string; bodyHtml: string };
};

// Texte de source injecté dans le prompt. Deux régimes, parce que les sources n'y jouent pas le
// même rôle : quand on rédige le corps elles SONT la matière première (6000 car.) ; quand le corps
// existe déjà elles ne servent que de contexte d'appoint pour un titre/des tags/une catégorie, et
// les envoyer en entier est le plus gros gaspillage de tokens du chemin partiel (1500 car.).
const SOURCE_CHARS_WRITING = 6000;
const SOURCE_CHARS_CONTEXT = 1500;

function joinSources(input: GenerateInput, chars: number): string {
  return input.sources.map((s, i) => `Source ${i + 1} — ${s.mediaName} (${s.url}):\n${s.text.slice(0, chars)}`).join("\n\n");
}

function imagesLine(input: GenerateInput): string {
  const imgs = input.candidateImages.length ? input.candidateImages.join(", ") : "(aucune)";
  return `Images candidates disponibles (choisis featuredImageUrl STRICTEMENT dans cette liste, jamais une URL de source; si aucune ne convient ou la liste est vide, featuredImageUrl=null et confidence.imageMissing=true, et renseigne imageCredit uniquement si une image est choisie): ${imgs}`;
}

// Prompt de régénération PARTIELLE sans réécriture : le corps existe déjà et n'est ni renvoyé ni
// modifié. On ne garde donc que les consignes des champs cochés, on donne l'article actuel comme
// référence de cohérence, et les sources ne sont plus qu'un contexte tronqué.
// L'article actuel n'est PAS envoyé pour une sélection « image seule » : choisir une illustration
// parmi les candidates ne demande pas de lire le corps, et c'est le chemin le moins cher du lot.
function buildPartialPrompt(input: GenerateInput, fields: DraftFields): string {
  const needsArticleContext = fields.title || fields.excerpt || fields.category || fields.tags;
  const lines = [
    "Tu es journaliste économique pour Afrotiative, média panafricain business & finance francophone.",
    "L'article ci-dessous est DÉJÀ rédigé : son corps ne doit être ni réécrit, ni renvoyé, ni modifié.",
    "Produis UNIQUEMENT les champs demandés ci-dessous, strictement cohérents avec cet article et sans rien inventer.",
  ];
  if (fields.title) lines.push("Propose un titre en français, informatif et factuel, fidèle au contenu de l'article.");
  if (fields.excerpt) lines.push("Rédige un extrait (chapô) court résumant l'article.");
  if (fields.category) lines.push(`Choisis la catégorie STRICTEMENT dans cette liste: ${input.categories.join(", ")}. Si aucune ne convient, choisis la plus proche et mets confidence.categoryUncertain=true.`);
  if (fields.tags) lines.push("Propose des tags courts.");
  if (fields.image) lines.push(imagesLine(input));
  lines.push("Réponds uniquement via le schéma structuré demandé.");
  if (needsArticleContext && input.current) {
    lines.push(`\nTitre actuel : ${input.current.title}\n\nCorps actuel (référence, à NE PAS renvoyer) :\n${input.current.bodyHtml}`);
  }
  if (input.sources.length) lines.push(`\nSources d'origine (contexte) :\n${joinSources(input, SOURCE_CHARS_CONTEXT)}`);
  return lines.join("\n");
}

// Exported (not just used internally) so it can be unit-tested (tests/ai-prompt.test.ts) without
// invoking the LLM: asserts the built string carries the subheading + cross-check instructions
// below (SP4 Task 3) rather than exercising them only indirectly through a mocked provider call.
export function buildArticlePrompt(input: GenerateInput): string {
  const fields = input.fields ?? ALL_DRAFT_FIELDS;
  // Corps décoché ⇒ aucune rédaction à demander. Corps coché ⇒ prompt d'origine, mot pour mot :
  // les autres champs ne pèsent presque rien face au corps, les retirer ne gagnerait rien.
  if (!fields.body) return buildPartialPrompt(input, fields);
  const cats = input.categories.join(", ");
  const srcs = joinSources(input, SOURCE_CHARS_WRITING);
  return [
    "Tu es journaliste économique pour Afrotiative, média panafricain business & finance francophone.",
    "À partir des sources ci-dessous couvrant le même sujet, rédige UN article original en français, ton professionnel, factuel, sourcé.",
    "Structure le corps de l'article (bodyHtml) avec des sous-titres HTML <h2> et/ou <h3> pertinents et informatifs : prévois une nouvelle section, donc un nouveau sous-titre, toutes les 2 à 3 paragraphes. Évite les titres génériques (\"Introduction\", \"Conclusion\") : chaque sous-titre doit annoncer le contenu précis de sa section.",
    "Croise et exploite TOUTES les sources fournies ci-dessous, pas seulement la première : rapproche leurs informations, relève les convergences et, le cas échéant, les divergences, et attribue chaque affirmation importante à sa source (ex: \"selon Ecofin\", \"d'après Jeune Afrique\").",
    "N'ajoute JAMAIS toi-même une section \"Sources\" ou \"Références\" à la fin de l'article : une liste de sources est ajoutée automatiquement après le corps du texte, donc bodyHtml ne doit contenir que le texte de l'article (avec ses sous-titres), jamais une liste de liens ou de sources.",
    `Choisis la catégorie STRICTEMENT dans cette liste: ${cats}. Si aucune ne convient, choisis la plus proche et mets confidence.categoryUncertain=true.`,
    "Propose des tags courts.",
    imagesLine(input),
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
// `fields.image` faux ⇒ AUCUNE normalisation d'image : les champs image ne sont pas demandés, ils
// sont complétés depuis l'article existant par completeDraft ci-dessous, et les forcer à null ici
// écraserait la valeur conservée par un `null` trompeur (applyRegeneration ne les lit pas dans ce
// cas, mais un brouillon qui se contredit lui-même est un piège pour le prochain lecteur).
function sanitizeDraft<T extends PartialArticleDraft>(draft: T, candidateImages: string[], fields: DraftFields): T {
  if (!fields.image) return draft;
  const img = draft.featuredImageUrl && candidateImages.includes(draft.featuredImageUrl) ? draft.featuredImageUrl : null;
  return {
    ...draft,
    featuredImageUrl: img,
    imageCredit: img ? (draft.imageCredit ?? null) : null,
    imageSourceUrl: img ? (draft.imageSourceUrl ?? null) : null,
    confidence: { ...draft.confidence, imageMissing: img ? draft.confidence.imageMissing : true },
  };
}

// Complète un brouillon PARTIEL en brouillon complet, pour que le type public de generateArticle
// (et donc stages.ts, regenerate.ts, mock.ts) ne change pas. Les champs non demandés reprennent la
// valeur actuelle de l'article : applyRegeneration ne les lira pas (selectRegenerationColumns ne
// retient que les champs cochés), mais un brouillon qui reflète l'article réel ne peut pas induire
// en erreur si un futur appelant s'en sert.
function completeDraft(partial: PartialArticleDraft, input: GenerateInput): ArticleDraft {
  return {
    title: partial.title ?? input.current?.title ?? "",
    bodyHtml: partial.bodyHtml ?? input.current?.bodyHtml ?? "",
    excerpt: partial.excerpt ?? "",
    category: partial.category ?? "",
    tags: partial.tags ?? [],
    featuredImageUrl: partial.featuredImageUrl ?? null,
    imageCredit: partial.imageCredit ?? null,
    imageSourceUrl: partial.imageSourceUrl ?? null,
    confidence: partial.confidence,
  };
}

// PURE — the article-draft "flaky" predicate used to decide whether an OpenRouter response is
// usable or should trigger rotation to the next pooled token (lib/ai/with-token-pool.ts). Exported
// so it's unit-testable without invoking the LLM or the pool (tests/openrouter-flaky-wiring.test.ts).
export function articleIsFlaky(bodyHtml: string, minChars: number): boolean {
  return plainTextLen(bodyHtml) < minChars;
}

// PURE — l'équivalent d'articleIsFlaky quand le CORPS n'a pas été demandé : le seuil de longueur
// n'a plus rien à mesurer. Un champ TEXTE coché mais vide (ou absent) est le seul signal fiable
// d'une réponse inexploitable, et justifie de tourner sur le jeton OpenRouter suivant.
// Exclus délibérément : les tags (une liste vide est permise par le schéma) et l'image (une absence
// d'image est un résultat légitime — confidence.imageMissing — qu'aucun autre jeton ne changera).
export function partialDraftIsFlaky(draft: PartialArticleDraft, fields: DraftFields): boolean {
  const empty = (v: string | undefined) => (v ?? "").trim().length === 0;
  return (fields.title && empty(draft.title))
    || (fields.excerpt && empty(draft.excerpt))
    || (fields.category && empty(draft.category));
}

export async function generateArticle(
  input: GenerateInput,
): Promise<{ draft: ArticleDraft; via: string; failure?: AiFailureReason; failureDetail?: string }> {
  const cfg = getPipelineConfig();
  const fields = input.fields ?? ALL_DRAFT_FIELDS;
  const schema = buildArticleSchema(input.categories, fields);

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
      // Seuil de « brouillon inexploitable » lu PARESSEUSEMENT, à l'intérieur de `op` : sur une
      // installation sans le moindre jeton, le runner ne rappelle jamais `op`, donc aucune lecture
      // DB n'a lieu — l'ancienne lecture en amont faisait payer un aller-retour (et transformait une
      // panne de base en exception remontant hors de generateArticle) à un chemin qui n'en avait
      // aucun besoin. Mémorisé au premier passage : le pool peut appeler `op` une fois par jeton.
      let minContentChars: number | undefined;
      // `isFlaky` n'est appelé par le runner qu'APRÈS un `op` résolu, donc `minContentChars` est
      // toujours renseigné ici ; le `?? 0` n'est qu'un garde-fou de typage (un seuil de 0 ne
      // qualifie jamais un brouillon de flaky, on ne rejette donc rien à tort).
      // Corps non demandé ⇒ le seuil de longueur n'a rien à mesurer : on bascule sur le prédicat
      // « un champ texte coché est vide » (partialDraftIsFlaky ci-dessus).
      const isFlaky = (draft: PartialArticleDraft) => fields.body
        ? articleIsFlaky(draft.bodyHtml ?? "", minContentChars ?? 0)
        : partialDraftIsFlaky(draft, fields);
      // Rotates across every pooled token (DB-managed + the env-configured key as a fallback member —
      // see lib/ai/token-pool.ts), letting a quota error or a flaky/too-short draft on one token fall
      // through to the next rather than failing this provider outright. The generateObject call is left
      // to THROW on error (never caught here) so runWithOpenRouterPool can classify + rotate on it.
      const r = await runWithOpenRouterPool(async (apiKey) => {
        if (minContentChars === undefined) minContentChars = (await getPipelineSettings()).openrouterMinContentChars;
        const model = buildOpenRouterModel(cfg, apiKey);
        const { object } = await generateObject({
          model,
          schema,
          prompt: buildArticlePrompt(input),
          // Relaxes OpenAI-family strict json_schema validation (which rejects `format: "uri"`,
          // used by our nullable URL fields). Ignored by providers that don't recognize this key.
          providerOptions: { openaiCompatible: { strictJsonSchema: false } },
        });
        return object as PartialArticleDraft;
      }, isFlaky);
      // sanitizeDraft AVANT completeDraft : la normalisation d'image ne doit juger que ce que le
      // modèle a réellement renvoyé, jamais les valeurs reprises de l'article existant.
      if (r.ok) return { draft: completeDraft(sanitizeDraft(r.value, input.candidateImages, fields), input), via: "openrouter" };
      // `unconfigured` vient du pool lui-même (aucune ligne openrouter_tokens ET aucune clé
      // d'environnement, voir lib/ai/token-pool.ts) : aucun jeton n'a été essayé, il n'y a donc rien
      // à mémoriser — on laisse `failure` intact pour que le retour final reste "unconfigured" sans
      // écraser l'échec d'un fournisseur précédent. `empty_pool` en revanche est une vraie anomalie
      // (des jetons EXISTENT mais dorment tous) et se mémorise telle quelle, y compris — et c'est
      // tout l'objet de ce correctif — quand ces jetons ne viennent que de Réglages.
      if (r.reason === "unconfigured") continue;
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
        return { draft: completeDraft(sanitizeDraft(object as PartialArticleDraft, input.candidateImages, fields), input), via: name };
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
    draft: sanitizeDraft(mockGenerateArticle(input), input.candidateImages, ALL_DRAFT_FIELDS),
    via: "mock",
    failure: failure ?? "unconfigured",
    failureDetail,
  };
}
