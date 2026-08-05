import type { ArticleDraft } from "./schema";

export function mockGenerateArticle(input: { sources: { mediaName: string; text: string }[]; candidateImages: string[]; categories: string[] }): ArticleDraft {
  const first = input.sources[0];
  const base = (first?.text ?? "Contenu indisponible").slice(0, 400);
  return {
    title: `[MOCK] ${base.slice(0, 60)}`.trim(),
    // Two <h2> subheadings (not just one) so downstream consumers of the mock draft — the
    // completeness signal in lib/pipeline/score.ts, and tests/ai-prompt.test.ts — see the same
    // sous-titre structure the real prompt (SP4 Task 3) now asks providers for.
    bodyHtml: `<p>${base}</p><h2>Contexte</h2><p>Article de substitution généré sans fournisseur IA configuré.</p><h2>À vérifier</h2><p>Ce contenu de repli doit être relu et complété par un journaliste avant publication.</p>`,
    excerpt: base.slice(0, 140),
    category: input.categories[0] ?? "Économie",
    tags: ["à vérifier"],
    featuredImageUrl: input.candidateImages[0] ?? null,
    imageCredit: input.candidateImages[0] ? (first?.mediaName ?? null) : null,
    imageSourceUrl: null,
    confidence: { categoryUncertain: true, imageMissing: !input.candidateImages[0], clusterUncertain: true },
  };
}
