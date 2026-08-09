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
  // server.stop() D'ABORD, inconditionnellement : si un beforeAll partiel ou une suppression
  // ci-dessous lève, le serveur fixture ne doit jamais rester ouvert.
  server?.stop(true);

  // Chaque suppression est gardée par la présence de son id (un beforeAll qui échoue à mi-chemin —
  // ex. l'insertion de renderTemplates — laisse templateId à undefined alors qu'articleId et
  // categoryId sont déjà posés) ET isolée dans son propre try/catch : sans ça, la suppression d'un
  // id manquant ou une erreur sur UNE ligne ferait échouer tout le reste de afterAll, laissant fuir
  // les lignes suivantes dans la base partagée. L'ordre (renders -> renderTemplates -> articles ->
  // wpCategories) respecte les contraintes de clé étrangère (articles.category_id et
  // render_templates.category_id référencent wp_categories).
  const steps: Array<[string, () => Promise<unknown>]> = [
    ["renders", () => articleId ? db.delete(renders).where(eq(renders.subjectId, articleId)) : Promise.resolve()],
    ["renderTemplates", () => templateId ? db.delete(renderTemplates).where(inArray(renderTemplates.id, [templateId])) : Promise.resolve()],
    ["articles", () => articleId ? db.delete(articles).where(inArray(articles.id, [articleId])) : Promise.resolve()],
    ["wpCategories", () => categoryId ? db.delete(wpCategories).where(eq(wpCategories.id, categoryId)) : Promise.resolve()],
  ];
  for (const [label, step] of steps) {
    try {
      await step();
    } catch (e) {
      console.error(`Nettoyage e2e — échec sur « ${label} » (base partagée, à vérifier manuellement) :`, e);
    }
  }
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

    // La PHOTO DE FOND spécifiquement a été peinte, pas seulement « quelque chose de non uniforme » :
    // un écart-type de canal élevé ne le prouve PAS — le titre blanc seul sur fond sombre suffit à
    // produire un écart-type élevé même si element.ts avait silencieusement ignoré le calque `bg`
    // (voir le `continue` sur URI manquante, lib/studio/element.ts). Vérifié empiriquement : en
    // rendant la même scène SANS le calque `bg`, l'écart-type du canal rouge reste à 43.6 (contre
    // 43.5 avec) — un faux positif total pour ce genre de test.
    // La couleur de la photo fixture ci-dessus (r:30, g:90, b:40 — nettement plus verte que rouge)
    // laisse une signature que le reste de la scène n'a pas : bordure et texte de catégorie sont
    // dans la même teinte verte que la photo mais couvrent une surface bien plus petite. Comparer
    // canal G à canal R discrimine donc la présence réelle de la photo : ~44 vs ~20 (bg présent)
    // contre ~26 vs ~20 (bg absent, écart insuffisant) — vérifié empiriquement en supprimant le
    // calque `bg` de la scène et confirmant que cette assertion échoue alors (voir le rapport de
    // tâche pour le détail des deux mesures).
    const stats = await sharp(Buffer.from(bytes)).stats();
    expect(stats.channels[1].mean).toBeGreaterThan(stats.channels[0].mean + 10);

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
