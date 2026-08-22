import { asc, eq, inArray } from "drizzle-orm";
import { db, scriptVariants, scriptBeats, beatInserts } from "@/db";
import { RefusalError } from "@/lib/video/persist";

// SP6 (variantes dérivées) — cœurs DB de dérivation (copie profonde) et de suppression d'une
// variante. Volontairement SANS "use server" : même motif que lib/video/persist.ts (voir son
// commentaire d'en-tête) — le mapping colonnes ↔ appelants y vit, jamais dans les fichiers
// "use server".

export async function deriveVariantCore(
  input: { sourceVariantId: string; platform: string; aspectRatio: string; targetDurationSec: number | null },
): Promise<{ variantId: string }> {
  return db.transaction(async (tx) => {
    const [source] = await tx.select({ id: scriptVariants.id, projectId: scriptVariants.projectId })
      .from(scriptVariants).where(eq(scriptVariants.id, input.sourceVariantId)).for("update");
    if (!source) throw new RefusalError("Variante source introuvable.");

    const variants = await tx.select({ position: scriptVariants.position }).from(scriptVariants)
      .where(eq(scriptVariants.projectId, source.projectId));
    const position = variants.reduce((max, v) => Math.max(max, v.position), -1) + 1;

    let nv: { id: string };
    try {
      [nv] = await tx.insert(scriptVariants).values({
        projectId: source.projectId,
        platform: input.platform as (typeof scriptVariants.$inferInsert)["platform"],
        aspectRatio: input.aspectRatio,
        targetDurationSec: input.targetDurationSec,
        position,
        derivedFromId: input.sourceVariantId,
      }).returning({ id: scriptVariants.id });
    } catch (err: any) {
      if (err?.code === "23505" || err?.cause?.code === "23505") {
        throw new RefusalError("Une autre variante a été créée au même moment. Réessayez.");
      }
      throw err;
    }

    const srcBeats = await tx.select().from(scriptBeats)
      .where(eq(scriptBeats.variantId, input.sourceVariantId)).orderBy(asc(scriptBeats.position));

    const idMap = new Map<string, string>();
    for (const b of srcBeats) {
      const [row] = await tx.insert(scriptBeats).values({
        variantId: nv.id, externalId: b.externalId, position: b.position, kind: b.kind,
        spokenText: b.spokenText, directionNote: b.directionNote, screenText: b.screenText,
        transitionIn: b.transitionIn, transitionOut: b.transitionOut,
        estimatedDurationSec: b.estimatedDurationSec, durationOverrideSec: b.durationOverrideSec,
        framing: b.framing, speakerId: b.speakerId, sources: b.sources,
        // EXCLUS : answersBeatId (remappé plus bas), selectedTakeId, montageCheckedAt, importedSnapshot, locallyEditedAt.
      }).returning({ id: scriptBeats.id });
      idMap.set(b.id, row.id);
    }

    // Remap des liens Q/R vers les beats copiés.
    for (const b of srcBeats) {
      if (!b.answersBeatId) continue;
      const target = idMap.get(b.answersBeatId);
      const newId = idMap.get(b.id);
      if (target && newId) {
        await tx.update(scriptBeats).set({ answersBeatId: target }).where(eq(scriptBeats.id, newId));
      }
    }

    // Copie des inserts.
    const srcIds = srcBeats.map((b) => b.id);
    if (srcIds.length > 0) {
      const inserts = await tx.select().from(beatInserts)
        .where(inArray(beatInserts.beatId, srcIds)).orderBy(asc(beatInserts.position));
      for (const ins of inserts) {
        const newBeatId = idMap.get(ins.beatId);
        if (!newBeatId) continue;
        await tx.insert(beatInserts).values({
          beatId: newBeatId, kind: ins.kind, url: ins.url, r2Key: ins.r2Key,
          tcIn: ins.tcIn, tcOut: ins.tcOut, displayDurationSec: ins.displayDurationSec,
          credit: ins.credit, rightsNote: ins.rightsNote, linkStatus: ins.linkStatus,
          linkCheckedAt: ins.linkCheckedAt, position: ins.position,
        });
      }
    }

    return { variantId: nv.id };
  });
}

export async function deleteVariantCore(input: { variantId: string }): Promise<void> {
  await db.transaction(async (tx) => {
    const [v] = await tx.select({ id: scriptVariants.id, derivedFromId: scriptVariants.derivedFromId })
      .from(scriptVariants).where(eq(scriptVariants.id, input.variantId)).for("update");
    if (!v) throw new RefusalError("Variante introuvable.");
    if (v.derivedFromId === null) throw new RefusalError("La variante d'origine ne peut pas être supprimée.");
    await tx.delete(scriptVariants).where(eq(scriptVariants.id, input.variantId));
  });
}
