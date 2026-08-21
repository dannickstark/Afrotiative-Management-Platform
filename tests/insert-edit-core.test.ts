import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, videoProjects, scriptVariants, scriptBeats, beatInserts } from "@/db";
import { updateBeatInsertCore } from "@/lib/video/persist";

const P = "00000000-0000-0000-0000-0000000003a1";
let insertId = "";

afterAll(async () => { await db.delete(videoProjects).where(eq(videoProjects.id, P)); });

test("patch partiel : crédit/tc éditables sans reset du statut ; url change → reset", async () => {
  await db.insert(videoProjects).values({ id: P, title: "T", subject: null }).onConflictDoNothing();
  const [v] = await db.insert(scriptVariants).values({ projectId: P, platform: "youtube_long", position: 0 }).returning();
  const [b] = await db.insert(scriptBeats).values({ variantId: v.id, externalId: "b1", position: 0, kind: "insert", spokenText: "" }).returning();
  const [ins] = await db.insert(beatInserts).values({ beatId: b.id, kind: "image", url: "http://x/a.jpg", position: 0, linkStatus: "ok", linkCheckedAt: new Date() }).returning();
  insertId = ins.id;

  // Éditer crédit + tc : le statut vérifié DOIT survivre.
  await updateBeatInsertCore({ insertId, credit: "AFP", tcIn: "00:00:01", tcOut: "00:00:05" });
  let [row] = await db.select().from(beatInserts).where(eq(beatInserts.id, insertId));
  expect(row.credit).toBe("AFP");
  expect(row.tcIn).toBe("00:00:01");
  expect(row.linkStatus).toBe("ok"); // pas de reset

  // Changer l'url : reset à non_verifie.
  await updateBeatInsertCore({ insertId, url: "http://x/b.jpg" });
  [row] = await db.select().from(beatInserts).where(eq(beatInserts.id, insertId));
  expect(row.url).toBe("http://x/b.jpg");
  expect(row.linkStatus).toBe("non_verifie");
  expect(row.linkCheckedAt).toBeNull();

  // Champ absent = inchangé (crédit non touché en ne le passant pas).
  await updateBeatInsertCore({ insertId, rightsNote: "CC-BY" });
  [row] = await db.select().from(beatInserts).where(eq(beatInserts.id, insertId));
  expect(row.credit).toBe("AFP");
  expect(row.rightsNote).toBe("CC-BY");
});
