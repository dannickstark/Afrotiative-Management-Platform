import { timingSafeEqual } from "node:crypto";

// Constant-time string comparison for the two internet-reachable cron trigger secrets
// (app/api/pipeline/run/route.ts, app/api/publish/due/route.ts). Plain `!==` short-circuits on
// the first differing byte, which leaks timing information about how many leading bytes of the
// secret an attacker's guess matched. Buffer length is compared first (not secret) before the
// constant-time byte comparison, since timingSafeEqual throws on mismatched buffer lengths.
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false; // length is not secret
  return timingSafeEqual(ab, bb);
}
