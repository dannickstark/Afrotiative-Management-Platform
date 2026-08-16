import { describe, it, expect, beforeAll, afterAll, mock } from "bun:test";
import { db, articles, articleSources } from "@/db";
import { eq, inArray } from "drizzle-orm";
import type { ArticleDraft } from "@/lib/ai/schema";
import type { AiFailureReason } from "@/lib/ai/failure-message";
import { faker } from "@faker-js/faker";

// regenerateArticle est le cœur unitaire partagé par regenerate (action unitaire) et
// regenerateInQueue (appelé en boucle par la barre d'actions du /queue, un article par appel).
// Il est PLAIN (pas de "use server") : ni RBAC ni revalidatePath ici, donc on peut
// l'exercer directement sous `bun test`, sans mocker session/next-cache.
//
// Task 3 : le chemin « generateArticle renvoie via:"mock" » est maintenant couvert lui aussi, en
// mockant @/lib/extract (pour dépasser « Aucune source à régénérer » sans réseau) et
// @/lib/ai/generate-article (pour piloter `failure` directement). Les DEUX modules sont importés
// DYNAMIQUEMENT par regenerate-core.ts (au moment de l'appel, pas au chargement du fichier) — donc
// mock.module() ici, exécuté avant tout appel à regenerateArticle(), est vu par ces `await
// import(...)` internes exactement comme dans tests/ai-fallback.test.ts (voir son commentaire
// d'en-tête pour la justification complète du pattern captureRéelle→mock.module→restore).
//
// Ce fichier applique désormais ce pattern EN ENTIER : les implémentations réelles sont capturées
// ci-dessous AVANT les mock.module(), et afterAll repointe les indirections *Impl dessus. Sans cela,
// les deux mocks (mock.module est global au processus `bun test`, et mock.restore() ne le défait pas
// dans cette version de Bun) fuiraient vers tout fichier importé ensuite — inoffensif aujourd'hui
// seulement par chance, à cause de l'ordre alphabétique des fichiers.
// NB : on destructure les VALEURS (et non l'objet de namespace), car mock.module() mute l'objet
// d'exports en place — garder le namespace rendrait la fonction MOCKÉE dans afterAll.
const { extractExternal: realExtractExternal } = await import("@/lib/extract");
const { generateArticle: realGenerateArticle } = await import("@/lib/ai/generate-article");

let extractExternalImpl: (url: string) => Promise<{ title: string; text: string; images: string[]; via: string; attempts: unknown[] }> =
  async () => ({ title: "t", text: "Contenu extrait de test, assez long.", images: [], via: "test", attempts: [] });
mock.module("@/lib/extract", () => ({
  extractExternal: (url: string) => extractExternalImpl(url),
}));

let generateArticleImpl: () => Promise<{ draft: ArticleDraft; via: string; failure?: AiFailureReason; failureDetail?: string }> =
  async () => { throw new Error("generateArticleImpl not set"); };
mock.module("@/lib/ai/generate-article", () => ({
  generateArticle: () => generateArticleImpl(),
}));

// regenerate-core.ts importe aussi dynamiquement @/lib/pipeline/regenerate (applyRegeneration) —
// UNIQUEMENT atteint côté succès (via !== "mock"), jamais exercé par les cas mock:true ci-dessous.
// Pas besoin de le mocker : les tests "mock" retournent avant cet import.

// Importés APRÈS l'enregistrement des mocks ci-dessus, par cohérence avec le reste de la suite
// (bien que regenerateArticle() lui-même n'importe @/lib/extract et @/lib/ai/generate-article
// qu'au moment de l'appel — l'ordre d'import ici est donc sans effet réel, mais suit la
// convention établie par tests/ai-fallback.test.ts pour rester lisible).
const { regenerateArticle } = await import("@/lib/pipeline/regenerate-core");
const { aiFailureMessage } = await import("@/lib/ai/failure-message");

const ALL = { title: true, body: true, excerpt: true, category: true, tags: true, image: true };

