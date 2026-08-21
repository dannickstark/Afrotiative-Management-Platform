import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, videoProjects, scriptVariants, scriptBeats, beatTakes } from "@/db";
import { addTakeCore, updateTakeCore, deleteTakeCore, selectTakeCore, readTournageCore } from "@/lib/video/takes-core";

const P = "00000000-0000-0000-0000-0000000004a1";
let variantId = "", beatId = "", otherBeatId = "";

afterAll(async () => { await db.delete(videoProjects).where(eq(videoProjects.id, P)); });

test("add → numérotation, select, delete efface la retenue, readTournage", async () => {
  await db.insert(videoProjects).values({ id: P, title: "T", subject: null }).onConflictDoNothing();
  const [v] = await db.insert(scriptVariants).values({ projectId: P, platform: "youtube_long", position: 0 }).returning();
  variantId = v.id;
  const [b] = await db.insert(scriptBeats).values({ variantId, externalId: "b1", position: 0, kind: "narration", spokenText: "Bonjour" }).returning();
  const [b2] = await db.insert(scriptBeats).values({ variantId, externalId: "b2", position: 1, kind: "reponse", spokenText: "Oui" }).returning();
  beatId = b.id; otherBeatId = b2.id;

  const t1 = await addTakeCore({ beatId, status: "mauvaise" });
  const t2 = await addTakeCore({ beatId });
  expect([t1.number, t2.number]).toEqual([1, 2]);

  await updateTakeCore({ takeId: t2.id, status: "bonne", note: "la bonne" });
  await selectTakeCore({ beatId, takeId: t2.id });
  let [beatRow] = await db.select().from(scriptBeats).where(eq(scriptBeats.id, beatId));
  expect(beatRow.selectedTakeId).toBe(t2.id);

  // Refuse une prise d'un autre beat.
  await expect(selectTakeCore({ beatId: otherBeatId, takeId: t2.id })).rejects.toThrow();

  // Supprimer la prise retenue efface selectedTakeId.
  await deleteTakeCore({ takeId: t2.id });
  [beatRow] = await db.select().from(scriptBeats).where(eq(scriptBeats.id, beatId));
  expect(beatRow.selectedTakeId).toBeNull();

  const read = await readTournageCore(variantId);
  expect(read?.beats.map((x) => x.position)).toEqual([0, 1]);
  expect(read?.beats[0].takes.map((x) => x.number)).toEqual([1]); // t1 reste
});
