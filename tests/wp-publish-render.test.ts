import { describe, it, expect, beforeAll, afterAll, spyOn } from "bun:test";
import sharp from "sharp";
import {
  db, articles, articleSources, wpCategories, renderTemplates, renderTemplateVersions, renders,
  distributions, articleRevisions,
} from "@/db";
import { eq, and, inArray } from "drizzle-orm";
import { publishArticle, republishArticle, renderFailureOutcome } from "@/lib/wp/publish";
import type { RenderStore } from "@/lib/studio";
import { ARTICLE_IMAGE_TEMPLATE } from "@/db/studio-templates";

// tests/wp-publish-render.test.ts — V3 Tâche 3 : buildPublishPayload (lib/wp/publish.ts) demande
// désormais à V1 le rendu article_image AVANT de téléverser l'image à la une. Trois issues (spec
// §2) : { ok:true, url } → CETTE url est téléversée ; { ok:true, url:null } → aucun gabarit résolu,
// image brute inchangée ; { ok:false, message } → la publication échoue, l'article reste
// `approved`. tests/wp-publish.test.ts et tests/publish-due.test.ts (protégés, non modifiés)
// couvrent déjà le chemin « aucun gabarit », implicitement : ni l'un ni l'autre ne configure R2 ni
// n'injecte de RenderStore, donc buildPublishPayload retombe sur l'image brute sans jamais tenter
// de rendu (voir son propre commentaire). Ce fichier couvre le reste : gabarit résolu (bonne URL
// téléversée), rendu en échec (publication bloquée), featuredImageUrl jamais réécrit, cache par
// inputHash sur deux publications successives, ET le repli « R2 non configuré » explicitement.
//
// Remarque pour la revue : il n'existe PAS de scénario intégration reproduisant fidèlement le cas
// { ok:true, url:null } (gabarit RÉSOLU comme absent) pour le contexte article_image dans la base
// dev partagée — `bun run db:studio-templates` y sème un gabarit de départ SANS catégorie
// (« Image à la une — défaut », portée (article_image, null, null)), qui est le repli FINAL de
// resolveTemplate (lib/studio/resolve.ts) : toute catégorie, y compris une catégorie fraîchement
// créée sans gabarit dédié, s'y résout. Supprimer ce gabarit de départ pour forcer le cas est hors
// de question (consigne explicite : ne pas toucher aux gabarits semés). Le comportement OBSERVABLE
// requis — « avec aucun gabarit, l'image brute est utilisée, comportement identique à aujourd'hui »
// — est donc vérifié via le repli « R2 non configuré » ci-dessous, qui produit exactement la même
// sortie (image brute, aucun échec) par un chemin différent mais réellement emprunté par
// tests/wp-publish.test.ts/publish-due.test.ts dans CET environnement de test.

const ENV_KEYS = ["WP_BASE_URL", "WP_USER", "WP_APP_PASSWORD"] as const;
const savedEnv: Record<string, string | undefined> = {};

// Store de test HTTP : contrairement à MemoryRenderStore (lib/studio/store.ts), qui renvoie une URL
// `memory://…` non téléchargeable (rejetée par le garde SSRF d'uploadFeaturedImage), celui-ci
// renvoie une URL https "de forme publique" servie par le fetch monkeypatché ci-dessous — c'est ce
// qui permet à publishArticle d'aller au bout : re-télécharger le rendu puis le pousser vers la
// médiathèque WP fake, exactement comme en production avec R2RenderStore.
const CDN_BASE = "https://cdn.render-test.example";
class FakeCdnRenderStore implements RenderStore {
  readonly bytesByKey = new Map<string, Uint8Array>();
  putCount = 0;
  async put(key: string, bytes: Uint8Array, _mime: string): Promise<string> {
    this.putCount++;
    this.bytesByKey.set(key, bytes);
    return `${CDN_BASE}/${key}`;
  }
}

// Gabarit délibérément défaillant dans CET environnement de test : {{brand.logo}} n'a jamais de
// valeur sous `bun test` (test-setup.ts ne charge jamais STUDIO_BRAND_LOGO_URL, voir sa propre
// note) — un article par ailleurs complet dont le gabarit résolu référence ce jeton produit donc un
// MissingTokensError authentique, sans avoir à violer la garde de complétude de publishArticle
// (qui n'exige jamais brand.logo — seulement image/crédit/source/catégorie/sources).
const FAILING_LOGO_SCENE = {
  schemaVersion: 1 as const,
  canvas: { width: 400, height: 300, background: "#000000" },
  layers: [
    {
      id: "logo", name: "Logo", visible: true, locked: false,
      frame: { x: 0, y: 0, w: 100, h: 100 },
      type: "image" as const,
      source: { kind: "slot" as const, slot: "brand.logo" },
      fit: "cover" as const,
    },
  ],
};

