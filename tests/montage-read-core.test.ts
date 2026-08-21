import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, videoProjects, scriptVariants, scriptBeats, beatInserts } from "@/db";
import { readConducteurCore } from "@/lib/montage/persist";

const P = "00000000-0000-0000-0000-00000000f00d";
let variantId = "";

afterAll(async () => {
  await db.delete(videoProjects).where(eq(videoProjects.id, P));
});

test("readConducteurCore projette beats ordonnés, durées stockées et totaux", async () => {
  await db.insert(videoProjects).values({ id: P, title: "Test", subject: null }).onConflictDoNothing();
  const [v] = await db.insert(scriptVariants).values({ projectId: P, platform: "youtube_long", position: 0 }).returning();
  variantId = v.id;
  const [b1] = await db.insert(scriptBeats).values({ variantId, externalId: "b1", position: 0, kind: "narration", spokenText: "Bonjour", estimatedDurationSec: 5, durationOverrideSec: 12 }).returning();
  await db.insert(scriptBeats).values({ variantId, externalId: "b2", position: 1, kind: "broll", spokenText: "", estimatedDurationSec: 4 });
  await db.insert(beatInserts).values({ beatId: b1.id, kind: "image", url: "http://x/a.jpg", position: 0, linkStatus: "mort" });

  const res = await readConducteurCore(variantId);
  expect(res).not.toBeNull();
  expect(res!.projectId).toBe(P);
  expect(res!.conducteur.beats.map((b) => b.position)).toEqual([0, 1]);
  expect(res!.conducteur.beats[0].durationSec).toBe(12); // override stocké
  expect(res!.conducteur.totals).toMatchObject({ beatCount: 2, totalDurationSec: 16, insertCount: 1, deadLinkCount: 1 });
});

test("variante inconnue → null", async () => {
  expect(await readConducteurCore("00000000-0000-0000-0000-000000000000")).toBeNull();
});
