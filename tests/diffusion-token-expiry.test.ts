import { describe, expect, test, beforeAll, afterAll, afterEach } from "bun:test";
import { randomBytes } from "node:crypto";
import { eq, and, inArray } from "drizzle-orm";
import { db, socialChannelSettings, alerts } from "@/db";
import { triggerDiffusionTick } from "@/lib/diffusion/scheduler";
import { getChannelSettings, setChannelCredentialsCore, updateChannelSettingsCore } from "@/lib/diffusion/settings-core";
import { SOCIAL_CHANNELS } from "@/lib/diffusion/channels";
import { CHANNEL_LABELS, type Channel } from "@/lib/studio";

// tests/diffusion-token-expiry.test.ts — Task 2 (D7 spec §4): token-expiry tracking and alerting,
// exercised end to end through the REAL scheduler tick (triggerDiffusionTick) against seeded
// social_channel_settings rows — same overall shape as tests/diffusion-scheduler.test.ts.
//
// TWO deviations from the task brief's literal pseudocode, both forced by things already true and
// guarded elsewhere in this codebase, not a reinterpretation of the feature:
//
// 1. The brief's example seeds "linkedin" as the CONFIGURED channel in every scenario that needs
//    hasAllCredentials(channel, settings) to be true. At the time THIS task (Task 2) shipped,
//    lib/diffusion/channels.ts's SOCIAL_CHANNELS.linkedin.credentialFields was STILL `[]` —
//    LinkedIn's two real fields (organizationUrn/accessToken) were Task 4's job (plan §"Produces"),
//    not this one's — and hasAllCredentials (settings-core.ts) returns false unconditionally
//    whenever declared.length === 0. tests/diffusion-setup-guide.test.ts already guarded this exact
//    fact (its "channels with no credential fields" test asserted that list was EXACTLY
//    ["linkedin","tiktok","whatsapp","x"]), so populating linkedin's credentialFields here to make
//    the brief's literal channel choice work would have broken that unrelated, already-green test
//    outside this task's file list. Every scenario below that needs a GENUINELY configured channel
//    (not vacuously "never configured, so of course nothing alerts") therefore uses "instagram"
//    (real credentialFields: igUserId/pageAccessToken) in place of "linkedin", and keeps "facebook"
//    for the brief's own facebook-based scenario unchanged. The one brief scenario that does NOT
//    depend on hasAllCredentials — "saving credentials defaults tokenExpiresAt to ~60 days out" —
//    keeps "linkedin" exactly as written: at the time, setChannelCredentialsCore accepted any key
//    names for linkedin under lib/validation.ts's validateChannelCredentialFields carve-out for a
//    channel with no declared fields yet.
//
//    Correction (D7 final review, Issue 12): D7 Tasks 4/6 have SINCE given linkedin its own real
//    declared keys (organizationUrn/accessToken) — the paragraph above is now a historical account of
//    why this file's OTHER scenarios use instagram/facebook, not a live fact about linkedin today.
//    The carve-out citation in the last sentence is also stale for the same reason:
//    tests/diffusion-crypto.test.ts's "linkedin" fixture now saves under linkedin's real declared
//    keys, so it no longer exercises that carve-out at all (see lib/validation.ts's own corrected
//    comment). Restructuring this file's channel choices now that linkedin has real fields is out of
//    this fix's scope — the behaviour below is unchanged, only this account of why it looks the way
//    it does was wrong.
//
// 2. The brief's warnIfTokenExpiring sets `entityId: channel` on the alert. alerts.entity_id
//    (db/schema.ts) is a `uuid` column, and a channel key ("linkedin", "facebook", …) is not a
//    UUID — inserting one fails at the DB level (tests/alerts.test.ts's own "a non-uuid string
//    rejects" test exercises exactly this), and createAlert's blanket try/catch (lib/alerts/
//    notify.ts) swallows that failure silently: no row would ever be created, forever, with nothing
//    but a console.error to notice by. The implementation (lib/diffusion/scheduler.ts) instead
//    leaves entityId null and identifies "this channel's alert" by its deterministic `title`
//    ("Jeton {label} bientôt expiré") — see that file's own comment on warnIfTokenExpiring.
//    alertsFor() below matches the same way.
// ─────────────────────────────────────────────────────────────────────────────

const SAVED_KEY = process.env.CREDENTIALS_ENCRYPTION_KEY;
beforeAll(() => {
  process.env.CREDENTIALS_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});
afterAll(() => {
  if (SAVED_KEY === undefined) delete process.env.CREDENTIALS_ENCRYPTION_KEY;
  else process.env.CREDENTIALS_ENCRYPTION_KEY = SAVED_KEY;
});