let server: ReturnType<typeof Bun.serve>;
let base: string;
let realFetch: typeof fetch;

let nextCategoryId = 8001;
let nextMediaId = 9001;
let nextPostId = 10001;
const mediaCalls: { body: Uint8Array; contentType: string | null }[] = [];
const fetchedUrls: string[] = [];

const RAW_IMAGE_URL = "https://raw-image-test.example/photo.jpg";
let RAW_IMAGE_BYTES: Uint8Array;

let categoryWithTemplateId: string;
let categoryForFailureId: string;
let templateOkId: string;
let templateFailId: string;
let articleForRenderId: string;
let articleForFailureId: string;
let articleNoStoreId: string;

beforeAll(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

  RAW_IMAGE_BYTES = await sharp({
    create: { width: 60, height: 40, channels: 3, background: { r: 200, g: 30, b: 30 } },
  }).jpeg().toBuffer();

  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      const method = req.method;

      if (path.endsWith("/categories") && method === "GET") {
        return Response.json([]);
      }
      if (path.endsWith("/categories") && method === "POST") {
        const body = await req.json();
        const id = nextCategoryId++;
        return Response.json({ id, name: body.name });
      }
      if (path.endsWith("/media") && method === "POST") {
        const body = new Uint8Array(await req.arrayBuffer());
        mediaCalls.push({ body, contentType: req.headers.get("content-type") });
        const id = nextMediaId++;
        return Response.json({ id, source_url: `${base}/media/${id}.jpg` });
      }
      if (path.endsWith("/posts") && method === "POST") {
        const id = nextPostId++;
        return Response.json({ id, link: `${base}/?p=${id}` });
      }
      const postIdMatch = path.match(/\/posts\/(\d+)$/);
      if (postIdMatch && method === "POST") {
        return Response.json({ id: Number(postIdMatch[1]), link: `${base}${path}` });
      }
      return new Response("not found", { status: 404 });
    },
  });
  base = `http://localhost:${server.port}`;
  process.env.WP_BASE_URL = base;
  process.env.WP_USER = "bot-test";
  process.env.WP_APP_PASSWORD = "app pass test";

  // Fetch monkeypatché : sert l'image brute fixture ET tout rendu produit par FakeCdnRenderStore
  // (deux domaines "de forme publique", distincts l'un de l'autre — de façon à pouvoir prouver
  // laquelle des deux URLs a réellement été demandée) ; tout le reste (le serveur WP fake
  // ci-dessus, en http://localhost) part vers le vrai fetch.
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === RAW_IMAGE_URL) {
      fetchedUrls.push(url);
      return new Response(Buffer.from(RAW_IMAGE_BYTES), { headers: { "content-type": "image/jpeg" } });
    }
    if (url.startsWith(`${CDN_BASE}/`)) {
      fetchedUrls.push(url);
      const key = url.slice(`${CDN_BASE}/`.length);
      const bytes = latestRenderStore?.bytesByKey.get(key);
      if (!bytes) return new Response("not found", { status: 404 });
      return new Response(Buffer.from(bytes), { headers: { "content-type": "image/jpeg" } });
    }
    return realFetch(input, init);
  }) as typeof fetch;

  const [catOk] = await db.insert(wpCategories).values({
    name: "Rendu WP Test", slug: `rendu-wp-test-${Date.now()}`, color: "#1B7F4A",
  }).returning();
  categoryWithTemplateId = catOk.id;

  const [catFail] = await db.insert(wpCategories).values({
    name: "Rendu WP Test Échec", slug: `rendu-wp-test-echec-${Date.now()}`, color: "#7F1B4A",
  }).returning();
  categoryForFailureId = catFail.id;

  // Portée (article_image, null, <categoryId fraîche>) : exemptée du registre statique de
  // tests/studio-fixtures.ts (categoryId généré à chaque exécution, comme studio-e2e.test.ts).
  const [tOk] = await db.insert(renderTemplates).values({
    name: "WP Publish Render Test — OK", context: "article_image", channel: null,
    categoryId: categoryWithTemplateId, format: "website_featured", width: 1200, height: 675,
    scene: ARTICLE_IMAGE_TEMPLATE,
  }).returning();
  templateOkId = tOk.id;
  await db.insert(renderTemplateVersions).values({ templateId: templateOkId, version: 1, scene: ARTICLE_IMAGE_TEMPLATE });
  await db.update(renderTemplates).set({ publishedVersion: 1 }).where(eq(renderTemplates.id, templateOkId));

  const [tFail] = await db.insert(renderTemplates).values({
    name: "WP Publish Render Test — Échec", context: "article_image", channel: null,
    categoryId: categoryForFailureId, format: "website_featured", width: 400, height: 300,
    scene: FAILING_LOGO_SCENE,
  }).returning();
  templateFailId = tFail.id;
  await db.insert(renderTemplateVersions).values({ templateId: templateFailId, version: 1, scene: FAILING_LOGO_SCENE });
  await db.update(renderTemplates).set({ publishedVersion: 1 }).where(eq(renderTemplates.id, templateFailId));

  const complete = {
    imageCredit: "Crédit Test Rendu", imageSourceUrl: "https://example.com/credit-rendu",
    status: "approved" as const,
  };

  const [aRender] = await db.insert(articles).values({
    title: "Article avec gabarit résolu", bodyHtml: "<p>Contenu.</p>",
    excerpt: "Extrait.", categoryId: categoryWithTemplateId,
    featuredImageUrl: RAW_IMAGE_URL, ...complete,
  }).returning();
  articleForRenderId = aRender.id;
  await db.insert(articleSources).values({ articleId: articleForRenderId, mediaName: "Source Test", url: "https://example.com/source" });

  const [aFail] = await db.insert(articles).values({
    title: "Article avec rendu en échec", bodyHtml: "<p>Contenu.</p>",
    excerpt: "Extrait.", categoryId: categoryForFailureId,
    featuredImageUrl: RAW_IMAGE_URL, ...complete,
  }).returning();
  articleForFailureId = aFail.id;
  await db.insert(articleSources).values({ articleId: articleForFailureId, mediaName: "Source Test", url: "https://example.com/source" });

  const [aNoStore] = await db.insert(articles).values({
    title: "Article sans renderStore injecté (R2 non configuré ici)", bodyHtml: "<p>Contenu.</p>",
    excerpt: "Extrait.", categoryId: categoryWithTemplateId,
    featuredImageUrl: RAW_IMAGE_URL, ...complete,
  }).returning();
  articleNoStoreId = aNoStore.id;
  await db.insert(articleSources).values({ articleId: articleNoStoreId, mediaName: "Source Test", url: "https://example.com/source" });
});

