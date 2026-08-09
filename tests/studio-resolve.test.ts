import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { db, renderTemplates, renderTemplateVersions, wpCategories } from "@/db";
import { inArray, eq } from "drizzle-orm";
import { resolveTemplate } from "@/lib/studio/resolve";
import type { TemplateContext } from "@/lib/studio/tokens";
import { deleteTemplateScope } from "./studio-fixtures";

// Canaux synthétiques, PAS de vrais membres de CHANNELS ("x", "tiktok", "whatsapp") : voir
// tests/studio-fixtures.ts règle 3 — un vrai canal peut un jour recevoir un gabarit de départ réel
// (db/studio-templates.ts), auquel cas son usage ici comme "portée connue vide" casserait.
const CHANNEL_NEVER_PUBLISHED = "test-repli-jamais-publie"; // ex-"x"
const CHANNEL_PUBLISHED_SNAPSHOT = "test-repli-instantane-publie"; // ex-"tiktok"
const CHANNEL_NO_TEMPLATE_AT_ALL = "test-repli-canal-inexistant"; // ex-"whatsapp", jamais inséré

const templateIds: string[] = [];
let categoryId: string;

function sceneWithTitle(title: string) {
  return {
    schemaVersion: 1,
    canvas: { width: 1200, height: 630, background: "#000000" },
    layers: [{
      id: "t", name: title, visible: true, locked: false, frame: { x: 0, y: 0, w: 10, h: 10 },
      type: "text", content: title, font: { family: "Noto Sans", size: 10, weight: 400 },
      color: "#FFFFFF", align: "left", vAlign: "top", lineHeight: 1.2,
    }],
  };
}

async function makeTemplate(o: {
  // Défaut "social_post" pour ne pas toucher les tests existants ; un contexte distinct
  // ("article_image") est utilisé pour le repli catégorie-sans-canal, afin d'éviter tout conflit
  // avec les portées "social_post" déjà occupées par les fixtures précédentes (index d'unicité
  // NULLS NOT DISTINCT sur (context, channel, category_id)).
  context?: TemplateContext;
  channel: string | null; categoryId: string | null; publish: string | null; draft: string; archived?: boolean;
}) {
  const [t] = await db.insert(renderTemplates).values({
    name: o.draft, context: o.context ?? "social_post", channel: o.channel, categoryId: o.categoryId,
    format: "fb_link", width: 1200, height: 630, scene: sceneWithTitle(o.draft),
    archived: o.archived ?? false,
  }).returning();
  templateIds.push(t.id);
  if (o.publish) {
    await db.insert(renderTemplateVersions).values({ templateId: t.id, version: 1, scene: sceneWithTitle(o.publish) });
    await db.update(renderTemplates).set({ publishedVersion: 1 }).where(eq(renderTemplates.id, t.id));
  }
  return t;
}

beforeAll(async () => {
  // Delete-then-insert des portées STATIQUES que ce fichier possède (voir tests/studio-fixtures.ts
  // pour la règle et le registre complet) : répare une exécution interrompue au lieu de laisser une
  // ligne poison casser SQLSTATE 23505 sur toutes les exécutions suivantes, y compris dans D'AUTRES
  // fichiers pour (quote_card, null, null).
  await deleteTemplateScope("social_post", CHANNEL_NEVER_PUBLISHED, null);
  await deleteTemplateScope("social_post", CHANNEL_PUBLISHED_SNAPSHOT, null);
  await deleteTemplateScope("social_post", "test-priorite-canal", null);
  await deleteTemplateScope("social_post", null, null);
  await deleteTemplateScope("quote_card", null, null);

  const [c] = await db.insert(wpCategories).values({
    name: `Studio test ${Date.now()}`, slug: `studio-test-${Date.now()}`,
  }).returning();
  categoryId = c.id;
});

