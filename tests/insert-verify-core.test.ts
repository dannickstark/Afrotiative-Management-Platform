import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, videoProjects, scriptVariants, scriptBeats, beatInserts } from "@/db";
import {
  setInsertLinkStatusCore, listProjectInsertsForVerifyCore, verifyProjectLinksCore,
} from "@/lib/video/persist";

const P = "00000000-0000-0000-0000-0000000004a1";

afterAll(async () => { await db.delete(videoProjects).where(eq(videoProjects.id, P)); });

test("verifyProjectLinksCore : url publique → ok, url privée → mort SANS fetch, statuts persistés", async () => {
  await db.insert(videoProjects).values({ id: P, title: "T", subject: null }).onConflictDoNothing();
  const [v] = await db.insert(scriptVariants).values({ projectId: P, platform: "youtube_long", position: 0 }).returning();
  const [b] = await db.insert(scriptBeats).values({ variantId: v.id, externalId: "b1", position: 0, kind: "insert", spokenText: "" }).returning();

  const [publicInsert] = await db.insert(beatInserts).values({
    beatId: b.id, kind: "image", url: "https://x.test/pub.jpg", position: 0, linkStatus: "non_verifie",
  }).returning();
  const [privateInsert] = await db.insert(beatInserts).values({
    beatId: b.id, kind: "image", url: "http://127.0.0.1/priv.jpg", position: 1, linkStatus: "non_verifie",
  }).returning();

  let fetchCalls = 0;
  const fetchImpl = (async () => { fetchCalls++; return new Response(null, { status: 200 }); }) as unknown as typeof fetch;

  const counts = await verifyProjectLinksCore({ projectId: P, fetchImpl });

  expect(counts.ok).toBe(1);
  expect(counts.mort).toBe(1);
  expect(counts.interdit).toBe(0);
  // Une seule url publique dans ce lot : le fetch injecté n'a été appelé qu'une fois — la privée
  // n'a jamais atteint doFetch (garde SSRF avant tout appel réseau).
  expect(fetchCalls).toBe(1);

  const [pubRow] = await db.select().from(beatInserts).where(eq(beatInserts.id, publicInsert.id));
  expect(pubRow.linkStatus).toBe("ok");
  expect(pubRow.linkCheckedAt).not.toBeNull();

  const [privRow] = await db.select().from(beatInserts).where(eq(beatInserts.id, privateInsert.id));
  expect(privRow.linkStatus).toBe("mort");
  expect(privRow.linkCheckedAt).not.toBeNull();

  const listed = await listProjectInsertsForVerifyCore(P);
  expect(listed.length).toBe(2);
});

test("setInsertLinkStatusCore : met à jour le statut sans bumper locallyEditedAt du beat", async () => {
  await db.insert(videoProjects).values({ id: P, title: "T", subject: null }).onConflictDoNothing();
  const [v] = await db.insert(scriptVariants).values({ projectId: P, platform: "tiktok", position: 1 }).returning();
  const [b] = await db.insert(scriptBeats).values({
    variantId: v.id, externalId: "b2", position: 0, kind: "insert", spokenText: "", locallyEditedAt: null,
  }).returning();
  const [ins] = await db.insert(beatInserts).values({
    beatId: b.id, kind: "image", url: "https://x.test/a.jpg", position: 0, linkStatus: "non_verifie",
  }).returning();

  await setInsertLinkStatusCore({ insertId: ins.id, status: "interdit" });

  const [row] = await db.select().from(beatInserts).where(eq(beatInserts.id, ins.id));
  expect(row.linkStatus).toBe("interdit");
  expect(row.linkCheckedAt).not.toBeNull();

  const [beatRow] = await db.select().from(scriptBeats).where(eq(scriptBeats.id, b.id));
  expect(beatRow.locallyEditedAt).toBeNull();
});

test("setInsertLinkStatusCore : insert introuvable → RefusalError", async () => {
  await expect(setInsertLinkStatusCore({
    insertId: "00000000-0000-0000-0000-000000000000", status: "ok",
  })).rejects.toThrow();
});