const createdArticleIds: string[] = [];
async function seedArticle(overrides: Partial<typeof articles.$inferInsert> = {}): Promise<string> {
  const [row] = await db.insert(articles).values({
    title: faker.lorem.sentence(),
    bodyHtml: "<p>Corps de test.</p>",
    generatedAt: new Date(),
    status: "pending",
    ...overrides,
  }).returning({ id: articles.id });
  createdArticleIds.push(row.id);
  return row.id;
}

async function seedArticleWithSource(overrides: Partial<typeof articles.$inferInsert> = {}): Promise<string> {
  const id = await seedArticle(overrides);
  await db.insert(articleSources).values({ articleId: id, mediaName: "Source test", url: "https://example.test/article" });
  return id;
}

afterAll(async () => {
  if (createdArticleIds.length) await db.delete(articles).where(inArray(articles.id, createdArticleIds));
  // Restauration réelle : les factories mock.module ci-dessus délèguent toujours à ces variables,
  // donc les repointer sur les fonctions réelles rend leur comportement d'origine à tout fichier
  // exécuté après celui-ci (mock.restore() ne défait pas mock.module dans cette version de Bun).
  extractExternalImpl = realExtractExternal as unknown as typeof extractExternalImpl;
  generateArticleImpl = realGenerateArticle as unknown as typeof generateArticleImpl;
});

describe("regenerateArticle (cœur unitaire)", () => {
  it("retourne { ok:false, title } avec « Sélectionnez au moins un champ » si aucun champ n'est coché", async () => {
    const r = await regenerateArticle("00000000-0000-0000-0000-000000000000", { title: false, body: false, excerpt: false, category: false, tags: false, image: false }, "acteur");
    expect(r.ok).toBe(false);
    expect(r.message).toBe("Sélectionnez au moins un champ à régénérer.");
  });

  it("retourne « Article introuvable. » et title = l'identifiant quand l'article n'existe pas", async () => {
    const missingId = "11111111-1111-1111-1111-111111111111";
    const r = await regenerateArticle(missingId, ALL, "acteur");
    expect(r.ok).toBe(false);
    expect(r.message).toBe("Article introuvable.");
    expect(r.title).toBe(missingId);
  });

  it("retourne « Aucune source à régénérer. » et le titre courant quand l'article n'a aucune source", async () => {
    // Article seedé SANS aucune ligne article_sources → arrêt avant tout appel réseau/IA.
    const id = await seedArticle({ title: "Article sans source" });
    const r = await regenerateArticle(id, ALL, "acteur");
    expect(r.ok).toBe(false);
    expect(r.message).toBe("Aucune source à régénérer.");
    expect(r.title).toBe("Article sans source");
  });

  it("répercute le message spécifique à `failure` quand generateArticle renvoie via:\"mock\"", async () => {
    generateArticleImpl = async () => ({
      draft: {} as ArticleDraft, via: "mock", failure: "rate_limited", failureDetail: "429 too many requests",
    });
    const id = await seedArticleWithSource({ title: "Article rate-limited" });
    const r = await regenerateArticle(id, ALL, "acteur");
    expect(r.ok).toBe(false);
    expect(r.message).toBe(aiFailureMessage("rate_limited", "régénération", "429 too many requests"));
    expect(r.title).toBe("Article rate-limited");
  });

  it("retombe sur le message \"unconfigured\" quand generateArticle renvoie via:\"mock\" sans `failure` (compatibilité ascendante)", async () => {
    generateArticleImpl = async () => ({ draft: {} as ArticleDraft, via: "mock" });
    const id = await seedArticleWithSource({ title: "Article sans raison" });
    const r = await regenerateArticle(id, ALL, "acteur");
    expect(r.ok).toBe(false);
    expect(r.message).toBe(aiFailureMessage("unconfigured", "régénération"));
    expect(r.message).toBe("Aucun fournisseur IA configuré — régénération impossible.");
    expect(r.title).toBe("Article sans raison");
  });
});
