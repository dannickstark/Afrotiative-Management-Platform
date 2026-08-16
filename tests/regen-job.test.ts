import { describe, it, expect, afterAll, mock } from "bun:test";
import { db, articles, regenJobs } from "@/db";
import { eq, inArray } from "drizzle-orm";
import { faker } from "@faker-js/faker";
import { openRegenJob, readRegenJob } from "@/lib/pipeline/regen-store";

// runRegenJob importe regenerateArticle DYNAMIQUEMENT : le mock ci-dessous, posé avant tout appel,
// est donc vu par cet `await import(...)` — même motif que tests/regenerate-core.test.ts.
const { regenerateArticle: realRegenerateArticle } = await import("@/lib/pipeline/regenerate-core");
let regenerateImpl: (id: string) => Promise<{ ok: boolean; message: string; title: string; awaitingImage?: boolean }> =
  async () => ({ ok: true, message: "ok", title: "T" });
// Le wrapper transmet TOUS les arguments (et non le seul `id`) : mock.module() est global au
// processus `bun test` et rien ne le défait après cette suite (voir le commentaire d'en-tête de
// tests/regenerate-core.test.ts). Si ce module fuit vers un fichier chargé ensuite dans le même
// lot — ce que fait exactement `bun test tests/regen-job.test.ts tests/regenerate-core.test.ts`,
// « regen-job » précédant « regenerate-core » par ordre alphabétique — ce fichier capture ce
// wrapper avant même son propre `await import(...)`. À ce stade `regenerateImpl` vaut déjà
// `realRegenerateArticle` (repointé par notre afterAll), donc transmettre tous les arguments
// restitue exactement le comportement réel plutôt que de faire tomber `fields`/`actorId`/`opts`.
mock.module("@/lib/pipeline/regenerate-core", () => ({
  regenerateArticle: (...args: Parameters<typeof realRegenerateArticle>) =>
    (regenerateImpl as unknown as (...a: typeof args) => ReturnType<typeof realRegenerateArticle>)(...args),
}));

const { runRegenJob } = await import("@/lib/pipeline/regen-job");

const ALL = { title: true, body: true, excerpt: true, category: true, tags: true, image: true };
const createdArticles: string[] = [];
const createdJobIds: string[] = [];

async function seedArticle() {
  const title = `Article ${faker.string.uuid()}`;
  const [a] = await db.insert(articles).values({ title, bodyHtml: "<p>x</p>" }).returning({ id: articles.id });
  createdArticles.push(a.id);
  return { id: a.id, title };
}

async function open(articlesInput: { id: string; title: string }[], imageMode: "auto" | "manual" = "auto") {
  const r = await openRegenJob({ actorId: null, articles: articlesInput, fields: ALL, imageMode });
  if (!r.ok) throw new Error("setup");
  createdJobIds.push(r.jobId);
  return r;
}

afterAll(async () => {
  // Les deux cascades vont vers regen_job_items (articles→items, jobs→items) : supprimer les
  // articles ne retire donc JAMAIS la ligne regen_jobs parente. On supprime les jobs AVANT les
  // articles, sinon chaque exécution de ce fichier laisse des jobs orphelins dans la base de dev
  // partagée (même pattern que tests/regen-store.test.ts).
  if (createdJobIds.length) await db.delete(regenJobs).where(inArray(regenJobs.id, createdJobIds));
  if (createdArticles.length) await db.delete(articles).where(inArray(articles.id, createdArticles));
  regenerateImpl = realRegenerateArticle as unknown as typeof regenerateImpl;
});

describe("runRegenJob", () => {
  it("traite chaque item et clôt le job", async () => {
    const a = await seedArticle(); const b = await seedArticle();
    const r = await open([a, b]);
    regenerateImpl = async () => ({ ok: true, message: "Article régénéré.", title: "T" });
    await runRegenJob(r.jobId);
    const view = await readRegenJob(r.jobId);
    expect(view?.status).toBe("done");
    expect(view?.done).toBe(2);
    expect(view?.items.every((i) => i.status === "ok")).toBe(true);
  });

  it("un échec métier n'interrompt pas le lot", async () => {
    const a = await seedArticle(); const b = await seedArticle();
    const r = await open([a, b]);
    regenerateImpl = async (id) => id === a.id
      ? { ok: false, message: "Aucune source à régénérer.", title: a.title }
      : { ok: true, message: "Article régénéré.", title: b.title };
    await runRegenJob(r.jobId);
    const view = await readRegenJob(r.jobId);
    expect(view?.status).toBe("done");
    expect(view?.items.find((i) => i.articleId === a.id)?.status).toBe("failed");
    expect(view?.items.find((i) => i.articleId === b.id)?.status).toBe("ok");
  });

  it("une exception inattendue marque l'item en échec sans faire tomber le job", async () => {
    const a = await seedArticle();
    const r = await open([a]);
    regenerateImpl = async () => { throw new Error("réseau mort"); };
    await runRegenJob(r.jobId);
    const view = await readRegenJob(r.jobId);
    expect(view?.status).toBe("failed");
    expect(view?.items[0].status).toBe("failed");
    expect(view?.items[0].message).toContain("réseau mort");
  });

  it("respecte l'annulation entre deux articles", async () => {
    const a = await seedArticle(); const b = await seedArticle();
    const r = await open([a, b]);
    let calls = 0;
    regenerateImpl = async () => {
      calls += 1;
      await db.update(regenJobs).set({ cancelRequested: true }).where(eq(regenJobs.id, r.jobId));
      return { ok: true, message: "ok", title: "T" };
    };
    await runRegenJob(r.jobId);
    expect(calls).toBe(1);
    const view = await readRegenJob(r.jobId);
    expect(view?.status).toBe("cancelled");
  });

  it("propage awaitingImage en statut awaiting_image", async () => {
    const a = await seedArticle();
    const r = await open([a], "manual");
    regenerateImpl = async () => ({ ok: true, message: "Image à choisir.", title: a.title, awaitingImage: true });
    await runRegenJob(r.jobId);
    const view = await readRegenJob(r.jobId);
    expect(view?.items[0].status).toBe("awaiting_image");
  });
});
