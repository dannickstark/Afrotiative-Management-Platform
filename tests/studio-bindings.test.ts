import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  db, articles, articleSources, wpCategories, distributions,
  renderTemplates, renderTemplateVersions, renders,
} from "@/db";
import { eq, inArray } from "drizzle-orm";
import { articleTokenValues, DEFAULT_CATEGORY_COLOR } from "@/lib/studio/bindings";
import { renderForArticle, MemoryRenderStore, type AssetLoader } from "@/lib/studio";
import { loadFallbackFonts } from "@/lib/studio/fonts";

// ---- fixtures partagées : articleTokenValues ----
let articleId: string;
let categoryId: string;
const WP_POST_ID = "9182";

// wpPostUrl (lib/wp/post-url.ts) a besoin de getWpConfig() -> ces trois variables. test-setup.ts
// ne les charge PAS depuis .env.local (politique délibérée : les tests DB tournent sans
// dépendances externes par défaut), donc on les pose nous-mêmes, comme tests/published-queries.test.ts
// le fait déjà pour lib/queries/published.ts.
const WP_ENV = { WP_BASE_URL: "https://wp.example.com", WP_USER: "u", WP_APP_PASSWORD: "p" };
const wpEnvSnapshot: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of Object.keys(WP_ENV)) {
    wpEnvSnapshot[k] = process.env[k];
    process.env[k] = (WP_ENV as Record<string, string>)[k];
  }

  const [c] = await db.insert(wpCategories).values({
    name: "Agribusiness test", slug: `agri-${Date.now()}`, color: "#1B7F4A",
  }).returning();
  categoryId = c.id;

  const [a] = await db.insert(articles).values({
    title: "Le cacao camerounais",
    bodyHtml: "<p>x</p>",
    excerpt: "Un chapô.",
    categoryId,
    featuredImageUrl: "https://cdn.test/photo.jpg",
    imageCredit: "Reuters",
    status: "approved",
  }).returning();
  articleId = a.id;

  await db.insert(articleSources).values([
    { articleId, mediaName: "Reuters", url: "https://reuters.test/a" },
    { articleId, mediaName: "Jeune Afrique", url: "https://ja.test/b" },
  ]);

  // Distribution WordPress RÉELLE : sans cette ligne, dist?.externalId serait undefined et
  // article.url n'existerait déjà pas AVANT tout filtrage par contexte — le test "n'expose jamais"
  // passerait alors trivialement, même si le filtre de tokens.ts était supprimé. Avec cette ligne,
  // une vraie URL existe et doit être activement filtrée hors du contexte article_image.
  await db.insert(distributions).values({
    articleId, channel: "wordpress", status: "sent", externalId: WP_POST_ID,
  });
});

afterAll(async () => {
  await db.delete(articles).where(inArray(articles.id, [articleId])); // cascade: sources, distributions
  await db.delete(wpCategories).where(eq(wpCategories.id, categoryId));
  for (const k of Object.keys(WP_ENV)) {
    if (wpEnvSnapshot[k] === undefined) delete process.env[k]; else process.env[k] = wpEnvSnapshot[k];
  }
});

describe("articleTokenValues", () => {
  it("fournit les jetons de base du contexte article_image", async () => {
    const v = await articleTokenValues(articleId, "article_image");
    expect(v["article.title"]).toBe("Le cacao camerounais");
    expect(v["article.excerpt"]).toBe("Un chapô.");
    expect(v["article.image"]).toBe("https://cdn.test/photo.jpg");
    expect(v["category.name"]).toBe("Agribusiness test");
    expect(v["category.color"]).toBe("#1B7F4A");
    expect(v["source.names"]).toBe("Reuters, Jeune Afrique");
  });

  it("n'expose JAMAIS article.url dans le contexte article_image", async () => {
    const v = await articleTokenValues(articleId, "article_image");
    expect(v["article.url"]).toBeUndefined();
  });

  it("construit pourtant une VRAIE article.url via wpPostUrl dans un contexte qui l'autorise (social_post)", async () => {
    // Preuve que la valeur ci-dessus est bien filtrée, et non simplement absente : le même article,
    // dans un contexte où CONTEXT_TOKENS autorise article.url, expose le permalien reconstruit par
    // wpPostUrl(baseUrl, dist.externalId) — pas le placeholder `wp:<id>` d'origine.
    const v = await articleTokenValues(articleId, "social_post");
    expect(v["article.url"]).toBe(`https://wp.example.com/?p=${WP_POST_ID}`);
  });

  it("retombe sur la couleur par défaut quand la catégorie n'en a pas", async () => {
    await db.update(wpCategories).set({ color: null }).where(eq(wpCategories.id, categoryId));
    const v = await articleTokenValues(articleId, "article_image");
    expect(v["category.color"]).toBe(DEFAULT_CATEGORY_COLOR);
    await db.update(wpCategories).set({ color: "#1B7F4A" }).where(eq(wpCategories.id, categoryId));
  });

  it("lève quand l'article n'existe pas", async () => {
    await expect(articleTokenValues("00000000-0000-0000-0000-000000000000", "article_image"))
      .rejects.toThrow("Article introuvable.");
  });
});

