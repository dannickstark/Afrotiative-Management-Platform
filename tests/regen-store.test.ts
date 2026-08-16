import { describe, it, expect, afterAll } from "bun:test";
import { db, articles, regenJobs, regenJobItems } from "@/db";
import { eq, inArray } from "drizzle-orm";
import { faker } from "@faker-js/faker";
import {
  openRegenJob, listJobItems, setItemStage, finishItem, isCancelRequested,
  finalizeRegenJob, readRegenJob,
} from "@/lib/pipeline/regen-store";

const ALL = { title: true, body: true, excerpt: true, category: true, tags: true, image: true };
const createdArticles: string[] = [];

async function seedArticle(): Promise<{ id: string; title: string }> {
  const title = `Article ${faker.string.uuid()}`;
  const [a] = await db.insert(articles).values({ title, bodyHtml: "<p>x</p>" }).returning({ id: articles.id });
  createdArticles.push(a.id);
  return { id: a.id, title };
}

afterAll(async () => {
  if (createdArticles.length) await db.delete(articles).where(inArray(articles.id, createdArticles));
});

describe("openRegenJob", () => {
  it("crée le job et un item par article", async () => {
    const a = await seedArticle(); const b = await seedArticle();
    const r = await openRegenJob({ actorId: null, articles: [a, b], fields: ALL, imageMode: "auto" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const view = await readRegenJob(r.jobId);
    expect(view?.total).toBe(2);
    expect(view?.done).toBe(0);
    expect(view?.status).toBe("running");
    expect(view?.items.map((i) => i.title).sort()).toEqual([a.title, b.title].sort());
    expect(view?.items.every((i) => i.stage === "queued" && i.status === "pending")).toBe(true);
  });

  it("refuse un article déjà présent dans un job en vol", async () => {
    const a = await seedArticle();
    const first = await openRegenJob({ actorId: null, articles: [a], fields: ALL, imageMode: "auto" });
    expect(first.ok).toBe(true);
    const second = await openRegenJob({ actorId: null, articles: [a], fields: ALL, imageMode: "auto" });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.message).toContain("déjà en cours");
  });

  it("un article redevient éligible une fois son item terminé", async () => {
    const a = await seedArticle();
    const first = await openRegenJob({ actorId: null, articles: [a], fields: ALL, imageMode: "auto" });
    if (!first.ok) throw new Error("setup");
    const [item] = await listJobItems(first.jobId);
    await finishItem(item.id, "ok", null);
    const second = await openRegenJob({ actorId: null, articles: [a], fields: ALL, imageMode: "auto" });
    expect(second.ok).toBe(true);
  });
});

describe("avancement et clôture", () => {
  it("setItemStage / finishItem incrémentent done et alimentent la vue", async () => {
    const a = await seedArticle(); const b = await seedArticle();
    const r = await openRegenJob({ actorId: null, articles: [a, b], fields: ALL, imageMode: "auto" });
    if (!r.ok) throw new Error("setup");
    const items = await listJobItems(r.jobId);
    await setItemStage(items[0].id, "extracting");
    let view = await readRegenJob(r.jobId);
    expect(view?.items.find((i) => i.id === items[0].id)?.stage).toBe("extracting");
    await finishItem(items[0].id, "ok", null);
    await finishItem(items[1].id, "failed", "boum");
    view = await readRegenJob(r.jobId);
    expect(view?.done).toBe(2);
    expect(view?.items.find((i) => i.id === items[1].id)?.message).toBe("boum");
  });

  it("finalizeRegenJob : failed seulement si TOUS les items ont échoué", async () => {
    const a = await seedArticle(); const b = await seedArticle();
    const r = await openRegenJob({ actorId: null, articles: [a, b], fields: ALL, imageMode: "auto" });
    if (!r.ok) throw new Error("setup");
    const items = await listJobItems(r.jobId);
    await finishItem(items[0].id, "failed", "boum");
    await finishItem(items[1].id, "awaiting_image", null);
    await finalizeRegenJob(r.jobId);
    expect((await readRegenJob(r.jobId))?.status).toBe("done");

    const c = await seedArticle();
    const r2 = await openRegenJob({ actorId: null, articles: [c], fields: ALL, imageMode: "auto" });
    if (!r2.ok) throw new Error("setup");
    const [only] = await listJobItems(r2.jobId);
    await finishItem(only.id, "failed", "boum");
    await finalizeRegenJob(r2.jobId);
    expect((await readRegenJob(r2.jobId))?.status).toBe("failed");
  });

  it("isCancelRequested reflète le drapeau", async () => {
    const a = await seedArticle();
    const r = await openRegenJob({ actorId: null, articles: [a], fields: ALL, imageMode: "auto" });
    if (!r.ok) throw new Error("setup");
    expect(await isCancelRequested(r.jobId)).toBe(false);
    await db.update(regenJobs).set({ cancelRequested: true }).where(eq(regenJobs.id, r.jobId));
    expect(await isCancelRequested(r.jobId)).toBe(true);
  });

  it("un article d'un job ANNULÉ redevient éligible à un nouveau job", async () => {
    const a = await seedArticle(); const b = await seedArticle();
    const r = await openRegenJob({ actorId: null, articles: [a, b], fields: ALL, imageMode: "auto" });
    if (!r.ok) throw new Error("setup");
    const items = await listJobItems(r.jobId);
    // Un seul item traité, puis annulation : l'autre reste ouvert si finalizeRegenJob ne le ferme pas.
    await finishItem(items[0].id, "ok", null);
    await db.update(regenJobs).set({ cancelRequested: true }).where(eq(regenJobs.id, r.jobId));
    await finalizeRegenJob(r.jobId);

    expect((await readRegenJob(r.jobId))?.status).toBe("cancelled");
    // `done` reste à 1 : le compteur reflète le travail réel, pas la fermeture administrative.
    expect((await readRegenJob(r.jobId))?.done).toBe(1);
    const second = await openRegenJob({ actorId: null, articles: [a, b], fields: ALL, imageMode: "auto" });
    expect(second.ok).toBe(true);
  });
});