const TEST_CHANNELS = ["facebook", "instagram", "linkedin"] as const;

function daysFromNow(n: number): Date {
  return new Date(Date.now() + n * 24 * 60 * 60 * 1000);
}

// Deterministic per channel (CHANNEL_LABELS is a fixed 1:1 map) — mirrors lib/diffusion/
// scheduler.ts's own (private) tokenExpiringAlertTitle exactly, since entityId can't carry the
// channel key (deviation 2 above).
function tokenExpiringTitle(channel: Channel): string {
  return `Jeton ${CHANNEL_LABELS[channel]} bientôt expiré`;
}

async function alertsFor(channel: Channel) {
  return db.select().from(alerts)
    .where(and(eq(alerts.type, "token_expiring"), eq(alerts.title, tokenExpiringTitle(channel))));
}

async function deleteChannelSettingsRows() {
  await db.delete(socialChannelSettings).where(inArray(socialChannelSettings.channel, TEST_CHANNELS));
}
async function deleteTokenAlerts() {
  await db.delete(alerts).where(and(
    eq(alerts.type, "token_expiring"),
    inArray(alerts.title, TEST_CHANNELS.map(tokenExpiringTitle)),
  ));
}
async function cleanup() {
  await deleteChannelSettingsRows();
  await deleteTokenAlerts();
}

// Cleaned up in beforeAll AND afterEach AND afterAll (Task 1's review flagged a file that only did
// one of these) — afterEach matters MOST here specifically: the 24h dedup gate (hasRecentTokenAlert,
// scheduler.ts) means a token_expiring row left behind by one test would silently suppress the very
// next test's own alert, turning an unrelated test failure into a false read on THIS feature.
beforeAll(cleanup);
afterEach(cleanup);
afterAll(cleanup);

// Seeds `channel` (must have REAL credentialFields — facebook/instagram today) as fully configured:
// real credential values are actually saved (so hasAllCredentials is genuinely true, not vacuously
// so because the channel has no declared fields at all), then enabled/autoEnabled/tokenExpiresAt are
// applied on top through the SAME guarded write path an admin's own save would use.
async function seedConfiguredChannel(
  channel: Channel,
  overrides: { tokenExpiresAt?: Date | null; autoEnabled?: boolean; enabled?: boolean } = {},
): Promise<void> {
  const fields = SOCIAL_CHANNELS[channel].credentialFields;
  if (fields.length === 0) {
    throw new Error(`seedConfiguredChannel: "${channel}" has no declared credentialFields yet — pick a channel that does (facebook/instagram today).`);
  }
  const values = Object.fromEntries(fields.map((f) => [f.key, `test-${f.key}-${channel}`]));
  const credRes = await setChannelCredentialsCore(channel, values);
  if (!credRes.ok) throw new Error(`seedConfiguredChannel: setChannelCredentialsCore failed: ${credRes.message}`);

  const settingsRes = await updateChannelSettingsCore(channel, {
    enabled: overrides.enabled ?? true,
    autoEnabled: overrides.autoEnabled ?? false,
    ...("tokenExpiresAt" in overrides ? { tokenExpiresAt: overrides.tokenExpiresAt ?? null } : {}),
  });
  if (!settingsRes.ok) throw new Error(`seedConfiguredChannel: updateChannelSettingsCore failed: ${settingsRes.message}`);
}

// Seeds `channel` with NO stored credentials (hasAllCredentials is false) but an explicit
// tokenExpiresAt anyway — proves the "no credentials raises nothing" test is actually exercising the
// hasAllCredentials gate, not just "there was never a date to compare against" (which "instagram"
// having REAL credentialFields makes a meaningful distinction, unlike a channel with none declared).
async function seedChannelWithoutCredentials(
  channel: Channel,
  overrides: { tokenExpiresAt?: Date | null } = {},
): Promise<void> {
  await getChannelSettings(channel); // lazy-create the row (D1 convention) — still credential-free
  const res = await updateChannelSettingsCore(channel, {
    autoEnabled: false,
    ...("tokenExpiresAt" in overrides ? { tokenExpiresAt: overrides.tokenExpiresAt ?? null } : {}),
  });
  if (!res.ok) throw new Error(`seedChannelWithoutCredentials: updateChannelSettingsCore failed: ${res.message}`);
}

