// lib/diffusion/settings-core.ts — the read + write core for social_channel_settings. NOT a
// "use server" module (same split as lib/studio/template-core.ts): every export of a "use server"
// module is an unauthenticated Server Action (lib/actions/taxonomy-actions.ts:5-11), so every raw
// writer here (updateChannelSettingsCore, setChannelCredentialsCore, deleteChannelCredentialsCore)
// is only reachable, guarded, through lib/actions/diffusion-settings-actions.ts. getChannelSettings
// is a plain read — like getPipelineSettings/getFeeds/getTaxonomy (lib/queries/settings.ts), it
// carries no RBAC check of its own; access is gated at the page/layout level, not per query
// function.
import { db, socialChannelSettings } from "@/db";
import { eq } from "drizzle-orm";
import { SOCIAL_CHANNELS } from "./channels";
import { CHANNELS, type Channel } from "@/lib/studio";
import { getCryptoConfig, encryptSecret, decryptSecret } from "./crypto";

// Every column EXCEPT the encrypted `credentials` blob. That blob never needs to leave the server:
// nothing that renders UI or crosses a "use server" Server Action boundary needs the ciphertext
// itself — only whether one is set (`credentialsSetAt`, still on this type) and, server-side only,
// its DECRYPTED value (getDecryptedCredentials, below — a completely separate function, deliberately
// not reachable from anything that returns this type). Omitting the field here means every function
// in this module that returns `SocialChannelSettings` physically strips `credentials` off the row
// before returning it (see omitCredentials) — a caller can't forget to sanitize because there's
// nothing to remember; the type itself has no ciphertext-shaped hole to leak through.
export type SocialChannelSettings = Omit<typeof socialChannelSettings.$inferSelect, "credentials">;

type FullSettingsRow = typeof socialChannelSettings.$inferSelect;

function omitCredentials(row: FullSettingsRow): SocialChannelSettings {
  const { credentials: _credentials, ...rest } = row;
  return rest;
}

// D1's placeholder baseline for a channel's settings row before an admin has ever visited
// /settings/social/[channel] (D1 Lot 3). captionMaxChars is ALWAYS derived from that channel's own
// registry entry (captionLimits.default), never a fixed literal — a different channel gets a
// different starting cap. The auto-send fields start OFF/conservative: D1 does not ship the
// scheduler itself (Lot 4), so a channel nobody has configured must never silently auto-post.
// `enabled` starts ON, by contrast: D1's whole point is that the socle — registry, StubChannel,
// and (once Lot 2 ships) the Diffusion panel — is verifiable end to end with zero real adapters. A
// channel an operator has never visited must still be usable manually from the article page the
// moment the panel lands, not silently hidden behind an unvisited settings page. `credentials` /
// `credentialsSetAt` are left out on purpose (both nullable columns, default NULL) — a fresh
// channel has no credential until Task 1's setChannelCredentialsCore is called.
function defaultsFor(channel: Channel): typeof socialChannelSettings.$inferInsert {
  return {
    channel,
    enabled: true,
    captionMaxChars: SOCIAL_CHANNELS[channel].captionLimits.default,
    captionPrompt: null,
    autoEnabled: false,
    autoIntervalHours: 6,
    autoMaxBacklogDays: 3,
    autoWindowStartHour: 8,
    autoWindowEndHour: 20,
    lastAutoSendAt: null,
  };
}

// Internal: the actual DB read/lazy-create, returning EVERY column, including the encrypted
// `credentials` blob. Not exported — the only code in this file allowed to see the ciphertext is
// the credential-specific functions below (setChannelCredentialsCore, deleteChannelCredentialsCore,
// getDecryptedCredentials). Every other reader goes through getChannelSettings, which strips it.
// onConflictDoNothing + a re-read handles the race where two callers both find no row and both try
// to create it — same pattern as getPipelineSettings (lib/queries/settings.ts).
async function getOrCreateSettingsRow(channel: Channel): Promise<FullSettingsRow> {
  const [row] = await db.select().from(socialChannelSettings).where(eq(socialChannelSettings.channel, channel));
  if (row) return row;

  const [created] = await db.insert(socialChannelSettings).values(defaultsFor(channel))
    .onConflictDoNothing()
    .returning();
  if (created) return created;

  const [again] = await db.select().from(socialChannelSettings).where(eq(socialChannelSettings.channel, channel));
  return again;
}

// Returns the settings row for `channel`, creating it lazily on first read. NEVER includes the
// encrypted `credentials` blob (see SocialChannelSettings/omitCredentials above) — this is what
// Server Components pass as props to Client Components (e.g.
// app/(app)/settings/social/[channel]/page.tsx → SocialChannelForm) and what
// updateChannelSettingsCore below returns to the guarded Server Action, so it must be safe to ship
// to the browser by construction, not by caller discipline.
export async function getChannelSettings(channel: Channel): Promise<SocialChannelSettings> {
  return omitCredentials(await getOrCreateSettingsRow(channel));
}

