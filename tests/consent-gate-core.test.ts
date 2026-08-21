import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, interviewSpeakers, videoProjects } from "@/db";
import { setProjectStatusCore } from "@/lib/video/persist";

const P1 = "00000000-0000-0000-0000-0000000c0e51";
const P2 = "00000000-0000-0000-0000-0000000c0e52";

afterAll(async () => {
  await db.delete(interviewSpeakers).where(eq(interviewSpeakers.projectId, P1));
  await db.delete(videoProjects).where(eq(videoProjects.id, P1));
  await db.delete(videoProjects).where(eq(videoProjects.id, P2));
});

test("setProjectStatusCore : refuse → en_montage si un intervenant n'a pas consenti", async () => {
  await db.insert(videoProjects).values({ id: P1, title: "T1", subject: null, status: "tourne" })
    .onConflictDoNothing();
  const [speaker] = await db.insert(interviewSpeakers).values({
    projectId: P1, name: "Intervenant", consentGiven: false,
  }).returning({ id: interviewSpeakers.id });

  await expect(setProjectStatusCore({ projectId: P1, to: "en_montage" })).rejects.toThrow();

  await db.update(interviewSpeakers).set({ consentGiven: true }).where(eq(interviewSpeakers.id, speaker.id));

  await setProjectStatusCore({ projectId: P1, to: "en_montage" });
  const [row] = await db.select({ status: videoProjects.status }).from(videoProjects).where(eq(videoProjects.id, P1));
  expect(row.status).toBe("en_montage");
});

test("setProjectStatusCore : passe → en_montage sans intervenant", async () => {
  await db.insert(videoProjects).values({ id: P2, title: "T2", subject: null, status: "tourne" })
    .onConflictDoNothing();

  await setProjectStatusCore({ projectId: P2, to: "en_montage" });
  const [row] = await db.select({ status: videoProjects.status }).from(videoProjects).where(eq(videoProjects.id, P2));
  expect(row.status).toBe("en_montage");
});
