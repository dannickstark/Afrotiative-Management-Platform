import { createHash, randomBytes } from "node:crypto";
import { safeEqual } from "@/lib/timing-safe";

// Module PUR : ni base, ni réseau. Le jeton est un secret À HAUTE ENTROPIE (32 octets aléatoires),
// pas un mot de passe : SHA-256 est le bon outil ici, et bcrypt/argon2 seraient un contresens
// (ils protègent contre la force brute d'un secret DEVINABLE, ce qu'un aléa de 256 bits n'est pas).
export const TOKEN_NAMESPACE = "afro_vid_";
// namespace (9) + 6 caractères aléatoires : assez pour reconnaître un jeton dans une liste, trop
// peu pour aider qui que ce soit à le reconstituer.
export const PREFIX_LENGTH = TOKEN_NAMESPACE.length + 6;

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function generateToken(): { token: string; prefix: string; tokenHash: string } {
  const token = TOKEN_NAMESPACE + randomBytes(32).toString("base64url");
  return { token, prefix: token.slice(0, PREFIX_LENGTH), tokenHash: hashToken(token) };
}

/**
 * Le préfixe sert à retrouver UNE ligne candidate au lieu de parcourir la table. Renvoie `null`
 * pour tout ce qui ne peut pas être un de nos jetons — on évite ainsi une requête inutile sur un
 * en-tête `Authorization` qui appartient à quelqu'un d'autre.
 */
export function prefixOf(token: string): string | null {
  if (!token.startsWith(TOKEN_NAMESPACE)) return null;
  if (token.length <= PREFIX_LENGTH) return null;
  return token.slice(0, PREFIX_LENGTH);
}

/**
 * Comparaison à TEMPS CONSTANT via safeEqual : un `===` sur les hachés court-circuite au premier
 * octet différent et laisse fuir, par le temps de réponse, combien d'octets de tête un candidat a
 * devinés. Même précaution que les deux secrets de cron (lib/timing-safe.ts).
 */
export function tokenMatches(token: string, storedHash: string): boolean {
  if (!storedHash) return false;
  return safeEqual(hashToken(token), storedHash);
}