// /settings/social (Task 7) lists every channel at once. Returns one row per CHANNELS entry, in
// that same fixed order — the page zips this array back up against CHANNELS itself to recover each
// row's (typed) Channel key, rather than trusting the `channel` column's own type (plain `text` in
// the DB, see db/schema.ts's comment on socialChannelSettings.channel — so drizzle infers it as
// `string`, not the Channel union). Lazily creates any row that doesn't exist yet, same as a single
// getChannelSettings call — an admin opening the list for the very first time must see all five
// channels, not just whichever ones happen to already have a settings row.
export async function getAllChannelSettings(): Promise<SocialChannelSettings[]> {
  return Promise.all(CHANNELS.map((channel) => getChannelSettings(channel)));
}

// Only the fields an operator can actually change from /settings/social/[channel] (spec §6):
// enabled, the caption cap + prompt override, and the automatic-publish block. `channel` and
// `updatedAt` are never part of a patch — the former is the row's identity, the latter is always
// server-set (below). Credentials are a SEPARATE write path (setChannelCredentialsCore /
// deleteChannelCredentialsCore) — deliberately excluded here so this patch can never accidentally
// carry a plaintext secret through a code path that wasn't built to encrypt it.
export type UpdateChannelSettingsPatch = Partial<Pick<
  SocialChannelSettings,
  | "enabled" | "captionMaxChars" | "captionPrompt"
  | "autoEnabled" | "autoIntervalHours" | "autoMaxBacklogDays"
  | "autoWindowStartHour" | "autoWindowEndHour"
>>;

export type UpdateChannelSettingsResult =
  | { ok: true; settings: SocialChannelSettings }
  | { ok: false; message: string };

// The actual write, called ONLY from the guarded lib/actions/diffusion-settings-actions.ts
// (requireUser + requirePermission(role, "social", "manage") happen there, before this runs).
//
// captionMaxChars is bounded by that channel's OFFICIAL captionLimits (spec §2: "un réglage ne peut
// pas les dépasser") — out-of-range values are REFUSED with a French message naming the actual
// [min, max] bounds, not silently clamped into range: an operator who asked for 5000 on a channel
// capped at 280 needs to know why their setting didn't take, not have it silently rewritten to 280
// behind their back.
export async function updateChannelSettingsCore(
  channel: Channel,
  patch: UpdateChannelSettingsPatch,
): Promise<UpdateChannelSettingsResult> {
  if (patch.captionMaxChars !== undefined) {
    const { min, max } = SOCIAL_CHANNELS[channel].captionLimits;
    const { label } = SOCIAL_CHANNELS[channel];
    if (patch.captionMaxChars < min || patch.captionMaxChars > max) {
      return {
        ok: false,
        message: `La limite de caractères pour ${label} doit être comprise entre ${min} et ${max}.`,
      };
    }
  }

  // Guarantees the row exists (lazy creation) before the UPDATE below — an UPDATE against a
  // non-existent row would silently affect zero rows instead of erroring, leaving the operator's
  // change with no visible effect.
  await getOrCreateSettingsRow(channel);

  const [updated] = await db.update(socialChannelSettings)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(socialChannelSettings.channel, channel))
    .returning();

  return { ok: true, settings: omitCredentials(updated) };
}

// System-only write, called EXCLUSIVELY by lib/diffusion/scheduler.ts (Task 9) — never reachable
// from the guarded Server Action (UpdateChannelSettingsPatch above deliberately excludes
// lastAutoSendAt: an operator has no field for it on /settings/social/[channel]). Written BEFORE
// sendToChannelCore is even called (spec §5's anti-doublon guarantee): a slow send can then never
// be picked up twice by the following tick, since the very next getChannelSettings() read already
// sees the new value. Guarantees the row exists first (lazy creation) for the same reason
// updateChannelSettingsCore does — an UPDATE against a not-yet-created row would silently affect 0
// rows. Also bumps updatedAt, same convention as every other write in this module.
export async function setLastAutoSendAt(channel: Channel, at: Date): Promise<void> {
  await getOrCreateSettingsRow(channel);
  await db.update(socialChannelSettings)
    .set({ lastAutoSendAt: at, updatedAt: at })
    .where(eq(socialChannelSettings.channel, channel));
}

