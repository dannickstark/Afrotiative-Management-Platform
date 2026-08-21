import { afterAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db, videoProjects, scriptVariants, scriptBeats, beatInserts, scriptJournal, user } from "@/db";
import { RefusalError } from "@/lib/video/persist";
import { toggleBeatCheckedCore, flagInsertDeadCore } from "@/lib/montage/persist";

const P = "00000000-0000-0000-0000-0000000a1101";
const OTHER_P = "00000000-0000-0000-0000-0000000a1102";
const ACTOR_ID = "test-montage-annotate-user";

afterAll(async () => {
  await db.delete(scriptJournal).where(eq(scriptJournal.projectId, P));
  await db.delete(scriptJournal).where(eq(scriptJournal.projectId, OTHER_P));
  await db.delete(videoProjects).where(eq(videoProjects.id, P));
  await db.delete(videoProjects).where(eq(videoProjects.id, OTHER_P));
  await db.delete(user).where(eq(user.id, ACTOR_ID));
});

test("toggleBeatCheckedCore bascule null→date→null et journalise", async () => {
  await db.insert(videoProjects).values({ id: P, title: "Test annotate", subject: null }).onConflictDoNothing();
  await db.insert(user).values({ id: ACTOR_ID, name: "Monteur Test", email: "test-montage-annotate@example.com" }).onConflictDoNothing();
  const [v] = await db.insert(scriptVariants).values({ projectId: P, platform: "youtube_long", position: 0 }).returning();
  const [b] = await db.insert(scriptBeats).values({ variantId: v.id, externalId: "b1", position: 0, kind: "narration", spokenText: "x" }).returning();

  const first = await toggleBeatCheckedCore({ beatId: b.id, projectId: P, actorUserId: ACTOR_ID });
  expect(first.checked).toBe(true);

  const [afterFirst] = await db.select().from(scriptBeats).where(eq(scriptBeats.id, b.id));
  expect(afterFirst.montageCheckedAt).not.toBeNull();

  const second = await toggleBeatCheckedCore({ beatId: b.id, projectId: P, actorUserId: ACTOR_ID });
  expect(second.checked).toBe(false);

  const [afterSecond] = await db.select().from(scriptBeats).where(eq(scriptBeats.id, b.id));
  expect(afterSecond.montageCheckedAt).toBeNull();

  const journalRows = await db.select().from(scriptJournal)
    .where(and(eq(scriptJournal.projectId, P), eq(scriptJournal.toolName, "toggle_beat_checked")));
  expect(journalRows.length).toBe(2);
  for (const row of journalRows) {
    expect(row.source).toBe("monteur");
    expect(row.outcome).toBe("applique");
    expect(row.actorUserId).toBe(ACTOR_ID);
  }
});

test("flagInsertDeadCore passe l'insert à mort et journalise", async () => {
  const [v] = await db.insert(scriptVariants).values({ projectId: P, platform: "tiktok", position: 1 }).returning();
  const [b] = await db.insert(scriptBeats).values({ variantId: v.id, externalId: "b2", position: 0, kind: "insert", spokenText: "" }).returning();
  const [ins] = await db.insert(beatInserts).values({ beatId: b.id, kind: "image", url: "http://x/a.jpg", position: 0 }).returning();

  await flagInsertDeadCore({ insertId: ins.id, projectId: P, actorUserId: ACTOR_ID });

  const [afterFlag] = await db.select().from(beatInserts).where(eq(beatInserts.id, ins.id));
  expect(afterFlag.linkStatus).toBe("mort");
  expect(afterFlag.linkCheckedAt).not.toBeNull();

  const journalRows = await db.select().from(scriptJournal)
    .where(and(eq(scriptJournal.projectId, P), eq(scriptJournal.toolName, "flag_insert_dead")));
  expect(journalRows.length).toBe(1);
  expect(journalRows[0].source).toBe("monteur");
  expect(journalRows[0].outcome).toBe("applique");
});

test("un beat/insert d'un autre projet est refusé", async () => {
  await db.insert(videoProjects).values({ id: OTHER_P, title: "Autre projet", subject: null }).onConflictDoNothing();
  const [v] = await db.insert(scriptVariants).values({ projectId: OTHER_P, platform: "youtube_long", position: 0 }).returning();
  const [b] = await db.insert(scriptBeats).values({ variantId: v.id, externalId: "b1", position: 0, kind: "narration", spokenText: "x" }).returning();
  const [ins] = await db.insert(beatInserts).values({ beatId: b.id, kind: "image", url: "http://x/a.jpg", position: 0 }).returning();

  await expect(toggleBeatCheckedCore({ beatId: b.id, projectId: P, actorUserId: ACTOR_ID })).rejects.toBeInstanceOf(RefusalError);
  await expect(flagInsertDeadCore({ insertId: ins.id, projectId: P, actorUserId: ACTOR_ID })).rejects.toBeInstanceOf(RefusalError);
});
