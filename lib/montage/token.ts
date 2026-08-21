import { createHash, randomBytes } from "node:crypto";
import { safeEqual } from "@/lib/timing-safe";

// Module PUR : ni base, ni réseau. Miroir de lib/mcp/token.ts, avec un namespace DISTINCT
// (afro_montage_ vs afro_vid_) : un jeton de partage de conducteur n'a jamais les pouvoirs d'un
// jeton MCP, et les deux ne doivent jamais pouvoir se confondre au premier coup d'œil.
export const SHARE_NAMESPACE = "afro_montage_";
export const SHARE_PREFIX_LENGTH = SHARE_NAMESPACE.length + 6;

export function hashShareToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function generateShareToken(): { token: string; prefix: string; tokenHash: string } {
  const token = SHARE_NAMESPACE + randomBytes(32).toString("base64url");
  return { token, prefix: token.slice(0, SHARE_PREFIX_LENGTH), tokenHash: hashShareToken(token) };
}

export function sharePrefixOf(token: string): string | null {
  if (!token.startsWith(SHARE_NAMESPACE)) return null;
  if (token.length <= SHARE_PREFIX_LENGTH) return null;
  return token.slice(0, SHARE_PREFIX_LENGTH);
}

export function shareTokenMatches(token: string, storedHash: string): boolean {
  if (!storedHash) return false;
  return safeEqual(hashShareToken(token), storedHash);
}