describe("token expiry alerting (D7 spec §4)", () => {
  test("a channel whose token expires in 3 days raises exactly one alert", async () => {
    await seedConfiguredChannel("instagram", { tokenExpiresAt: daysFromNow(3), autoEnabled: false });
    await triggerDiffusionTick({ channels: ["instagram"] });
    const rows = await alertsFor("instagram");
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("token_expiring");
    expect(rows[0].detail).toMatch(/Instagram/);
  });

  // The sharpest test in this file: enabled AND autoEnabled are BOTH false — tickChannel itself
  // would return immediately without ever looking at the token, so a passing result here proves the
  // check truly sits in the OUTER loop, before tickChannel, not merely "before the isDue check
  // inside it". Auto-publish is off by default (spec §5's baseline), so this is the common case, not
  // an edge one — a regression that moved this check back inside tickChannel would fail this test
  // while leaving every OTHER test in this file green.
  test("auto-publish OFF still alerts — the common case must not be silent", async () => {
    await seedConfiguredChannel("facebook", { tokenExpiresAt: daysFromNow(2), autoEnabled: false, enabled: false });
    await triggerDiffusionTick({ channels: ["facebook"] });
    expect(await alertsFor("facebook")).toHaveLength(1);
  });

  test("a token expiring in 30 days raises nothing", async () => {
    await seedConfiguredChannel("instagram", { tokenExpiresAt: daysFromNow(30) });
    await triggerDiffusionTick({ channels: ["instagram"] });
    expect(await alertsFor("instagram")).toHaveLength(0);
  });

  test("a channel with no credentials raises nothing", async () => {
    await seedChannelWithoutCredentials("instagram", { tokenExpiresAt: daysFromNow(1) });
    await triggerDiffusionTick({ channels: ["instagram"] });
    expect(await alertsFor("instagram")).toHaveLength(0);
  });

  // At most one alert per channel per 24h (spec §4) — the tick runs every 15 minutes, so without
  // this gate a token sitting inside the warning window for a week would raise ~672 rows, not 1.
  test("two ticks in the same day raise one alert, not two", async () => {
    await seedConfiguredChannel("instagram", { tokenExpiresAt: daysFromNow(1) });
    await triggerDiffusionTick({ channels: ["instagram"] });
    await triggerDiffusionTick({ channels: ["instagram"] });
    expect(await alertsFor("instagram")).toHaveLength(1);
  });

  test("saving credentials defaults tokenExpiresAt to ~60 days out", async () => {
    await setChannelCredentialsCore("linkedin", { organizationUrn: "urn:li:organization:1", accessToken: "tok" });
    const s = await getChannelSettings("linkedin");
    const days = (s.tokenExpiresAt!.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(59);
    expect(days).toBeLessThan(61);
  });

  // D7 final review, Important 1 — the reviewer's own second concrete ordering: an admin fixes a
  // TYPO in organizationUrn (not a token rotation at all) after already having recorded the REAL
  // expiry date. Before the fix, setChannelCredentialsCore reset tokenExpiresAt to "now + 60 days"
  // on EVERY credential write, unconditionally — so this partial, non-token write would have
  // silently discarded the admin-set date. This is the test that would FAIL if that reset were still
  // unconditional: the admin-set date (45 days out) is neither ~60 days out (what the old,
  // unconditional default would produce) nor anywhere close to it, so a regression back to the old
  // behaviour changes the asserted value, it doesn't just weaken an assertion.
  test("a second, partial credential write does not move an admin-set tokenExpiresAt date", async () => {
    // First save — nothing stored yet, so tokenExpiresAt is seeded to the ~60-day default.
    await setChannelCredentialsCore("linkedin", { organizationUrn: "urn:li:organization:typo", accessToken: "tok" });

    // The admin then records the REAL date read off LinkedIn's Token Generator (setup-guide.ts's
    // "Générer le jeton" step / docs/DEPLOYMENT.md §2 point 4) — deliberately NOT ~60 days out, so a
    // silent reset back toward "now + 60 days" is unambiguous.
    const adminSetDate = daysFromNow(45);
    const correctionRes = await updateChannelSettingsCore("linkedin", { tokenExpiresAt: adminSetDate });
    if (!correctionRes.ok) throw new Error(`updateChannelSettingsCore failed: ${correctionRes.message}`);

    // A LATER write that only fixes a typo'd organizationUrn — accessToken is not re-submitted, so
    // this is not a token rotation of any kind, just spec §5's ordinary "rotate one field" path.
    const fixRes = await setChannelCredentialsCore("linkedin", { organizationUrn: "urn:li:organization:corrige" });
    if (!fixRes.ok) throw new Error(`setChannelCredentialsCore failed: ${fixRes.message}`);

    const s = await getChannelSettings("linkedin");
    expect(s.tokenExpiresAt!.getTime()).toBe(adminSetDate.getTime()); // untouched by the typo fix
    const days = (s.tokenExpiresAt!.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(44);
    expect(days).toBeLessThan(46); // nowhere near the ~60-day default the old, unconditional reset would have produced
  });
});
