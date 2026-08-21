import { asc, eq, and, inArray } from "drizzle-orm";
import { db, scriptVariants, scriptBeats, beatTakes, videoProjects } from "@/db";
import { RefusalError } from "@/lib/video/persist";
import { nextTakeNumber } from "@/lib/video/tournage-rules";
import { BEAT_KIND_LABEL } from "@/lib/video/labels";
import type { TakeStatus } from "@/lib/video/schema";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Ordre de verrou : découvrir la variante (select nu), la verrouiller FOR UPDATE, PUIS écrire beat_takes.
async function lockVariantOfBeat(tx: Tx, beatId: string): Promise<string> {
  const [beat] = await tx.select({ variantId: scriptBeats.variantId }).from(scriptBeats).where(eq(scriptBeats.id, beatId));
  if (!beat) throw new RefusalError("Beat introuvable.");
  await tx.select({ id: scriptVariants.id }).from(scriptVariants).where(eq(scriptVariants.id, beat.variantId)).for("update");
  return beat.variantId;
}

export async function addTakeCore(input: { beatId: string; status?: TakeStatus }): Promise<{ id: string; number: number }> {
  return db.transaction(async (tx) => {
    await lockVariantOfBeat(tx, input.beatId);
    const existing = await tx.select({ number: beatTakes.number }).from(beatTakes).where(eq(beatTakes.beatId, input.beatId));
    const number = nextTakeNumber(existing.map((r) => r.number));
    const [row] = await tx.insert(beatTakes).values({
      beatId: input.beatId, number, status: input.status ?? "a_revoir", startedAt: new Date(),
    }).returning({ id: beatTakes.id });
    return { id: row.id, number };
  });
}

export async function updateTakeCore(input: { takeId: string; status?: TakeStatus; note?: string | null }): Promise<void> {
  await db.transaction(async (tx) => {
    const [take] = await tx.select({ beatId: beatTakes.beatId }).from(beatTakes).where(eq(beatTakes.id, input.takeId));
    if (!take) throw new RefusalError("Prise introuvable.");
    await lockVariantOfBeat(tx, take.beatId);
    const patch: Partial<typeof beatTakes.$inferInsert> = {};
    if (input.status !== undefined) patch.status = input.status;
    if (input.note !== undefined) patch.note = input.note;
    if (Object.keys(patch).length === 0) return;
    await tx.update(beatTakes).set(patch).where(eq(beatTakes.id, input.takeId));
  });
}

export async function deleteTakeCore(input: { takeId: string }): Promise<void> {
  await db.transaction(async (tx) => {
    const [take] = await tx.select({ beatId: beatTakes.beatId }).from(beatTakes).where(eq(beatTakes.id, input.takeId));
    if (!take) throw new RefusalError("Prise introuvable.");
    await lockVariantOfBeat(tx, take.beatId);
    // Si c'était la prise retenue, l'effacer (référence logique sans FK).
    await tx.update(scriptBeats).set({ selectedTakeId: null })
      .where(and(eq(scriptBeats.id, take.beatId), eq(scriptBeats.selectedTakeId, input.takeId)));
    await tx.delete(beatTakes).where(eq(beatTakes.id, input.takeId));
  });
}

export async function selectTakeCore(input: { beatId: string; takeId: string | null }): Promise<void> {
  await db.transaction(async (tx) => {
    await lockVariantOfBeat(tx, input.beatId);
    if (input.takeId !== null) {
      const [take] = await tx.select({ beatId: beatTakes.beatId }).from(beatTakes).where(eq(beatTakes.id, input.takeId));
      if (!take || take.beatId !== input.beatId) throw new RefusalError("Prise absente de ce beat.");
    }
    await tx.update(scriptBeats).set({ selectedTakeId: input.takeId }).where(eq(scriptBeats.id, input.beatId));
  });
}

export type TakeRow = { id: string; number: number; status: string; note: string | null; startedAt: Date | null };
export type TournageBeat = {
  id: string; position: number; kind: string; kindLabel: string;
  spokenText: string; directionNote: string | null; selectedTakeId: string | null; takes: TakeRow[];
};

export async function readTournageCore(
  variantId: string,
): Promise<{ variantId: string; projectId: string; status: string; beats: TournageBeat[] } | null> {
  const [variant] = await db.select().from(scriptVariants).where(eq(scriptVariants.id, variantId));
  if (!variant) return null;
  const [project] = await db.select({ id: videoProjects.id, status: videoProjects.status })
    .from(videoProjects).where(eq(videoProjects.id, variant.projectId));
  if (!project) return null;

  const beats = await db.select().from(scriptBeats).where(eq(scriptBeats.variantId, variantId)).orderBy(asc(scriptBeats.position));
  const beatIds = beats.map((b) => b.id);
  const takes = beatIds.length
    ? await db.select().from(beatTakes).where(inArray(beatTakes.beatId, beatIds)).orderBy(asc(beatTakes.number))
    : [];
  const byBeat = new Map<string, TakeRow[]>();
  for (const t of takes) {
    const l = byBeat.get(t.beatId) ?? [];
    l.push({ id: t.id, number: t.number, status: t.status, note: t.note, startedAt: t.startedAt });
    byBeat.set(t.beatId, l);
  }

  return {
    variantId, projectId: project.id, status: project.status,
    beats: beats.map((b) => ({
      id: b.id, position: b.position, kind: b.kind, kindLabel: BEAT_KIND_LABEL[b.kind] ?? b.kind,
      spokenText: b.spokenText, directionNote: b.directionNote, selectedTakeId: b.selectedTakeId,
      takes: byBeat.get(b.id) ?? [],
    })),
  };
}
