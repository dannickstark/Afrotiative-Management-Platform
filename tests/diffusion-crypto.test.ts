import { describe, it, expect, afterEach, beforeEach, beforeAll, afterAll, mock } from "bun:test";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, socialChannelSettings, user } from "@/db";
import {
  getCryptoConfig, encryptSecret, decryptSecret,
  CredentialsNotConfiguredError, DecryptionFailedError,
} from "@/lib/diffusion/crypto";
import {
  getChannelSettings, getAllChannelSettings,
  setChannelCredentialsCore, deleteChannelCredentialsCore, getDecryptedCredentials,
} from "@/lib/diffusion/settings-core";

// Task 1 (D2+D3) — lib/diffusion/crypto.ts. This is the security-sensitive foundation every social
// adapter's credential storage sits on: AES-256-GCM, a random IV per call, the auth tag actually
// verified on decrypt. Self-review focus per the brief: "would this still pass if the behaviour it
// claims to verify were removed?" — the random-IV test compares TWO independent ciphertexts (a
// fixed/reused IV would make them equal), and the tamper test flips a real byte and requires a
// THROW (a decrypt that silently returned corrupted bytes would fail this, not just "look wrong").

const SAVED = process.env.CREDENTIALS_ENCRYPTION_KEY;
function setKey(base64: string | undefined) {
  if (base64 === undefined) delete process.env.CREDENTIALS_ENCRYPTION_KEY;
  else process.env.CREDENTIALS_ENCRYPTION_KEY = base64;
}
afterEach(() => setKey(SAVED));

const VALID_KEY = randomBytes(32).toString("base64");

describe("getCryptoConfig", () => {
  it("returns null when CREDENTIALS_ENCRYPTION_KEY is unset", () => {
    setKey(undefined);
    expect(getCryptoConfig()).toBeNull();
  });

  it("returns null when the key does not decode to exactly 32 bytes", () => {
    setKey(Buffer.from("too short").toString("base64")); // 9 bytes
    expect(getCryptoConfig()).toBeNull();
    setKey(randomBytes(48).toString("base64")); // 48 bytes — also wrong
    expect(getCryptoConfig()).toBeNull();
  });

  it("returns a config with a 32-byte key when CREDENTIALS_ENCRYPTION_KEY is valid", () => {
    setKey(VALID_KEY);
    const cfg = getCryptoConfig();
    expect(cfg).not.toBeNull();
    expect(cfg!.key.length).toBe(32);
  });
});

describe("encryptSecret / decryptSecret — round trip", () => {
  it("decrypts back to the exact original plaintext", () => {
    setKey(VALID_KEY);
    const plain = "EAAG_super_secret_page_token_abc123";
    const stored = encryptSecret(plain);
    expect(decryptSecret(stored)).toBe(plain);
  });

  it("round-trips an empty string and unicode content", () => {
    setKey(VALID_KEY);
    expect(decryptSecret(encryptSecret(""))).toBe("");
    const unicode = "jeton-éàç-日本語-🔑";
    expect(decryptSecret(encryptSecret(unicode))).toBe(unicode);
  });

  it("the stored value never contains the plaintext as a literal substring", () => {
    setKey(VALID_KEY);
    const plain = "MySuperSecretToken";
    const stored = encryptSecret(plain);
    expect(stored).not.toContain(plain);
  });
});

describe("encryptSecret — random IV (D2+D3 brief: 'a fixed IV is the classic AES-GCM catastrophe')", () => {
  it("two encryptions of the SAME plaintext produce DIFFERENT stored values", () => {
    setKey(VALID_KEY);
    const plain = "identical-plaintext-both-times";
    const a = encryptSecret(plain);
    const b = encryptSecret(plain);
    expect(a).not.toBe(b); // would coincidentally still hold even with a fixed IV+deterministic nonce reuse bug in some setups, so...
    // ...also assert the IV component specifically differs (first ':'-delimited segment), which is
    // what actually proves randomness rather than e.g. ciphertext differing for an unrelated reason.
    const ivA = a.split(":")[0];
    const ivB = b.split(":")[0];
    expect(ivA).not.toBe(ivB);
    // Both must still decrypt correctly despite differing — differing IVs are not differing keys.
    expect(decryptSecret(a)).toBe(plain);
    expect(decryptSecret(b)).toBe(plain);
  });
});

