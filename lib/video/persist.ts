import {
  db, videoProjects, scriptVariants, scriptBeats, beatInserts, scriptJournal, scriptJournalSource,
} from "@/db";
import { and, asc, eq, gt, inArray, ne } from "drizzle-orm";
import {
  applyMerge, computeMerge, parseIncoming, stripEnvelope, type BeatRow, type BeatSnapshot,
  type Diff, type Issue, type Mutations,
} from "@/lib/video/import";
import { beatSeconds } from "@/lib/video/duration";
import { sanitizeArticleHtml } from "@/lib/sanitize";
import { getVideoSettings } from "@/lib/queries/video-settings";
import type { InsertPayload, VariantPayload } from "@/lib/video/schema";

// Cœur DB brut du module vidéo — délibérément SANS "use server" (voir lib/actions/video-actions.ts
// pour le motif). C'est aussi la SEULE exception à « lib/video/* n'importe jamais @/db » : le
// mapping payload français → colonnes anglaises vit ici, et nulle part ailleurs.

type JournalSource = (typeof scriptJournalSource.enumValues)[number];
// "en_attente" (round de correction 1) : un diff préparé mais pas encore appliqué. Distinct
// d'"annule", qui signifie « revenu en arrière », pas « jamais appliqué ».
type JournalOutcome = "rejete" | "en_attente" | "applique" | "annule";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbLike = typeof db | Tx;

// L'état d'un beat capturé AVANT une mutation — c'est l'unique matière première d'une annulation
// fidèle. `applied` (colonne jsonb, aucune migration requise) porte ces instantanés en plus des
// `Mutations` déjà journalisées (round de correction 1, ruling 2) : sans eux, "annuler" une
// modification ou une suppression n'est pas dérivable de `Mutations`, qui ne décrit que l'état
// D'ARRIVÉE.
type BeforeBeat = {
  externalId: string;
  snapshot: BeatSnapshot;
  importedSnapshot: BeatSnapshot | null;
  position: number;
  locallyEditedAt: string | null; // ISO — jsonb ne sérialise pas les Date nativement
  durationOverrideSec: number | null;
  estimatedDurationSec: number;
};
type AppliedRecord = Mutations & { before: BeforeBeat[] };

// ─────────────────────────────────────────────────────────────────────────────
// Création de projet
// ─────────────────────────────────────────────────────────────────────────────