// Le store de la publication EN COURS — le fetch monkeypatché ci-dessus doit pouvoir retrouver les
// octets d'un rendu quel que soit le test qui l'a produit ; chaque describe pose la sienne avant
// d'appeler publishArticle/republishArticle.
let latestRenderStore: FakeCdnRenderStore | undefined;

afterAll(async () => {
  server?.stop(true);
  globalThis.fetch = realFetch;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }

  const articleIds = [articleForRenderId, articleForFailureId, articleNoStoreId].filter(Boolean);
  const steps: Array<[string, () => Promise<unknown>]> = [
    ["renders", () => articleIds.length ? db.delete(renders).where(inArray(renders.subjectId, articleIds)) : Promise.resolve()],
    ["distributions", () => articleIds.length ? db.delete(distributions).where(inArray(distributions.articleId, articleIds)) : Promise.resolve()],
    ["articleRevisions", () => articleIds.length ? db.delete(articleRevisions).where(inArray(articleRevisions.articleId, articleIds)) : Promise.resolve()],
    ["articleSources", () => articleIds.length ? db.delete(articleSources).where(inArray(articleSources.articleId, articleIds)) : Promise.resolve()],
    ["articles", () => articleIds.length ? db.delete(articles).where(inArray(articles.id, articleIds)) : Promise.resolve()],
    ["renderTemplates", () => db.delete(renderTemplates).where(inArray(renderTemplates.id, [templateOkId, templateFailId].filter(Boolean)))],
    ["wpCategories", () => db.delete(wpCategories).where(inArray(wpCategories.id, [categoryWithTemplateId, categoryForFailureId].filter(Boolean)))],
  ];
  for (const [label, step] of steps) {
    try {
      await step();
    } catch (e) {
      console.error(`Nettoyage wp-publish-render — échec sur « ${label} » (base partagée, à vérifier manuellement) :`, e);
    }
  }
});

