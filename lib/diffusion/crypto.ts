// lib/diffusion/crypto.ts — Task 1 (D2+D3): AES-256-GCM helpers for social_channel_settings'
// encrypted `credentials` blob (db/schema.ts). Same idiom as lib/wp/config.ts's getWpConfig(): a
// getCryptoConfig() that returns `null` when CREDENTIALS_ENCRYPTION_KEY is absent/malformed, so a
// missing key disables the FEATURE (credential fields refuse to save, in French — see
// lib/diffusion/settings-core.ts's setChannelCredentialsCore) instead of the app crashing. Follows
// the house node:crypto style already used by lib/team-password.ts (randomInt) and
// lib/studio/store.ts (createHash) — plain, non-"use server" module, since a synchronous helper
// like encryptSecret can't be a Server Action export anyway (Next 16 only allows async-function
// exports from a "use server" file) and, per lib/actions/taxonomy-actions.ts's comment, every
// export of such a file is an unauthenticated network entry point — this module must never gain a
// "use server" directive.
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // 96-bit IV — the size GCM is defined/optimized for (avoids the extra GHASH pass a non-96-bit IV requires)
const AUTH_TAG_BYTES = 16; // GCM's standard/default tag length (node:crypto's own default when none is passed to createCipheriv)

export type CryptoConfig = { key: Buffer };

// `CREDENTIALS_ENCRYPTION_KEY` — 32 raw bytes, base64-encoded (see .env.example / docs/DEPLOYMENT.md
// for how to generate one: `openssl rand -base64 32`). Returns null (never throws) when the env var
// is absent, not valid base64, or does not decode to exactly 32 bytes — a truncated/corrupted key
// must disable the feature the same way a missing one does, not attempt AES-256 with the wrong key
// size (node:crypto would throw a raw, unfriendly error for that).
export function getCryptoConfig(): CryptoConfig | null {
  const raw = process.env.CREDENTIALS_ENCRYPTION_KEY;
  if (!raw) return null;
  // No try/catch here (removed, review finding — harmless dead code): Buffer.from(x, "base64")
  // never throws, even on non-base64 input (it decodes leniently, dropping invalid characters) —
  // the length check right below is what actually rejects a bad/truncated/non-base64 key.
  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_BYTES) return null;
  return { key };
}

// Thrown only by encryptSecret/decryptSecret below when called directly without a configured key —
// a defense-in-depth safety net, not the primary "feature unavailable" path. The primary path is
// callers checking getCryptoConfig() themselves first (exactly like getWpConfig()'s callers) and
// returning a French message before ever reaching these functions — see setChannelCredentialsCore.
export class CredentialsNotConfiguredError extends Error {
  constructor() {
    super("Chiffrement des identifiants non configuré (CREDENTIALS_ENCRYPTION_KEY manquant ou invalide).");
    this.name = "CredentialsNotConfiguredError";
  }
}

// Thrown by decryptSecret when authentication fails (wrong key, corrupted/truncated ciphertext, or
// a bit-flipped/tampered value) — GCM's whole point is that this happens INSTEAD OF silently
// returning garbage plaintext. Also thrown for a malformed stored value (wrong number of `:`-
// separated parts) so a corrupted DB row fails the same loud way rather than crashing deeper inside
// node:crypto with a less legible error.
export class DecryptionFailedError extends Error {
  constructor(reason: string) {
    super(`Échec du déchiffrement : ${reason}`);
    this.name = "DecryptionFailedError";
  }
}

// Stored format: base64(iv) + ":" + base64(authTag) + ":" + base64(ciphertext). All three are
// self-describing/fixed-or-delimited, so decryptSecret never has to guess where one part ends and
// the next begins.
function serialize(iv: Buffer, authTag: Buffer, ciphertext: Buffer): string {
  return `${iv.toString("base64")}:${authTag.toString("base64")}:${ciphertext.toString("base64")}`;
}