// ─────────────────────────────────────────────────────────────────────────────
// Task 1 (D2+D3) — encrypted credential storage. `credentials` (db/schema.ts) is a generic
// string→string map; every value stored is encryptSecret's output. Field NAMES are NOT this
// module's business — Task 2+ decide them per adapter (Facebook: "pageId"/"pageAccessToken";
// Instagram: "igUserId", reusing the same "pageAccessToken"; a future LinkedIn:
// "organizationUrn"/"accessToken"). That's exactly what makes adding a new channel's credential
// shape a code change in that channel's adapter, never a migration here.
// ─────────────────────────────────────────────────────────────────────────────

export type SetCredentialsResult =
  | { ok: true; settings: SocialChannelSettings }
  | { ok: false; message: string };

const NO_KEY_MESSAGE =
  "Chiffrement des identifiants non configuré (CREDENTIALS_ENCRYPTION_KEY manquant côté serveur) : " +
  "impossible d'enregistrer un identifiant tant que cette variable n'est pas définie.";

// Encrypts every value in `values` and MERGES them into the channel's existing `credentials` blob —
// a key not present in `values` keeps whatever it was already storing (e.g. rotating just the
// access token without re-submitting the page id). Refuses UP FRONT, before any encryption or DB
// write, when getCryptoConfig() is null: this is the brief's "a missing key must disable the
// feature, not crash" applied to the actual write path, in French, exactly like
// updateChannelSettingsCore's captionMaxChars refusal above.
export async function setChannelCredentialsCore(
  channel: Channel,
  values: Record<string, string>,
): Promise<SetCredentialsResult> {
  if (!getCryptoConfig()) return { ok: false, message: NO_KEY_MESSAGE };

  const current = await getOrCreateSettingsRow(channel);
  const merged: Record<string, string> = { ...(current.credentials ?? {}) };
  for (const [key, value] of Object.entries(values)) merged[key] = encryptSecret(value);

  const [updated] = await db.update(socialChannelSettings)
    .set({ credentials: merged, credentialsSetAt: new Date(), updatedAt: new Date() })
    .where(eq(socialChannelSettings.channel, channel))
    .returning();

  return { ok: true, settings: omitCredentials(updated) };
}

// The brief's "Supprimer" action — clears every stored credential field for `channel` in one shot
// (not a single-field delete: write-only inputs never show which fields are currently set, so a
// full-channel "start over" is the only UI action that's unambiguous to the admin).
export async function deleteChannelCredentialsCore(channel: Channel): Promise<SetCredentialsResult> {
  await getOrCreateSettingsRow(channel);
  const [updated] = await db.update(socialChannelSettings)
    .set({ credentials: null, credentialsSetAt: null, updatedAt: new Date() })
    .where(eq(socialChannelSettings.channel, channel))
    .returning();
  return { ok: true, settings: omitCredentials(updated) };
}

// SERVER-SIDE ONLY. Decrypts and returns `channel`'s actual credential values. The ONLY legitimate
// callers are a channel adapter's own `send()` (Task 2+, e.g. lib/diffusion/meta/facebook.ts
// building its Graph API request) or a free connectivity check (Task 4's testConnection-style
// action) — never a "use server" action's return value, never a Client Component prop, never a log
// line (Global Constraints: "a decrypted secret should exist only inside a server-side send").
//
// Returns null (not a throw) when nothing is stored, AND when the key is entirely MISSING or
// malformed (getCryptoConfig() itself returns null for that case, checked below before decryption
// is ever attempted) — same "unavailable, not a crash" contract as getCryptoConfig() itself.
//
// Correction (final-review finding, Important 1 — this comment previously, incorrectly, said "when
// the key is missing/wrong" here, i.e. implied a WRONG key also just returns null; the reviewer
// judged that inaccuracy the likely root cause of every caller below independently omitting a
// guard for the case this paragraph is about): a well-formed key that is simply the WRONG one
// (rotated without re-entering credentials, or a mixed-key blob from a partial re-save — see
// docs/DEPLOYMENT.md §2's recovery procedure) is NOT caught here. It reaches decryptSecret
// (lib/diffusion/crypto.ts), whose auth-tag check then fails and THROWS DecryptionFailedError —
// this function does not catch it, so it propagates to the caller. Every current caller
// (lib/diffusion/meta/facebook.ts's/instagram.ts's send(), lib/diffusion/meta/connection-test.ts)
// wraps its own call to this function in a try/catch for exactly that reason; a new caller must do
// the same, or call getCryptoConfig() itself first the way this comment used to (wrongly) imply
// getDecryptedCredentials already did for it.
export async function getDecryptedCredentials(channel: Channel): Promise<Record<string, string> | null> {
  const row = await getOrCreateSettingsRow(channel);
  if (!row.credentials) return null;
  if (!getCryptoConfig()) return null;

  const out: Record<string, string> = {};
  for (const [key, ciphertext] of Object.entries(row.credentials)) out[key] = decryptSecret(ciphertext);
  return out;
}
