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

// Refus MÉTIER (validation, péremption, conflit) plutôt qu'échec technique — distingué des erreurs
// DB réelles pour que applyImportCore/revertJournalEntryCore puissent les convertir en
// `{ ok: false, message }` français sans avaler une vraie panne (round de correction 2, I4).
class RefusalError extends Error {}

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

    // `spokenText` vient de l'éditeur riche du monteur — même assainisseur que le corps d'article
    // (spec §8) : on ne fait jamais confiance à du HTML posé côté client sans repasser par DOMPurify.
    const spokenText = input.spokenText !== undefined ? sanitizeArticleHtml(input.spokenText) : current.spokenText;
    const durationOverrideSec = input.durationOverrideSec !== undefined
      ? input.durationOverrideSec
      : current.durationOverrideSec;

    const estimatedDurationSec = beatSeconds({ spokenText, durationOverrideSec }, wordsPerMinute);

    await tx.update(scriptBeats).set({
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

// Round de correction 1 (Task 12, I4) : restreint à la SEULE `url`, comme verrouillé par
// l'utilisateur (spec §6 : « URL éditable »). Les autres colonnes de beat_inserts (tcIn, tcOut,
// displayDurationSec, credit, rightsNote) n'ont ni appelant, ni UI, ni test, ni validation calibrée
// — elles reviendront avec le lot qui les rend éditables plutôt que d'être exposées ici sans
// couverture.
export async function updateBeatInsertCore(input: {
  insertId: string;
  url: string | null;
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
    // changer si on les laissait tels quels.
    const urlChanged = input.url !== current.url;

    // script_beats AVANT beat_inserts (ordre ci-dessus) : cette édition d'insert est aussi une
    // édition humaine du beat parent, au même titre qu'updateBeatCore — computeMerge doit savoir
    // au prochain ré-import que ce beat s'est écarté de son dernier import.
    await tx.update(scriptBeats).set({
      locallyEditedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(scriptBeats.id, locatedInsert.beatId));

    // `r2Key` n'est jamais touché ici : c'est la clé de l'asset rapatrié par le SP2 (upload/miroir
    // R2), sans rapport avec l'URL source que l'humain corrige à la main. Seule `url` est écrite
    // (round de correction 1, I4) — tcIn/tcOut/displayDurationSec/credit/rightsNote restent hors
    // périmètre tant qu'aucune UI ne les édite.
    await tx.update(beatInserts).set({
      url: input.url,
      linkStatus: urlChanged ? "non_verifie" : current.linkStatus,
      linkCheckedAt: urlChanged ? null : current.linkCheckedAt,
      updatedAt: new Date(),
    }).where(eq(beatInserts.id, input.insertId));

    // (même motif que updateBeatCore/reorderBeatsCore) : rend l'aperçu d'import périmé.
    await tx.update(scriptVariants).set({ updatedAt: new Date() }).where(eq(scriptVariants.id, locatedBeat.variantId));
  });
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
}): Promise<string> {
  const [entry] = await dbLike.insert(scriptJournal).values({
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
    inserts: (s.inserts ?? []).map((ins) => ({
      type: ins.type,
      url: ins.url,
      tc_in: ins.tc_in,
      tc_out: ins.tc_out,
      duree_affichage_sec: ins.duree_affichage_sec,
      credit: ins.credit,
      droits: ins.droits,
    })),
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
  for (const ins of inserts) {
    const list = insertsByBeat.get(ins.beatId) ?? [];
    // Mêmes clés, dans le même ordre que insertPayloadSchema (lib/video/schema.ts) : type, url,
    // tc_in, tc_out, duree_affichage_sec, credit, droits — computeMerge compare les instantanés par
    // JSON.stringify, donc une forme différente pour une valeur identique produirait un conflit
    // fantôme (vérifié à nouveau au round de correction 2).
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
    importedSnapshot: normalizeSnapshot(b.importedSnapshot),
  }));
}

async function loadBeatRows(dbLike: DbLike, variantId: string): Promise<BeatRow[]> {
  const full = await loadFullBeatRows(dbLike, variantId);
  return full.map((r) => ({
    externalId: r.externalId, position: r.position, snapshot: r.snapshot, importedSnapshot: r.importedSnapshot,
  }));
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
}): Promise<{ ok: true; journalId: string; diff: Diff } | { ok: false; issues: Issue[] }> {
  const parsed = parseIncoming(args.raw);
  if (!parsed.ok) {
    await writeJournal(db, {
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
    await writeJournal(db, {
      projectId: args.projectId, variantId: null, source: args.source, userId: args.userId,
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
      projectId: args.projectId, variantId: args.variantId, source: args.source, userId: args.userId,
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
    projectId: args.projectId, variantId: targetVariant.id, source: args.source, userId: args.userId,
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
          estimatedDurationSec: beatSeconds({ spokenText: snapshot.spokenText, durationOverrideSec: null }, wordsPerMinute),
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
      if (!applied.before) {
        throw new RefusalError("Cette entrée est antérieure à l'enregistrement de l'état d'avant, elle n'est pas annulable.");
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
