import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, montageShares, user, videoProjects } from "@/db";
import { createShareCore, listSharesCore, resolveShare, revokeShareCore } from "@/lib/montage/access";

const PROJECT_ID = "00000000-0000-0000-0000-00000005ea4e";
const USER_ID = "test-montage-share-user";

afterAll(async () => {
  await db.delete(montageShares).where(eq(montageShares.projectId, PROJECT_ID));
  await db.delete(videoProjects).where(eq(videoProjects.id, PROJECT_ID));
  await db.delete(user).where(eq(user.id, USER_ID));
});

test("createShareCore puis resolveShare résout le projet, revokeShareCore ferme l'accès", async () => {
  await db.insert(videoProjects).values({ id: PROJECT_ID, title: "Test partage", subject: null }).onConflictDoNothing();
  await db.insert(user).values({ id: USER_ID, name: "Test Monteur", email: "test-montage-share@example.com" }).onConflictDoNothing();

  const { id: shareId, token } = await createShareCore({ projectId: PROJECT_ID, userId: USER_ID, expiresAt: null });
  expect(shareId).toBeTruthy();
  expect(token.startsWith("afro_montage_")).toBe(true);

  const resolved = await resolveShare(token);
  expect(resolved).toEqual({ ok: true, projectId: PROJECT_ID, shareId });

  const rows = await listSharesCore(PROJECT_ID);
  expect(rows.some((r) => r.id === shareId)).toBe(true);

  const revoked = await revokeShareCore({ shareId, userId: USER_ID, seesAll: false });
  expect(revoked).toEqual({ ok: true });

  const afterRevoke = await resolveShare(token);
  expect(afterRevoke).toEqual({ ok: false });
});

test("revokeShareCore refuse un autre propriétaire sans seesAll", async () => {
  const { id: shareId } = await createShareCore({ projectId: PROJECT_ID, userId: USER_ID, expiresAt: null });
  const denied = await revokeShareCore({ shareId, userId: "someone-else", seesAll: false });
  expect(denied.ok).toBe(false);

  const allowed = await revokeShareCore({ shareId, userId: "someone-else", seesAll: true });
  expect(allowed).toEqual({ ok: true });
});

test("resolveShare renvoie false pour un jeton expiré", async () => {
  const past = new Date(Date.now() - 1000);
  const { token } = await createShareCore({ projectId: PROJECT_ID, userId: USER_ID, expiresAt: past });
  const resolved = await resolveShare(token);
  expect(resolved).toEqual({ ok: false });
});

test("resolveShare renvoie false pour un jeton inconnu ou mal formé", async () => {
  expect(await resolveShare("afro_montage_" + "z".repeat(40))).toEqual({ ok: false });
  expect(await resolveShare("afro_vid_xxxxxx")).toEqual({ ok: false });
});
