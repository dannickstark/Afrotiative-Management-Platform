// Cœur DB montage. Comme lib/video/persist.ts : PAS de "use server", accès @/db regroupé,
// gardé par les server actions ailleurs. Module pur interdit d'importer ceci.
import { and, asc, eq, inArray } from "drizzle-orm";
import { db, scriptVariants, videoProjects, scriptBeats, beatInserts, interviewSpeakers, scriptJournal } from "@/db";
import { buildConducteur, type Conducteur, type RundownBeatInput } from "@/lib/video/rundown";
import { getStudioConfig } from "@/lib/studio/config";
import { publicUrlFor } from "@/lib/storage/r2";
import { RefusalError } from "@/lib/video/persist"; // réutiliser le signal de refus métier

function mediaResolver(): (url: string | null, r2Key: string | null) => string | null {
  const cfg = getStudioConfig();
  return (url, r2Key) => (cfg && r2Key ? publicUrlFor(cfg, r2Key) : url);
}

export async function readConducteurCore(
  variantId: string,
): Promise<{ projectId: string; variantId: string; conducteur: Conducteur } | null> {
  const [variant] = await db.select().from(scriptVariants).where(eq(scriptVariants.id, variantId));
  if (!variant) return null;
  const [project] = await db.select().from(videoProjects).where(eq(videoProjects.id, variant.projectId));
  if (!project) return null;

  const beats = await db.select().from(scriptBeats)
    .where(eq(scriptBeats.variantId, variantId))
    .orderBy(asc(scriptBeats.position));

  const speakerIds = beats.map((b) => b.speakerId).filter((x): x is string => !!x);
  const speakers = speakerIds.length
    ? await db.select().from(interviewSpeakers).where(inArray(interviewSpeakers.id, speakerIds))
    : [];
  const speakerName = new Map(speakers.map((s) => [s.id, s.name]));

  const beatIds = beats.map((b) => b.id);
  const inserts = beatIds.length
    ? await db.select().from(beatInserts).where(inArray(beatInserts.beatId, beatIds)).orderBy(asc(beatInserts.position))
    : [];
  const insertsByBeat = new Map<string, typeof inserts>();
  for (const ins of inserts) {
    const list = insertsByBeat.get(ins.beatId) ?? [];
    list.push(ins);
    insertsByBeat.set(ins.beatId, list);
  }

  const input: RundownBeatInput[] = beats.map((b) => ({
    id: b.id,
    position: b.position, kind: b.kind, spokenText: b.spokenText,
    directionNote: b.directionNote, screenText: b.screenText,
    transitionIn: b.transitionIn, transitionOut: b.transitionOut,
    estimatedDurationSec: b.estimatedDurationSec, durationOverrideSec: b.durationOverrideSec,
    speakerName: b.speakerId ? (speakerName.get(b.speakerId) ?? null) : null,
    montageCheckedAt: b.montageCheckedAt,
    inserts: (insertsByBeat.get(b.id) ?? []).map((ins) => ({
      id: ins.id, kind: ins.kind, url: ins.url, r2Key: ins.r2Key,
      tcIn: ins.tcIn, tcOut: ins.tcOut, displayDurationSec: ins.displayDurationSec,
      credit: ins.credit, rightsNote: ins.rightsNote, linkStatus: ins.linkStatus,
    })),
  }));

  return { projectId: project.id, variantId, conducteur: buildConducteur(input, mediaResolver()) };
}

// Task 9 : les cœurs d'annotation monteur (beat coché, insert signalé mort). Chaque appel ne
// touche qu'un seul beat/insert — pas d'ordre de verrou multi-tables à respecter au-delà de
// l'ordre déjà en vigueur (script_variants < script_beats < beat_inserts) — mais l'appartenance
// au projet DOIT être vérifiée avant toute écriture : c'est ce qui empêche un jeton de partage
// (dont le projectId est imposé par lib/actions/montage-actions.ts) d'agir hors de son projet.
async function beatBelongsToProject(
  beatId: string,
  projectId: string,
): Promise<{ id: string; variantId: string } | null> {
  const [row] = await db.select({ id: scriptBeats.id, variantId: scriptBeats.variantId, projectId: scriptVariants.projectId })
    .from(scriptBeats)
    .innerJoin(scriptVariants, eq(scriptVariants.id, scriptBeats.variantId))
    .where(and(eq(scriptBeats.id, beatId), eq(scriptVariants.projectId, projectId)))
    .limit(1);
  return row ? { id: row.id, variantId: row.variantId } : null;
}

export async function toggleBeatCheckedCore(
  { beatId, projectId, actorUserId }: { beatId: string; projectId: string; actorUserId: string | null },
): Promise<{ checked: boolean }> {
  const beat = await beatBelongsToProject(beatId, projectId);
  if (!beat) throw new RefusalError("Beat introuvable pour ce projet.");
  const [cur] = await db.select({ at: scriptBeats.montageCheckedAt }).from(scriptBeats).where(eq(scriptBeats.id, beatId));
  const next = cur?.at ? null : new Date();
  await db.update(scriptBeats).set({ montageCheckedAt: next }).where(eq(scriptBeats.id, beatId));
  await db.insert(scriptJournal).values({
    projectId, variantId: beat.variantId, source: "monteur", toolName: "toggle_beat_checked",
    actorUserId, outcome: "applique", diff: { beatId, checked: next !== null },
  });
  return { checked: next !== null };
}

export async function flagInsertDeadCore(
  { insertId, projectId, actorUserId }: { insertId: string; projectId: string; actorUserId: string | null },
): Promise<void> {
  const [row] = await db.select({ id: beatInserts.id, variantId: scriptBeats.variantId, projectId: scriptVariants.projectId })
    .from(beatInserts)
    .innerJoin(scriptBeats, eq(scriptBeats.id, beatInserts.beatId))
    .innerJoin(scriptVariants, eq(scriptVariants.id, scriptBeats.variantId))
    .where(and(eq(beatInserts.id, insertId), eq(scriptVariants.projectId, projectId)))
    .limit(1);
  if (!row) throw new RefusalError("Insert introuvable pour ce projet.");
  await db.update(beatInserts).set({ linkStatus: "mort", linkCheckedAt: new Date() }).where(eq(beatInserts.id, insertId));
  await db.insert(scriptJournal).values({
    projectId, variantId: row.variantId, source: "monteur", toolName: "flag_insert_dead",
    actorUserId, outcome: "applique", diff: { insertId, linkStatus: "mort" },
  });
}
