// lib/diffusion/settings-core.ts — the read + write core for social_channel_settings. NOT a
// "use server" module (same split as lib/studio/template-core.ts): every export of a "use server"
// module is an unauthenticated Server Action (lib/actions/taxonomy-actions.ts:5-11), so the raw
// writer (updateChannelSettingsCore) lives here and is only reachable, guarded, through
// lib/actions/diffusion-settings-actions.ts's updateChannelSettings. getChannelSettings is a plain
// read — like getPipelineSettings/getFeeds/getTaxonomy (lib/queries/settings.ts), it carries no
// RBAC check of its own; access is gated at the page/layout level, not per query function.
import { db, socialChannelSettings } from "@/db";
import { eq } from "drizzle-orm";
import { SOCIAL_CHANNELS } from "./channels";
import type { Channel } from "@/lib/studio";

export type SocialChannelSettings = typeof socialChannelSettings.$inferSelect;

// D1's placeholder baseline for a channel's settings row before an admin has ever visited
// /settings/social/[channel] (D1 Lot 3). captionMaxChars is ALWAYS derived from that channel's own
// registry entry (captionLimits.default), never a fixed literal — a different channel gets a
// different starting cap. The auto-send fields start OFF/conservative: D1 does not ship the
// scheduler itself (Lot 4), so a channel nobody has configured must never silently auto-post.
// `enabled` starts ON, by contrast: D1's whole point is that the socle — registry, StubChannel,
// and (once Lot 2 ships) the Diffusion panel — is verifiable end to end with zero real adapters. A
// channel an operator has never visited must still be usable manually from the article page the
// moment the panel lands, not silently hidden behind an unvisited settings page.
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

// Returns the settings row for `channel`, creating it lazily (from defaultsFor above) on first
// read. onConflictDoNothing + a re-read handles the race where two callers both find no row and
// both try to create it — same pattern as getPipelineSettings (lib/queries/settings.ts).
export async function getChannelSettings(channel: Channel): Promise<SocialChannelSettings> {
  const [row] = await db.select().from(socialChannelSettings).where(eq(socialChannelSettings.channel, channel));
  if (row) return row;

  const [created] = await db.insert(socialChannelSettings).values(defaultsFor(channel))
    .onConflictDoNothing()
    .returning();
  if (created) return created;

  const [again] = await db.select().from(socialChannelSettings).where(eq(socialChannelSettings.channel, channel));
  return again;
}

// Only the fields an operator can actually change from /settings/social/[channel] (spec §6):
// enabled, the caption cap + prompt override, and the automatic-publish block. `channel` and
// `updatedAt` are never part of a patch — the former is the row's identity, the latter is always
// server-set (below).
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
  await getChannelSettings(channel);

  const [updated] = await db.update(socialChannelSettings)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(socialChannelSettings.channel, channel))
    .returning();

  return { ok: true, settings: updated };
}