// ---- renderForArticle : la façade publique elle-même ----
//
// Le brief ne fournit aucun test pour renderForArticle : c'est pourtant la fonction que TOUT le
// reste de la V1 appelle (V3 « Aperçu », D1 « Diffusion »), et elle assemble sept modules distincts
// (resolve, bindings, render, store) — un défaut de câblage (mauvais ordre de garde, oubli de
// catch, court-circuit de cache qui ne court-circuite pas vraiment) ne serait détecté par AUCUN
// test unitaire de ces modules pris isolément. MemoryRenderStore rend ce test possible sans R2 ni
// réseau (seul le téléchargement de police de repli embarqué touche le disque local).
describe("renderForArticle", () => {
  const templateIds: string[] = [];
  const articleIds2: string[] = [];
  const catIds2: string[] = [];

  function textScene(content: string, fontAssetId?: string) {
    return {
      schemaVersion: 1 as const,
      canvas: { width: 200, height: 100, background: "#000000" },
      layers: [{
        id: "t", name: "t", visible: true, locked: false,
        frame: { x: 0, y: 0, w: 180, h: 80 },
        type: "text" as const, content,
        font: { assetId: fontAssetId, family: "Noto Sans", size: 14, weight: 400 as const },
        color: "#FFFFFF", align: "left" as const, vAlign: "top" as const, lineHeight: 1.2,
      }],
    };
  }

  async function publishedTemplate(o: {
    context: string; channel?: string | null; categoryId: string | null; content: string; fontAssetId?: string;
  }) {
    const scene = textScene(o.content, o.fontAssetId);
    const [t] = await db.insert(renderTemplates).values({
      name: "gabarit test", context: o.context, channel: o.channel ?? null, categoryId: o.categoryId,
      format: "website_featured", width: 200, height: 100, scene,
    }).returning();
    templateIds.push(t.id);
    await db.insert(renderTemplateVersions).values({ templateId: t.id, version: 1, scene });
    await db.update(renderTemplates).set({ publishedVersion: 1 }).where(eq(renderTemplates.id, t.id));
    return t.id;
  }

  async function mkArticle(o: { title: string; categoryId: string | null }) {
    const [a] = await db.insert(articles).values({
      title: o.title, bodyHtml: "<p>x</p>", categoryId: o.categoryId, status: "approved",
    }).returning();
    articleIds2.push(a.id);
    return a.id;
  }

  afterAll(async () => {
    if (templateIds.length) await db.delete(renders).where(inArray(renders.templateId, templateIds));
    if (templateIds.length) await db.delete(renderTemplates).where(inArray(renderTemplates.id, templateIds));
    if (articleIds2.length) await db.delete(articles).where(inArray(articles.id, articleIds2));
    if (catIds2.length) await db.delete(wpCategories).where(inArray(wpCategories.id, catIds2));
  });

  it("« aucun gabarit » est un succès normal : url et renderId null, degraded false", async () => {
    // "recap_card" n'est utilisé par AUCUN autre test/fixture du dépôt comme gabarit par défaut
    // (vérifié : seul studio-resolve.test.ts s'en sert pour affirmer resolveTemplate(...) === null).
    const id = await mkArticle({ title: "Sans gabarit", categoryId: null });
    const res = await renderForArticle(id, { context: "recap_card", store: new MemoryRenderStore() });
    expect(res).toEqual({ ok: true, url: null, renderId: null, degraded: false });
  });

  it("rend l'image, la met en cache, et le second appel identique COURT-CIRCUITE le rendu (même renderId)", async () => {
    const [c] = await db.insert(wpCategories).values({
      name: "Render test", slug: `render-test-${Date.now()}`,
    }).returning();
    catIds2.push(c.id);
    const templateId = await publishedTemplate({ context: "article_image", categoryId: c.id, content: "{{article.title}}" });
    const id = await mkArticle({ title: "Titre à rendre", categoryId: c.id });

    const store = new MemoryRenderStore();
    const first = await renderForArticle(id, { context: "article_image", store });
    if (!first.ok || first.url === null) throw new Error(`rendu attendu réussi, reçu : ${JSON.stringify(first)}`);
    expect(first.degraded).toBe(false);
    expect(first.url).toContain("memory://");
    expect(store.objects.size).toBe(1);

    const second = await renderForArticle(id, { context: "article_image", store });
    // La preuve du court-circuit n'est PAS que le second appel réussit avec les mêmes valeurs —
    // storageKeyFor(hash, mime, date) est déterministe (mois UTC courant), donc un store.put répété
    // écraserait la MÊME clé mémoire et laisserait store.objects.size à 1 même si le rendu avait été
    // refait en double. La vraie preuve est la contrainte UNIQUE renders_input_hash_unique côté DB :
    // si le court-circuit (findCachedRender AVANT tout rendu) était supprimé ou mal ordonné, ce second
    // appel tenterait un second db.insert avec le MÊME inputHash, violerait cette contrainte, et
    // tomberait dans le catch générique de renderForArticle — donc second.ok serait FALSE. C'est le
    // succès même de cet appel qui démontre que la ligne a été retrouvée, pas recréée.
    if (!second.ok) throw new Error(`le court-circuit de cache a échoué : ${JSON.stringify(second)}`);
    expect(second.renderId).toBe(first.renderId);
    expect(second.url).toBe(first.url);

    const rows = await db.select().from(renders).where(eq(renders.templateId, templateId));
    expect(rows.length).toBe(1);
  });

  // Important 6 (revue de branche) : renderForArticle n'exposait aucun moyen d'injecter un vrai
  // AssetLoader — V2 (qui peuplera render_assets) n'aurait eu aucune façon de le brancher sans
  // modifier cette fonction. Ce test prouve que l'option `assets` n'est pas seulement acceptée par
  // le TYPE mais réellement TRANSMISE à renderScene : même gabarit (police liée à un assetId), sans
  // loader la police d'asset est introuvable (NullAssetLoader par défaut, dégradation tolérée) ;
  // avec un loader qui la fournit, le rendu n'est plus dégradé.
  it("l'option assets est transmise à renderScene : un AssetLoader personnalisé évite la dégradation", async () => {
    const [c] = await db.insert(wpCategories).values({
      name: "Assets test", slug: `assets-test-${Date.now()}`,
    }).returning();
    catIds2.push(c.id);
    await publishedTemplate({
      context: "article_image", categoryId: c.id, content: "{{article.title}}", fontAssetId: "asset-titre",
    });

    const withoutLoader = await mkArticle({ title: "Sans loader", categoryId: c.id });
    const resNoLoader = await renderForArticle(withoutLoader, { context: "article_image", store: new MemoryRenderStore() });
    if (!resNoLoader.ok) throw new Error(`rendu attendu réussi : ${JSON.stringify(resNoLoader)}`);
    expect(resNoLoader.degraded).toBe(true); // aucun loader fourni -> NullAssetLoader -> police introuvable

    const [font] = await loadFallbackFonts();
    const customLoader: AssetLoader = {
      async font(assetId) { return assetId === "asset-titre" ? font : null; },
      async imageUrl() { return null; },
    };
    const withLoader = await mkArticle({ title: "Avec loader", categoryId: c.id });
    const resWithLoader = await renderForArticle(withLoader, {
      context: "article_image", store: new MemoryRenderStore(), assets: customLoader,
    });
    if (!resWithLoader.ok) throw new Error(`rendu attendu réussi : ${JSON.stringify(resWithLoader)}`);
    expect(resWithLoader.degraded).toBe(false);
  });

  it("un jeton manquant dans le gabarit publié échoue franchement, en français, sans planter", async () => {
    // "quote.text" est un jeton légal du contexte quote_card (tokens.ts) mais articleTokenValues
    // ne le calcule JAMAIS pour un article (ce n'est pas un jeton d'article) : ce gabarit échoue
    // donc TOUJOURS à la résolution des jetons, de façon déterministe.
    //
    // Portée (quote_card, null, <categoryId FRAIS>) — PAS (quote_card, null, null) :
    // tests/studio-resolve.test.ts est l'unique propriétaire de cette dernière (voir
    // tests/studio-fixtures.ts). Un categoryId généré à chaque exécution (comme les autres tests de
    // ce describe) suffit à s'en distinguer structurellement, sans avoir besoin d'un canal — et
    // évite de forcer un canal synthétique à travers `channel?: Channel | null` (Important 6), qui
    // n'accepte que les cinq membres réels de CHANNELS.
    const [c] = await db.insert(wpCategories).values({
      name: "Quote test", slug: `quote-test-${Date.now()}`,
    }).returning();
    catIds2.push(c.id);
    await publishedTemplate({ context: "quote_card", categoryId: c.id, content: "{{quote.text}}" });
    const id = await mkArticle({ title: "Article sans citation", categoryId: c.id });

    const res = await renderForArticle(id, { context: "quote_card", store: new MemoryRenderStore() });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.message).toContain("Génération de l'image échouée");
    expect(res.message).toContain("quote.text");
  });

  it("renvoie un message français quand l'article n'existe pas", async () => {
    const res = await renderForArticle("00000000-0000-0000-0000-000000000000", {
      context: "article_image", store: new MemoryRenderStore(),
    });
    expect(res).toEqual({ ok: false, reason: "render_failed", message: "Article introuvable." });
  });
});
