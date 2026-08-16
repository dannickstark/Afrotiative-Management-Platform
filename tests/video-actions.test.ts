import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { db, videoProjects, scriptVariants, scriptBeats, scriptJournal } from "@/db";
import { and, eq } from "drizzle-orm";
import { EXAMPLE_PAYLOAD, type Payload } from "@/lib/video/schema";
import { createVideoProjectCore, prepareImportCore, applyImportCore, revertJournalEntryCore } from "@/lib/video/persist";

// Construit un payload à une seule variante ("youtube_long", la variante par défaut du projet de
// test) portant exactement les beats fournis — utilitaire pour les scénarios de modification /
// suppression du round de correction 1 (ruling 2).
function payloadWithBeats(beats: Payload["variantes"][number]["beats"]): Payload {
  return {
    schema_version: EXAMPLE_PAYLOAD.schema_version,
    projet: EXAMPLE_PAYLOAD.projet,
    variantes: [{ plateforme: "youtube_long", duree_cible_sec: null, ratio: null, beats }],
  };
}

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

  it("appliquer deux fois la même entrée de journal échoue", async () => {
    const variant = (await db.select().from(scriptVariants).where(eq(scriptVariants.projectId, projectId)))[0];
    const prepared = await prepareImportCore({ projectId, variantId: variant.id, raw: JSON.stringify(EXAMPLE_PAYLOAD), userId: null, source: "copier_coller" });
    if (!prepared.ok) throw new Error("diff attendu");
    const first = await applyImportCore({ journalId: prepared.journalId, variantId: variant.id, accept: [], variantUpdatedAt: variant.updatedAt });
    expect(first.ok).toBe(true);

    const freshVariant = (await db.select().from(scriptVariants).where(eq(scriptVariants.id, variant.id)))[0];
    const second = await applyImportCore({ journalId: prepared.journalId, variantId: variant.id, accept: [], variantUpdatedAt: freshVariant.updatedAt });
    expect(second.ok).toBe(false);
  });
});

// Round de correction 1, ruling 3 : « aucun import partiel » s'applique aussi aux effets de bord
// de la préparation — une variante manquante ne doit jamais être créée si une AUTRE variante du
// même payload est par ailleurs invalide.
describe("variante manquante — aucun import partiel", () => {
  it("un payload visant une plateforme sans variante ET portant une erreur ne crée aucune ligne script_variants", async () => {
    const beat0 = structuredClone(EXAMPLE_PAYLOAD.variantes[0].beats[0]);
    const tiktokBeat = structuredClone(EXAMPLE_PAYLOAD.variantes[0].beats[1]);
    tiktokBeat.id = "b-99-tiktok";
    const payload: Payload = {
      schema_version: EXAMPLE_PAYLOAD.schema_version,
      projet: EXAMPLE_PAYLOAD.projet,
      variantes: [
        { plateforme: "youtube_long", duree_cible_sec: null, ratio: null, beats: [beat0] },
        // "tiktok" n'a pas encore de variante dans ce projet, et il lui manque duree_cible_sec/ratio.
        { plateforme: "tiktok", duree_cible_sec: null, ratio: null, beats: [tiktokBeat] },
      ],
    };

    const variant = (await db.select().from(scriptVariants).where(eq(scriptVariants.projectId, projectId)))[0];
    const r = await prepareImportCore({ projectId, variantId: variant.id, raw: JSON.stringify(payload), userId: null, source: "copier_coller" });
    expect(r.ok).toBe(false);

    const tiktokVariants = await db.select().from(scriptVariants)
      .where(and(eq(scriptVariants.projectId, projectId), eq(scriptVariants.platform, "tiktok")));
    expect(tiktokVariants).toHaveLength(0);
  });
});

