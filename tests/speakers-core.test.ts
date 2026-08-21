import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, videoProjects, scriptVariants, scriptBeats, interviewSpeakers } from "@/db";
import { createSpeakerCore, updateSpeakerCore, deleteSpeakerCore } from "@/lib/video/speakers-persist";
import { listSpeakers } from "@/lib/queries/video";

const P = "00000000-0000-0000-0000-0000000005a1";

afterAll(async () => { await db.delete(videoProjects).where(eq(videoProjects.id, P)); });

test("CRUD intervenant + suppression dénoue les beats", async () => {
  await db.insert(videoProjects).values({ id: P, title: "T", subject: null }).onConflictDoNothing();
  const [v] = await db.insert(scriptVariants).values({ projectId: P, platform: "interview", position: 0 }).returning();
  const [b] = await db.insert(scriptBeats).values({ variantId: v.id, externalId: "b1", position: 0, kind: "reponse", spokenText: "" }).returning();

  const id = await createSpeakerCore({ projectId: P, name: "Awa", role: "Experte" });
  let list = await listSpeakers(P);
  expect(list.find((s) => s.id === id)?.consentGiven).toBe(false);

  await updateSpeakerCore({ speakerId: id, consentGiven: true, consentNote: "Signé le 20/08" });
  list = await listSpeakers(P);
  expect(list.find((s) => s.id === id)?.consentGiven).toBe(true);

  // Assigner puis supprimer : le beat doit être dénoué (speakerId → null), pas d'erreur FK.
  await db.update(scriptBeats).set({ speakerId: id }).where(eq(scriptBeats.id, b.id));
  await deleteSpeakerCore({ speakerId: id });
  const [beatRow] = await db.select().from(scriptBeats).where(eq(scriptBeats.id, b.id));
  expect(beatRow.speakerId).toBeNull();
  expect((await listSpeakers(P)).length).toBe(0);
});