export async function createVideoProjectCore(input: {
  title: string;
  subject: string | null;
  platform: string;
  targetDurationSec: number | null;
  aspectRatio: string;
  articleId: string | null;
  userId: string | null;
}): Promise<string> {
  // Un projet a toujours au moins une variante (spec) : on la crée ici, en position 0, à partir
  // des plateforme / durée / ratio reçus à la création — le test du brief lit `scriptVariants`
  // juste après cet appel.
  return db.transaction(async (tx) => {
    const [project] = await tx.insert(videoProjects).values({
      title: input.title,
      subject: input.subject,
      articleId: input.articleId,
      createdBy: input.userId,
    }).returning();

    await tx.insert(scriptVariants).values({
      projectId: project.id,
      platform: input.platform as (typeof scriptVariants.$inferInsert)["platform"],
      targetDurationSec: input.targetDurationSec,
      aspectRatio: input.aspectRatio,
      position: 0,
    });

    return project.id;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Édition d'un beat
// ─────────────────────────────────────────────────────────────────────────────

export async function updateBeatCore(input: {
  beatId: string;
  spokenText?: string;
  directionNote?: string | null;
  screenText?: string | null;
  transitionIn?: string | null;
  transitionOut?: string | null;
  durationOverrideSec?: number | null;
  sources?: string[];
}): Promise<void> {
  const [current] = await db.select().from(scriptBeats).where(eq(scriptBeats.id, input.beatId));
  if (!current) throw new Error("Beat introuvable.");

  // `spokenText` vient de l'éditeur riche du monteur — même assainisseur que le corps d'article
  // (spec §8) : on ne fait jamais confiance à du HTML posé côté client sans repasser par DOMPurify.
  const spokenText = input.spokenText !== undefined ? sanitizeArticleHtml(input.spokenText) : current.spokenText;
  const durationOverrideSec = input.durationOverrideSec !== undefined
    ? input.durationOverrideSec
    : current.durationOverrideSec;

  const { wordsPerMinute } = await getVideoSettings();
  const estimatedDurationSec = beatSeconds({ spokenText, durationOverrideSec }, wordsPerMinute);

  await db.update(scriptBeats).set({
    spokenText,
    directionNote: input.directionNote !== undefined ? input.directionNote : current.directionNote,
    screenText: input.screenText !== undefined ? input.screenText : current.screenText,
    transitionIn: input.transitionIn !== undefined ? input.transitionIn : current.transitionIn,
    transitionOut: input.transitionOut !== undefined ? input.transitionOut : current.transitionOut,
    sources: input.sources !== undefined ? input.sources : current.sources,
    durationOverrideSec,
    estimatedDurationSec,
    // Une édition humaine explicite : ce beat s'écarte désormais potentiellement de son dernier
    // import, donc computeMerge doit le savoir au prochain ré-import.
    locallyEditedAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(scriptBeats.id, input.beatId));
}

// ─────────────────────────────────────────────────────────────────────────────
// Réordonnancement
// ─────────────────────────────────────────────────────────────────────────────

export async function reorderBeatsCore(input: { variantId: string; order: string[] }): Promise<void> {
  await db.transaction(async (tx) => {
    for (const [index, externalId] of input.order.entries()) {
      await tx.update(scriptBeats)
        .set({ position: index, updatedAt: new Date() })
        .where(and(eq(scriptBeats.variantId, input.variantId), eq(scriptBeats.externalId, externalId)));
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Import — préparation (lecture seule hors journal)
// ─────────────────────────────────────────────────────────────────────────────

async function writeJournal(args: {
  projectId: string;
  variantId: string | null;
  source: JournalSource;
  userId: string | null;
  schemaVersion: string | null;
  rawPayload: unknown;
  errorReport: unknown[];
  diff: Record<string, unknown>;
  outcome: JournalOutcome;
}): Promise<string> {
  const [entry] = await db.insert(scriptJournal).values({
    projectId: args.projectId,
    variantId: args.variantId,
    source: args.source,
    actorUserId: args.userId,
    schemaVersion: args.schemaVersion,
    rawPayload: args.rawPayload,
    errorReport: args.errorReport,
    diff: args.diff,
    applied: {},
    outcome: args.outcome,
  }).returning({ id: scriptJournal.id });
  return entry.id;
}

// Stocke le JSON réellement compris (post-BOM/fences) quand c'est possible, sinon la chaîne brute
// telle quelle : quand un import échoue, la seule façon de diagnostiquer est de relire ce que le
// modèle a produit, pas ce que le parseur en a compris (commentaire du schéma, db/schema.ts).
function rawPayloadForJournal(raw: string): unknown {
  try {
    return JSON.parse(stripEnvelope(raw));
  } catch {
    return raw;
  }
}

// Charge l'état complet (colonnes brutes incluses : id, durationOverrideSec, estimatedDurationSec,
// locallyEditedAt) — dbLike accepte aussi bien `db` que `tx` : capturer l'état "avant" dans
// applyImportCore doit se faire DANS la transaction, sur la même connexion que les écritures qui
// suivent.
async function loadFullBeatRows(dbLike: DbLike, variantId: string) {
  const beats = await dbLike.select().from(scriptBeats)
    .where(eq(scriptBeats.variantId, variantId))
    .orderBy(asc(scriptBeats.position));
  if (beats.length === 0) return [];

  const beatIds = beats.map((b) => b.id);
  const inserts = await dbLike.select().from(beatInserts)
    .where(inArray(beatInserts.beatId, beatIds))
    .orderBy(asc(beatInserts.position));

  const insertsByBeat = new Map<string, InsertPayload[]>();
  for (const ins of inserts) {
    const list = insertsByBeat.get(ins.beatId) ?? [];
    // Mêmes clés, dans le même ordre que insertPayloadSchema (lib/video/schema.ts) : computeMerge
    // compare les instantanés par JSON.stringify, donc une forme différente pour une valeur
    // identique produirait un conflit fantôme.
    list.push({
      type: ins.kind,
      url: ins.url,
      tc_in: ins.tcIn,
      tc_out: ins.tcOut,
      duree_affichage_sec: ins.displayDurationSec,
      credit: ins.credit,
      droits: ins.rightsNote,
    });
    insertsByBeat.set(ins.beatId, list);
  }

  return beats.map((b) => ({
    id: b.id,
    externalId: b.externalId,
    position: b.position,
    locallyEditedAt: b.locallyEditedAt,
    durationOverrideSec: b.durationOverrideSec,
    estimatedDurationSec: b.estimatedDurationSec,
    snapshot: {
      kind: b.kind,
      spokenText: b.spokenText,
      directionNote: b.directionNote,
      screenText: b.screenText,
      transitionIn: b.transitionIn,
      transitionOut: b.transitionOut,
      sources: b.sources,
      inserts: insertsByBeat.get(b.id) ?? [],
    } as BeatSnapshot,
    importedSnapshot: (b.importedSnapshot as unknown as BeatSnapshot | null) ?? null,
  }));
}

async function loadBeatRows(variantId: string): Promise<BeatRow[]> {
  const full = await loadFullBeatRows(db, variantId);
  return full.map((r) => ({
    externalId: r.externalId, position: r.position, snapshot: r.snapshot, importedSnapshot: r.importedSnapshot,
  }));
}

export async function prepareImportCore(args: {
  projectId: string;
  variantId: string;
  raw: string;
  userId: string | null;
  source: JournalSource;
}): Promise<{ ok: true; journalId: string; diff: Diff } | { ok: false; issues: Issue[] }> {
  const parsed = parseIncoming(args.raw);
  if (!parsed.ok) {
    await writeJournal({
      projectId: args.projectId, variantId: args.variantId, source: args.source, userId: args.userId,
      schemaVersion: null, rawPayload: rawPayloadForJournal(args.raw), errorReport: parsed.issues,
      diff: {}, outcome: "rejete",
    });
    return { ok: false, issues: parsed.issues };
  }

  const existingVariants = await db.select().from(scriptVariants).where(eq(scriptVariants.projectId, args.projectId));
  const targetVariant = existingVariants.find((v) => v.id === args.variantId);
  if (!targetVariant) {
    const issues: Issue[] = [{ path: "variantId", message: "Variante introuvable pour ce projet." }];
    await writeJournal({
      projectId: args.projectId, variantId: null, source: args.source, userId: args.userId,
      schemaVersion: parsed.payload.schema_version, rawPayload: rawPayloadForJournal(args.raw),
      errorReport: issues, diff: {}, outcome: "rejete",
    });
    return { ok: false, issues };
  }

  // Variante absente (spec §8) : une plateforme du payload qui n'a pas encore de variante dans le
  // projet en obtient une, à condition que plateforme/durée cible/ratio soient tous les trois
  // présents — sinon on réclame les trois champs plutôt que de deviner. « Aucun import partiel »
  // (round de correction 1, ruling 3) : on calcule la TOTALITÉ des issues d'abord, sans rien
  // écrire — une variante ne doit jamais être créée si une AUTRE variante du même payload,
  // rencontrée plus tard dans le tableau, s'avère invalide.
  const missingVariantIssues: Issue[] = [];
  const variantsToCreate: {
    plateforme: VariantPayload["plateforme"]; dureeCibleSec: number; ratio: string;
  }[] = [];
  const knownPlatforms = new Set(existingVariants.map((v) => v.platform));
  for (const [vi, variante] of parsed.payload.variantes.entries()) {
    if (knownPlatforms.has(variante.plateforme)) continue;
    if (variante.duree_cible_sec != null && variante.ratio != null) {
      variantsToCreate.push({
        plateforme: variante.plateforme, dureeCibleSec: variante.duree_cible_sec, ratio: variante.ratio,
      });
      knownPlatforms.add(variante.plateforme); // le payload répète parfois la même plateforme absente
    } else {
      missingVariantIssues.push({
        path: `variantes[${vi}]`,
        message: "plateforme, duree_cible_sec et ratio sont requis pour créer une nouvelle variante.",
      });
    }
  }
  if (missingVariantIssues.length > 0) {
    await writeJournal({
      projectId: args.projectId, variantId: args.variantId, source: args.source, userId: args.userId,
      schemaVersion: parsed.payload.schema_version, rawPayload: rawPayloadForJournal(args.raw),
      errorReport: missingVariantIssues, diff: {}, outcome: "rejete",
    });
    return { ok: false, issues: missingVariantIssues };
  }

  let variants = existingVariants;
  for (const v of variantsToCreate) {
    const nextPosition = variants.reduce((max, existing) => Math.max(max, existing.position), -1) + 1;
    const [created] = await db.insert(scriptVariants).values({
      projectId: args.projectId,
      platform: v.plateforme,
      targetDurationSec: v.dureeCibleSec,
      aspectRatio: v.ratio,
      position: nextPosition,
    }).returning();
    variants = [...variants, created];
  }

  const refreshedTarget = variants.find((v) => v.id === args.variantId) ?? targetVariant;
  const matchingVariante = parsed.payload.variantes.find((v) => v.plateforme === refreshedTarget.platform);
  if (!matchingVariante) {
    const noVariantIssues: Issue[] = [{
      path: "variantes",
      message: `le payload ne contient aucune variante « ${refreshedTarget.platform} ».`,
    }];
    await writeJournal({
      projectId: args.projectId, variantId: refreshedTarget.id, source: args.source, userId: args.userId,
      schemaVersion: parsed.payload.schema_version, rawPayload: rawPayloadForJournal(args.raw),
      errorReport: noVariantIssues, diff: {}, outcome: "rejete",
    });
    return { ok: false, issues: noVariantIssues };
  }

  const currentBeats = await loadBeatRows(refreshedTarget.id);
  const diff = computeMerge(currentBeats, matchingVariante.beats);

  // Journalisée mais PAS encore appliquée : outcome "en_attente" (round de correction 1). Distinct
  // d'"annule" (qui signifie « revenu en arrière ») — une requête sur les imports annulés ne doit
  // pas remonter les diffs simplement en attente de décision. applyImportCore la fait passer à
  // "applique" au moment décisif, et refuse d'agir si l'entrée n'est plus "en_attente".
  const journalId = await writeJournal({
    projectId: args.projectId, variantId: refreshedTarget.id, source: args.source, userId: args.userId,
    schemaVersion: parsed.payload.schema_version, rawPayload: rawPayloadForJournal(args.raw),
    errorReport: [], diff: diff as unknown as Record<string, unknown>, outcome: "en_attente",
  });

  return { ok: true, journalId, diff };
}

// ─────────────────────────────────────────────────────────────────────────────
// Import — application (une seule transaction)
// ─────────────────────────────────────────────────────────────────────────────

async function resolveBeatId(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  variantId: string,
  externalId: string,
): Promise<string> {
  const [row] = await tx.select({ id: scriptBeats.id }).from(scriptBeats)
    .where(and(eq(scriptBeats.variantId, variantId), eq(scriptBeats.externalId, externalId)));
  if (!row) throw new Error(`Beat introuvable pour la mise à jour des inserts (${externalId}).`);
  return row.id;
}

function insertValuesFor(beatId: string, inserts: BeatSnapshot["inserts"]) {
  return inserts.map((ins, i) => ({
    beatId,
    kind: ins.type,
    url: ins.url ?? null,
    tcIn: ins.tc_in ?? null,
    tcOut: ins.tc_out ?? null,
    displayDurationSec: ins.duree_affichage_sec ?? null,
    credit: ins.credit ?? null,
    rightsNote: ins.droits ?? null,
    position: i,
  }));
}

async function insertBeatInserts(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  externalId: string,
  variantId: string,
  inserts: BeatSnapshot["inserts"],
): Promise<void> {
  if (inserts.length === 0) return;
  const beatId = await resolveBeatId(tx, variantId, externalId);
  await tx.insert(beatInserts).values(insertValuesFor(beatId, inserts));
}

async function replaceBeatInserts(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  externalId: string,
  variantId: string,
  inserts: BeatSnapshot["inserts"],
): Promise<void> {
  const beatId = await resolveBeatId(tx, variantId, externalId);
  await tx.delete(beatInserts).where(eq(beatInserts.beatId, beatId));
  if (inserts.length > 0) {
    await tx.insert(beatInserts).values(insertValuesFor(beatId, inserts));
  }
}

// spokenText vient d'un modèle et transite par un éditeur riche — il passe par le même
// assainisseur que le corps d'article (spec §8).
function sanitizeSnapshot(s: BeatSnapshot): BeatSnapshot {
  return { ...s, spokenText: sanitizeArticleHtml(s.spokenText) };
}

export async function applyImportCore(args: {
  journalId: string; variantId: string; accept: string[]; variantUpdatedAt: Date;
}): Promise<{ ok: true; applied: number } | { ok: false; message: string }> {
  const [variant] = await db.select().from(scriptVariants).where(eq(scriptVariants.id, args.variantId));
  if (!variant) return { ok: false as const, message: "Variante introuvable." };
  // Péremption : le diff a été calculé sur un état qui a bougé depuis. Appliquer quand même
  // écraserait une modification qu'on n'a jamais montrée à l'utilisateur.
  if (variant.updatedAt.getTime() !== args.variantUpdatedAt.getTime()) {
    return { ok: false as const, message: "L'aperçu est périmé — recalculez le diff avant d'appliquer." };
  }

  const [entry] = await db.select().from(scriptJournal).where(eq(scriptJournal.id, args.journalId));
  if (!entry) return { ok: false as const, message: "Entrée de journal introuvable." };
  // Refuse une entrée déjà appliquée ou déjà annulée : appliquer deux fois la même entrée, ou
  // appliquer une entrée annulée, écrirait une seconde fois des mutations déjà (dés)actées.
  if (entry.outcome !== "en_attente") {
    return {
      ok: false as const,
      message: "Cette entrée n'est plus en attente d'application (déjà appliquée ou annulée).",
    };
  }

  const { wordsPerMinute } = await getVideoSettings();
  const mutations = applyMerge(entry.diff as unknown as Diff, { accept: args.accept });

  await db.transaction(async (tx) => {
    // Capture l'état ANTÉRIEUR de tous les beats que la mutation va toucher — updates, removes, et
    // ceux dont seule la position change — AVANT toute écriture. C'est la seule matière première
    // d'une annulation fidèle (round de correction 1, ruling 2) : `Mutations` seule ne décrit que
    // l'état d'arrivée.
    const currentRows = await loadFullBeatRows(tx, args.variantId);
    const updateIds = new Set(mutations.update.map((u) => u.externalId));
    const removeIds = new Set(mutations.remove);
    const orderIndex = new Map(mutations.order.map((id, i) => [id, i]));
    const before: BeforeBeat[] = currentRows
      .filter((row) => updateIds.has(row.externalId) || removeIds.has(row.externalId)
        || orderIndex.get(row.externalId) !== undefined && orderIndex.get(row.externalId) !== row.position)
      .map((row) => ({
        externalId: row.externalId,
        snapshot: row.snapshot,
        importedSnapshot: row.importedSnapshot,
        position: row.position,
        locallyEditedAt: row.locallyEditedAt ? row.locallyEditedAt.toISOString() : null,
        durationOverrideSec: row.durationOverrideSec,
        estimatedDurationSec: row.estimatedDurationSec,
      }));

    for (const row of mutations.create) {
      const snapshot = sanitizeSnapshot(row.snapshot);
      await tx.insert(scriptBeats).values({
        variantId: args.variantId, externalId: row.externalId,
        position: mutations.order.indexOf(row.externalId),
        kind: snapshot.kind, spokenText: snapshot.spokenText,
        directionNote: snapshot.directionNote, screenText: snapshot.screenText,
        transitionIn: snapshot.transitionIn, transitionOut: snapshot.transitionOut,
        sources: snapshot.sources,
        estimatedDurationSec: beatSeconds({ spokenText: snapshot.spokenText, durationOverrideSec: null }, wordsPerMinute),
        // L'instantané devient la nouvelle base de fusion, et l'édition locale est remise à zéro :
        // ce beat est désormais exactement ce que le dernier import a posé.
        importedSnapshot: snapshot, locallyEditedAt: null,
      });
      await insertBeatInserts(tx, row.externalId, args.variantId, snapshot.inserts);
    }

    for (const patch of mutations.update) {
      const snapshot = sanitizeSnapshot(patch.snapshot);
      await tx.update(scriptBeats).set({
        kind: snapshot.kind, spokenText: snapshot.spokenText,
        directionNote: snapshot.directionNote, screenText: snapshot.screenText,
        transitionIn: snapshot.transitionIn, transitionOut: snapshot.transitionOut,
        sources: snapshot.sources,
        estimatedDurationSec: beatSeconds({ spokenText: snapshot.spokenText, durationOverrideSec: null }, wordsPerMinute),
        importedSnapshot: snapshot, locallyEditedAt: null, updatedAt: new Date(),
      }).where(and(eq(scriptBeats.variantId, args.variantId), eq(scriptBeats.externalId, patch.externalId)));
      await replaceBeatInserts(tx, patch.externalId, args.variantId, snapshot.inserts);
    }

    if (mutations.remove.length > 0) {
      await tx.delete(scriptBeats).where(and(
        eq(scriptBeats.variantId, args.variantId), inArray(scriptBeats.externalId, mutations.remove),
      ));
    }

    // Réordonnancement APRÈS ajouts et suppressions : l'ordre porte sur les beats survivants.
    for (const [index, externalId] of mutations.order.entries()) {
      await tx.update(scriptBeats).set({ position: index }).where(and(
        eq(scriptBeats.variantId, args.variantId), eq(scriptBeats.externalId, externalId),
      ));
    }

    await tx.update(scriptVariants).set({ updatedAt: new Date() }).where(eq(scriptVariants.id, args.variantId));
    const appliedRecord: AppliedRecord = { ...mutations, before };
    await tx.update(scriptJournal)
      .set({ outcome: "applique", applied: appliedRecord as unknown as Record<string, unknown> })
      .where(eq(scriptJournal.id, args.journalId));
  });

  return { ok: true as const, applied: mutations.create.length + mutations.update.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// Annulation d'une entrée de journal
// ─────────────────────────────────────────────────────────────────────────────

// Restaure depuis `applied` (round de correction 1, ruling 2) : `applied.before` (capturé dans
// applyImportCore, DANS la même transaction que les écritures, avant qu'elles n'aient lieu) porte
// l'état antérieur de chaque beat modifié/supprimé/déplacé par cette entrée — c'est ce qui rend
// l'annulation d'une modification ou d'une suppression réellement fidèle, pas seulement celle
// d'une création.
export async function revertJournalEntryCore(
  journalId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const [entry] = await db.select().from(scriptJournal).where(eq(scriptJournal.id, journalId));
  if (!entry) return { ok: false, message: "Entrée de journal introuvable." };
  if (entry.outcome !== "applique") return { ok: false, message: "Cette entrée n'a rien appliqué à annuler." };
  if (entry.revertedAt) return { ok: false, message: "Cette entrée a déjà été annulée." };
  if (!entry.variantId) return { ok: false, message: "Variante introuvable pour cette entrée." };

  const applied = entry.applied as unknown as AppliedRecord;
  const touchedIds = new Set([
    ...applied.create.map((r) => r.externalId),
    ...applied.update.map((u) => u.externalId),
    ...applied.remove,
  ]);

  // Refuse si un import postérieur non annulé a retouché l'un des mêmes externalId : l'annuler
  // effacerait un changement qu'on n'a jamais montré à l'utilisateur comme « à annuler ».
  // `ne(id, journalId)` en plus de `gt(createdAt, ...)`, et pas seulement ce dernier : `createdAt`
  // (JS Date, précision milliseconde) perd la précision microseconde de la colonne timestamp au
  // retour de lecture, si bien qu'un aller-retour de CETTE entrée à travers `gt` peut se
  // retrouver strictement supérieur à sa propre valeur arrondie — elle se bloquerait elle-même
  // sans cette exclusion explicite.
  const laterEntries = await db.select().from(scriptJournal).where(and(
    eq(scriptJournal.variantId, entry.variantId),
    eq(scriptJournal.outcome, "applique"),
    ne(scriptJournal.id, entry.id),
    gt(scriptJournal.createdAt, entry.createdAt),
  ));
  for (const later of laterEntries) {
    if (later.revertedAt) continue; // déjà annulée elle-même : ne bloque pas
    const laterApplied = later.applied as unknown as AppliedRecord;
    const laterIds = [
      ...laterApplied.create.map((r) => r.externalId),
      ...laterApplied.update.map((u) => u.externalId),
      ...laterApplied.remove,
    ];
    if (laterIds.some((id) => touchedIds.has(id))) {
      return { ok: false, message: "Un import plus récent a modifié un des mêmes beats — annulation impossible." };
    }
  }

  const beforeByExternalId = new Map(applied.before.map((b) => [b.externalId, b]));

  await db.transaction(async (tx) => {
    const variantId = entry.variantId as string;

    // 1. Retire ce que cette entrée a créé.
    for (const row of applied.create) {
      await tx.delete(scriptBeats).where(and(
        eq(scriptBeats.variantId, variantId), eq(scriptBeats.externalId, row.externalId),
      ));
    }

    // 2. Recrée, à l'identique, les beats que cette entrée avait supprimés.
    for (const externalId of applied.remove) {
      const b = beforeByExternalId.get(externalId);
      if (!b) continue; // ne devrait pas arriver : applyImportCore capture systématiquement `before` pour `remove`
      await tx.insert(scriptBeats).values({
        variantId, externalId,
        position: b.position,
        kind: b.snapshot.kind, spokenText: b.snapshot.spokenText,
        directionNote: b.snapshot.directionNote, screenText: b.snapshot.screenText,
        transitionIn: b.snapshot.transitionIn, transitionOut: b.snapshot.transitionOut,
        sources: b.snapshot.sources,
        durationOverrideSec: b.durationOverrideSec, estimatedDurationSec: b.estimatedDurationSec,
        importedSnapshot: b.importedSnapshot, locallyEditedAt: b.locallyEditedAt ? new Date(b.locallyEditedAt) : null,
      });
      await replaceBeatInserts(tx, externalId, variantId, b.snapshot.inserts);
    }

    // 3. Restaure le contenu des beats que cette entrée avait modifiés.
    for (const patch of applied.update) {
      const b = beforeByExternalId.get(patch.externalId);
      if (!b) continue; // idem : capturé systématiquement pour `update`
      await tx.update(scriptBeats).set({
        kind: b.snapshot.kind, spokenText: b.snapshot.spokenText,
        directionNote: b.snapshot.directionNote, screenText: b.snapshot.screenText,
        transitionIn: b.snapshot.transitionIn, transitionOut: b.snapshot.transitionOut,
        sources: b.snapshot.sources,
        durationOverrideSec: b.durationOverrideSec, estimatedDurationSec: b.estimatedDurationSec,
        importedSnapshot: b.importedSnapshot, locallyEditedAt: b.locallyEditedAt ? new Date(b.locallyEditedAt) : null,
        updatedAt: new Date(),
      }).where(and(eq(scriptBeats.variantId, variantId), eq(scriptBeats.externalId, patch.externalId)));
      await replaceBeatInserts(tx, patch.externalId, variantId, b.snapshot.inserts);
    }

    // 4. Restaure les positions de TOUS les beats capturés dans `before` — y compris ceux dont
    // seule la position avait bougé lors de l'application, sans modification de contenu.
    for (const b of applied.before) {
      await tx.update(scriptBeats).set({ position: b.position }).where(and(
        eq(scriptBeats.variantId, variantId), eq(scriptBeats.externalId, b.externalId),
      ));
    }

    await tx.update(scriptJournal).set({ outcome: "annule", revertedAt: new Date() }).where(eq(scriptJournal.id, journalId));
  });

  return { ok: true };
}
