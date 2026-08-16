import { z } from "zod";

export const confidenceSchema = z.object({
  categoryUncertain: z.boolean(), imageMissing: z.boolean(), clusterUncertain: z.boolean(),
});

// Quels champs du brouillon on DEMANDE au modèle. Volontairement structurellement identique à
// RegenerateFieldsInput (lib/validation.ts) — le dialogue « Renvoyer à l'IA » coche exactement ces
// six cases — mais déclaré ici pour que la couche IA ne dépende pas de la couche validation.
export type DraftFields = { title: boolean; body: boolean; excerpt: boolean; category: boolean; tags: boolean; image: boolean };
export const ALL_DRAFT_FIELDS: DraftFields = { title: true, body: true, excerpt: true, category: true, tags: true, image: true };

// Le brouillon COMPLET. Écrit explicitement (et non inféré du schéma) depuis que
// buildArticleSchema construit une forme variable : le type public ne doit PAS se mettre à rétrécir
// avec la sélection, sans quoi tous les appelants (stages.ts, regenerate.ts, mock.ts) devraient
// gérer des champs optionnels alors qu'ils reçoivent toujours un brouillon complété.
// Les champs image restent `| null | undefined` car le schéma les déclare `.nullish()` (voir plus
// bas) ; sanitizeDraft (generate-article.ts) normalise `undefined` en `null` avant persistance.
export type ArticleDraft = {
  title: string;
  bodyHtml: string;
  excerpt: string;
  category: string;
  tags: string[];
  featuredImageUrl?: string | null;
  imageCredit?: string | null;
  imageSourceUrl?: string | null;
  confidence: z.infer<typeof confidenceSchema>;
};

// Ce que le modèle renvoie sur une régénération partielle : seuls les champs cochés sont présents.
// `confidence` est TOUJOURS demandé (applyRegeneration fusionne les flags champ par champ).
export type PartialArticleDraft = Partial<ArticleDraft> & { confidence: ArticleDraft["confidence"] };

// `fields` par défaut = tout : l'ingestion (lib/pipeline/stages.ts) appelle sans second argument et
// obtient le schéma complet d'origine, inchangé.
export function buildArticleSchema(categoryNames: string[], fields: DraftFields = ALL_DRAFT_FIELDS) {
  const category = categoryNames.length >= 1
    ? z.enum(categoryNames as [string, ...string[]])
    : z.string();
  const shape: Record<string, z.ZodTypeAny> = {};
  if (fields.title) shape.title = z.string().min(5);
  if (fields.body) shape.bodyHtml = z.string().min(1);
  if (fields.excerpt) shape.excerpt = z.string();
  if (fields.category) shape.category = category;
  if (fields.tags) shape.tags = z.array(z.string()).max(8);
  if (fields.image) {
    // .nullish() (= .nullable().optional()) rather than .nullable(): real providers
    // (OpenRouter/OpenAI structured output) frequently OMIT these keys entirely instead of
    // sending null when there's no image, and a merely-.nullable() field still requires the
    // key to be present, so omission fails validation and needlessly falls through to the
    // mock. sanitizeDraft() in generate-article.ts normalizes undefined to null before persist.
    shape.featuredImageUrl = z.string().url().nullish();
    shape.imageCredit = z.string().nullish();
    shape.imageSourceUrl = z.string().url().nullish();
  }
  shape.confidence = confidenceSchema;
  // Cast : la forme est construite dynamiquement, donc Zod ne peut plus l'inférer statiquement.
  // Le schéma reste la seule source de vérité à l'exécution (c'est lui que valide generateObject).
  return z.object(shape) as unknown as z.ZodType<PartialArticleDraft>;
}
