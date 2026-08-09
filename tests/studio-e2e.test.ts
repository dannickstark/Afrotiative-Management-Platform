import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import sharp from "sharp";
import { db, renderTemplates, renderTemplateVersions, articles, wpCategories, renders } from "@/db";
import { eq, inArray } from "drizzle-orm";
import { renderForArticle } from "@/lib/studio";
import { MemoryRenderStore } from "@/lib/studio/store";
import { validateScene } from "@/lib/studio/tokens";
import { parseScene } from "@/lib/studio/scene";
import { ARTICLE_IMAGE_TEMPLATE, FB_TEMPLATE, IG_TEMPLATE } from "@/db/studio-templates";

let articleId: string;
let categoryId: string;
let templateId: string;
let server: ReturnType<typeof Bun.serve>;
// Compte les requêtes HTTP reçues par le serveur fixture — c'est ce qui permet à l'assertion de
// cache plus bas de prouver qu'un SECOND rendu n'a réellement PAS eu lieu (pas seulement que le
// deuxième appel a réussi) : un cache défaillant qui re-rendrait silencieusement déclencherait un
// second téléchargement de l'image, incrémentant ce compteur.
let imageRequests = 0;

beforeAll(async () => {
  const png = await sharp({
    create: { width: 900, height: 900, channels: 3, background: { r: 30, g: 90, b: 40 } },
  }).png().toBuffer();
  server = Bun.serve({
    port: 0,
    fetch: () => {
      imageRequests++;
      return new Response(png, { headers: { "content-type": "image/png" } });
    },
  });

  const [c] = await db.insert(wpCategories).values({
    name: "E2E Agri", slug: `e2e-agri-${Date.now()}`, color: "#1B7F4A",
  }).returning();
  categoryId = c.id;

  const [a] = await db.insert(articles).values({
    title: "Le cacao camerounais bat un record d'exportation",
    bodyHtml: "<p>x</p>", excerpt: "Chapô.", categoryId,
    featuredImageUrl: `http://127.0.0.1:${server.port}/photo.png`,
    imageCredit: "Reuters", status: "approved",
  }).returning();
  articleId = a.id;

  // Scopé à CETTE catégorie (pas categoryId: null) : `bun run db:studio-templates` (exécuté en
  // production comme en développement, y compris avant cette suite) sème un gabarit par défaut
  // pour exactement (article_image, null, null) — un second gabarit publié sur la même portée
  // violerait l'index unique render_templates_scope. Utiliser la catégorie du test exerce en plus
  // le niveau de repli PRINCIPAL du contexte article_image, (context, null, categoryId), documenté
  // en §5 de la spec : celui-ci n'a jamais de canal, donc c'est ce niveau — pas le repli générique
  // final — que resolveTemplate doit trouver en premier ici.
  const [t] = await db.insert(renderTemplates).values({
    name: "E2E", context: "article_image", channel: null, categoryId,
    format: "website_featured", width: 1200, height: 675, scene: ARTICLE_IMAGE_TEMPLATE,
  }).returning();
  templateId = t.id;
  await db.insert(renderTemplateVersions).values({ templateId, version: 1, scene: ARTICLE_IMAGE_TEMPLATE });
  await db.update(renderTemplates).set({ publishedVersion: 1 }).where(eq(renderTemplates.id, templateId));
});

afterAll(async () => {
  await db.delete(renders).where(eq(renders.subjectId, articleId));
  await db.delete(renderTemplates).where(inArray(renderTemplates.id, [templateId]));
  await db.delete(articles).where(inArray(articles.id, [articleId]));
  await db.delete(wpCategories).where(eq(wpCategories.id, categoryId));
  server.stop(true);
});

describe("gabarits de départ", () => {
  // Les TROIS gabarits hérités par FB_TEMPLATE/IG_TEMPLATE (spread + map de ARTICLE_IMAGE_TEMPLATE,
  // db/studio-templates.ts) doivent chacun rester une scène valide pour LEUR PROPRE contexte —
  // pas seulement le premier : un ".map" qui casse discrètement un champ sur le calque titre
  // (le point exact que le cast retiré de IG_TEMPLATE aurait pu masquer) ne serait détecté par
  // aucun test si seul ARTICLE_IMAGE_TEMPLATE était vérifié ici.
  it("sont des scènes valides pour leur contexte", () => {
    expect(validateScene(parseScene(ARTICLE_IMAGE_TEMPLATE), "article_image")).toEqual([]);
    expect(validateScene(parseScene(FB_TEMPLATE), "social_post")).toEqual([]);
    expect(validateScene(parseScene(IG_TEMPLATE), "social_post")).toEqual([]);
  });
});

describe("renderForArticle — bout en bout", () => {
  it("rend, stocke et met en cache", async () => {
    const store = new MemoryRenderStore();
    // fetchImpl: le serveur fixture ci-dessus tourne en local (127.0.0.1) — le garde SSRF partagé
    // le refuserait sinon. Même mécanisme que tests/studio-images.test.ts et
    // tests/studio-render.test.ts : la levée du garde exige EN PLUS NODE_ENV === "test" (déjà le
    // cas sous `bun test`), donc ce paramètre n'ouvre aucune brèche en production.
    const first = await renderForArticle(articleId, { context: "article_image", store, fetchImpl: fetch });
    expect(first.ok).toBe(true);
    if (!first.ok || !first.url) throw new Error("rendu attendu");
    expect(store.objects.size).toBe(1);
    expect(imageRequests).toBe(1); // un rendu = un téléchargement de l'image de fond

    const bytes = [...store.objects.values()][0];
    const meta = await sharp(Buffer.from(bytes)).metadata();
    expect(meta.width).toBe(1200);
    expect(meta.height).toBe(675);

    // La scène a réellement été PEINTE (photo de fond, bordure catégorie, titre blanc), pas
    // seulement des dimensions correctes sur un canevas vide : un canevas non peint serait uni à
    // la couleur de fond du gabarit (#0B0B0B) et aurait un écart-type de canal proche de zéro. Le
    // titre en blanc plein sur un fond sombre, à lui seul, garantit un écart-type élevé.
    const stats = await sharp(Buffer.from(bytes)).stats();
    expect(stats.channels[0].stdev).toBeGreaterThan(20);

    // Deuxième appel : servi par le cache, aucun nouvel objet stocké — ET surtout aucun second
    // rendu déclenché. `store.objects.size` seul ne le prouverait pas (un second rendu produisant
    // exactement les mêmes octets écraserait la même clé sans changer la taille de la Map) ; le
    // compteur de requêtes, lui, ne peut augmenter QUE si l'image de fond a été retéléchargée, ce
    // qui n'arrive que sur un vrai rendu.
    const second = await renderForArticle(articleId, { context: "article_image", store, fetchImpl: fetch });
    if (!second.ok) throw new Error("rendu attendu");
    expect(second.renderId).toBe(first.renderId);
    expect(store.objects.size).toBe(1);
    expect(imageRequests).toBe(1);
  });

  it("renvoie url:null quand aucun gabarit ne correspond au contexte", async () => {
    const r = await renderForArticle(articleId, { context: "recap_card", store: new MemoryRenderStore() });
    expect(r).toEqual({ ok: true, url: null, renderId: null, degraded: false });
  });
});
