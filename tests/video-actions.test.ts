import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { db, videoProjects, scriptVariants, scriptBeats, scriptJournal } from "@/db";
import { eq } from "drizzle-orm";
import { EXAMPLE_PAYLOAD } from "@/lib/video/schema";
import { createVideoProjectCore, prepareImportCore, applyImportCore } from "@/lib/video/persist";

let projectId: string;

beforeAll(async () => {
  projectId = await createVideoProjectCore({
    title: "Test — Babadampulu", subject: "sujet", platform: "youtube_long",
    targetDurationSec: 720, aspectRatio: "16:9", articleId: null, userId: null,
  });
});

afterAll(async () => { await db.delete(videoProjects).where(eq(videoProjects.id, projectId)); });

describe("import de bout en bout", () => {
  it("un payload valide produit un diff en ajouts", async () => {
    const variant = (await db.select().from(scriptVariants).where(eq(scriptVariants.projectId, projectId)))[0];
    const r = await prepareImportCore({ projectId, variantId: variant.id, raw: JSON.stringify(EXAMPLE_PAYLOAD), userId: null, source: "copier_coller" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.diff.added).toHaveLength(2);
  });

  it("l'application écrit les beats et l'instantané d'import", async () => {
    const variant = (await db.select().from(scriptVariants).where(eq(scriptVariants.projectId, projectId)))[0];
    const prepared = await prepareImportCore({ projectId, variantId: variant.id, raw: JSON.stringify(EXAMPLE_PAYLOAD), userId: null, source: "copier_coller" });
    if (!prepared.ok) throw new Error("diff attendu");
    await applyImportCore({ journalId: prepared.journalId, variantId: variant.id, accept: ["b-01-accroche", "b-02-contexte"], variantUpdatedAt: variant.updatedAt });

    const beats = await db.select().from(scriptBeats).where(eq(scriptBeats.variantId, variant.id));
    expect(beats).toHaveLength(2);
    expect(beats.every((b) => b.importedSnapshot !== null)).toBe(true);
    expect(beats.find((b) => b.externalId === "b-01-accroche")!.estimatedDurationSec).toBeGreaterThan(0);
  });

  it("un payload invalide est journalisé comme rejeté sans rien écrire", async () => {
    const variant = (await db.select().from(scriptVariants).where(eq(scriptVariants.projectId, projectId)))[0];
    const before = (await db.select().from(scriptBeats).where(eq(scriptBeats.variantId, variant.id))).length;
    const r = await prepareImportCore({ projectId, variantId: variant.id, raw: "{ pas du json", userId: null, source: "copier_coller" });
    expect(r.ok).toBe(false);
    const after = (await db.select().from(scriptBeats).where(eq(scriptBeats.variantId, variant.id))).length;
    expect(after).toBe(before);
    const journal = await db.select().from(scriptJournal).where(eq(scriptJournal.projectId, projectId));
    expect(journal.some((j) => j.outcome === "rejete")).toBe(true);
  });

  it("un diff calculé sur un état périmé est refusé", async () => {
    const variant = (await db.select().from(scriptVariants).where(eq(scriptVariants.projectId, projectId)))[0];
    const prepared = await prepareImportCore({ projectId, variantId: variant.id, raw: JSON.stringify(EXAMPLE_PAYLOAD), userId: null, source: "copier_coller" });
    if (!prepared.ok) throw new Error("diff attendu");
    const stale = new Date(variant.updatedAt.getTime() - 60_000);
    const r = await applyImportCore({ journalId: prepared.journalId, variantId: variant.id, accept: [], variantUpdatedAt: stale });
    expect(r.ok).toBe(false);
  });
});
