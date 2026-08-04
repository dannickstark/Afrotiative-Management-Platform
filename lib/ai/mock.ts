import type { ArticleDraft } from "./schema";

export function mockGenerateArticle(input: { sources: { mediaName: string; text: string }[]; candidateImages: string[]; categories: string[] }): ArticleDraft {
  const first = input.sources[0];
  const base = (first?.text ?? "Contenu indisponible").slice(0, 400);
  return {
    title: `[MOCK] ${base.slice(0, 60)}`.trim(),
    bodyHtml: `<p>${base}</p><h2>Contexte</h2><p>Article de substitution généré sans fournisseur IA configuré.</p>`,
    excerpt: base.slice(0, 140),
    category: input.categories[0] ?? "Économie",
    tags: ["à vérifier"],
    featuredImageUrl: input.candidateImages[0] ?? null,
    imageCredit: input.candidateImages[0] ? (first?.mediaName ?? null) : null,
    imageSourceUrl: null,
    confidence: { categoryUncertain: true, imageMissing: !input.candidateImages[0], clusterUncertain: true },
  };
}
