// Cœur DB montage. Comme lib/video/persist.ts : PAS de "use server", accès @/db regroupé,
// gardé par les server actions ailleurs. Module pur interdit d'importer ceci.
import { and, asc, eq, inArray } from "drizzle-orm";
import { db, scriptVariants, videoProjects, scriptBeats, beatInserts, interviewSpeakers } from "@/db";
import { buildConducteur, type Conducteur, type RundownBeatInput } from "@/lib/video/rundown";
import { getStudioConfig } from "@/lib/studio/config";
import { publicUrlFor } from "@/lib/storage/r2";

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
