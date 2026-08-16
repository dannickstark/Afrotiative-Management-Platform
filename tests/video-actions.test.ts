import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { db, videoProjects, scriptVariants, scriptBeats, scriptJournal } from "@/db";
import { and, asc, eq } from "drizzle-orm";
import { EXAMPLE_PAYLOAD, type Payload } from "@/lib/video/schema";
import {
  createVideoProjectCore, prepareImportCore, applyImportCore, revertJournalEntryCore, updateBeatCore,
} from "@/lib/video/persist";

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

async function newProject(title: string): Promise<{ projectId: string; variantId: string }> {
  const projectId = await createVideoProjectCore({
    title, subject: "sujet", platform: "youtube_long",
    targetDurationSec: 720, aspectRatio: "16:9", articleId: null, userId: null,
  });
  const [variant] = await db.select().from(scriptVariants).where(eq(scriptVariants.projectId, projectId));
  return { projectId, variantId: variant.id };
}

// Round de correction 2, I11 : chaque describe monte et démonte son propre projet — une exécution
// ciblée (`bun test -t "..."`) sur un seul describe ne doit dépendre d'aucun autre.

describe("import de bout en bout", () => {
  let projectId: string;

  beforeAll(async () => { ({ projectId } = await newProject("Test — Babadampulu (bout en bout)")); });
  afterAll(async () => { await db.delete(videoProjects).where(eq(videoProjects.id, projectId)); });

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

  // Round de correction 2, I7 : `importedSnapshot` est stocké APRÈS sanitizeArticleHtml. Sans
  // assainir aussi `theirs` avant computeMerge, ré-importer le MÊME payload ferait apparaître un
  // "modifié" fantôme à chaque fois. Dépend du test précédent (beats déjà importés) — ordre stable
  // à l'intérieur d'un même describe (bun:test exécute les `it` d'un describe dans l'ordre).
  it("préparer deux fois de suite le même payload après application donne un diff vide", async () => {
    const variant = (await db.select().from(scriptVariants).where(eq(scriptVariants.projectId, projectId)))[0];
    const r = await prepareImportCore({ projectId, variantId: variant.id, raw: JSON.stringify(EXAMPLE_PAYLOAD), userId: null, source: "copier_coller" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.diff.added).toHaveLength(0);
      expect(r.diff.modified).toHaveLength(0);
      expect(r.diff.conflicts).toHaveLength(0);
      expect(r.diff.removed).toHaveLength(0);
    }
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

  // Round de correction 2, I11 : l'ancienne version fabriquait le timestamp périmé à la main
  // (`updatedAt - 60_000`), ce qui verrouille une soustraction, pas un comportement — et PASSE même
  // avec le bug C1 en place (updateBeatCore ne bumpait pas scriptVariants.updatedAt). Cette version
  // provoque la péremption par une vraie édition entre prepareImport et applyImport : c'est le
  // scénario que le garde existe pour couvrir.
  it("une édition humaine entre prepareImport et applyImport rend l'aperçu périmé (C1)", async () => {
    const variant = (await db.select().from(scriptVariants).where(eq(scriptVariants.projectId, projectId)))[0];
    const [someBeat] = await db.select().from(scriptBeats).where(eq(scriptBeats.variantId, variant.id)).limit(1);
    expect(someBeat).toBeTruthy();

    const prepared = await prepareImportCore({ projectId, variantId: variant.id, raw: JSON.stringify(EXAMPLE_PAYLOAD), userId: null, source: "copier_coller" });
    if (!prepared.ok) throw new Error("diff attendu");
    const staleUpdatedAt = variant.updatedAt;

    // Édition humaine RÉELLE entre la préparation et l'application.
    await updateBeatCore({ beatId: someBeat.id, spokenText: "Édition humaine survenue pendant la préparation." });

    const r = await applyImportCore({ journalId: prepared.journalId, variantId: variant.id, accept: [], variantUpdatedAt: staleUpdatedAt });
    expect(r.ok).toBe(false);
  });

  // Round de correction 2, I11 : l'ancienne version utilisait `accept: []`, donc la première
  // application était un no-op — elle ne prouvait rien sur une double application qui écrirait
  // deux fois. Cette version accepte une sélection non vide.
  it("appliquer deux fois la même entrée de journal échoue (sélection non vide)", async () => {
    const projectId2 = (await newProject("Test — Babadampulu (double application)")).projectId;
    try {
      const variant = (await db.select().from(scriptVariants).where(eq(scriptVariants.projectId, projectId2)))[0];
      const prepared = await prepareImportCore({ projectId: projectId2, variantId: variant.id, raw: JSON.stringify(EXAMPLE_PAYLOAD), userId: null, source: "copier_coller" });
      if (!prepared.ok) throw new Error("diff attendu");
      const first = await applyImportCore({ journalId: prepared.journalId, variantId: variant.id, accept: ["b-01-accroche", "b-02-contexte"], variantUpdatedAt: variant.updatedAt });
      expect(first.ok).toBe(true);

      const beatsAfterFirst = await db.select().from(scriptBeats).where(eq(scriptBeats.variantId, variant.id));
      expect(beatsAfterFirst).toHaveLength(2);

      const freshVariant = (await db.select().from(scriptVariants).where(eq(scriptVariants.id, variant.id)))[0];
      const second = await applyImportCore({ journalId: prepared.journalId, variantId: variant.id, accept: ["b-01-accroche", "b-02-contexte"], variantUpdatedAt: freshVariant.updatedAt });
      expect(second.ok).toBe(false);

      // La double application n'a RIEN écrit de plus (pas de doublon sur script_beats_variant_external_uq).
      const beatsAfterSecond = await db.select().from(scriptBeats).where(eq(scriptBeats.variantId, variant.id));
      expect(beatsAfterSecond).toHaveLength(2);
    } finally {
      await db.delete(videoProjects).where(eq(videoProjects.id, projectId2));
    }
  }, 20000);
});

// Round de correction 1, ruling 3, étendu round de correction 2, C3 : « aucun import partiel »
// s'applique aussi aux effets de bord de la préparation — une variante manquante ne doit jamais
// être créée si une AUTRE issue existe par ailleurs (champs manquants OU absence de variante
// correspondant à la variante ciblée).
describe("variante manquante — aucun import partiel", () => {
  let projectId: string;

  beforeAll(async () => { ({ projectId } = await newProject("Test — Babadampulu (variante manquante)")); });
  afterAll(async () => { await db.delete(videoProjects).where(eq(videoProjects.id, projectId)); });

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

  // Round de correction 3, T1 : la version précédente de ce test envoyait un "tiktok" SANS
  // duree_cible_sec/ratio — l'ancien code (buggé, d'AVANT le round 2) empilait déjà une issue
  // « champs manquants » pour cette raison-là et retournait avant même d'atteindre la boucle de
  // création : le test empruntait le chemin déjà corrigé au round 1 et passait à l'identique sur du
  // code buggé, sans jamais toucher le bug réel du C3 (des variantes créées avant le contrôle
  // « aucune variante ne correspond à la cible »). Ce payload-ci a délibérément TOUS les champs
  // requis pour "tiktok" (duree_cible_sec: 60, ratio: "9:16") — la SEULE raison de rejet est
  // l'absence de variante "youtube_long" (la cible) dans le payload. Sur l'ancien code, la boucle de
  // création aurait créé la variante "tiktok" (valide) AVANT que le contrôle de correspondance à la
  // cible ne fasse rejeter l'import : `variantsAfter` vaudrait 2, pas 1.
  it("un payload sans variante correspondant à la variante ciblée ne crée aucune ligne script_variants (C3)", async () => {
    const variant = (await db.select().from(scriptVariants).where(eq(scriptVariants.projectId, projectId)))[0];
    const beat0 = structuredClone(EXAMPLE_PAYLOAD.variantes[0].beats[0]);
    const payload: Payload = {
      schema_version: EXAMPLE_PAYLOAD.schema_version,
      projet: EXAMPLE_PAYLOAD.projet,
      variantes: [{ plateforme: "tiktok", duree_cible_sec: 60, ratio: "9:16", beats: [beat0] }],
    };

    const r = await prepareImportCore({ projectId, variantId: variant.id, raw: JSON.stringify(payload), userId: null, source: "copier_coller" });
    expect(r.ok).toBe(false);

    const variantsAfter = await db.select().from(scriptVariants).where(eq(scriptVariants.projectId, projectId));
    expect(variantsAfter).toHaveLength(1); // toujours seulement la variante par défaut — pas de "tiktok" créé puis abandonné
  });
});

// Round de correction 2, C2 : journalId et variantId arrivent tous deux du client — sans contrôle
// de cohérence, un diff calculé sur une variante pourrait être appliqué à une autre.
describe("cohérence variante ⇄ journal", () => {
  let projectId: string;
  let variantAId: string;
  let variantBId: string;

  beforeAll(async () => {
    ({ projectId, variantId: variantAId } = await newProject("Test — Babadampulu (cohérence variante)"));
    const [variantB] = await db.insert(scriptVariants).values({
      projectId, platform: "tiktok", targetDurationSec: 60, aspectRatio: "9:16", position: 1,
    }).returning();
    variantBId = variantB.id;
  });
  afterAll(async () => { await db.delete(videoProjects).where(eq(videoProjects.id, projectId)); });

  // Round de correction 3, T3 : la version précédente utilisait `accept: []` — sans aucune
  // mutation à appliquer de toute façon, l'assertion « aucun beat écrit sur B » passait déjà
  // trivialement, qu'elle qu'ait pu être le comportement du contrôle de cohérence. Sélection NON
  // VIDE ici : si le contrôle `entry.variantId !== args.variantId` ne bloquait pas, les deux beats
  // d'EXAMPLE_PAYLOAD seraient réellement écrits sur la variante B.
  it("applyImportCore refuse un journalId qui ne correspond pas à la variante ciblée", async () => {
    const prepared = await prepareImportCore({ projectId, variantId: variantAId, raw: JSON.stringify(EXAMPLE_PAYLOAD), userId: null, source: "copier_coller" });
    if (!prepared.ok) throw new Error("diff attendu");

    const [variantB] = await db.select().from(scriptVariants).where(eq(scriptVariants.id, variantBId));
    const r = await applyImportCore({
      journalId: prepared.journalId, variantId: variantBId,
      accept: ["b-01-accroche", "b-02-contexte"], variantUpdatedAt: variantB.updatedAt,
    });
    expect(r.ok).toBe(false);

    // La variante B n'a reçu aucun beat — le diff calculé sur A n'a jamais dû s'y appliquer, même
    // avec une sélection qui aurait réellement créé des lignes si le contrôle avait laissé passer.
    const beatsB = await db.select().from(scriptBeats).where(eq(scriptBeats.variantId, variantBId));
    expect(beatsB).toHaveLength(0);
  });
});

// Round de correction 3, T2 : le test séquentiel de double application (ci-dessus, dans "import de
// bout en bout") passe à l'identique sur le code d'AVANT le round 2 — le garde `outcome !==
// "en_attente"` existait déjà bien avant, seulement hors transaction. Deux appels l'un après
// l'autre ne testent JAMAIS la concurrence réelle : le second lit toujours un état déjà "applique"
// puisque le premier a fini avant qu'il ne commence. Ce test-ci lance deux applyImportCore
// EFFECTIVEMENT en parallèle (Promise.all) sur le MÊME journalId, avec une sélection non vide —
// sans le verrou `for("update")` + la mise à jour conditionnelle de l'outcome (round de correction
// 2, I4), les deux liraient "en_attente" avant que l'un ou l'autre n'ait écrit quoi que ce soit, et
// écriraient chacun leur propre INSERT sur script_beats : soit une violation de
// script_beats_variant_external_uq (les deux insèrent le même externalId), soit — pire — un
// doublon silencieux si l'unicité ne portait pas sur les bonnes colonnes. On vérifie ici qu'EXACTEMENT
// un des deux appels réussit et que le nombre de beats en base correspond à une seule application,
// pas au compte des statuts de retour seuls.
describe("concurrence sur applyImportCore (I4)", () => {
  let projectId: string;

  beforeAll(async () => { ({ projectId } = await newProject("Test — Babadampulu (concurrence I4)")); });
  afterAll(async () => { await db.delete(videoProjects).where(eq(videoProjects.id, projectId)); });

  it("deux applyImportCore concurrents sur le même journalId : un seul réussit, aucune écriture en double", async () => {
    const variant = (await db.select().from(scriptVariants).where(eq(scriptVariants.projectId, projectId)))[0];
    const prepared = await prepareImportCore({ projectId, variantId: variant.id, raw: JSON.stringify(EXAMPLE_PAYLOAD), userId: null, source: "copier_coller" });
    if (!prepared.ok) throw new Error("diff attendu");

    const call = () => applyImportCore({
      journalId: prepared.journalId, variantId: variant.id,
      accept: ["b-01-accroche", "b-02-contexte"], variantUpdatedAt: variant.updatedAt,
    });
    const [r1, r2] = await Promise.all([call(), call()]);

    const results = [r1, r2];
    expect(results.filter((r) => r.ok).length).toBe(1);
    expect(results.filter((r) => !r.ok).length).toBe(1);

    // Pas de doublon : deux applications concurrentes n'ont écrit QUE les deux beats attendus,
    // pas quatre (une paire par tentative) — la preuve porte sur l'état de la base, pas seulement
    // sur les statuts de retour.
    const beats = await db.select().from(scriptBeats).where(eq(scriptBeats.variantId, variant.id));
    expect(beats).toHaveLength(2);
  }, 20000);
});

// Round de correction 1, ruling 2 : `applyImportCore` capture l'état antérieur de chaque beat
// touché (`applied.before`), ce qui rend l'annulation d'une modification ou d'une suppression
// réellement fidèle — pas seulement celle d'une création.
describe("annulation d'une entrée de journal", () => {
  let projectId: string;

  beforeAll(async () => { ({ projectId } = await newProject("Test — Babadampulu (annulation)")); });
  afterAll(async () => { await db.delete(videoProjects).where(eq(videoProjects.id, projectId)); });

  it("annuler un import qui a modifié un beat restaure le texte et l'instantané d'import", async () => {
    const variant = (await db.select().from(scriptVariants).where(eq(scriptVariants.projectId, projectId)))[0];
    const seedPrep = await prepareImportCore({ projectId, variantId: variant.id, raw: JSON.stringify(EXAMPLE_PAYLOAD), userId: null, source: "copier_coller" });
    if (!seedPrep.ok) throw new Error("diff attendu");
    await applyImportCore({ journalId: seedPrep.journalId, variantId: variant.id, accept: ["b-01-accroche", "b-02-contexte"], variantUpdatedAt: variant.updatedAt });

    const [beforeModify] = await db.select().from(scriptBeats)
      .where(and(eq(scriptBeats.variantId, variant.id), eq(scriptBeats.externalId, "b-01-accroche")));
    const originalText = beforeModify.spokenText;
    const originalImportedSnapshot = beforeModify.importedSnapshot;

    const freshVariant = (await db.select().from(scriptVariants).where(eq(scriptVariants.id, variant.id)))[0];
    const beat0 = structuredClone(EXAMPLE_PAYLOAD.variantes[0].beats[0]);
    beat0.texte = "Texte modifié pour le test d'annulation.";
    const beat1 = structuredClone(EXAMPLE_PAYLOAD.variantes[0].beats[1]);
    const modifyPayload = payloadWithBeats([beat0, beat1]);

    const prepared = await prepareImportCore({ projectId, variantId: variant.id, raw: JSON.stringify(modifyPayload), userId: null, source: "copier_coller" });
    if (!prepared.ok) throw new Error("diff attendu");
    expect(prepared.diff.modified.some((m) => m.externalId === "b-01-accroche")).toBe(true);

    const applied = await applyImportCore({ journalId: prepared.journalId, variantId: variant.id, accept: ["b-01-accroche"], variantUpdatedAt: freshVariant.updatedAt });
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
  }, 20000);

  it("annuler un import qui a supprimé un beat le recrée à l'identique", async () => {
    const variant = (await db.select().from(scriptVariants).where(eq(scriptVariants.projectId, projectId)))[0];
    // Cette variante porte déjà b-01-accroche/b-02-contexte si le test précédent a tourné avant
    // celui-ci : ne réimporte donc que si absent, pour rester indépendant de l'ORDRE des `it` à
    // l'intérieur du describe.
    const existing = await db.select().from(scriptBeats).where(eq(scriptBeats.variantId, variant.id));
    if (existing.length === 0) {
      const seedPrep = await prepareImportCore({ projectId, variantId: variant.id, raw: JSON.stringify(EXAMPLE_PAYLOAD), userId: null, source: "copier_coller" });
      if (!seedPrep.ok) throw new Error("diff attendu");
      await applyImportCore({ journalId: seedPrep.journalId, variantId: variant.id, accept: ["b-01-accroche", "b-02-contexte"], variantUpdatedAt: variant.updatedAt });
    }

    const freshVariant = (await db.select().from(scriptVariants).where(eq(scriptVariants.id, variant.id)))[0];
    const [beforeRemove] = await db.select().from(scriptBeats)
      .where(and(eq(scriptBeats.variantId, variant.id), eq(scriptBeats.externalId, "b-02-contexte")));
    expect(beforeRemove).toBeTruthy();

    const beat0 = structuredClone(EXAMPLE_PAYLOAD.variantes[0].beats[0]);
    const removePayload = payloadWithBeats([beat0]); // "b-02-contexte" absent → proposé en suppression

    const prepared = await prepareImportCore({ projectId, variantId: variant.id, raw: JSON.stringify(removePayload), userId: null, source: "copier_coller" });
    if (!prepared.ok) throw new Error("diff attendu");
    expect(prepared.diff.removed.some((r) => r.externalId === "b-02-contexte")).toBe(true);

    const applied = await applyImportCore({ journalId: prepared.journalId, variantId: variant.id, accept: ["b-02-contexte"], variantUpdatedAt: freshVariant.updatedAt });
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
  }, 20000);

  // Round de correction 2, I11 : cas manquant — un import qui ne fait QUE déplacer des beats
  // existants (aucun contenu modifié) doit, une fois annulé, restaurer leurs positions.
  it("annuler un import qui a seulement déplacé des beats restaure les positions", async () => {
    const projectId2 = (await newProject("Test — Babadampulu (réordonnancement)")).projectId;
    try {
      const variant = (await db.select().from(scriptVariants).where(eq(scriptVariants.projectId, projectId2)))[0];
      const seedPrep = await prepareImportCore({ projectId: projectId2, variantId: variant.id, raw: JSON.stringify(EXAMPLE_PAYLOAD), userId: null, source: "copier_coller" });
      if (!seedPrep.ok) throw new Error("diff attendu");
      await applyImportCore({ journalId: seedPrep.journalId, variantId: variant.id, accept: ["b-01-accroche", "b-02-contexte"], variantUpdatedAt: variant.updatedAt });

      const freshVariant = (await db.select().from(scriptVariants).where(eq(scriptVariants.id, variant.id)))[0];
      const newBeat = structuredClone(EXAMPLE_PAYLOAD.variantes[0].beats[0]);
      newBeat.id = "b-00-intro";
      newBeat.texte = "Nouvelle accroche en tête, insérée par cet import.";
      const beat0 = structuredClone(EXAMPLE_PAYLOAD.variantes[0].beats[0]);
      const beat1 = structuredClone(EXAMPLE_PAYLOAD.variantes[0].beats[1]);
      // "b-00-intro" en tête → b-01-accroche et b-02-contexte glissent d'une position, SANS que leur
      // contenu ne change (donc ni `modified` ni `conflicts` pour eux, uniquement `added` pour
      // "b-00-intro").
      const payload = payloadWithBeats([newBeat, beat0, beat1]);

      const prepared = await prepareImportCore({ projectId: projectId2, variantId: variant.id, raw: JSON.stringify(payload), userId: null, source: "copier_coller" });
      if (!prepared.ok) throw new Error("diff attendu");
      expect(prepared.diff.added.map((a) => a.externalId)).toEqual(["b-00-intro"]);
      expect(prepared.diff.modified).toHaveLength(0);

      const applied = await applyImportCore({ journalId: prepared.journalId, variantId: variant.id, accept: ["b-00-intro"], variantUpdatedAt: freshVariant.updatedAt });
      expect(applied.ok).toBe(true);

      const afterApply = await db.select().from(scriptBeats).where(eq(scriptBeats.variantId, variant.id)).orderBy(asc(scriptBeats.position));
      expect(afterApply.map((b) => b.externalId)).toEqual(["b-00-intro", "b-01-accroche", "b-02-contexte"]);

      const reverted = await revertJournalEntryCore(prepared.journalId);
      expect(reverted.ok).toBe(true);

      const afterRevert = await db.select().from(scriptBeats).where(eq(scriptBeats.variantId, variant.id)).orderBy(asc(scriptBeats.position));
      // "b-00-intro" a été créé par cet import → retiré par l'annulation. b-01/b-02 retrouvent leurs
      // positions d'avant (0 et 1).
      expect(afterRevert.map((b) => b.externalId)).toEqual(["b-01-accroche", "b-02-contexte"]);
      expect(afterRevert.find((b) => b.externalId === "b-01-accroche")!.position).toBe(0);
      expect(afterRevert.find((b) => b.externalId === "b-02-contexte")!.position).toBe(1);
    } finally {
      await db.delete(videoProjects).where(eq(videoProjects.id, projectId2));
    }
  }, 20000);

  it("annuler est refusé quand un import postérieur non annulé a retouché le même externalId", async () => {
    const projectId2 = (await newProject("Test — Babadampulu (annulation bloquée)")).projectId;
    try {
      let variant = (await db.select().from(scriptVariants).where(eq(scriptVariants.projectId, projectId2)))[0];
      const seedPrep = await prepareImportCore({ projectId: projectId2, variantId: variant.id, raw: JSON.stringify(EXAMPLE_PAYLOAD), userId: null, source: "copier_coller" });
      if (!seedPrep.ok) throw new Error("diff attendu");
      await applyImportCore({ journalId: seedPrep.journalId, variantId: variant.id, accept: ["b-01-accroche", "b-02-contexte"], variantUpdatedAt: variant.updatedAt });
      variant = (await db.select().from(scriptVariants).where(eq(scriptVariants.id, variant.id)))[0];

      const beat0v1 = structuredClone(EXAMPLE_PAYLOAD.variantes[0].beats[0]);
      beat0v1.texte = "Première modification (C1).";
      const beat1 = structuredClone(EXAMPLE_PAYLOAD.variantes[0].beats[1]);
      const payload1 = payloadWithBeats([beat0v1, beat1]);

      const prepared1 = await prepareImportCore({ projectId: projectId2, variantId: variant.id, raw: JSON.stringify(payload1), userId: null, source: "copier_coller" });
      if (!prepared1.ok) throw new Error("diff attendu");
      const applied1 = await applyImportCore({ journalId: prepared1.journalId, variantId: variant.id, accept: ["b-01-accroche"], variantUpdatedAt: variant.updatedAt });
      expect(applied1.ok).toBe(true);

      variant = (await db.select().from(scriptVariants).where(eq(scriptVariants.id, variant.id)))[0];

      const beat0v2 = structuredClone(EXAMPLE_PAYLOAD.variantes[0].beats[0]);
      beat0v2.texte = "Seconde modification (C2), postérieure.";
      const payload2 = payloadWithBeats([beat0v2, beat1]);

      const prepared2 = await prepareImportCore({ projectId: projectId2, variantId: variant.id, raw: JSON.stringify(payload2), userId: null, source: "copier_coller" });
      if (!prepared2.ok) throw new Error("diff attendu");
      const applied2 = await applyImportCore({ journalId: prepared2.journalId, variantId: variant.id, accept: ["b-01-accroche"], variantUpdatedAt: variant.updatedAt });
      expect(applied2.ok).toBe(true);

      const revertResult = await revertJournalEntryCore(prepared1.journalId);
      expect(revertResult.ok).toBe(false);
    } finally {
      await db.delete(videoProjects).where(eq(videoProjects.id, projectId2));
    }
  }, 20000);
});
