import { describe, it, expect, afterAll } from "bun:test";
import { db, articles, articleRevisions } from "@/db";
import { eq, inArray, desc } from "drizzle-orm";
import { faker } from "@faker-js/faker";
import { applyImagePick } from "@/lib/pipeline/regen-store";

const created: string[] = [];
const candidates = [
  { url: "https://a.test/1.jpg", sourceUrl: "https://a.test/art", mediaName: "Média A" },
  { url: "https://b.test/2.jpg", sourceUrl: "https://b.test/art", mediaName: "Média B" },
];

async function seed(withImage: string | null) {
  const [a] = await db.insert(articles).values({
    title: `Article ${faker.string.uuid()}`, bodyHtml: "<p>x</p>",
    featuredImageUrl: withImage, pendingImageCandidates: candidates,
  }).returning({ id: articles.id });
  created.push(a.id);
  return a.id;
}

afterAll(async () => {
  if (created.length) await db.delete(articles).where(inArray(articles.id, created));
});

describe("applyImagePick", () => {
  it("écrit l'image choisie, vide l'attente et laisse une révision", async () => {
    const id = await seed(null);
    const r = await applyImagePick(id, { url: "https://b.test/2.jpg", credit: "Média B", sourceUrl: "https://b.test/art" }, null);
    expect(r.ok).toBe(true);
    const [row] = await db.select().from(articles).where(eq(articles.id, id));
    expect(row.featuredImageUrl).toBe("https://b.test/2.jpg");
    expect(row.imageCredit).toBe("Média B");
    expect(row.imageSourceUrl).toBe("https://b.test/art");
    expect(row.pendingImageCandidates).toBeNull();
    const [rev] = await db.select().from(articleRevisions).where(eq(articleRevisions.articleId, id)).orderBy(desc(articleRevisions.at));
    expect(rev.action).toBe("image choisie");
  });

  it("« Aucune image » vide l'attente SANS toucher l'image en place", async () => {
    const id = await seed("https://ancienne/img.jpg");
    const r = await applyImagePick(id, null, null);
    expect(r.ok).toBe(true);
    const [row] = await db.select().from(articles).where(eq(articles.id, id));
    expect(row.featuredImageUrl).toBe("https://ancienne/img.jpg");
    expect(row.pendingImageCandidates).toBeNull();
  });

  it("refuse une URL absente de la liste en attente", async () => {
    const id = await seed(null);
    const r = await applyImagePick(id, { url: "https://ailleurs.test/z.jpg", credit: null, sourceUrl: null }, null);
    expect(r.ok).toBe(false);
    const [row] = await db.select().from(articles).where(eq(articles.id, id));
    expect(row.featuredImageUrl).toBeNull();
    expect(row.pendingImageCandidates).not.toBeNull();
  });
});
