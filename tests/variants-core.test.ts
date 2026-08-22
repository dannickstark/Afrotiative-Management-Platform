import { afterAll, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import { db, videoProjects, scriptVariants, scriptBeats, beatInserts, interviewSpeakers } from "@/db";
import { deriveVariantCore, deleteVariantCore } from "@/lib/video/variants-persist";

const P = "00000000-0000-0000-0000-0000000006a1";
afterAll(async () => {
  // script_beats.speaker_id → interview_speakers.id n'a pas de ON DELETE CASCADE (même motif que
  // tests/beat-speaker-answers-core.test.ts) : on dénoue avant de supprimer le projet, sinon la
  // suppression en cascade de videoProjects (qui supprime interview_speakers directement) peut
  // s'exécuter avant celle des script_beats qui référencent encore ces intervenants.
  const variants = await db.select({ id: scriptVariants.id }).from(scriptVariants).where(eq(scriptVariants.projectId, P));
  const variantIds = variants.map((v) => v.id);
  if (variantIds.length > 0) {
    await db.update(scriptBeats).set({ speakerId: null }).where(inArray(scriptBeats.variantId, variantIds));
  }
  await db.delete(videoProjects).where(eq(videoProjects.id, P));
});

test("dérive une copie profonde (beats+inserts, answersBeatId remappé, speaker préservé)", async () => {
  await db.insert(videoProjects).values({ id: P, title: "T", subject: null }).onConflictDoNothing();
  const [src] = await db.insert(scriptVariants).values({ projectId: P, platform: "youtube_long", position: 0, aspectRatio: "16:9" }).returning();
  const [sp] = await db.insert(interviewSpeakers).values({ projectId: P, name: "Awa" }).returning();
  const [q] = await db.insert(scriptBeats).values({ variantId: src.id, externalId: "q1", position: 0, kind: "question", spokenText: "Q" }).returning();
  const [r] = await db.insert(scriptBeats).values({ variantId: src.id, externalId: "r1", position: 1, kind: "reponse", spokenText: "R", answersBeatId: q.id, speakerId: sp.id }).returning();
  await db.insert(beatInserts).values({ beatId: r.id, kind: "image", url: "http://x/a.jpg", position: 0 });

  const { variantId } = await deriveVariantCore({ sourceVariantId: src.id, platform: "reel", aspectRatio: "9:16", targetDurationSec: 60 });

  const [nv] = await db.select().from(scriptVariants).where(eq(scriptVariants.id, variantId));
  expect(nv.derivedFromId).toBe(src.id);
  expect(nv.position).toBe(1);
  expect(nv.aspectRatio).toBe("9:16");

  const nBeats = await db.select().from(scriptBeats).where(eq(scriptBeats.variantId, variantId));
  expect(nBeats.length).toBe(2);
  const nq = nBeats.find((b) => b.externalId === "q1")!;
  const nr = nBeats.find((b) => b.externalId === "r1")!;
  expect(nq.id).not.toBe(q.id);                 // nouveaux ids
  expect(nr.answersBeatId).toBe(nq.id);         // remappé vers le beat COPIÉ, pas la source
  expect(nr.speakerId).toBe(sp.id);             // speaker (projet) préservé
  const nIns = await db.select().from(beatInserts).where(eq(beatInserts.beatId, nr.id));
  expect(nIns.length).toBe(1);
  expect(nIns[0].url).toBe("http://x/a.jpg");
  // La source est inchangée.
  expect((await db.select().from(scriptBeats).where(eq(scriptBeats.variantId, src.id))).length).toBe(2);
});

test("supprime une dérivée ; refuse l'origine", async () => {
  const [src] = await db.select().from(scriptVariants).where(and(eq(scriptVariants.projectId, P), eq(scriptVariants.position, 0)));
  await expect(deleteVariantCore({ variantId: src.id })).rejects.toThrow(); // origine protégée
  const [derived] = await db.select().from(scriptVariants).where(and(eq(scriptVariants.projectId, P), eq(scriptVariants.position, 1)));
  await deleteVariantCore({ variantId: derived.id });
  expect((await db.select().from(scriptVariants).where(eq(scriptVariants.id, derived.id))).length).toBe(0);
});
