// Plain module (NOT "use server") — a "use server" file may only export async
// functions, but this exports a const (LOCK_TTL_MS) and a sync fn (isLockActive).
export const LOCK_TTL_MS = 5 * 60_000;

export function isLockActive(lockedAt: Date | null): boolean {
  return !!lockedAt && Date.now() - new Date(lockedAt).getTime() < LOCK_TTL_MS;
}