afterAll(async () => {
  if (templateIds.length) await db.delete(renderTemplates).where(inArray(renderTemplates.id, templateIds));
  await db.delete(wpCategories).where(eq(wpCategories.id, categoryId));
});

describe("resolveTemplate", () => {
  it("renvoie null quand aucun gabarit ne correspond", async () => {
    expect(await resolveTemplate({ context: "recap_card" })).toBeNull();
  });

  it("ignore un gabarit jamais publié", async () => {
    await makeTemplate({ channel: CHANNEL_NEVER_PUBLISHED, categoryId: null, publish: null, draft: "brouillon" });
    expect(await resolveTemplate({ context: "social_post", channel: CHANNEL_NEVER_PUBLISHED })).toBeNull();
  });

  it("renvoie l'INSTANTANÉ PUBLIÉ, pas le brouillon de travail", async () => {
    await makeTemplate({ channel: CHANNEL_PUBLISHED_SNAPSHOT, categoryId: null, publish: "publié", draft: "brouillon" });
    const r = await resolveTemplate({ context: "social_post", channel: CHANNEL_PUBLISHED_SNAPSHOT });
    const layer = r!.scene.layers[0];
    if (layer.type !== "text") throw new Error("type");
    expect(layer.content).toBe("publié");
  });

  // Canal "test-priorite-canal", PAS "instagram" : `bun run db:studio-templates`
  // (db/studio-templates.ts) sème désormais en base un gabarit par défaut réel et permanent à la
  // portée EXACTE (social_post, instagram, null) — le premier makeTemplate() ci-dessous entrerait
  // en collision avec lui. La colonne `channel` est du texte libre (aucun enum Postgres, voir
  // db/schema.ts), un canal synthétique qui n'existe dans aucun gabarit de départ est donc sûr ici.
  it("préfère (contexte, canal, catégorie) au défaut de canal", async () => {
    await makeTemplate({ channel: "test-priorite-canal", categoryId: null, publish: "défaut-canal", draft: "d" });
    await makeTemplate({ channel: "test-priorite-canal", categoryId, publish: "spécifique", draft: "d" });
    const r = await resolveTemplate({ context: "social_post", channel: "test-priorite-canal", categoryId });
    const layer = r!.scene.layers[0];
    if (layer.type !== "text") throw new Error("type");
    expect(layer.content).toBe("spécifique");
  });

  it("retombe sur le défaut de canal quand la catégorie n'a pas de gabarit", async () => {
    const r = await resolveTemplate({ context: "social_post", channel: "test-priorite-canal", categoryId: null });
    const layer = r!.scene.layers[0];
    if (layer.type !== "text") throw new Error("type");
    expect(layer.content).toBe("défaut-canal");
  });

  it("retombe sur le défaut de contexte quand le canal n'a pas de gabarit", async () => {
    await makeTemplate({ channel: null, categoryId: null, publish: "défaut-contexte", draft: "d" });
    const r = await resolveTemplate({ context: "social_post", channel: CHANNEL_NO_TEMPLATE_AT_ALL });
    const layer = r!.scene.layers[0];
    if (layer.type !== "text") throw new Error("type");
    expect(layer.content).toBe("défaut-contexte");
  });

  it("préfère (contexte, canal, null) au défaut de contexte quand les deux existent", async () => {
    // Réutilise le gabarit CHANNEL_PUBLISHED_SNAPSHOT créé plus haut (défaut de canal, publié =
    // « publié ») : à ce stade, le défaut de contexte créé par le test précédent existe aussi en
    // base. Les deux niveaux sont donc simultanément valides pour ce canal — si le résolveur consultait le défaut
    // de contexte avant le défaut de canal (ordre inversé), ce test échouerait. Aucun des tests
    // précédents ne peut détecter une telle inversion : chacun n'a jamais qu'un seul des deux
    // niveaux valide au moment de la requête.
    const r = await resolveTemplate({ context: "social_post", channel: CHANNEL_PUBLISHED_SNAPSHOT });
    const layer = r!.scene.layers[0];
    if (layer.type !== "text") throw new Error("type");
    expect(layer.content).toBe("publié");
  });

  // Réutilise CHANNEL_NEVER_PUBLISHED — PAS "facebook" : "facebook" a désormais un gabarit de départ
  // réel (non archivé, publié) permanent en base à (social_post, facebook, null), qui l'emporterait
  // sur le repli attendu ici. CHANNEL_NEVER_PUBLISHED est sûr à réutiliser : le brouillon non publié
  // créé par « ignore un gabarit jamais publié » ci-dessus occupe déjà cette portée mais reste
  // invisible au résolveur (publishedVersion NULL) ; ce test y ajoute une ligne ARCHIVÉE, elle aussi
  // invisible (archived = true), et l'index unique ne s'applique qu'aux lignes non archivées.
  it("ignore un gabarit archivé", async () => {
    await makeTemplate({ channel: CHANNEL_NEVER_PUBLISHED, categoryId: null, publish: "archivé", draft: "d", archived: true });
    const r = await resolveTemplate({ context: "social_post", channel: CHANNEL_NEVER_PUBLISHED });
    const layer = r!.scene.layers[0];
    if (layer.type !== "text") throw new Error("type");
    expect(layer.content).toBe("défaut-contexte");
  });

  // ---- Quatrième palier (context, null, categoryId) — repli catégorie SANS canal. C'est le
  // chemin PRINCIPAL du contexte "article_image" : une image à la une n'a pas de canal (ce n'est
  // pas un post social), toute résolution y arrive donc comme { context: "article_image",
  // channel: null, categoryId: <catégorie de l'article> }. Contexte dédié pour ne pas entrer en
  // conflit avec les portées "social_post" déjà occupées plus haut.
  it("résout (contexte, null, catégorie) sans canal", async () => {
    await makeTemplate({
      context: "article_image", channel: null, categoryId, publish: "catégorie-sans-canal", draft: "d",
    });
    const r = await resolveTemplate({ context: "article_image", categoryId });
    const layer = r!.scene.layers[0];
    if (layer.type !== "text") throw new Error("type");
    expect(layer.content).toBe("catégorie-sans-canal");
  });

  it("préfère (contexte, null, catégorie) au défaut de contexte quand les deux existent", async () => {
    // Contexte "quote_card", délibérément DIFFÉRENT de "article_image" utilisé par le test
    // précédent : `bun run db:studio-templates` sème désormais en base un gabarit par défaut réel
    // et permanent à la portée EXACTE (article_image, null, null) — y insérer un second gabarit
    // (même pour un autre test) violerait l'index unique render_templates_scope. "quote_card" n'a
    // aucun gabarit de départ semé, donc ce test construit lui-même, de façon autonome, les DEUX
    // paliers qu'il compare (la logique de préséance testée est générique à resolveTemplate, pas
    // spécifique à article_image — le choix du contexte importe seulement pour ne pas percuter les
    // gabarits de départ réels).
    //
    // (quote_card, null, null) : CE fichier en est l'unique propriétaire (voir
    // tests/studio-fixtures.ts) — channel DOIT rester null, c'est précisément le repli de contexte
    // sans canal que ce test vérifie. tests/studio-schema.test.ts et tests/studio-bindings.test.ts
    // utilisent désormais des portées synthétiques distinctes pour ne plus jamais y entrer en
    // collision.
    await makeTemplate({
      context: "quote_card", channel: null, categoryId, publish: "quote-catégorie", draft: "d",
    });
    await makeTemplate({
      context: "quote_card", channel: null, categoryId: null, publish: "quote-défaut-contexte", draft: "d",
    });
    const r = await resolveTemplate({ context: "quote_card", categoryId });
    const layer = r!.scene.layers[0];
    if (layer.type !== "text") throw new Error("type");
    expect(layer.content).toBe("quote-catégorie");
  });
});