// Round de correction 1, ruling 2 : `applyImportCore` capture désormais l'état antérieur de
// chaque beat touché (`applied.before`), ce qui rend l'annulation d'une modification ou d'une
// suppression réellement fidèle — pas seulement celle d'une création.
describe("annulation d'une entrée de journal", () => {
  it("annuler un import qui a modifié un beat restaure le texte et l'instantané d'import", async () => {
    const variant = (await db.select().from(scriptVariants).where(eq(scriptVariants.projectId, projectId)))[0];
    const [beforeModify] = await db.select().from(scriptBeats)
      .where(and(eq(scriptBeats.variantId, variant.id), eq(scriptBeats.externalId, "b-01-accroche")));
    const originalText = beforeModify.spokenText;
    const originalImportedSnapshot = beforeModify.importedSnapshot;

    const beat0 = structuredClone(EXAMPLE_PAYLOAD.variantes[0].beats[0]);
    beat0.texte = "Texte modifié pour le test d'annulation.";
    const beat1 = structuredClone(EXAMPLE_PAYLOAD.variantes[0].beats[1]);
    const modifyPayload = payloadWithBeats([beat0, beat1]);

    const prepared = await prepareImportCore({ projectId, variantId: variant.id, raw: JSON.stringify(modifyPayload), userId: null, source: "copier_coller" });
    if (!prepared.ok) throw new Error("diff attendu");
    expect(prepared.diff.modified.some((m) => m.externalId === "b-01-accroche")).toBe(true);

    const applied = await applyImportCore({ journalId: prepared.journalId, variantId: variant.id, accept: ["b-01-accroche"], variantUpdatedAt: variant.updatedAt });
    expect(applied.ok).toBe(true);

    const [modifiedBeat] = await db.select().from(scriptBeats)
      .where(and(eq(scriptBeats.variantId, variant.id), eq(scriptBeats.externalId, "b-01-accroche")));
    expect(modifiedBeat.spokenText).toContain("Texte modifié pour le test d'annulation.");
    expect(modifiedBeat.spokenText).not.toBe(originalText);

    const reverted = await revertJournalEntryCore(prepared.journalId);
    expect(reverted.ok).toBe(true);

    const [restoredBeat] = await db.select().from(scriptBeats)
      .where(and(eq(scriptBeats.variantId, variant.id), eq(scriptBeats.externalId, "b-01-accroche")));
    expect(restoredBeat.spokenText).toBe(originalText);
    expect(restoredBeat.importedSnapshot).toEqual(originalImportedSnapshot);
  }, 20000); // préparer + appliquer + annuler : plusieurs aller-retours réseau Neon, motif de tests/diffusion-scheduler.test.ts

  it("annuler un import qui a supprimé un beat le recrée à l'identique", async () => {
    const variant = (await db.select().from(scriptVariants).where(eq(scriptVariants.projectId, projectId)))[0];
    const [beforeRemove] = await db.select().from(scriptBeats)
      .where(and(eq(scriptBeats.variantId, variant.id), eq(scriptBeats.externalId, "b-02-contexte")));
    expect(beforeRemove).toBeTruthy();

    const beat0 = structuredClone(EXAMPLE_PAYLOAD.variantes[0].beats[0]);
    const removePayload = payloadWithBeats([beat0]); // "b-02-contexte" absent → proposé en suppression

    const prepared = await prepareImportCore({ projectId, variantId: variant.id, raw: JSON.stringify(removePayload), userId: null, source: "copier_coller" });
    if (!prepared.ok) throw new Error("diff attendu");
    expect(prepared.diff.removed.some((r) => r.externalId === "b-02-contexte")).toBe(true);

    const applied = await applyImportCore({ journalId: prepared.journalId, variantId: variant.id, accept: ["b-02-contexte"], variantUpdatedAt: variant.updatedAt });
    expect(applied.ok).toBe(true);

    const afterRemove = await db.select().from(scriptBeats)
      .where(and(eq(scriptBeats.variantId, variant.id), eq(scriptBeats.externalId, "b-02-contexte")));
    expect(afterRemove).toHaveLength(0);

    const reverted = await revertJournalEntryCore(prepared.journalId);
    expect(reverted.ok).toBe(true);

    const [recreated] = await db.select().from(scriptBeats)
      .where(and(eq(scriptBeats.variantId, variant.id), eq(scriptBeats.externalId, "b-02-contexte")));
    expect(recreated).toBeTruthy();
    expect(recreated.spokenText).toBe(beforeRemove.spokenText);
    expect(recreated.importedSnapshot).toEqual(beforeRemove.importedSnapshot);
  }, 20000); // préparer + appliquer + annuler : plusieurs aller-retours réseau Neon

  it("annuler est refusé quand un import postérieur non annulé a retouché le même externalId", async () => {
    let variant = (await db.select().from(scriptVariants).where(eq(scriptVariants.projectId, projectId)))[0];

    const beat0v1 = structuredClone(EXAMPLE_PAYLOAD.variantes[0].beats[0]);
    beat0v1.texte = "Première modification (C1).";
    const beat1 = structuredClone(EXAMPLE_PAYLOAD.variantes[0].beats[1]);
    const payload1 = payloadWithBeats([beat0v1, beat1]);

    const prepared1 = await prepareImportCore({ projectId, variantId: variant.id, raw: JSON.stringify(payload1), userId: null, source: "copier_coller" });
    if (!prepared1.ok) throw new Error("diff attendu");
    const applied1 = await applyImportCore({ journalId: prepared1.journalId, variantId: variant.id, accept: ["b-01-accroche"], variantUpdatedAt: variant.updatedAt });
    expect(applied1.ok).toBe(true);

    variant = (await db.select().from(scriptVariants).where(eq(scriptVariants.id, variant.id)))[0];

    const beat0v2 = structuredClone(EXAMPLE_PAYLOAD.variantes[0].beats[0]);
    beat0v2.texte = "Seconde modification (C2), postérieure.";
    const payload2 = payloadWithBeats([beat0v2, beat1]);

    const prepared2 = await prepareImportCore({ projectId, variantId: variant.id, raw: JSON.stringify(payload2), userId: null, source: "copier_coller" });
    if (!prepared2.ok) throw new Error("diff attendu");
    const applied2 = await applyImportCore({ journalId: prepared2.journalId, variantId: variant.id, accept: ["b-01-accroche"], variantUpdatedAt: variant.updatedAt });
    expect(applied2.ok).toBe(true);

    const revertResult = await revertJournalEntryCore(prepared1.journalId);
    expect(revertResult.ok).toBe(false);
  }, 20000); // deux cycles préparer+appliquer puis une tentative d'annulation : encore plus d'aller-retours réseau Neon
});
