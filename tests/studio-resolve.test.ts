import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { db, renderTemplates, renderTemplateVersions, wpCategories } from "@/db";
import { inArray, eq } from "drizzle-orm";
import { resolveTemplate } from "@/lib/studio/resolve";

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
  channel: string | null; categoryId: string | null; publish: string | null; draft: string; archived?: boolean;
}) {
  const [t] = await db.insert(renderTemplates).values({
    name: o.draft, context: "social_post", channel: o.channel, categoryId: o.categoryId,
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
    await makeTemplate({ channel: "x", categoryId: null, publish: null, draft: "brouillon" });
    expect(await resolveTemplate({ context: "social_post", channel: "x" })).toBeNull();
  });

  it("renvoie l'INSTANTANÉ PUBLIÉ, pas le brouillon de travail", async () => {
    await makeTemplate({ channel: "tiktok", categoryId: null, publish: "publié", draft: "brouillon" });
    const r = await resolveTemplate({ context: "social_post", channel: "tiktok" });
    const layer = r!.scene.layers[0];
    if (layer.type !== "text") throw new Error("type");
    expect(layer.content).toBe("publié");
  });

  it("préfère (contexte, canal, catégorie) au défaut de canal", async () => {
    await makeTemplate({ channel: "instagram", categoryId: null, publish: "défaut-canal", draft: "d" });
    await makeTemplate({ channel: "instagram", categoryId, publish: "spécifique", draft: "d" });
    const r = await resolveTemplate({ context: "social_post", channel: "instagram", categoryId });
    const layer = r!.scene.layers[0];
    if (layer.type !== "text") throw new Error("type");
    expect(layer.content).toBe("spécifique");
  });

  it("retombe sur le défaut de canal quand la catégorie n'a pas de gabarit", async () => {
    const r = await resolveTemplate({ context: "social_post", channel: "instagram", categoryId: null });
    const layer = r!.scene.layers[0];
    if (layer.type !== "text") throw new Error("type");
    expect(layer.content).toBe("défaut-canal");
  });

  it("retombe sur le défaut de contexte quand le canal n'a pas de gabarit", async () => {
    await makeTemplate({ channel: null, categoryId: null, publish: "défaut-contexte", draft: "d" });
    const r = await resolveTemplate({ context: "social_post", channel: "whatsapp" });
    const layer = r!.scene.layers[0];
    if (layer.type !== "text") throw new Error("type");
    expect(layer.content).toBe("défaut-contexte");
  });

  it("préfère (contexte, canal, null) au défaut de contexte quand les deux existent", async () => {
    // Réutilise le gabarit « tiktok » créé plus haut (défaut de canal, publié = « publié ») : à ce
    // stade, le défaut de contexte créé par le test précédent existe aussi en base. Les deux
    // niveaux sont donc simultanément valides pour ce canal — si le résolveur consultait le défaut
    // de contexte avant le défaut de canal (ordre inversé), ce test échouerait. Aucun des tests
    // précédents ne peut détecter une telle inversion : chacun n'a jamais qu'un seul des deux
    // niveaux valide au moment de la requête.
    const r = await resolveTemplate({ context: "social_post", channel: "tiktok" });
    const layer = r!.scene.layers[0];
    if (layer.type !== "text") throw new Error("type");
    expect(layer.content).toBe("publié");
  });

  it("ignore un gabarit archivé", async () => {
    await makeTemplate({ channel: "facebook", categoryId: null, publish: "archivé", draft: "d", archived: true });
    const r = await resolveTemplate({ context: "social_post", channel: "facebook" });
    const layer = r!.scene.layers[0];
    if (layer.type !== "text") throw new Error("type");
    expect(layer.content).toBe("défaut-contexte");
  });
});