// Review finding (Important 2): createDecipheriv/setAuthTag (below, in decryptSecret) throw a raw
// node:crypto TypeError — "Invalid initialization vector" / "Invalid authentication tag length: N"
// — for an iv/authTag of the wrong BYTE LENGTH, and they do so OUTSIDE decryptSecret's own try
// block, so that TypeError used to escape uncaught instead of becoming a DecryptionFailedError like
// every other malformed-input case here. That defeats the whole point of this module's typed-error
// contract (this file's header comment: "a corrupted DB row fails the same loud way... rather than
// crashing deeper inside node:crypto with a less legible error") for the specific case of a
// malformed-but-3-segment stored value (`decryptSecret("a:b:c")`, `decryptSecret("AAAA:BBBB:CCCC")`
// — see tests/diffusion-crypto.test.ts). Validating both lengths HERE, before either byte buffer
// ever reaches node:crypto, closes that gap at the one place both decryptSecret call sites
// (encryptSecret never calls deserialize) share.
function deserialize(stored: string): { iv: Buffer; authTag: Buffer; ciphertext: Buffer } {
  const parts = stored.split(":");
  if (parts.length !== 3) throw new DecryptionFailedError("format de secret chiffré invalide.");
  const [ivB64, tagB64, dataB64] = parts;
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(tagB64, "base64");
  const ciphertext = Buffer.from(dataB64, "base64");
  if (iv.length !== IV_BYTES) {
    throw new DecryptionFailedError(`taille d'IV invalide (${IV_BYTES} octets attendus, ${iv.length} reçus) — donnée altérée ou format invalide.`);
  }
  if (authTag.length !== AUTH_TAG_BYTES) {
    throw new DecryptionFailedError(`taille d'empreinte d'authentification invalide (${AUTH_TAG_BYTES} octets attendus, ${authTag.length} reçus) — donnée altérée ou format invalide.`);
  }
  return { iv, authTag, ciphertext };
}

// Encrypts `plain` under CREDENTIALS_ENCRYPTION_KEY with a FRESH random IV every call — this is
// what makes two encryptions of the same plaintext produce different output (see
// tests/diffusion-crypto.test.ts): a fixed/reused IV under GCM is the classic catastrophic failure
// (it lets an attacker XOR two ciphertexts to cancel the keystream and recover the XOR of the two
// plaintexts, and breaks GCM's authentication guarantee entirely). The auth tag is appended to the
// returned string, not just discarded — decryptSecret verifies it on every call.
export function encryptSecret(plain: string): string {
  const cfg = getCryptoConfig();
  if (!cfg) throw new CredentialsNotConfiguredError();

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, cfg.key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return serialize(iv, authTag, ciphertext);
}

// Decrypts a value produced by encryptSecret. Verifies the auth tag as part of decipher.final() —
// any tampering (a flipped bit anywhere in iv/authTag/ciphertext) makes final() throw, which this
// re-throws as DecryptionFailedError rather than ever returning corrupted plaintext.
export function decryptSecret(stored: string): string {
  const cfg = getCryptoConfig();
  if (!cfg) throw new CredentialsNotConfiguredError();

  const { iv, authTag, ciphertext } = deserialize(stored);
  // createDecipheriv/setAuthTag moved INSIDE the try (review finding, Important 2, belt-and-braces
  // on top of deserialize's own length checks above): both used to sit outside this block and could
  // throw a raw node:crypto TypeError of their own for a malformed iv/authTag — deserialize now
  // rejects those before either buffer gets here, but keeping the two calls inside this try as well
  // means ANY node:crypto exception on this path — not just decipher.final()'s auth-tag mismatch —
  // becomes DecryptionFailedError, matching this file's header comment's promise in full rather
  // than for only the cases anticipated today.
  try {
    const decipher = createDecipheriv(ALGORITHM, cfg.key, iv);
    decipher.setAuthTag(authTag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plain.toString("utf8");
  } catch {
    // node:crypto's own error here is a low-level "Unsupported state or unable to authenticate
    // data" — surface OUR typed error instead, same reasoning as WordPressNotConfiguredError.
    throw new DecryptionFailedError("l'empreinte d'authentification ne correspond pas (donnée altérée ou mauvaise clé).");
  }
}