describe("decryptSecret — tampered ciphertext fails loudly (auth tag actually verified)", () => {
  it("throws DecryptionFailedError when a ciphertext byte is flipped, rather than returning garbage", () => {
    setKey(VALID_KEY);
    const stored = encryptSecret("un-jeton-valide");
    const [ivB64, tagB64, dataB64] = stored.split(":");
    const bytes = Buffer.from(dataB64, "base64");
    bytes[0] = bytes[0] ^ 0xff; // flip every bit of the first ciphertext byte
    const tampered = `${ivB64}:${tagB64}:${bytes.toString("base64")}`;

    expect(() => decryptSecret(tampered)).toThrow(DecryptionFailedError);
  });

  it("throws when the auth tag itself is tampered with", () => {
    setKey(VALID_KEY);
    const stored = encryptSecret("un-autre-jeton");
    const [ivB64, tagB64, dataB64] = stored.split(":");
    const tagBytes = Buffer.from(tagB64, "base64");
    tagBytes[0] = tagBytes[0] ^ 0xff;
    const tampered = `${ivB64}:${tagBytes.toString("base64")}:${dataB64}`;

    expect(() => decryptSecret(tampered)).toThrow(DecryptionFailedError);
  });

  it("throws (does not decrypt) when a DIFFERENT key than the one used to encrypt is active", () => {
    setKey(VALID_KEY);
    const stored = encryptSecret("secret-sous-cle-a");
    setKey(randomBytes(32).toString("base64")); // a different, equally valid 32-byte key
    expect(() => decryptSecret(stored)).toThrow(DecryptionFailedError);
  });

  it("throws on a malformed stored value (wrong number of segments)", () => {
    setKey(VALID_KEY);
    expect(() => decryptSecret("not-a-valid-stored-secret")).toThrow(DecryptionFailedError);
  });

  // Review finding (Important 2): before the fix, createDecipheriv/setAuthTag sat OUTSIDE
  // decryptSecret's try block, so a stored value with the right number of ':'-delimited segments
  // but the WRONG byte length for its iv/authTag component escaped as a raw node:crypto TypeError
  // ("Invalid initialization vector" / "Invalid authentication tag length: N"), not this module's
  // own DecryptionFailedError — defeating the "fails the same loud way... rather than crashing
  // deeper inside node:crypto" promise this file's header comment makes. Both reproductions below
  // are the reviewer's own verified repro strings.
  it("throws DecryptionFailedError, not a raw node:crypto TypeError, for a 3-segment value with a too-short IV", () => {
    setKey(VALID_KEY);
    expect(() => decryptSecret("a:b:c")).toThrow(DecryptionFailedError);
    try {
      decryptSecret("a:b:c");
      throw new Error("expected decryptSecret to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(DecryptionFailedError);
      expect(e).not.toBeInstanceOf(TypeError);
    }
  });

  it("throws DecryptionFailedError, not a raw node:crypto TypeError, for a 3-segment value with a too-short auth tag", () => {
    setKey(VALID_KEY);
    expect(() => decryptSecret("AAAA:BBBB:CCCC")).toThrow(DecryptionFailedError);
    try {
      decryptSecret("AAAA:BBBB:CCCC");
      throw new Error("expected decryptSecret to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(DecryptionFailedError);
      expect(e).not.toBeInstanceOf(TypeError);
    }
  });
});

describe("no key configured — refuses instead of crashing", () => {
  it("encryptSecret throws CredentialsNotConfiguredError, in French, when CREDENTIALS_ENCRYPTION_KEY is unset", () => {
    setKey(undefined);
    expect(() => encryptSecret("peu importe")).toThrow(CredentialsNotConfiguredError);
    expect(() => encryptSecret("peu importe")).toThrow(/CREDENTIALS_ENCRYPTION_KEY/);
  });

  it("decryptSecret throws CredentialsNotConfiguredError when CREDENTIALS_ENCRYPTION_KEY is unset", () => {
    setKey(VALID_KEY);
    const stored = encryptSecret("valeur");
    setKey(undefined);
    expect(() => decryptSecret(stored)).toThrow(CredentialsNotConfiguredError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// lib/diffusion/settings-core.ts — the credential read/write core built on top of the crypto
// module above. "linkedin" is used as this file's exclusive fixture channel (tests/diffusion-
// settings.test.ts already owns tiktok/facebook/instagram as ITS fixtures — same
// distinct-channels-per-file convention as that file's own comment), deleted in beforeAll/afterAll
// so a failed assertion never leaves a stray row for another suite.
// ─────────────────────────────────────────────────────────────────────────────
const CRED_CHANNEL = "linkedin" as const;

async function deleteCredChannelRow() {
  await db.delete(socialChannelSettings).where(eq(socialChannelSettings.channel, CRED_CHANNEL));
}

describe("settings-core credential storage (Task 1)", () => {
  beforeAll(async () => {
    await deleteCredChannelRow();
  });
  // beforeEach (not just beforeAll) — the file-level `afterEach(() => setKey(SAVED))` registered
  // above runs AFTER this block's own afterEach on every test (root hooks run outermost-last), so
  // a beforeAll-only setKey would leave the key unset again from the SECOND test onward. Setting it
  // fresh before every test sidesteps that hook-ordering trap entirely.
  beforeEach(() => setKey(VALID_KEY));
  afterEach(async () => {
    await deleteCredChannelRow();
  });
  afterAll(async () => {
    await deleteCredChannelRow();
    setKey(SAVED);
  });

  it("setChannelCredentialsCore stores encrypted values and getDecryptedCredentials round-trips the exact plaintext", async () => {
    const res = await setChannelCredentialsCore(CRED_CHANNEL, {
      organizationUrn: "urn:li:organization:12345", accessToken: "sekret-linkedin-token",
    });
    expect(res.ok).toBe(true);

    const decrypted = await getDecryptedCredentials(CRED_CHANNEL);
    expect(decrypted).toEqual({ organizationUrn: "urn:li:organization:12345", accessToken: "sekret-linkedin-token" });
  });

  it("merges a new credential field in without discarding a previously stored one", async () => {
    await setChannelCredentialsCore(CRED_CHANNEL, { organizationUrn: "urn:li:organization:1" });
    await setChannelCredentialsCore(CRED_CHANNEL, { accessToken: "second-token" });

    const decrypted = await getDecryptedCredentials(CRED_CHANNEL);
    expect(decrypted).toEqual({ organizationUrn: "urn:li:organization:1", accessToken: "second-token" });
  });

  it("a field set a second time is OVERWRITTEN, not duplicated/merged as a list", async () => {
    await setChannelCredentialsCore(CRED_CHANNEL, { accessToken: "first-token" });
    await setChannelCredentialsCore(CRED_CHANNEL, { accessToken: "rotated-token" });

    const decrypted = await getDecryptedCredentials(CRED_CHANNEL);
    expect(decrypted).toEqual({ accessToken: "rotated-token" });
  });

  it("credentialsSetAt is null before any credential is ever set, and non-null right after", async () => {
    const before = await getChannelSettings(CRED_CHANNEL);
    expect(before.credentialsSetAt).toBeNull();

    const t0 = Date.now();
    await setChannelCredentialsCore(CRED_CHANNEL, { accessToken: "x" });
    const after = await getChannelSettings(CRED_CHANNEL);
    expect(after.credentialsSetAt).not.toBeNull();
    expect(after.credentialsSetAt!.getTime()).toBeGreaterThanOrEqual(t0);
  });

  // D7 final review, Important 2 ("while you are there") — tokenExpiresAt used to survive a delete,
  // so the settings form kept showing an expiry date for a channel that no longer had any
  // credentials at all. This is the test that would FAIL if that field were dropped from the
  // `.set(...)` again: settings.tokenExpiresAt would still read the ~60-day value the earlier
  // setChannelCredentialsCore call seeded, not null.
  it("deleteChannelCredentialsCore clears every field AND credentialsSetAt AND tokenExpiresAt", async () => {
    await setChannelCredentialsCore(CRED_CHANNEL, { accessToken: "to-delete", organizationUrn: "urn:to-delete" });
    const beforeDelete = await getChannelSettings(CRED_CHANNEL);
    expect(beforeDelete.tokenExpiresAt).not.toBeNull(); // sanity: there IS a date to clear

    const res = await deleteChannelCredentialsCore(CRED_CHANNEL);
    expect(res.ok).toBe(true);

    expect(await getDecryptedCredentials(CRED_CHANNEL)).toBeNull();
    const settings = await getChannelSettings(CRED_CHANNEL);
    expect(settings.credentialsSetAt).toBeNull();
    expect(settings.tokenExpiresAt).toBeNull();
  });

  it("refuses to save when CREDENTIALS_ENCRYPTION_KEY is not configured, in French, and writes NOTHING", async () => {
    setKey(undefined);
    const res = await setChannelCredentialsCore(CRED_CHANNEL, { accessToken: "should-not-be-saved" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/CREDENTIALS_ENCRYPTION_KEY/);

    setKey(VALID_KEY); // restore before reading back, since getDecryptedCredentials also needs a key
    expect(await getDecryptedCredentials(CRED_CHANNEL)).toBeNull();
    expect((await getChannelSettings(CRED_CHANNEL)).credentialsSetAt).toBeNull();
  });

  it("getDecryptedCredentials returns null (not a crash) when the key is later removed after having been set", async () => {
    await setChannelCredentialsCore(CRED_CHANNEL, { accessToken: "whatever" });
    setKey(undefined);
    expect(await getDecryptedCredentials(CRED_CHANNEL)).toBeNull();
  });

  // The secret AT REST, in Postgres — reads the RAW row directly via `db`, bypassing every
  // sanitizing layer settings-core.ts provides (getChannelSettings omits `credentials` outright,
  // which would make this specific check pass VACUOUSLY through that function even if
  // setChannelCredentialsCore stored the plaintext verbatim instead of calling encryptSecret).
  // This is the one test in the file that would catch that exact bug.
  it("the value actually written to social_channel_settings.credentials is NOT the plaintext", async () => {
    const secretToken = "RAW-DB-COLUMN-PLAINTEXT-CHECK-77";
    await setChannelCredentialsCore(CRED_CHANNEL, { accessToken: secretToken });

    const [raw] = await db.select().from(socialChannelSettings).where(eq(socialChannelSettings.channel, CRED_CHANNEL));
    expect(raw.credentials).not.toBeNull();
    expect(JSON.stringify(raw.credentials)).not.toContain(secretToken);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The pair that matters most per the brief: "The realistic failure here is not a broken cipher —
// it is a secret leaking through a query result, a server-action return value, or a log line."
// Both tests below construct a SPECIFIC, easily-greppable secret string and assert it is absent
// from the ENTIRE serialized payload — not just "some field looks masked". Self-review check: each
// would FAIL if the function under test ever put the plaintext back into what it returns.
// ─────────────────────────────────────────────────────────────────────────────
describe("no plaintext ever crosses the settings-query boundary (Task 1 brief)", () => {
  afterEach(async () => {
    await deleteCredChannelRow();
    setKey(VALID_KEY);
  });
  afterAll(async () => {
    await deleteCredChannelRow();
    setKey(SAVED);
  });

  it("getChannelSettings's return value has no `credentials` property at all (encrypted or not)", async () => {
    setKey(VALID_KEY);
    await setChannelCredentialsCore(CRED_CHANNEL, { accessToken: "irrelevant-value" });
    const settings = await getChannelSettings(CRED_CHANNEL);
    expect(Object.prototype.hasOwnProperty.call(settings, "credentials")).toBe(false);
  });

  it("JSON.stringify(getChannelSettings(...)) contains no secret, before or after a credential is set", async () => {
    setKey(VALID_KEY);
    const secretToken = "VERY-SPECIFIC-LINKEDIN-TOKEN-98765";

    const before = await getChannelSettings(CRED_CHANNEL);
    expect(JSON.stringify(before)).not.toContain(secretToken);

    await setChannelCredentialsCore(CRED_CHANNEL, { accessToken: secretToken });
    const after = await getChannelSettings(CRED_CHANNEL);
    expect(JSON.stringify(after)).not.toContain(secretToken);

    // getAllChannelSettings (the /settings/social list page's read) must not leak it either.
    const all = await getAllChannelSettings();
    expect(JSON.stringify(all)).not.toContain(secretToken);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// lib/actions/diffusion-settings-actions.ts's updateChannelCredentials/deleteChannelCredentials —
// the actual guarded Server Action network entry point (every export of a "use server" module is
// an unauthenticated Server Action per lib/actions/taxonomy-actions.ts's own comment). Same
// mock.module recipe as tests/category-color.test.ts: capture the real session/cache exports
// first, mock requireUser to a seeded admin/editor, dynamically import the action module so its
// static imports resolve against the mocks, restore the real exports in afterAll.
// ─────────────────────────────────────────────────────────────────────────────
const { requireUser: realRequireUser, getSession: realGetSession } = await import("@/lib/session");
const { revalidatePath: realRevalidatePath, revalidateTag: realRevalidateTag } = await import("next/cache");

const [seededAdmin] = await db.select({ id: user.id, role: user.role })
  .from(user).where(eq(user.email, "admin@afrotiative.com"));
if (!seededAdmin) throw new Error("Seed manquant : admin@afrotiative.com introuvable (bun run db:seed).");
const FAKE_ADMIN = {
  id: seededAdmin.id, name: "Test Admin", email: "admin@afrotiative.com",
  role: seededAdmin.role, banned: false, image: null,
};

const [seededEditor] = await db.select({ id: user.id, role: user.role })
  .from(user).where(eq(user.email, "editor@afrotiative.com"));
if (!seededEditor) throw new Error("Seed manquant : editor@afrotiative.com introuvable (bun run db:seed).");
const FAKE_EDITOR = {
  id: seededEditor.id, name: "Test Éditeur", email: "editor@afrotiative.com",
  role: seededEditor.role, banned: false, image: null,
};

mock.module("@/lib/session", () => ({ getSession: realGetSession, requireUser: async () => FAKE_ADMIN }));
mock.module("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: realRevalidateTag }));

const { updateChannelCredentials, deleteChannelCredentials } = await import("@/lib/actions/diffusion-settings-actions");

describe("updateChannelCredentials / deleteChannelCredentials (guarded Server Actions) — Task 1", () => {
  // See the previous describe block's comment on why this is beforeEach, not just a one-time setup.
  beforeEach(() => setKey(VALID_KEY));
  afterEach(async () => {
    await deleteCredChannelRow();
  });
  afterAll(async () => {
    mock.module("@/lib/session", () => ({ getSession: realGetSession, requireUser: realRequireUser }));
    mock.module("next/cache", () => ({ revalidatePath: realRevalidatePath, revalidateTag: realRevalidateTag }));
    await deleteCredChannelRow();
  });

  it("the action's OWN return value contains no plaintext, even though the save actually succeeded", async () => {
    setKey(VALID_KEY);
    const secretToken = "ACTION-LEVEL-SECRET-TOKEN-42";

    const res = await updateChannelCredentials(CRED_CHANNEL, { accessToken: secretToken });
    expect(res.ok).toBe(true);
    expect(JSON.stringify(res)).not.toContain(secretToken);

    // Prove the assertion above isn't vacuous (e.g. a silent no-op action would also "not contain
    // the secret") by confirming it was actually persisted, decryptable, under the same key.
    expect(await getDecryptedCredentials(CRED_CHANNEL)).toEqual({ accessToken: secretToken });
  });

  it("refuses an empty credentials patch with a French message (schema-level guard)", async () => {
    const res = await updateChannelCredentials(CRED_CHANNEL, {});
    expect(res.ok).toBe(false);
  });

  it("deleteChannelCredentials clears a previously saved credential via the guarded action", async () => {
    await updateChannelCredentials(CRED_CHANNEL, { accessToken: "to-be-deleted" });
    const res = await deleteChannelCredentials(CRED_CHANNEL);
    expect(res.ok).toBe(true);
    expect(await getDecryptedCredentials(CRED_CHANNEL)).toBeNull();
  });

  it("refuses when CREDENTIALS_ENCRYPTION_KEY is not configured, in French, via the guarded action itself", async () => {
    setKey(undefined);
    const res = await updateChannelCredentials(CRED_CHANNEL, { accessToken: "wont-be-saved" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/CREDENTIALS_ENCRYPTION_KEY/);
  });

  it("an editor (no social:manage) is refused", async () => {
    mock.module("@/lib/session", () => ({ getSession: realGetSession, requireUser: async () => FAKE_EDITOR }));
    try {
      await expect(updateChannelCredentials(CRED_CHANNEL, { accessToken: "x" })).rejects.toThrow();
    } finally {
      mock.module("@/lib/session", () => ({ getSession: realGetSession, requireUser: async () => FAKE_ADMIN }));
    }
  });
});
