import {
  db, videoProjects, scriptVariants, scriptBeats, beatInserts, scriptJournal, scriptJournalSource,
} from "@/db";
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import {
  applyMerge, computeMerge, parseIncoming, stripEnvelope, type BeatRow, type BeatSnapshot,
  type Diff, type Issue, type Mutations,
} from "@/lib/video/import";
import { beatSeconds } from "@/lib/video/duration";
import { sanitizeArticleHtml } from "@/lib/sanitize";
import { getVideoSettings } from "@/lib/queries/video-settings";
import type { InsertPayload } from "@/lib/video/schema";

// Cœur DB brut du module vidéo — délibérément SANS "use server" (voir lib/actions/video-actions.ts
// pour le motif). C'est aussi la SEULE exception à « lib/video/* n'importe jamais @/db » : le
// mapping payload français → colonnes anglaises vit ici, et nulle part ailleurs.

type JournalSource = (typeof scriptJournalSource.enumValues)[number];
type JournalOutcome = "rejete" | "applique" | "annule";

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

async function loadBeatRows(variantId: string): Promise<BeatRow[]> {
  const beats = await db.select().from(scriptBeats)
    .where(eq(scriptBeats.variantId, variantId))
    .orderBy(asc(scriptBeats.position));
  if (beats.length === 0) return [];

  const beatIds = beats.map((b) => b.id);
  const inserts = await db.select().from(beatInserts)
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
    externalId: b.externalId,
    position: b.position,
    snapshot: {
      kind: b.kind,
      spokenText: b.spokenText,
      directionNote: b.directionNote,
      screenText: b.screenText,
      transitionIn: b.transitionIn,
      transitionOut: b.transitionOut,
      sources: b.sources,
      inserts: insertsByBeat.get(b.id) ?? [],
    },
    importedSnapshot: (b.importedSnapshot as unknown as BeatSnapshot | null) ?? null,
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
  // présents — sinon on réclame les trois champs plutôt que de deviner.
  let variants = existingVariants;
  const issues: Issue[] = [];
  for (const [vi, variante] of parsed.payload.variantes.entries()) {
    if (variants.some((v) => v.platform === variante.plateforme)) continue;
    if (variante.duree_cible_sec != null && variante.ratio != null) {
      const nextPosition = variants.reduce((max, v) => Math.max(max, v.position), -1) + 1;
      const [created] = await db.insert(scriptVariants).values({
        projectId: args.projectId,
        platform: variante.plateforme,
        targetDurationSec: variante.duree_cible_sec,
        aspectRatio: variante.ratio,
        position: nextPosition,
      }).returning();
      variants = [...variants, created];
    } else {
      issues.push({
        path: `variantes[${vi}]`,
        message: "plateforme, duree_cible_sec et ratio sont requis pour créer une nouvelle variante.",
      });
    }
  }
  if (issues.length > 0) {
    await writeJournal({
      projectId: args.projectId, variantId: args.variantId, source: args.source, userId: args.userId,
      schemaVersion: parsed.payload.schema_version, rawPayload: rawPayloadForJournal(args.raw),
      errorReport: issues, diff: {}, outcome: "rejete",
    });
    return { ok: false, issues };
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

  // Journalisée mais PAS encore appliquée : outcome "annule" fait office d'état « en attente de
  // décision » — le seul état neutre disponible dans script_journal_outcome (rejete/applique/
  // annule), qui n'a jamais prévu d'état intermédiaire. Si l'utilisateur n'applique jamais ce
  // diff, l'entrée reste "annule" et décrit correctement un import qui n'a rien changé.
  // applyImportCore la fait passer à "applique" au moment décisif.
  const journalId = await writeJournal({
    projectId: args.projectId, variantId: refreshedTarget.id, source: args.source, userId: args.userId,
    schemaVersion: parsed.payload.schema_version, rawPayload: rawPayloadForJournal(args.raw),
    errorReport: [], diff: diff as unknown as Record<string, unknown>, outcome: "annule",
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

  const { wordsPerMinute } = await getVideoSettings();
  const mutations = applyMerge(entry.diff as unknown as Diff, { accept: args.accept });

  await db.transaction(async (tx) => {
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
    await tx.update(scriptJournal)
      .set({ outcome: "applique", applied: mutations as unknown as Record<string, unknown> })
      .where(eq(scriptJournal.id, args.journalId));
  });

  return { ok: true as const, applied: mutations.create.length + mutations.update.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// Annulation d'une entrée de journal
// ─────────────────────────────────────────────────────────────────────────────

// Limite assumée : `applied` (Mutations) ne conserve que l'état POSÉ par l'import, jamais l'état
// d'AVANT (script_journal ne stocke pas de « before » pour update/remove — décision déjà prise au
// schéma, migration déjà appliquée, non révisable ici). Une création est donc réversible à coup
// sûr (on supprime ce qui a été posé) ; une modification ou une suppression ne le sont pas sans
// fabriquer une donnée qu'on n'a jamais eue. Plutôt que de deviner, on refuse ces cas — jamais de
// corruption silencieuse.
export async function revertJournalEntryCore(
  journalId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const [entry] = await db.select().from(scriptJournal).where(eq(scriptJournal.id, journalId));
  if (!entry) return { ok: false, message: "Entrée de journal introuvable." };
  if (entry.outcome !== "applique") return { ok: false, message: "Cette entrée n'a rien appliqué à annuler." };
  if (entry.revertedAt) return { ok: false, message: "Cette entrée a déjà été annulée." };
  if (!entry.variantId) return { ok: false, message: "Variante introuvable pour cette entrée." };

  const applied = entry.applied as unknown as Mutations;
  if (applied.update.length > 0 || applied.remove.length > 0) {
    return {
      ok: false,
      message: "Cet import a modifié ou supprimé des beats existants — l'annulation automatique "
        + "n'est pas prise en charge pour ce type d'import.",
    };
  }

  const touchedIds = new Set(applied.create.map((r) => r.externalId));

  // Refuse si un import postérieur non annulé a retouché l'un des mêmes externalId : l'annuler
  // effacerait un changement qu'on n'a jamais montré à l'utilisateur comme « à annuler ».
  const laterEntries = await db.select().from(scriptJournal).where(and(
    eq(scriptJournal.variantId, entry.variantId),
    eq(scriptJournal.outcome, "applique"),
    gt(scriptJournal.createdAt, entry.createdAt),
  ));
  for (const later of laterEntries) {
    if (later.revertedAt) continue; // déjà annulée elle-même : ne bloque pas
    const laterApplied = later.applied as unknown as Mutations;
    const laterIds = [
      ...laterApplied.create.map((r) => r.externalId),
      ...laterApplied.update.map((u) => u.externalId),
      ...laterApplied.remove,
    ];
    if (laterIds.some((id) => touchedIds.has(id))) {
      return { ok: false, message: "Un import plus récent a modifié un des mêmes beats — annulation impossible." };
    }
  }

  await db.transaction(async (tx) => {
    for (const row of applied.create) {
      await tx.delete(scriptBeats).where(and(
        eq(scriptBeats.variantId, entry.variantId as string), eq(scriptBeats.externalId, row.externalId),
      ));
    }
    await tx.update(scriptJournal).set({ outcome: "annule", revertedAt: new Date() }).where(eq(scriptJournal.id, journalId));
  });

  return { ok: true };
}