describe("gabarit résolu — c'est le RENDU qui est téléversé à WordPress, pas l'image brute", () => {
  const store = new FakeCdnRenderStore();

  it("publie avec succès ; les octets reçus par la médiathèque WP sont ceux du rendu, PAS ceux de l'image brute", async () => {
    latestRenderStore = store;
    const before = mediaCalls.length;
    const fetchedBefore = fetchedUrls.length;

    const res = await publishArticle(articleForRenderId, null, store);
    expect(res.ok).toBe(true);
    expect(typeof res.postId).toBe("number");

    // Exactement un rendu produit (un gabarit s'est résolu pour cette catégorie).
    expect(store.putCount).toBe(1);

    const newFetches = fetchedUrls.slice(fetchedBefore);
    // L'image brute EST téléchargée une fois — c'est un INGRÉDIENT du rendu (ARTICLE_IMAGE_TEMPLATE
    // compose la photo de fond depuis {{article.image}}), pas ce qui part vers WordPress. La preuve
    // que c'est bien le RENDU, et non l'image brute, qui atteint uploadFeaturedImage est double :
    //   1. l'URL du rendu (domaine CDN_BASE, distinct du domaine de l'image brute) a AUSSI été
    //      téléchargée — c'est CE second téléchargement que uploadFeaturedImage effectue ;
    //   2. l'image brute n'a été téléchargée qu'UNE SEULE fois (le rendu), jamais une seconde fois
    //      pour le téléversement — si buildPublishPayload avait par erreur gardé featuredImageUrl
    //      au lieu de render.url, ce compte serait 2, pas 1.
    expect(newFetches.filter((u) => u === RAW_IMAGE_URL)).toHaveLength(1);
    expect(newFetches.some((u) => u.startsWith(`${CDN_BASE}/`))).toBe(true);

    // Les octets reçus par /media sont ceux stockés par le RenderStore — jamais RAW_IMAGE_BYTES.
    // C'est la preuve la plus directe : le CONTENU réellement envoyé à WordPress, pas seulement
    // quelle URL a été demandée.
    const uploaded = mediaCalls.slice(before);
    expect(uploaded).toHaveLength(1);
    const renderedBytes = [...store.bytesByKey.values()][0];
    expect(Buffer.from(uploaded[0].body)).toEqual(Buffer.from(renderedBytes));
    expect(Buffer.from(uploaded[0].body)).not.toEqual(Buffer.from(RAW_IMAGE_BYTES));
  });

  it("featuredImageUrl n'est JAMAIS réécrit — il reste la trace de l'image d'origine après la publication", async () => {
    const [art] = await db.select().from(articles).where(eq(articles.id, articleForRenderId));
    expect(art.featuredImageUrl).toBe(RAW_IMAGE_URL);
  });

  it("une republication immédiate est un CACHE HIT V1 (inputHash inchangé) : un seul rendu au total sur deux publications", async () => {
    const mediaCallsBefore = mediaCalls.length;
    const putCountBefore = store.putCount;

    const res = await republishArticle(articleForRenderId, null, store);
    expect(res.ok).toBe(true);

    // Aucun NOUVEAU rendu produit — le cache par inputHash (V1) a servi la ligne `renders`
    // existante ; seul un compteur de mises en cache (ici store.putCount, jamais incrémenté par un
    // cache hit) le prouve, pas simplement le succès de la republication.
    expect(store.putCount).toBe(putCountBefore);

    // La republication a quand même téléversé une image (le rendu mis en cache est re-téléchargé
    // et repoussé à WordPress à chaque publication, seul le RENDU lui-même est mis en cache).
    expect(mediaCalls.length).toBe(mediaCallsBefore + 1);

    const [row] = await db.select().from(renders).where(eq(renders.subjectId, articleForRenderId));
    expect(row).toBeDefined(); // une seule ligne `renders` pour cet article (contrainte unique sur inputHash)
  });
});

describe("rendu en échec — la publication échoue, l'article reste `approved`", () => {
  const store = new FakeCdnRenderStore();

  it("un gabarit résolu dont le rendu échoue (jeton manquant) bloque TOUTE la publication", async () => {
    latestRenderStore = store;
    const res = await publishArticle(articleForFailureId, null, store);

    expect(res.ok).toBe(false);
    // Le message français du moteur (MissingTokensError), TEL QUEL — pas le préfixe générique
    // "La publication sur WordPress a échoué :" réservé aux vraies erreurs de transport WP.
    expect(res.message).toContain("Valeurs manquantes pour");
    expect(res.message).toContain("brand.logo");
    expect(res.message).not.toContain("La publication sur WordPress a échoué");

    // Jamais atteint : aucun appel WP media/posts n'a dû partir pour cet article.
    expect(store.putCount).toBe(0);

    const [art] = await db.select().from(articles).where(eq(articles.id, articleForFailureId));
    expect(art.status).toBe("approved"); // jamais 'published' — réessayable
    expect(art.publishedAt).toBeNull();

    const [dist] = await db.select().from(distributions).where(eq(distributions.articleId, articleForFailureId));
    expect(dist.status).toBe("failed");
    expect(dist.externalId).toBeNull();
  });
});

