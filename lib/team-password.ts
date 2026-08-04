import { randomInt } from "node:crypto";

// Character classes deliberately exclude visually ambiguous glyphs (0/O, 1/l/I) since a temp
// password is typically read off a screen and typed by hand once, out-of-band, by whoever
// receives it.
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const LOWER = "abcdefghijkmnpqrstuvwxyz";
const DIGITS = "23456789";
const SYMBOLS = "!@#$%^&*-_=+";
const ALL = UPPER + LOWER + DIGITS + SYMBOLS;

function pick(charset: string): string {
  return charset[randomInt(charset.length)];
}

/**
 * Cryptographically random temporary password for a newly created member
 * (lib/actions/team-actions.ts `addMember`). Guarantees at least one character from each class
 * (upper/lower/digit/symbol) and shuffles their position, using node:crypto's CSPRNG throughout.
 *
 * Kept in a plain (non "use server") module on purpose: a file-level "use server" directive
 * (required so components/settings/*.tsx Client Components can import the team actions directly)
 * only allows async-function exports in Next.js 16 — a synchronous, directly-callable pure
 * function like this one has to live outside that file. Identical constraint to
 * lib/validation.ts's `validateFeedInput` (see that file's comment / Task 2's report).
 *
 * SECURITY: the caller (addMember) must return this value to the UI exactly once and never log,
 * throw, or persist it in plaintext — createCredentialUser hashes it before the DB write, and
 * nothing in this module or its callers should console.log/console.error a password.
 */
export function generateTempPassword(length = 16): string {
  if (length < 4) throw new Error("length must be >= 4 to cover all character classes");
  const chars = [pick(UPPER), pick(LOWER), pick(DIGITS), pick(SYMBOLS)];
  while (chars.length < length) chars.push(pick(ALL));
  // Fisher-Yates shuffle so the guaranteed classes aren't always in the same four positions.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}
