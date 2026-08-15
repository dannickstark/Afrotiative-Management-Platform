import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { db, articles } from "@/db";
import { eq, inArray } from "drizzle-orm";
import { regenerateArticle } from "@/lib/pipeline/regenerate-core";
import { faker } from "@faker-js/faker";

// regenerateArticle est le cœur unitaire partagé par regenerate (action unitaire) et
// regenerateInQueue (appelé en boucle par la barre d'actions du /queue, un article par appel).
// Il est PLAIN (pas de "use server") : ni RBAC ni revalidatePath ici, donc on peut
// l'exercer directement sous `bun test`, sans mocker session/next-cache. Le chemin complet
// (extraction réseau + IA) n'est pas testable ici — on couvre les deux retours précoces qui ne
// touchent QUE la base : « article introuvable » et « aucune source ». Fixtures auto-nettoyées.
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

afterAll(async () => {
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
});