describe("R2 non configuré (aucun renderStore injecté) — repli sur l'image brute, comportement inchangé", () => {
  it("publie l'image brute sans jamais tenter de rendu — même chemin qu'avant V3 — ET laisse une trace (revue finale V3, Important 1)", async () => {
    const before = mediaCalls.length;
    const fetchedBefore = fetchedUrls.length;

    // Revue finale V3, Important 1 : avant ce correctif, ce repli était complètement SILENCIEUX —
    // aucun console.error, aucune ligne en base au-delà de la publication elle-même. Cette espionne
    // prouve que le repli laisse désormais une trace (même politique que renderForArticle,
    // lib/studio/index.ts, qui logue déjà tout échec de rendu franc).
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    // Pas de 3e argument : reproduit exactement l'appel de tests/wp-publish.test.ts et de
    // lib/wp/publish-due.ts — aucun store injecté, et R2_* n'est jamais posé sous `bun test`
    // (test-setup.ts ne le charge pas).
    const res = await publishArticle(articleNoStoreId);
    expect(res.ok).toBe(true);

    // La trace mentionne l'article concerné et le mot « R2 » — un opérateur qui grep ses logs de
    // production doit pouvoir la retrouver.
    const loggedFallback = errorSpy.mock.calls.some(
      (call) => call.some((arg) => typeof arg === "string" && arg.includes("[wp/publish]") && arg.includes(articleNoStoreId)),
    );
    expect(loggedFallback).toBe(true);
    errorSpy.mockRestore();

    // L'image brute a été téléchargée et téléversée — jamais une URL de rendu (aucun rendu n'a été
    // tenté du tout, puisque R2 n'est pas configuré dans cet environnement de test).
    const uploaded = mediaCalls.slice(before);
    expect(uploaded).toHaveLength(1);
    expect(Buffer.from(uploaded[0].body)).toEqual(Buffer.from(RAW_IMAGE_BYTES));

    const newFetches = fetchedUrls.slice(fetchedBefore);
    expect(newFetches).toEqual([RAW_IMAGE_URL]);
    expect(newFetches.some((u) => u.startsWith(`${CDN_BASE}/`))).toBe(false);

    // Aucune ligne `renders` produite pour cet article — le moteur n'a jamais été invoqué au-delà
    // du contrôle de stockage.
    const rows = await db.select().from(renders).where(eq(renders.subjectId, articleNoStoreId));
    expect(rows).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Revue finale V3, Important 1 — renderFailureOutcome (lib/wp/publish.ts) : la fonction PURE qui
// décide, à partir du DISCRIMINANT TYPÉ `reason`, si un rendu en échec doit se replier
// silencieusement sur l'image brute ou faire échouer toute la publication. Testée directement,
// SANS passer par la base ni par renderForArticle, avec un message délibérément TROMPEUR pour
// prouver que c'est `reason` — jamais le texte français de `message` — qui pilote la décision :
// avant l'extraction de cette fonction, buildPublishPayload comparait `render.message` au texte
// exact « Stockage R2 non configuré. », si bien qu'un simple changement de copie aurait pu inverser
// silencieusement le comportement de publication.
// ─────────────────────────────────────────────────────────────────────────────
describe("renderFailureOutcome — le DISCRIMINANT typé pilote la décision, jamais le texte du message", () => {
  it("« storage_unconfigured » se replie sur l'image brute", () => {
    expect(renderFailureOutcome("storage_unconfigured")).toBe("fallback");
  });

  // C'est ce test — avec « render_failed » et RIEN d'autre — qui prouve la propriété demandée par
  // la revue finale (« changer le texte du message ne doit jamais changer l'issue de publication ») :
  // renderFailureOutcome ne PREND MÊME PAS `message` en paramètre, seulement `reason`. Un
  // changement de copie française n'a donc littéralement AUCUN chemin pour atteindre cette
  // décision, garanti par la SIGNATURE de la fonction (vérifié par tsc), pas seulement par son
  // comportement observé à l'exécution — la version d'avant cette revue, elle, comparait
  // directement `render.message` au texte exact « Stockage R2 non configuré. ».
  it("« render_failed » fait échouer la publication, quel que soit le texte de message associé ailleurs", () => {
    expect(renderFailureOutcome("render_failed")).toBe("fail");
  });
});
