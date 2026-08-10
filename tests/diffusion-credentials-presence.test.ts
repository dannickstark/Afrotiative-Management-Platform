import { describe, expect, test, beforeAll, afterEach, afterAll } from "bun:test";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, socialChannelSettings } from "@/db";
import {
  hasAllCredentials, getChannelSettings, setChannelCredentialsCore,
  deleteChannelCredentialsCore, updateChannelSettingsCore,
} from "@/lib/diffusion/settings-core";

// This suite exercises real encrypt/decrypt round trips end to end (setChannelCredentialsCore
// actually writes/merges an encrypted blob), so it needs a valid CREDENTIALS_ENCRYPTION_KEY of its
// own — set/restored HERE, file-scoped, rather than in test-setup.ts (which stays deliberately
// minimal: DB creds + auth config only, so no single feature's test needs touch the shared preload
// every suite runs through). Same per-file convention already used by tests/diffusion-crypto.test.ts,
// tests/diffusion-facebook.test.ts, tests/diffusion-instagram.test.ts and tests/diffusion-
// connection-test.test.ts. The M7 "mixed-key blob" test below then swaps in a SECOND valid key
// mid-test and restores this one — exactly the "suite's valid key" the file's own comment refers to.
const SAVED_KEY = process.env.CREDENTIALS_ENCRYPTION_KEY;
beforeAll(() => {
  process.env.CREDENTIALS_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});
afterAll(() => {
  if (SAVED_KEY === undefined) delete process.env.CREDENTIALS_ENCRYPTION_KEY;
  else process.env.CREDENTIALS_ENCRYPTION_KEY = SAVED_KEY;
});

// "facebook" is a real channel with DECLARED credentialFields (pageId/pageAccessToken) — needed
// because several assertions below depend on that exact two-field shape (and on "organizationUrn"
// being a key Facebook does NOT declare); no dedicated non-production fixture channel has any
// credentialFields to test against. tests/diffusion-settings.test.ts, tests/diffusion-facebook.
// test.ts and tests/diffusion-connection-test.test.ts already share "facebook" as a fixture the
// same way, and each cleans up its own row (D7 review, Important 3 — this file must too, not rely
// on a sibling's cleanup or on the shared Neon dev branch happening to be clean). Deleted before
// the suite starts AND after every single test, so no test here ever depends on residue left by a
// previous test in this file (the first test's `credentialKeys` assertion specifically requires a
// row with pageId and NOTHING else) and nothing here outlives this file's own run.
async function deleteFacebookRow() {
  await db.delete(socialChannelSettings).where(eq(socialChannelSettings.channel, "facebook"));
}
beforeAll(deleteFacebookRow);
afterEach(deleteFacebookRow);
afterAll(deleteFacebookRow);

describe("credential presence means ALL declared fields (D2+D3 final review, M6)", () => {
  test("saving only pageId leaves Facebook reported as NOT configured", async () => {
    await setChannelCredentialsCore("facebook", { pageId: "123" });
    const s = await getChannelSettings("facebook");
    expect(s.credentialKeys).toEqual(["pageId"]);          // the key IS reported
    expect(hasAllCredentials("facebook", s)).toBe(false);   // but the channel is not configured
  });

  test("saving both fields reports configured", async () => {
    await setChannelCredentialsCore("facebook", { pageId: "123", pageAccessToken: "tok" });
    const s = await getChannelSettings("facebook");
    expect(hasAllCredentials("facebook", s)).toBe(true);
  });

  test("credentialKeys never leaks a value", async () => {
    await setChannelCredentialsCore("facebook", { pageId: "123", pageAccessToken: "sup3rs3cret" });
    const s = await getChannelSettings("facebook");
    expect(JSON.stringify(s)).not.toContain("sup3rs3cret");
    expect(JSON.stringify(s)).not.toContain("123");
  });

  test("a channel with no declared fields is never 'configured'", async () => {
    const s = await getChannelSettings("x");
    expect(hasAllCredentials("x", s)).toBe(false);
  });
});

describe("a credential write refuses to create a mixed-key blob (M7)", () => {
  test("when the existing blob no longer decrypts, the write is refused in French", async () => {
    // written under the suite's valid key, then the key is swapped for a different valid one
    await setChannelCredentialsCore("facebook", { pageId: "123", pageAccessToken: "tok" });
    const original = process.env.CREDENTIALS_ENCRYPTION_KEY;
    process.env.CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    try {
      const res = await setChannelCredentialsCore("facebook", { pageId: "456" });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.message).toMatch(/déchiffr/i);
        expect(res.message).toMatch(/Supprimer/);   // names the way out
      }
    } finally {
      process.env.CREDENTIALS_ENCRYPTION_KEY = original;
    }
  });
});

describe("credential input validation (M8, M9)", () => {
  test("a key not declared for the channel is refused", async () => {
    const res = await setChannelCredentialsCore("facebook", { organizationUrn: "urn:li:organization:1" });
    expect(res.ok).toBe(false);
  });

  test("an over-long value is refused", async () => {
    const res = await setChannelCredentialsCore("facebook", { pageId: "x".repeat(4097) });
    expect(res.ok).toBe(false);
  });

  test("an unknown channel is refused with a French message, not a TypeError", async () => {
    // @ts-expect-error deliberately bypassing the type to reach the runtime guard
    const res = await setChannelCredentialsCore("not-a-channel", { pageId: "1" });
    expect(res.ok).toBe(false);
  });

  // D7 final review, Important 2 — spec §5 item 4's channel-validity guard landed on
  // setChannelCredentialsCore alone; deleteChannelCredentialsCore and updateChannelSettingsCore
  // reach the exact same getOrCreateSettingsRow → defaultsFor → SOCIAL_CHANNELS[channel].
  // captionLimits.default path on an unknown channel, which throws a raw TypeError — reachable from
  // an unauthenticated "use server" export (deleteChannelCredentials/updateChannelSettings,
  // lib/actions/diffusion-settings-actions.ts) with no validation of its own. Without these two
  // tests, the suite implied coverage of both writers that it did not actually have — only the `set`
  // path was ever exercised here.
  test("deleteChannelCredentialsCore refuses an unknown channel with a French message, not a TypeError", async () => {
    // @ts-expect-error deliberately bypassing the type to reach the runtime guard
    const res = await deleteChannelCredentialsCore("not-a-channel");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toContain("Canal social invalide");
  });

  test("updateChannelSettingsCore refuses an unknown channel with a French message, not a TypeError", async () => {
    // @ts-expect-error deliberately bypassing the type to reach the runtime guard
    const res = await updateChannelSettingsCore("not-a-channel", { enabled: true });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toContain("Canal social invalide");
  });
});
