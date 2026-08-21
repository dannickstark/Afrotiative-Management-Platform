import { desc, eq } from "drizzle-orm";
import { db, montageShares, user } from "@/db";
import { generateShareToken, sharePrefixOf, shareTokenMatches } from "@/lib/montage/token";

export type ShareRow = {
  id: string;
  projectId: string;
  createdByName: string | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastAccessedAt: Date | null;
  createdAt: Date;
};

export async function resolveShare(
  rawToken: string,
): Promise<{ ok: true; projectId: string; shareId: string } | { ok: false }> {
  const prefix = sharePrefixOf(rawToken);
  if (!prefix) return { ok: false };
  const [row] = await db.select().from(montageShares).where(eq(montageShares.tokenPrefix, prefix)).limit(1);
  if (!row) return { ok: false };
  if (row.revokedAt) return { ok: false };
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return { ok: false };
  if (!shareTokenMatches(rawToken, row.tokenHash)) return { ok: false };
  await db.update(montageShares).set({ lastAccessedAt: new Date() }).where(eq(montageShares.id, row.id));
  return { ok: true, projectId: row.projectId, shareId: row.id };
}

export async function createShareCore(
  { projectId, userId, expiresAt }: { projectId: string; userId: string; expiresAt: Date | null },
): Promise<{ id: string; token: string }> {
  const { token, prefix, tokenHash } = generateShareToken();
  const [row] = await db.insert(montageShares)
    .values({ projectId, tokenPrefix: prefix, tokenHash, createdBy: userId, expiresAt })
    .returning({ id: montageShares.id });
  return { id: row.id, token };
}

export async function revokeShareCore(
  { shareId, userId, seesAll }: { shareId: string; userId: string; seesAll: boolean },
): Promise<{ ok: boolean; message?: string }> {
  const [row] = await db.select().from(montageShares).where(eq(montageShares.id, shareId)).limit(1);
  if (!row) return { ok: false, message: "Lien introuvable." };
  if (!seesAll && row.createdBy !== userId) return { ok: false, message: "Vous ne pouvez révoquer que vos propres liens." };
  await db.update(montageShares).set({ revokedAt: new Date() }).where(eq(montageShares.id, shareId));
  return { ok: true };
}

export async function listSharesCore(projectId: string): Promise<ShareRow[]> {
  return db.select({
    id: montageShares.id, projectId: montageShares.projectId, createdByName: user.name,
    expiresAt: montageShares.expiresAt, revokedAt: montageShares.revokedAt,
    lastAccessedAt: montageShares.lastAccessedAt, createdAt: montageShares.createdAt,
  }).from(montageShares)
    .leftJoin(user, eq(user.id, montageShares.createdBy))
    .where(eq(montageShares.projectId, projectId))
    .orderBy(desc(montageShares.createdAt));
}
