import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { db, scriptJournal, type scriptJournalSource } from "@/db";
import { eq } from "drizzle-orm";
import { createVideoProjectCore, markProjectReviewedCore } from "@/lib/video/persist";
import { listVideoProjects, unreviewedAgentWrites } from "@/lib/queries/video";
import { cleanupProject } from "./mcp-harness";

// Lane DB (touche la base Neon partagée — HORS de PURE_FILES dans scripts/test-fast.ts) : vérifie
// le marqueur « non relue » (brief Task 8), le garde-fou compensatoire pour la décision de laisser
// un agent appliquer un import sans revue de diff humaine. `cleanupProject` (tests/mcp-harness.ts)
// supprime le projet en `afterAll`, qui s'exécute même si un `it` du describe échoue — les cascades
// de `videoProjects` (db/schema.ts) emportent `script_journal` avec lui, donc aucune ligne ne
// survit à une échec de test.

async function newProject(title: string): Promise<string> {
  return createVideoProjectCore({
    title, subject: null, platform: "youtube_long",
    targetDurationSec: 720, aspectRatio: "16:9", articleId: null, userId: null,
  });
}

// Écrit directement une ligne de journal — pas via prepareImportCore/writeJournal (non exportée) :
// ce test porte sur le marquage lui-même, pas sur le pipeline d'import, donc la forme minimale du
// journal (source + outcome, le reste par défaut) suffit et garde chaque test lisible en une ligne.
async function insertJournal(
  projectId: string, source: (typeof scriptJournalSource.enumValues)[number],
) {
  const [entry] = await db.insert(scriptJournal).values({
    projectId, source, outcome: "rejete", rawPayload: {},
  }).returning();
  return entry;
}

describe("markProjectReviewedCore", () => {
  let projectId: string;

  beforeAll(async () => { projectId = await newProject("Test — marqueur non relue"); });
  afterAll(async () => { await cleanupProject(projectId); });

  it("une écriture d'agent naît avec reviewedAt à null", async () => {
    const entry = await insertJournal(projectId, "mcp");
    expect(entry.reviewedAt).toBeNull();
  });

  it("marque relues les écritures mcp non relues du projet", async () => {
    const entry = await insertJournal(projectId, "mcp");
    await markProjectReviewedCore(projectId, null);
    const [row] = await db.select().from(scriptJournal).where(eq(scriptJournal.id, entry.id));
    expect(row.reviewedAt).not.toBeNull();
  });

  it("une seconde écriture d'agent après relecture repasse le projet en « non relue »", async () => {
    // Tout marquer relu d'abord — état de départ propre pour ce test, quel que soit l'ordre
    // d'exécution des `it` précédents dans ce describe.
    await markProjectReviewedCore(projectId, null);
    expect(await unreviewedAgentWrites(projectId)).toBe(0);

    const entry = await insertJournal(projectId, "mcp");
    expect(entry.reviewedAt).toBeNull();
    expect(await unreviewedAgentWrites(projectId)).toBeGreaterThan(0);
  });

  it("ne touche pas les entrées source « copier_coller » — appliquées par un humain, rien à relire", async () => {
    const entry = await insertJournal(projectId, "copier_coller");
    await markProjectReviewedCore(projectId, null);
    const [row] = await db.select().from(scriptJournal).where(eq(scriptJournal.id, entry.id));
    expect(row.reviewedAt).toBeNull();
  });

  it("ne touche pas les entrées source « manuel »", async () => {
    const entry = await insertJournal(projectId, "manuel");
    await markProjectReviewedCore(projectId, null);
    const [row] = await db.select().from(scriptJournal).where(eq(scriptJournal.id, entry.id));
    expect(row.reviewedAt).toBeNull();
  });

  it("ne touche pas les entrées mcp déjà relues d'un autre projet", async () => {
    const other = await newProject("Test — marqueur non relue (isolation)");
    try {
      const entry = await insertJournal(other, "mcp");
      await markProjectReviewedCore(projectId, null); // marque UNIQUEMENT `projectId`
      const [row] = await db.select().from(scriptJournal).where(eq(scriptJournal.id, entry.id));
      expect(row.reviewedAt).toBeNull();
    } finally {
      await cleanupProject(other);
    }
  });
});

describe("unreviewedAgentWrites / unreviewedCount", () => {
  let projectId: string;

  beforeAll(async () => { projectId = await newProject("Test — compteur non relue"); });
  afterAll(async () => { await cleanupProject(projectId); });

  it("compte juste : mcp non relues seulement, ni copier_coller ni déjà relues", async () => {
    await insertJournal(projectId, "mcp");
    await insertJournal(projectId, "mcp");
    await insertJournal(projectId, "copier_coller");
    const alreadyReviewed = await insertJournal(projectId, "mcp");
    await db.update(scriptJournal).set({ reviewedAt: new Date() }).where(eq(scriptJournal.id, alreadyReviewed.id));

    expect(await unreviewedAgentWrites(projectId)).toBe(2);
  });

  it("listVideoProjects renvoie un unreviewedCount aligné avec unreviewedAgentWrites", async () => {
    const rows = await listVideoProjects();
    const row = rows.find((p) => p.id === projectId);
    expect(row).toBeDefined();
    expect(row!.unreviewedCount).toBe(await unreviewedAgentWrites(projectId));
  });
});
