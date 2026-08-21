import {
  db, videoProjects, scriptVariants, scriptBeats, beatInserts, scriptJournal, scriptJournalSource,
  interviewSpeakers,
} from "@/db";
import { and, asc, eq, gt, inArray, isNull, ne } from "drizzle-orm";
import {
  applyMerge, computeMerge, normalizeInserts, parseIncoming, stripEnvelope, toPayloadBeat,
  type BeatRow, type BeatSnapshot, type Diff, type Issue, type Mutations,
} from "@/lib/video/import";
import { estimateSeconds } from "@/lib/video/duration";
import { sanitizeArticleHtml } from "@/lib/sanitize";
import { getVideoSettings } from "@/lib/queries/video-settings";
import {
  SCHEMA_VERSION, type InsertKind, type InsertPayload, type Payload, type VariantPayload,
} from "@/lib/video/schema";
import { verifyUrl } from "@/lib/video/link-check";
import { mapWithConcurrency } from "@/lib/async-pool";
import { estTransitionAutorisee } from "@/lib/video/tournage-rules";

// Cœur DB brut du module vidéo — délibérément SANS "use server" (voir lib/actions/video-actions.ts
// pour le motif). C'est aussi la SEULE exception à « lib/video/* n'importe jamais @/db » : le
// mapping payload français → colonnes anglaises vit ici, et nulle part ailleurs.

type JournalSource = (typeof scriptJournalSource.enumValues)[number];
// "en_attente" (round de correction 1) : un diff préparé mais pas encore appliqué. Distinct
// d'"annule", qui signifie « revenu en arrière », pas « jamais appliqué ».
type JournalOutcome = "rejete" | "en_attente" | "applique" | "annule";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbLike = typeof db | Tx;

// Refus MÉTIER (validation, péremption, conflit) plutôt qu'échec technique — distingué des erreurs
// DB réelles pour que applyImportCore/revertJournalEntryCore puissent les convertir en
// `{ ok: false, message }` français sans avaler une vraie panne (round de correction 2, I4).
// Exportée (round de correction final) : `updateBeatCore`/`updateBeatInsertCore` renvoient une
// valeur utile plutôt qu'un `{ ok, message }`, elles LÈVENT donc leurs refus au lieu de les
// retourner. Sans cette classe visible, leurs appelants gardés (lib/actions/video-actions.ts) ne
// pouvaient pas distinguer « Beat introuvable » — un refus métier routinier — d'une vraie panne DB,
// et laissaient remonter les deux en erreur serveur brute côté client.
export class RefusalError extends Error {}

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
// `before` optionnel (round de correction 2, I10) : les entrées "applique" écrites avant son
// introduction n'en portent pas — revertJournalEntryCore doit le tolérer, pas planter dessus.
type AppliedRecord = Mutations & { before?: BeforeBeat[] };

/**
 * L'entrée de journal porte-t-elle l'état d'AVANT, seule matière première d'une annulation fidèle ?
 * Exportée (round de correction final, I3) pour que l'écran de projet n'offre le bouton « Annuler »
 * QUE là où revertJournalEntryCore peut aboutir : le prédicat est un seul, partagé, plutôt qu'une
 * lecture du jsonb recopiée côté rendu — deux lectures finiraient par ne plus s'accorder.
 */
