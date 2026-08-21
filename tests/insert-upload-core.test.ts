// DB (comme insert-verify-core.test.ts) : insère un projet/variante/beat/insert réels et appelle
// uploadInsertMediaCore avec un PNG 1x1 réel (décodable par sharp via validateImageAsset) et
// deps.sendRequest stubbé (aucun appel réseau réel vers R2). NON inscrit au PURE_FILES
// (scripts/test-fast.ts) : ce test touche la vraie base Neon partagée, comme insert-verify-core.test.ts.
//
// Si l'environnement de test n'a pas les variables R2 (getStudioConfig() → null), on pose des
// valeurs factices AVANT tout appel — putObject est stubbé via deps.sendRequest, donc ces valeurs
// ne servent qu'à faire passer getStudioConfig().
process.env.R2_ACCOUNT_ID ||= "test-account";
process.env.R2_ACCESS_KEY_ID ||= "test-key";
process.env.R2_SECRET_ACCESS_KEY ||= "test-secret";
process.env.R2_BUCKET ||= "test-bucket";
process.env.R2_PUBLIC_BASE_URL ||= "https://media.test.example";

import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, videoProjects, scriptVariants, scriptBeats, beatInserts } from "@/db";
import { uploadInsertMediaCore, insertMediaKey } from "@/lib/video/insert-upload-core";

const P = "00000000-0000-0000-0000-0000000004b1";

afterAll(async () => { await db.delete(videoProjects).where(eq(videoProjects.id, P)); });

const PNG_1x1 = Uint8Array.from(atob(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
), (c) => c.charCodeAt(0));

test("insertMediaKey : préfixe video/inserts/yyyy/mm/", () => {
  const key = insertMediaKey("png", new Date("2026-03-15T00:00:00Z"));
  expect(key).toMatch(/^video\/inserts\/2026\/03\/[0-9a-f-]+\.png$/);
});

test("uploadInsertMediaCore : upload un PNG réel, persiste r2Key/url/linkStatus=ok, bumpe locallyEditedAt", async () => {
  await db.insert(videoProjects).values({ id: P, title: "T", subject: null }).onConflictDoNothing();
  const [v] = await db.insert(scriptVariants).values({ projectId: P, platform: "youtube_long", position: 0 }).returning();
  const [b] = await db.insert(scriptBeats).values({
    variantId: v.id, externalId: "b1", position: 0, kind: "insert", spokenText: "", locallyEditedAt: null,
  }).returning();
  const [ins] = await db.insert(beatInserts).values({
    beatId: b.id, kind: "image", url: null, position: 0, linkStatus: "non_verifie",
  }).returning();

  const file = new File([PNG_1x1], "a.png", { type: "image/png" });

  const result = await uploadInsertMediaCore({
    insertId: ins.id,
    file,
    deps: { sendRequest: async () => new Response(null, { status: 200 }) },
  });

  expect(result.r2Key).toMatch(/^video\/inserts\//);
  expect(result.url).toBeTruthy();

  const [row] = await db.select().from(beatInserts).where(eq(beatInserts.id, ins.id));
  expect(row.r2Key).toBe(result.r2Key);
  expect(row.url).toBe(result.url);
  expect(row.linkStatus).toBe("ok");
  expect(row.linkCheckedAt).not.toBeNull();

  const [beatRow] = await db.select().from(scriptBeats).where(eq(scriptBeats.id, b.id));
  expect(beatRow.locallyEditedAt).not.toBeNull();
});

test("uploadInsertMediaCore : insert introuvable → RefusalError", async () => {
  const file = new File([PNG_1x1], "a.png", { type: "image/png" });
  await expect(uploadInsertMediaCore({
    insertId: "00000000-0000-0000-0000-000000000000",
    file,
    deps: { sendRequest: async () => new Response(null, { status: 200 }) },
  })).rejects.toThrow();
});
