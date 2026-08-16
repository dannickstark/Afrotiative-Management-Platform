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
const { extractExternal: realExtractExternal, extract: realExtract } = await import("@/lib/extract");
const { generateArticle: realGenerateArticle } = await import("@/lib/ai/generate-article");

let extractCalls: string[] = [];
let extractImpl: (url: string) => Promise<{ title: string; text: string; images: string[]; via: string; attempts: unknown[] }> =
  async () => ({ title: "t", text: "Contenu extrait de test, assez long.", images: [], via: "test", attempts: [] });
let extractExternalImpl = extractImpl;
mock.module("@/lib/extract", () => ({
  extract: (url: string) => { extractCalls.push(url); return extractImpl(url); },
  extractExternal: (url: string) => extractExternalImpl(url),
}));

let lastGenerateInput: { sources: { url: string }[] } | null = null;
let generateArticleImpl: () => Promise<{ draft: ArticleDraft; via: string; failure?: AiFailureReason; failureDetail?: string }> =
  async () => { throw new Error("generateArticleImpl not set"); };
mock.module("@/lib/ai/generate-article", () => ({
  generateArticle: (input: { sources: { url: string }[] }) => { lastGenerateInput = input; return generateArticleImpl(); },
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

// Variante à plusieurs sources, pour les tests d'extraction ci-dessous (parallélisme, timeout).
// `seedArticle` alimente déjà `createdArticleIds`, donc le nettoyage dans `afterAll` couvre aussi
// ces articles sans array de plus.
async function seedArticleWithSources(urls: string[]): Promise<{ articleId: string }> {
  const articleId = await seedArticle();
  await db.insert(articleSources).values(urls.map((url) => ({ articleId, mediaName: "Test", url })));
  return { articleId };
}

const draftFixture: ArticleDraft = {
  title: "Titre régénéré", bodyHtml: "<p>Corps régénéré assez long pour passer.</p>",
  excerpt: "Extrait", category: "Économie", tags: ["a"],
  featuredImageUrl: null, imageCredit: null, imageSourceUrl: null,
  confidence: { categoryUncertain: false, imageMissing: true, clusterUncertain: false },
};

afterAll(async () => {
  // Restauration réelle EN PREMIER : les factories mock.module ci-dessus délèguent toujours à ces
  // variables, donc les repointer sur les fonctions réelles rend leur comportement d'origine à tout
  // fichier exécuté après celui-ci (mock.restore() ne défait pas mock.module dans cette version de
  // Bun). L'ordre compte : le nettoyage DB ci-dessous peut jeter (base indisponible, ligne
  // verrouillée) et abandonnerait alors les mocks en place pour tout le reste du processus `bun
  // test` — exactement la fuite que cette restauration existe pour empêcher.
  extractImpl = realExtract as unknown as typeof extractImpl;
  extractExternalImpl = realExtractExternal as unknown as typeof extractExternalImpl;
  generateArticleImpl = realGenerateArticle as unknown as typeof generateArticleImpl;
  if (createdArticleIds.length) await db.delete(articles).where(inArray(articles.id, createdArticleIds));
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

describe("regenerateArticle — extraction", () => {
  it("utilise extract() (et non extractExternal) sur les sources de l'article", async () => {
    const { articleId } = await seedArticleWithSources(["https://a.test/1"]);
    extractCalls = [];
    generateArticleImpl = async () => ({ draft: draftFixture, via: "openrouter" });
    await regenerateArticle(articleId, { ...ALL }, null);
    expect(extractCalls).toEqual(["https://a.test/1"]);
  });

  it("extrait les sources EN PARALLÈLE", async () => {
    const { articleId } = await seedArticleWithSources([
      "https://a.test/1", "https://a.test/2", "https://a.test/3",
    ]);
    // On mesure la CONCURRENCE, pas le temps écoulé : regenerateArticle enchaîne plusieurs
    // allers-retours vers la base distante partagée avant et après l'extraction, si bien qu'aucune
    // borne d'horloge ne peut isoler la phase d'extraction de façon fiable. Compter les extractions
    // simultanées teste directement la propriété voulue, sans dépendre de la latence réseau.
    let inFlight = 0;
    let maxInFlight = 0;
    extractImpl = async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 100));
      inFlight -= 1;
      return { title: "t", text: "Contenu extrait de test, assez long.", images: [], via: "test", attempts: [] };
    };
    generateArticleImpl = async () => ({ draft: draftFixture, via: "openrouter" });

    await regenerateArticle(articleId, { ...ALL }, null, { timeoutMs: 5000 });

    // Séquentiel donnerait maxInFlight === 1.
    expect(maxInFlight).toBe(3);
  });

  it("une source qui dépasse le délai est ignorée, les autres passent", async () => {
    const { articleId } = await seedArticleWithSources(["https://slow.test/1", "https://fast.test/2"]);
    extractImpl = async (url) => {
      // 6000 ms, strictement > timeoutMs (5000 ms) ci-dessous : un délai IDENTIQUE créerait une
      // égalité de course entre le setTimeout interne de cette extraction (déjà armé quand elle est
      // appelée, avant même que withTimeout() ne pose le sien) et celui de withTimeout — égalité que
      // Promise.race tranche systématiquement en faveur du premier setTimeout arme, donc en faveur
      // de l'extraction, jamais du timeout. Vérifié empiriquement sur ce runtime Bun.
      if (url.includes("slow")) await new Promise((r) => setTimeout(r, 6000));
      return { title: "t", text: `Contenu de ${url}, assez long pour compter.`, images: [], via: "test", attempts: [] };
    };
    let seenSources = 0;
    generateArticleImpl = async () => { seenSources = lastGenerateInput?.sources.length ?? 0; return { draft: draftFixture, via: "openrouter" }; };
    const r = await regenerateArticle(articleId, { ...ALL }, null, { timeoutMs: 5000 });
    expect(r.ok).toBe(true);
    expect(seenSources).toBe(1);
  }, 15000);
});

describe("regenerateArticle — image sans candidat", () => {
  it("image SEULE et zéro candidat : échoue sans appeler l'IA et sans toucher l'article", async () => {
    const { articleId } = await seedArticleWithSources(["https://a.test/1"]);
    await db.update(articles).set({ featuredImageUrl: "https://ancienne/img.jpg", imageCredit: "Ancien" }).where(eq(articles.id, articleId));
    extractImpl = async () => ({ title: "t", text: "Contenu extrait de test, assez long.", images: [], via: "test", attempts: [] });
    let called = false;
    generateArticleImpl = async () => { called = true; return { draft: draftFixture, via: "openrouter" }; };

    const r = await regenerateArticle(articleId, { title: false, body: false, excerpt: false, category: false, tags: false, image: true }, null, { timeoutMs: 5000 });

    expect(r.ok).toBe(false);
    expect(r.message).toBe("Aucune image candidate trouvée — image inchangée.");
    expect(called).toBe(false);
    const [row] = await db.select().from(articles).where(eq(articles.id, articleId));
    expect(row.featuredImageUrl).toBe("https://ancienne/img.jpg");
    expect(row.imageCredit).toBe("Ancien");
  });

  it("image + titre et zéro candidat : applique le titre, épargne l'image, avertit", async () => {
    const { articleId } = await seedArticleWithSources(["https://a.test/1"]);
    await db.update(articles).set({ featuredImageUrl: "https://ancienne/img.jpg" }).where(eq(articles.id, articleId));
    extractImpl = async () => ({ title: "t", text: "Contenu extrait de test, assez long.", images: [], via: "test", attempts: [] });
    generateArticleImpl = async () => ({ draft: { ...draftFixture, title: "Titre tout neuf" }, via: "openrouter" });

    const r = await regenerateArticle(articleId, { title: true, body: false, excerpt: false, category: false, tags: false, image: true }, null, { timeoutMs: 5000 });

    expect(r.ok).toBe(true);
    expect(r.message).toContain("Aucune image candidate trouvée");
    const [row] = await db.select().from(articles).where(eq(articles.id, articleId));
    expect(row.title).toBe("Titre tout neuf");
    expect(row.featuredImageUrl).toBe("https://ancienne/img.jpg");
  });
});