export function hasBeforeState(applied: unknown): applied is { before: BeforeBeat[] } {
  return Array.isArray((applied as { before?: unknown } | null)?.before);
}

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
  categoryId: string | null;
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
      categoryId: input.categoryId,
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
  speakerId?: string | null;
  answersBeatId?: string | null;
}): Promise<{ spokenText: string; estimatedDurationSec: number; durationOverrideSec: number | null }> {
  // (round de correction 3, N2) : `getVideoSettings()` passe par le `db` global, donc une
  // CONNEXION SÉPARÉE de celle de la transaction ci-dessous (laquelle emprunte SA propre connexion
  // au pool dès `db.transaction(...)`). Appelée depuis L'INTÉRIEUR de la transaction, elle
  // emprunterait une seconde connexion — et peut même y committer un `INSERT` (la ligne de réglages
  // par défaut, si elle n'existe pas encore) hors de la transaction du beat. Un lot d'`updateBeat`
  // concurrents épuiserait alors le pool (chacun retient une connexion en attendant la seconde) et
  // bloquerait jusqu'au timeout. Hissée ici, avant `db.transaction`, comme applyImportCore le fait
  // déjà correctement.
  const { wordsPerMinute } = await getVideoSettings();

  return db.transaction(async (tx) => {
    // Ordre de verrouillage (round de correction 4) : `script_variants` D'ABORD, `script_beats`
    // ENSUITE — le même ordre que applyImportCore et revertJournalEntryCore. Sans ce verrou en
    // tête, cette transaction prenait la ligne beat puis attendait la ligne variante, pendant
    // qu'un import concurrent tenait la variante et voulait écrire ce même beat : un ABBA que
    // Postgres tranche par un `deadlock detected` — une exception brute, pas un refus métier,
    // qui remonterait illisible jusqu'à l'utilisateur. C'est exactement la collision que rend
    // probable le scénario « l'utilisateur édite entre la préparation et l'application ».
    //
    // Cette première lecture est SANS verrou : elle ne sert qu'à connaître la variante à
    // verrouiller (`variantId` n'est porté que par la ligne beat). Un `select` nu ne pose aucun
    // verrou de ligne, il ne peut donc pas participer au cycle. L'état faisant autorité est relu
    // ci-dessous, une fois la variante verrouillée — tous les écrivains de beats de cette variante
    // passent désormais par ce verrou, la relecture est donc stable jusqu'au commit.
    const [located] = await tx.select({ variantId: scriptBeats.variantId }).from(scriptBeats)
      .where(eq(scriptBeats.id, input.beatId));
    if (!located) throw new RefusalError("Beat introuvable.");

    const [variant] = await tx.select({ id: scriptVariants.id }).from(scriptVariants)
      .where(eq(scriptVariants.id, located.variantId)).for("update");
    if (!variant) throw new RefusalError("Variante introuvable pour ce beat.");

    const [current] = await tx.select().from(scriptBeats).where(eq(scriptBeats.id, input.beatId));
    if (!current) throw new RefusalError("Beat introuvable.");

    // Assignation d'un locuteur : l'intervenant doit appartenir au projet du beat.
    if (input.speakerId !== undefined && input.speakerId !== null) {
      const [proj] = await tx.select({ projectId: scriptVariants.projectId }).from(scriptVariants)
        .where(eq(scriptVariants.id, current.variantId));
      const [sp] = await tx.select({ projectId: interviewSpeakers.projectId }).from(interviewSpeakers)
        .where(eq(interviewSpeakers.id, input.speakerId));
      if (!sp || !proj || sp.projectId !== proj.projectId) throw new RefusalError("Intervenant absent de ce projet.");
    }
    // Mapping Q/R strict : réponse → question de la même variante, jamais soi-même.
    if (input.answersBeatId !== undefined && input.answersBeatId !== null) {
      if (current.kind !== "reponse") throw new RefusalError("Seul un beat « réponse » peut répondre à une question.");
      if (input.answersBeatId === input.beatId) throw new RefusalError("Un beat ne peut pas se répondre à lui-même.");
      const [target] = await tx.select({ kind: scriptBeats.kind, variantId: scriptBeats.variantId }).from(scriptBeats)
        .where(eq(scriptBeats.id, input.answersBeatId));
      if (!target || target.kind !== "question" || target.variantId !== current.variantId) {
        throw new RefusalError("La cible doit être une question de la même variante.");
      }
    }

    // `spokenText` vient de l'éditeur riche du monteur — même assainisseur que le corps d'article
    // (spec §8) : on ne fait jamais confiance à du HTML posé côté client sans repasser par DOMPurify.
    const spokenText = input.spokenText !== undefined ? sanitizeArticleHtml(input.spokenText) : current.spokenText;
    const durationOverrideSec = input.durationOverrideSec !== undefined
      ? input.durationOverrideSec
      : current.durationOverrideSec;

    // Round de correction final, I2 : la colonne `estimated_duration_sec` porte TOUJOURS
    // l'ESTIMATION PURE, jamais l'override. L'ancienne version écrivait ici
    // `beatSeconds({…, durationOverrideSec})`, donc l'override dans une colonne nommée « estimated »
    // — alors que les deux chemins d'écriture d'import (applyImportCore) y écrivaient l'estimation.
    // Une même colonne portait ainsi deux grandeurs différentes selon l'écrivain, et les lieux de
    // lecture divergeaient à leur tour : /video sommait `estimatedDurationSec` seul quand la vue
    // Écriture affichait `durationOverrideSec ?? estimatedDurationSec`. Le spec §4 tranche :
    // « `durationOverrideSec`, quand il est posé, l'emporte partout » — c'est donc aux LECTURES
    // d'appliquer le `??` (lib/queries/video.ts, components/video/beat-list.tsx), pas à l'écriture
    // d'écraser l'estimation.
    const estimatedDurationSec = estimateSeconds(spokenText, wordsPerMinute);

    await tx.update(scriptBeats).set({
      spokenText,
      directionNote: input.directionNote !== undefined ? input.directionNote : current.directionNote,
      screenText: input.screenText !== undefined ? input.screenText : current.screenText,
      transitionIn: input.transitionIn !== undefined ? input.transitionIn : current.transitionIn,
      transitionOut: input.transitionOut !== undefined ? input.transitionOut : current.transitionOut,
      sources: input.sources !== undefined ? input.sources : current.sources,
      speakerId: input.speakerId !== undefined ? input.speakerId : current.speakerId,
      answersBeatId: input.answersBeatId !== undefined ? input.answersBeatId : current.answersBeatId,
      durationOverrideSec,
      estimatedDurationSec,
      // Une édition humaine explicite : ce beat s'écarte désormais potentiellement de son dernier
      // import, donc computeMerge doit le savoir au prochain ré-import.
      locallyEditedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(scriptBeats.id, input.beatId));

    // (round de correction 2, C1) : le contrôle de péremption d'applyImportCore compare
    // scriptVariants.updatedAt. Sans ce bump, une édition humaine entre prepareImport et
    // applyImport passerait inaperçue et serait écrasée en silence par l'import.
    await tx.update(scriptVariants).set({ updatedAt: new Date() }).where(eq(scriptVariants.id, current.variantId));

    // Round de correction 1 (Task 12, I3) : renvoyer l'état RÉELLEMENT stocké — `spokenText` déjà
    // passé par sanitizeArticleHtml, `estimatedDurationSec` déjà recalculé avec la cadence des
    // réglages. L'appelant (updateBeat, lib/actions/video-actions.ts) relaie ces valeurs telles
    // quelles pour la mise à jour optimiste côté client, plutôt que de laisser le client réinjecter
    // son propre HTML non assaini ou recalculer la durée avec une cadence par défaut potentiellement
    // fausse (BeatList#storedSeconds — même round, I2).
    return { spokenText, estimatedDurationSec, durationOverrideSec };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Édition d'un insert (Task 12, complément de revue)
// ─────────────────────────────────────────────────────────────────────────────

// Patch partiel sur toutes les colonnes éditables de beat_inserts (spec §6 étendue, SP3) : `url`
// était la seule exposée au round de correction 1 (Task 12, I4) faute d'appelant/UI/validation pour
// le reste ; ce lot les rend toutes éditables (tcIn, tcOut, displayDurationSec, credit, rightsNote),
// chacune en patch partiel — absent = non touché, `null` = vidé.
export async function updateBeatInsertCore(input: {
  insertId: string;
  url?: string | null;
  kind?: InsertKind;
  tcIn?: string | null;
  tcOut?: string | null;
  displayDurationSec?: number | null;
  credit?: string | null;
  rightsNote?: string | null;
}): Promise<void> {
  await db.transaction(async (tx) => {
    // Ordre de verrouillage (round de correction 4, inventaire task-9-report.md) : `script_variants`
    // D'ABORD, `script_beats` ENSUITE, `beat_inserts` EN DERNIER — le même ordre global que
    // applyImportCore/revertJournalEntryCore (les deux seules autres fonctions qui écrivent
    // beat_inserts). Ne pas rouvrir le cycle ABBA que quatre rounds de correction ont mis quatre
    // passes à éliminer sur ce fichier.
    //
    // Deux lectures nues en tête, sans verrou : `insertId` ne porte que `beatId`, `beatId` ne porte
    // que `variantId` — il faut les deux pour savoir QUELLE variante verrouiller. Un `select` nu ne
    // pose aucun verrou de ligne, il ne peut donc pas participer au cycle ; l'état faisant autorité
    // est relu plus bas, une fois la variante verrouillée.
    const [locatedInsert] = await tx.select({ beatId: beatInserts.beatId }).from(beatInserts)
      .where(eq(beatInserts.id, input.insertId));
    if (!locatedInsert) throw new RefusalError("Insert introuvable.");

    const [locatedBeat] = await tx.select({ variantId: scriptBeats.variantId }).from(scriptBeats)
      .where(eq(scriptBeats.id, locatedInsert.beatId));
    if (!locatedBeat) throw new RefusalError("Beat introuvable pour cet insert.");

    const [variant] = await tx.select({ id: scriptVariants.id }).from(scriptVariants)
      .where(eq(scriptVariants.id, locatedBeat.variantId)).for("update");
    if (!variant) throw new RefusalError("Variante introuvable pour cet insert.");

    const [current] = await tx.select().from(beatInserts).where(eq(beatInserts.id, input.insertId));
    if (!current) throw new RefusalError("Insert introuvable.");

    // Une URL corrigée à la main n'a jamais été vérifiée : `linkStatus`/`linkCheckedAt` (posés par
    // un futur vérificateur de liens, hors périmètre ici) mentiraient sur l'URL qui vient de
    // changer si on les laissait tels quels. `url` est désormais optionnel (patch partiel) : absent
    // = pas touché, donc pas de reset ; seul un url FOURNI et différent du courant invalide le statut.
    const urlProvided = input.url !== undefined;
    const urlChanged = urlProvided && input.url !== current.url;

    // script_beats AVANT beat_inserts (ordre ci-dessus) : cette édition d'insert est aussi une
    // édition humaine du beat parent, au même titre qu'updateBeatCore — computeMerge doit savoir
    // au prochain ré-import que ce beat s'est écarté de son dernier import.
    await tx.update(scriptBeats).set({
      locallyEditedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(scriptBeats.id, locatedInsert.beatId));

    // `r2Key` n'est jamais touché ici : c'est la clé de l'asset rapatrié par le SP2 (upload/miroir
    // R2), sans rapport avec l'URL source que l'humain corrige à la main. Patch partiel : n'écrire
    // QUE les champs fournis (absent = no-op ; null = vider).
    const patch: Partial<typeof beatInserts.$inferInsert> = { updatedAt: new Date() };
    if (urlProvided) patch.url = input.url ?? null;
    if (input.kind !== undefined) patch.kind = input.kind;
    if (input.tcIn !== undefined) patch.tcIn = input.tcIn;
    if (input.tcOut !== undefined) patch.tcOut = input.tcOut;
    if (input.displayDurationSec !== undefined) patch.displayDurationSec = input.displayDurationSec;
    if (input.credit !== undefined) patch.credit = input.credit;
    if (input.rightsNote !== undefined) patch.rightsNote = input.rightsNote;
    // Seul un changement d'URL invalide la vérification (r2Key jamais touché ici).
    if (urlChanged) { patch.linkStatus = "non_verifie"; patch.linkCheckedAt = null; }

    await tx.update(beatInserts).set(patch).where(eq(beatInserts.id, input.insertId));

    // (même motif que updateBeatCore/reorderBeatsCore) : rend l'aperçu d'import périmé.
    await tx.update(scriptVariants).set({ updatedAt: new Date() }).where(eq(scriptVariants.id, locatedBeat.variantId));
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Vérification des liens d'insert (SP3, Task 3)
// ─────────────────────────────────────────────────────────────────────────────

export async function getInsertUrlCore(insertId: string): Promise<{ url: string | null } | null> {
  const [row] = await db.select({ url: beatInserts.url }).from(beatInserts).where(eq(beatInserts.id, insertId));
  return row ?? null;
}

export async function setInsertLinkStatusCore(
  input: { insertId: string; status: "ok" | "mort" | "interdit" },
): Promise<void> {
  await db.transaction(async (tx) => {
    const [loc] = await tx.select({ beatId: beatInserts.beatId }).from(beatInserts).where(eq(beatInserts.id, input.insertId));
    if (!loc) throw new RefusalError("Insert introuvable.");
    const [beat] = await tx.select({ variantId: scriptBeats.variantId }).from(scriptBeats).where(eq(scriptBeats.id, loc.beatId));
    if (!beat) throw new RefusalError("Beat introuvable pour cet insert.");
    // Verrou de variante pour l'ordre habituel ; PAS de bump locallyEditedAt (rafraîchissement de statut).
    await tx.select({ id: scriptVariants.id }).from(scriptVariants).where(eq(scriptVariants.id, beat.variantId)).for("update");
    await tx.update(beatInserts).set({ linkStatus: input.status, linkCheckedAt: new Date(), updatedAt: new Date() })
      .where(eq(beatInserts.id, input.insertId));
  });
}

export async function listProjectInsertsForVerifyCore(projectId: string): Promise<{ id: string; url: string | null }[]> {
  return db.select({ id: beatInserts.id, url: beatInserts.url })
    .from(beatInserts)
    .innerJoin(scriptBeats, eq(scriptBeats.id, beatInserts.beatId))
    .innerJoin(scriptVariants, eq(scriptVariants.id, scriptBeats.variantId))
    .where(eq(scriptVariants.projectId, projectId));
}

export async function verifyProjectLinksCore(
  input: { projectId: string; fetchImpl?: typeof fetch },
): Promise<{ ok: number; mort: number; interdit: number }> {
  const inserts = await listProjectInsertsForVerifyCore(input.projectId);
  const statuses = await mapWithConcurrency(inserts, 5, async (ins) => {
    const { status } = await verifyUrl(ins.url, { fetchImpl: input.fetchImpl });
    await setInsertLinkStatusCore({ insertId: ins.id, status });
    return status;
  });
  const counts = { ok: 0, mort: 0, interdit: 0 };
  for (const s of statuses) counts[s]++;
  return counts;
}

// ─────────────────────────────────────────────────────────────────────────────
// Réordonnancement
// ─────────────────────────────────────────────────────────────────────────────

export async function reorderBeatsCore(input: { variantId: string; order: string[] }): Promise<void> {
  await db.transaction(async (tx) => {
    // Ordre de verrouillage (round de correction 4) : `script_variants` D'ABORD, `script_beats`
    // ENSUITE — même motif que updateBeatCore ci-dessus. Un réordonnancement humain concurrent
    // d'un import sur la même variante prenait sinon les lignes beats avant la variante, à
    // rebours de applyImportCore/revertJournalEntryCore : ABBA, donc `deadlock detected`.
    // Effet secondaire bienvenu : le bump de `scriptVariants.updatedAt` en fin de transaction
    // n'est plus racé — deux réordonnancements concurrents sur la même variante sérialisent ici.
    await tx.select({ id: scriptVariants.id }).from(scriptVariants)
      .where(eq(scriptVariants.id, input.variantId)).for("update");

    for (const [index, externalId] of input.order.entries()) {
      await tx.update(scriptBeats)
        .set({ position: index, updatedAt: new Date() })
        .where(and(eq(scriptBeats.variantId, input.variantId), eq(scriptBeats.externalId, externalId)));
    }
    // (round de correction 2, C1) : même raison que updateBeatCore — un réordonnancement humain
    // entre prepareImport et applyImport doit rendre l'aperçu périmé.
    await tx.update(scriptVariants).set({ updatedAt: new Date() }).where(eq(scriptVariants.id, input.variantId));
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Import — préparation (lecture seule hors journal)
// ─────────────────────────────────────────────────────────────────────────────

async function writeJournal(dbLike: DbLike, args: {
  projectId: string;
  variantId: string | null;
  source: JournalSource;
  userId: string | null;
  schemaVersion: string | null;
  rawPayload: unknown;
  errorReport: unknown[];
  diff: Record<string, unknown>;
  outcome: JournalOutcome;
  // Provenance MCP (SP1 bis, Task 5) : le nom de l'outil et ses arguments, écrits DU PREMIER COUP
  // avec la ligne. L'appelant MCP les apposait auparavant par une seconde requête, ce qui l'obligeait
  // — sur un rejet, où aucun identifiant n'est rendu — à retrouver « la ligne la plus récente du
  // projet » : deux imports concurrents sur le même projet pouvaient alors s'échanger leurs
  // arguments, donc leur mémoire de l'état de la variante. Le chemin humain ne passe rien
  // (`source: "copier_coller"`), et les colonnes restent nulles comme avant.
  toolName?: string | null;
  toolArgs?: Record<string, unknown> | null;
}): Promise<string> {
  const [entry] = await dbLike.insert(scriptJournal).values({
    projectId: args.projectId,
    variantId: args.variantId,
    source: args.source,
    toolName: args.toolName ?? null,
    toolArgs: args.toolArgs ?? null,
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

// Postgres réordonne les clés d'un objet jsonb au stockage (observé : par longueur de clé, puis
// alphabétique — ni l'ordre d'insertion, ni un ordre stable côté application). `importedSnapshot`
// relu depuis la colonne jsonb n'a donc PAS le même ordre de clés que `theirs`, reconstruit à
// chaque appel dans l'ordre canonique par toSnapshot()/cette fonction. computeMerge (lib/video/
// import.ts, module pur, non modifiable ici) compare les instantanés par `JSON.stringify(a) !==
// JSON.stringify(b)` — sensible à l'ordre des clés. Sans cette normalisation, TOUT beat déjà
// importé ressortait "modifié" à chaque nouvelle préparation, même sur un ré-import strictement
// identique (trouvé en écrivant le test de l'I7 du round de correction 2 — la cause réelle n'était
// pas l'assainissement asymétrique visé par l'I7, mais ce réordonnancement jsonb ; les deux bugs
// produisaient le même symptôme).
function normalizeSnapshot(raw: unknown): BeatSnapshot | null {
  if (raw == null) return null;
  const s = raw as BeatSnapshot;
  return {
    kind: s.kind,
    spokenText: s.spokenText,
    directionNote: s.directionNote,
    screenText: s.screenText,
    transitionIn: s.transitionIn,
    transitionOut: s.transitionOut,
    sources: s.sources ?? [],
    // `normalizeInserts` (lib/video/import.ts) et non un mapping local : c'est LE producteur commun
    // de la forme des inserts (round de correction final, I1). Les instantanés jsonb écrits avant ce
    // correctif peuvent porter des clés optionnelles absentes — elles reprennent ici la valeur
    // `null`, donc la même forme que celle produite depuis les colonnes et depuis le payload.
    inserts: normalizeInserts(s.inserts),
  };
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
  // Les UUID des lignes d'insert, dans le MÊME ordre que les inserts normalisés ci-dessous : c'est
  // ce qui permet à readScriptCore (round de correction final, C1) de rendre à l'agent de quoi
  // appeler `update_insert` sans jamais mêler cet identifiant technique aux clés du contrat.
  const insertIdsByBeat = new Map<string, { insertId: string; linkStatus: string }[]>();
  for (const ins of inserts) {
    const list = insertsByBeat.get(ins.beatId) ?? [];
    const ids = insertIdsByBeat.get(ins.beatId) ?? [];
    ids.push({ insertId: ins.id, linkStatus: ins.linkStatus });
    insertIdsByBeat.set(ins.beatId, ids);
    // Mêmes clés, dans le même ordre que insertPayloadSchema (lib/video/schema.ts) — garanti par
    // `normalizeInserts`, le producteur commun (round de correction final, I1) plutôt que par un
    // mapping recopié ici : computeMerge compare les instantanés par JSON.stringify, donc une forme
    // différente pour une valeur identique produit un conflit fantôme.
    list.push(...normalizeInserts([{
      type: ins.kind,
      url: ins.url,
      tc_in: ins.tcIn,
      tc_out: ins.tcOut,
      duree_affichage_sec: ins.displayDurationSec,
      credit: ins.credit,
      droits: ins.rightsNote,
    }]));
    insertsByBeat.set(ins.beatId, list);
  }

  return beats.map((b) => ({
    id: b.id,
    externalId: b.externalId,
    position: b.position,
    insertIds: insertIdsByBeat.get(b.id) ?? [],
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
    importedSnapshot: normalizeSnapshot(b.importedSnapshot),
  }));
}

async function loadBeatRows(dbLike: DbLike, variantId: string): Promise<BeatRow[]> {
  const full = await loadFullBeatRows(dbLike, variantId);
  return full.map((r) => ({
    externalId: r.externalId, position: r.position, snapshot: r.snapshot, importedSnapshot: r.importedSnapshot,
  }));
}

/**
 * L'état d'une variante RENDU DANS LE VOCABULAIRE DU CONTRAT (round de correction final, C1) —
 * c'est-à-dire une charge utile que l'agent peut réviser puis resoumettre telle quelle à
 * `submit_script`, sans traduction de sa part. C'est le cœur qui la produit, jamais lib/mcp/tools.ts :
 * le mapping colonnes → instantané vit déjà ici (`loadFullBeatRows`), et l'instantané → contrat dans
 * lib/video/import.ts (`toPayloadBeat`, l'inverse exact de `toSnapshot`). Le rendre ailleurs, à la
 * main, c'est ce qui avait produit DEUX vocabulaires dans une seule charge utile — beats en interne,
 * inserts en contrat — et, au premier aller-retour, un script dupliqué en silence.
 *
 * Les identifiants techniques (UUID de beat et d'insert) sont RENDUS, mais dans un bloc à part :
 * `update_beat` et `update_insert` les exigent, et l'agent ne peut pas les deviner. Ils portent les
 * noms mêmes de ces arguments (`beatId`, `insertId`), donc ils ne peuvent pas être confondus avec la
 * clé `id` du contrat, qui est l'externalId — c'est précisément cette confusion qui a coûté C1.
 */
export async function readScriptCore(variantId: string): Promise<{
  variantId: string;
  projectId: string;
  payload: Payload;
  identifiantsInternes: {
    id: string; beatId: string; dureeEstimeeSec: number;
    inserts: { insertId: string; linkStatus: string }[];
  }[];
} | null> {
  const [variant] = await db.select().from(scriptVariants).where(eq(scriptVariants.id, variantId));
  if (!variant) return null;
  const [project] = await db.select().from(videoProjects).where(eq(videoProjects.id, variant.projectId));
  if (!project) return null;

  const rows = await loadFullBeatRows(db, variantId);

  return {
    variantId,
    projectId: project.id,
    payload: {
      schema_version: SCHEMA_VERSION,
      projet: { titre: project.title, sujet: project.subject, angle: null },
      variantes: [{
        plateforme: variant.platform as VariantPayload["plateforme"],
        duree_cible_sec: variant.targetDurationSec,
        ratio: variant.aspectRatio as VariantPayload["ratio"],
        beats: rows.map((r) => toPayloadBeat(r.externalId, r.snapshot)),
      }],
    },
    identifiantsInternes: rows.map((r) => ({
      id: r.externalId,
      beatId: r.id,
      // La durée qui fait foi à l'écran : la retouche manuelle l'emporte sur l'estimation.
      dureeEstimeeSec: r.durationOverrideSec ?? r.estimatedDurationSec,
      inserts: r.insertIds,
    })),
  };
}

// spokenText d'un beat de payload, assaini AVANT tout calcul de diff (round de correction 2, I7) :
// `importedSnapshot` est écrit APRÈS sanitizeArticleHtml (voir sanitizeSnapshot plus bas), donc
// comparer un `theirs` non assaini au `base`/`ours` (tous deux assainis) ferait apparaître une
// "modification fantôme" à chaque ré-import du même payload, indéfiniment, dès que l'assainisseur
// change quoi que ce soit au texte (entités HTML, espaces, etc). Assainir ICI, avant computeMerge,
// remet `base` et `theirs` dans le même espace.
function sanitizeIncomingBeats(beats: VariantPayload["beats"]): VariantPayload["beats"] {
  return beats.map((b) => ({ ...b, texte: b.texte != null ? sanitizeArticleHtml(b.texte) : b.texte }));
}

export async function prepareImportCore(args: {
  projectId: string;
  variantId: string;
  raw: string;
  userId: string | null;
  source: JournalSource;
  // Renseignés par le seul appelant MCP (lib/mcp/tools.ts) : voir writeJournal ci-dessus.
  toolName?: string | null;
  toolArgs?: Record<string, unknown> | null;
}): Promise<{ ok: true; journalId: string; diff: Diff } | { ok: false; issues: Issue[] }> {
  const parsed = parseIncoming(args.raw);
  if (!parsed.ok) {
    await writeJournal(db, {
      projectId: args.projectId, variantId: args.variantId, source: args.source, userId: args.userId, toolName: args.toolName, toolArgs: args.toolArgs,
      schemaVersion: null, rawPayload: rawPayloadForJournal(args.raw), errorReport: parsed.issues,
      diff: {}, outcome: "rejete",
    });
    return { ok: false, issues: parsed.issues };
  }

  const existingVariants = await db.select().from(scriptVariants).where(eq(scriptVariants.projectId, args.projectId));
  const targetVariant = existingVariants.find((v) => v.id === args.variantId);
  if (!targetVariant) {
    const issues: Issue[] = [{ path: "variantId", message: "Variante introuvable pour ce projet." }];
    await writeJournal(db, {
      projectId: args.projectId, variantId: null, source: args.source, userId: args.userId, toolName: args.toolName, toolArgs: args.toolArgs,
      schemaVersion: parsed.payload.schema_version, rawPayload: rawPayloadForJournal(args.raw),
      errorReport: issues, diff: {}, outcome: "rejete",
    });
    return { ok: false, issues };
  }

  // « Aucun import partiel » (round de correction 1 ruling 3, étendu au round de correction 2 C3) :
  // TOUTES les issues sont calculées d'abord, sans écrire une seule ligne — y compris celle du
  // payload qui ne contient aucune variante correspondant à la variante ciblée. Une variante ne
  // doit jamais être créée si le payload est par ailleurs rejeté pour une tout autre raison.
  const issues: Issue[] = [];

  const matchingVariante = parsed.payload.variantes.find((v) => v.plateforme === targetVariant.platform);
  if (!matchingVariante) {
    issues.push({
      path: "variantes",
      message: `le payload ne contient aucune variante « ${targetVariant.platform} ».`,
    });
  }

  // Variante absente (spec §8) : une plateforme du payload qui n'a pas encore de variante dans le
  // projet en obtient une, à condition que plateforme/durée cible/ratio soient tous les trois
  // présents — sinon on réclame les trois champs plutôt que de deviner.
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
      issues.push({
        path: `variantes[${vi}]`,
        message: "plateforme, duree_cible_sec et ratio sont requis pour créer une nouvelle variante.",
      });
    }
  }

  if (issues.length > 0) {
    await writeJournal(db, {
      projectId: args.projectId, variantId: args.variantId, source: args.source, userId: args.userId, toolName: args.toolName, toolArgs: args.toolArgs,
      schemaVersion: parsed.payload.schema_version, rawPayload: rawPayloadForJournal(args.raw),
      errorReport: issues, diff: {}, outcome: "rejete",
    });
    return { ok: false, issues };
  }

  // matchingVariante est garanti non-null ici : l'issue correspondante aurait fait retourner plus
  // haut. TypeScript ne le sait pas — assertion explicite plutôt qu'un `!` silencieux.
  if (!matchingVariante) throw new Error("Invariant rompu : matchingVariante devrait être défini ici.");

  // (round de correction 2, C3/I8) : les créations de variantes manquantes se font dans UNE seule
  // transaction — une boucle d'insert non transactionnelle laisserait la première variante créée
  // en base si une insertion suivante échouait en cours de route.
  if (variantsToCreate.length > 0) {
    await db.transaction(async (tx) => {
      let position = existingVariants.reduce((max, v) => Math.max(max, v.position), -1) + 1;
      for (const v of variantsToCreate) {
        await tx.insert(scriptVariants).values({
          projectId: args.projectId,
          platform: v.plateforme,
          targetDurationSec: v.dureeCibleSec,
          aspectRatio: v.ratio,
          position: position++,
        });
      }
    });
  }

  const currentBeats = await loadBeatRows(db, targetVariant.id);
  const sanitizedBeats = sanitizeIncomingBeats(matchingVariante.beats);
  const diff = computeMerge(currentBeats, sanitizedBeats);

  // Journalisée mais PAS encore appliquée : outcome "en_attente" (round de correction 1). Distinct
  // d'"annule" (qui signifie « revenu en arrière ») — une requête sur les imports annulés ne doit
  // pas remonter les diffs simplement en attente de décision. applyImportCore la fait passer à
  // "applique" au moment décisif, et refuse d'agir si l'entrée n'est plus "en_attente".
  const journalId = await writeJournal(db, {
    projectId: args.projectId, variantId: targetVariant.id, source: args.source, userId: args.userId, toolName: args.toolName, toolArgs: args.toolArgs,
    schemaVersion: parsed.payload.schema_version, rawPayload: rawPayloadForJournal(args.raw),
    errorReport: [], diff: diff as unknown as Record<string, unknown>, outcome: "en_attente",
  });

  return { ok: true, journalId, diff };
}

// ─────────────────────────────────────────────────────────────────────────────
// Import — application (une seule transaction)
// ─────────────────────────────────────────────────────────────────────────────

async function resolveBeatId(tx: Tx, variantId: string, externalId: string): Promise<string> {
  const [row] = await tx.select({ id: scriptBeats.id }).from(scriptBeats)
    .where(and(eq(scriptBeats.variantId, variantId), eq(scriptBeats.externalId, externalId)));
  if (!row) throw new Error(`Beat introuvable pour la mise à jour des inserts (${externalId}).`);
  return row.id;
}

// Réécrit intégralement les `beat_inserts` du beat visé, en reportant `r2Key`/`linkStatus`/
// `linkCheckedAt` depuis les lignes existantes par appariement sur la position (round de
// correction 2, point hors revue) : ces trois colonnes n'existent pas dans `BeatSnapshot` (donc
// pas dans le payload d'import), et les perdre à chaque ré-import effacerait silencieusement le
// travail d'un futur sous-projet qui les peuple (vérification de lien, upload R2). Fonctionne aussi
// pour un beat flambant neuf : `existing` est alors vide, donc `carry` reste `undefined` et les
// colonnes prennent leur défaut — comportement inchangé pour une création.
async function replaceBeatInserts(
  tx: Tx,
  externalId: string,
  variantId: string,
  inserts: BeatSnapshot["inserts"],
): Promise<void> {
  const beatId = await resolveBeatId(tx, variantId, externalId);
  const existing = await tx.select().from(beatInserts)
    .where(eq(beatInserts.beatId, beatId))
    .orderBy(asc(beatInserts.position));
  await tx.delete(beatInserts).where(eq(beatInserts.beatId, beatId));
  if (inserts.length === 0) return;

  await tx.insert(beatInserts).values(inserts.map((ins, i) => {
    const carry = existing[i];
    return {
      beatId,
      kind: ins.type,
      url: ins.url ?? null,
      tcIn: ins.tc_in ?? null,
      tcOut: ins.tc_out ?? null,
      displayDurationSec: ins.duree_affichage_sec ?? null,
      credit: ins.credit ?? null,
      rightsNote: ins.droits ?? null,
      position: i,
      r2Key: carry?.r2Key ?? null,
      linkStatus: carry?.linkStatus ?? "non_verifie",
      linkCheckedAt: carry?.linkCheckedAt ?? null,
    };
  }));
}

// spokenText vient d'un modèle et transite par un éditeur riche — il passe par le même
// assainisseur que le corps d'article (spec §8). Idempotent : le payload entrant a déjà été
// assaini avant computeMerge (sanitizeIncomingBeats), donc ce second passage est une garantie
// défensive, pas un besoin fonctionnel.
function sanitizeSnapshot(s: BeatSnapshot): BeatSnapshot {
  return { ...s, spokenText: sanitizeArticleHtml(s.spokenText) };
}

export async function applyImportCore(args: {
  journalId: string; variantId: string; accept: string[]; variantUpdatedAt: Date;
}): Promise<{ ok: true; applied: number } | { ok: false; message: string }> {
  const { wordsPerMinute } = await getVideoSettings();

  try {
    const applied = await db.transaction(async (tx) => {
      // Ordre de verrouillage (round de correction 3, N1) : `script_variants` D'ABORD, puis
      // `script_journal` — dans CET ORDRE PARTOUT (revertJournalEntryCore verrouille désormais
      // dans le même ordre). L'ancienne version verrouillait le journal en tête ici, mais
      // revertJournalEntryCore écrivait la variante avant le journal : deux transactions
      // concurrentes (un applyImport et un revertJournalEntry sur la même variante) pouvaient donc
      // s'attendre mutuellement en sens inverse — un ABBA classique que Postgres résout par un
      // `deadlock detected` (une exception non gérée, pas un refus métier). Verrouiller la variante
      // ici ferme aussi le dernier check-then-act sur la péremption : un `updateBeatCore` concurrent
      // qui tente de bumper CETTE MÊME ligne `scriptVariants.updatedAt` bloque désormais jusqu'à la
      // fin de cette transaction, il ne peut plus committer entre notre vérification et nos
      // écritures.
      const [variant] = await tx.select().from(scriptVariants).where(eq(scriptVariants.id, args.variantId)).for("update");
      if (!variant) throw new RefusalError("Variante introuvable.");

      // `for("update")` (round de correction 2, I4) : verrouille la ligne de journal pour la durée
      // de la transaction. Deux applyImportCore concurrents sur le MÊME journalId sérialisent ici —
      // le second ne lit l'entrée qu'après le commit (ou rollback) du premier, et voit alors son
      // véritable outcome ("applique"), pas un "en_attente" périmé lu hors transaction.
      const [entry] = await tx.select().from(scriptJournal).where(eq(scriptJournal.id, args.journalId)).for("update");
      if (!entry) throw new RefusalError("Entrée de journal introuvable.");

      // (round de correction 2, C2) : journalId et variantId arrivent tous deux du client — sans ce
      // contrôle, un diff calculé sur la variante A pourrait être appliqué à la variante B.
      if (entry.variantId !== args.variantId) {
        throw new RefusalError("Cette entrée de journal ne correspond pas à la variante ciblée.");
      }
      if (entry.outcome !== "en_attente") {
        throw new RefusalError("Cette entrée n'est plus en attente d'application (déjà appliquée ou annulée).");
      }
      // Cohérence projet ⇄ variante ⇄ entrée : la variante ciblée doit appartenir au même projet
      // que celui journalisé par prepareImportCore.
      if (entry.projectId !== variant.projectId) {
        throw new RefusalError("Incohérence entre le projet de l'entrée de journal et celui de la variante.");
      }
      // Péremption : le diff a été calculé sur un état qui a bougé depuis. Appliquer quand même
      // écraserait une modification qu'on n'a jamais montrée à l'utilisateur.
      if (variant.updatedAt.getTime() !== args.variantUpdatedAt.getTime()) {
        throw new RefusalError("L'aperçu est périmé — recalculez le diff avant d'appliquer.");
      }

      const mutations = applyMerge(entry.diff as unknown as Diff, { accept: args.accept });

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
          estimatedDurationSec: estimateSeconds(snapshot.spokenText, wordsPerMinute),
          // L'instantané devient la nouvelle base de fusion, et l'édition locale est remise à zéro :
          // ce beat est désormais exactement ce que le dernier import a posé.
          importedSnapshot: snapshot, locallyEditedAt: null,
        });
        await replaceBeatInserts(tx, row.externalId, args.variantId, snapshot.inserts);
      }

      for (const patch of mutations.update) {
        const snapshot = sanitizeSnapshot(patch.snapshot);
        await tx.update(scriptBeats).set({
          kind: snapshot.kind, spokenText: snapshot.spokenText,
          directionNote: snapshot.directionNote, screenText: snapshot.screenText,
          transitionIn: snapshot.transitionIn, transitionOut: snapshot.transitionOut,
          sources: snapshot.sources,
          estimatedDurationSec: estimateSeconds(snapshot.spokenText, wordsPerMinute),
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
      // Mise à jour CONDITIONNELLE (round de correction 2, I4) : `outcome = 'en_attente'` dans le
      // `where`, en plus du verrou `for("update")` ci-dessus — double garde, l'une pessimiste
      // (verrou), l'autre optimiste (condition + vérification du nombre de lignes affectées).
      const updatedJournal = await tx.update(scriptJournal)
        .set({ outcome: "applique", applied: appliedRecord as unknown as Record<string, unknown> })
        .where(and(eq(scriptJournal.id, args.journalId), eq(scriptJournal.outcome, "en_attente")))
        .returning({ id: scriptJournal.id });
      if (updatedJournal.length === 0) {
        throw new RefusalError("Cette entrée n'est plus en attente d'application (déjà appliquée ou annulée).");
      }

      return mutations.create.length + mutations.update.length;
    });

    return { ok: true as const, applied };
  } catch (e) {
    if (e instanceof RefusalError) return { ok: false as const, message: e.message };
    throw e;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Annulation d'une entrée de journal
// ─────────────────────────────────────────────────────────────────────────────

// Restaure depuis `applied` (round de correction 1, ruling 2) : `applied.before` (capturé dans
// applyImportCore, DANS la même transaction que les écritures, avant qu'elles n'aient lieu) porte
// l'état antérieur de chaque beat modifié/supprimé/déplacé par cette entrée — c'est ce qui rend
// l'annulation d'une modification ou d'une suppression réellement fidèle, pas seulement celle
// d'une création.
//
// Round de correction 3 (N1) : toute la fonction tourne désormais dans UNE seule transaction, avec
// le MÊME ordre de verrouillage qu'applyImportCore — `script_variants` d'abord, `script_journal`
// ensuite. Avant ce correctif, les lectures/contrôles se faisaient hors transaction puis la
// transaction finale écrivait `script_variants` avant `script_journal`, pendant qu'applyImportCore
// verrouillait `script_journal` en tête puis écrivait `script_variants` : un `applyImport` et un
// `revertJournalEntry` concurrents sur la même variante pouvaient s'attendre mutuellement en sens
// inverse (ABBA), et Postgres résolvait ça par un `deadlock detected` — une exception non gérée,
// pas un refus métier.
export async function revertJournalEntryCore(
  journalId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    await db.transaction(async (tx) => {
      // Lecture préalable SANS verrou, uniquement pour savoir QUELLE variante verrouiller en
      // premier — `entry.variantId` n'est connu qu'après une première lecture du journal. Le
      // verrou proprement dit n'est posé qu'ensuite, dans l'ordre variante puis journal.
      const [preliminary] = await tx.select({ variantId: scriptJournal.variantId }).from(scriptJournal)
        .where(eq(scriptJournal.id, journalId));
      if (!preliminary) throw new RefusalError("Entrée de journal introuvable.");
      if (!preliminary.variantId) throw new RefusalError("Variante introuvable pour cette entrée.");

      const [variant] = await tx.select().from(scriptVariants).where(eq(scriptVariants.id, preliminary.variantId)).for("update");
      if (!variant) throw new RefusalError("Variante introuvable pour cette entrée.");

      const [entry] = await tx.select().from(scriptJournal).where(eq(scriptJournal.id, journalId)).for("update");
      if (!entry) throw new RefusalError("Entrée de journal introuvable.");
      if (entry.outcome !== "applique") throw new RefusalError("Cette entrée n'a rien appliqué à annuler.");
      if (entry.revertedAt) throw new RefusalError("Cette entrée a déjà été annulée.");
      if (!entry.variantId) throw new RefusalError("Variante introuvable pour cette entrée.");

      const applied = entry.applied as unknown as AppliedRecord;
      // (round de correction 2, I10) : les entrées "applique" écrites avant l'introduction de
      // `applied.before` n'en portent pas — refus explicite plutôt qu'un TypeError sur `undefined`.
      //
      // Round de correction final (I3) : le motif est désormais DISTINGUÉ. Une écriture DIRECTE
      // d'agent (update_beat, reorder_beats, update_insert, create_video_project) est journalisée
      // "applique" avec un `applied` entièrement vide — il n'y a pas de fusion à décrire, seulement
      // un acte à attribuer (lib/mcp/tools.ts#journaliserEcritureDirecte). Lui répondre qu'elle est
      // « antérieure à l'enregistrement de l'état d'avant » était FAUX : elle est postérieure, elle
      // n'a simplement jamais eu d'état d'avant à enregistrer. Sur le chemin que le spec présente
      // comme le recours humain, un motif faux est pire qu'un refus.
      if (!hasBeforeState(applied)) {
        throw new RefusalError(
          applied.create === undefined && applied.update === undefined
            ? "Cette entrée est une retouche directe d'agent, pas un import : elle n'a pas d'état d'avant enregistré et ne peut pas être annulée d'un geste. Corrigez le beat concerné depuis l'onglet Écriture."
            : "Cette entrée est antérieure à l'enregistrement de l'état d'avant, elle n'est pas annulable.",
        );
      }
      const before = applied.before;

      const touchedIds = new Set([
        ...applied.create.map((r) => r.externalId),
        ...applied.update.map((u) => u.externalId),
        ...applied.remove,
      ]);

      // Refuse si un import postérieur non annulé a retouché l'un des mêmes externalId : l'annuler
      // effacerait un changement qu'on n'a jamais montré à l'utilisateur comme « à annuler ».
      // `ne(id, journalId)` en plus de `gt(createdAt, ...)`, et pas seulement ce dernier :
      // `createdAt` (JS Date, précision milliseconde) perd la précision microseconde de la colonne
      // timestamp au retour de lecture, si bien qu'un aller-retour de CETTE entrée à travers `gt`
      // peut se retrouver strictement supérieur à sa propre valeur arrondie — elle se bloquerait
      // elle-même sans cette exclusion explicite.
      const laterEntries = await tx.select().from(scriptJournal).where(and(
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
          throw new RefusalError("Un import plus récent a modifié un des mêmes beats — annulation impossible.");
        }
      }

      // (round de correction 2, I6) : même classe de perte de travail que C1, côté annulation
      // cette fois. Un `updateBeat` humain posté APRÈS cet import (donc après `entry.createdAt`)
      // sur l'un des beats que cette entrée a créés/modifiés serait écrasé en silence par la
      // restauration de `applied.before`. Seuls create/update ont une ligne vivante à vérifier —
      // un beat supprimé par cette entrée n'a plus de ligne en base.
      const liveTouchedIds = [...applied.create.map((r) => r.externalId), ...applied.update.map((u) => u.externalId)];
      if (liveTouchedIds.length > 0) {
        const liveBeats = await tx.select().from(scriptBeats).where(and(
          eq(scriptBeats.variantId, entry.variantId), inArray(scriptBeats.externalId, liveTouchedIds),
        ));
        const editedSince = liveBeats.filter((b) => b.locallyEditedAt && b.locallyEditedAt.getTime() > entry.createdAt.getTime());
        if (editedSince.length > 0) {
          throw new RefusalError(`Une édition manuelle postérieure à cet import existe sur : ${editedSince.map((b) => b.externalId).join(", ")} — annulation impossible.`);
        }
      }

      const beforeByExternalId = new Map(before.map((b) => [b.externalId, b]));
      const variantId = entry.variantId;

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
      for (const b of before) {
        await tx.update(scriptBeats).set({ position: b.position }).where(and(
          eq(scriptBeats.variantId, variantId), eq(scriptBeats.externalId, b.externalId),
        ));
      }

      // (round de correction 2, I5) : une entrée "en_attente" préparée avant cette annulation reste
      // applicable après elle sans ce bump, alors que son diff porte sur un état que l'annulation
      // vient de défaire. Écrite AVANT le journal (round de correction 3, N1) — même ordre que la
      // séquence de verrouillage ci-dessus.
      await tx.update(scriptVariants).set({ updatedAt: new Date() }).where(eq(scriptVariants.id, variantId));

      await tx.update(scriptJournal).set({ outcome: "annule", revertedAt: new Date() }).where(eq(scriptJournal.id, journalId));
    });

    return { ok: true as const };
  } catch (e) {
    if (e instanceof RefusalError) return { ok: false as const, message: e.message };
    throw e;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Marqueur « non relue » (Task 8)
// ─────────────────────────────────────────────────────────────────────────────

// L'utilisateur a accepté qu'un agent applique un import sans passer par la revue de diff humaine
// — le mécanisme central qui empêche un modèle d'effacer un beat par omission. Ce marqueur en est
// un des garde-fous compensatoires (spec Task 8) : toute écriture d'agent (`source: "mcp"`) naît
// avec `reviewedAt` à `null` et le reste jusqu'à ce qu'un humain ouvre le projet.
//
// UN SEUL `UPDATE` sur `script_journal`, hors de toute transaction et de l'ordre de verrouillage
// video_projects < script_variants < script_journal < script_beats < beat_inserts documenté plus
// haut dans ce fichier : le marquage ne touche QUE le journal, jamais une ligne de beat, donc il
// n'a besoin d'aucun verrou de rang supérieur et ne peut pas rouvrir les interblocages ABBA que
// quatre rounds de correction ont mis quatre passes à éliminer sur updateBeatCore/
// updateBeatInsertCore/applyImportCore/revertJournalEntryCore. Rester en dehors de cette chaîne est
// une propriété à préserver, pas un détail d'implémentation — ne jamais l'appeler depuis l'intérieur
// d'une des transactions ci-dessus.
//
// `userId` fait partie de la signature (brief Task 8) mais n'est aujourd'hui PAS écrit :
// `script_journal.reviewedAt` (db/schema.ts) n'a pas de colonne `reviewedBy` compagne — seul le
// MOMENT où un humain a ouvert le projet compte pour ce garde-fou, pas encore QUI. Le paramètre
// reste dans la signature plutôt que d'être retiré : l'appelant naturel (la page projet) connaît
// déjà `requireUser()`, et une future colonne `reviewedBy` n'aurait pas à changer cet appel.
// ─────────────────────────────────────────────────────────────────────────────
// Transition de statut de projet (SP4, Task 4)
// ─────────────────────────────────────────────────────────────────────────────

// Première écriture de `videoProjects.status` dans ce fichier — pas de variante impliquée, donc le
// verrou porte directement sur la ligne `videoProjects` (contrairement aux cœurs de beat ci-dessus,
// qui verrouillent la variante en tête). `estTransitionAutorisee` (lib/video/tournage-rules.ts) est
// la seule source de vérité des transitions permises — refus métier sinon, pas un `RefusalError` de
// contournement.
export async function setProjectStatusCore(input: { projectId: string; to: string }): Promise<void> {
  await db.transaction(async (tx) => {
    const [proj] = await tx.select({ status: videoProjects.status }).from(videoProjects)
      .where(eq(videoProjects.id, input.projectId)).for("update");
    if (!proj) throw new RefusalError("Projet introuvable.");
    if (!estTransitionAutorisee(proj.status, input.to)) throw new RefusalError("Transition de statut non autorisée.");
    await tx.update(videoProjects)
      .set({ status: input.to as (typeof videoProjects.$inferInsert)["status"], updatedAt: new Date() })
      .where(eq(videoProjects.id, input.projectId));
  });
}

export async function markProjectReviewedCore(projectId: string, userId: string | null): Promise<void> {
  void userId;
  await db.update(scriptJournal)
    .set({ reviewedAt: new Date() })
    .where(and(
      eq(scriptJournal.projectId, projectId),
      eq(scriptJournal.source, "mcp"),
      isNull(scriptJournal.reviewedAt),
    ));
}
