// lib/diffusion/channels.ts — D1 §2's channel registry. Every SocialChannel entry's `send` today
// delegates to StubChannel (./stub-channel.ts): D2 → D6 each replace ONE channel's `send` with a
// real adapter behind this SAME interface, and NOTHING else — key/label/context/format/
// captionLimits stay exactly as defined here.
import { CHANNELS, type Channel, type TemplateContext, type FormatKey } from "@/lib/studio";
import { StubChannel } from "./stub-channel";

// What a channel's `send` needs to actually publish: the rendered image (studio's public URL —
// the render itself is generated and its renderId frozen onto the distributions row BEFORE `send`
// is ever called, spec §4) and the final caption (already validated/clamped against
// captionLimits — spec §3's "l'IA propose, l'humain dispose"). `articleId` is carried through only
// for adapter-side logging/correlation, not for the adapter to re-fetch article data itself.
export type SendInput = {
  articleId: string;
  imageUrl: string;
  caption: string;
};

// House style (spec §7): channels report failure as data, never throw.
export type SendResult =
  | { ok: true; externalId: string }
  | { ok: false; message: string };

export interface SocialChannel {
  readonly key: Channel;
  readonly label: string; // French
  readonly context: TemplateContext; // always 'social_post' in D1 (spec §2)
  readonly format: FormatKey; // resolves the right render_templates row (lib/studio/resolve.ts)
  // The OFFICIAL platform ceiling — non-negotiable, hard-coded (spec §2). An operator's own
  // social_channel_settings.captionMaxChars is validated against this and can never exceed it
  // (lib/diffusion/settings-core.ts's updateChannelSettingsCore). `default` is D1's own suggested
  // "typical useful caption" starting point (not an official figure) — always <= max, used to seed
  // a channel's settings row on first read (lazy creation, Task 3) and as generateCaption's target
  // length before a channel has been configured.
  readonly captionLimits: { min: number; max: number; default: number };
  send(input: SendInput): Promise<SendResult>;
}

// ─────────────────────────────────────────────────────────────────────────────
// captionLimits sources (researched 2026-08-09 — see the task report for the verification method:
// two confirmed directly against Meta's/TikTok's own current developer docs by fetching the live
// page, the other three cross-checked against multiple independent, long-stable, mutually
// consistent industry sources; none guessed).
//
//  - facebook (63,206): Meta does not currently publish this figure on the live Graph API /photo
//    reference page (checked directly — no character-limit field documented there), but it is the
//    consistently and independently reported Facebook post/message character ceiling across many
//    long-standing industry sources (e.g. Sprout Social's and Hootsuite's character-count guides,
//    typecount.com's 2026 Facebook character-limit page), unchanged for years and reported the
//    same everywhere checked — high confidence despite the lack of a single current official page.
//  - instagram (2,200): long-standing figure from Instagram's own Help Center ("You can add up to
//    2,200 characters to your caption"), corroborated by the Instagram Graph API's own content-
//    publishing behavior and by every independent character-limit tracker checked.
//  - whatsapp (1,024): confirmed directly against Meta's OWN current WhatsApp Cloud API docs —
//    https://developers.facebook.com/docs/whatsapp/cloud-api/messages/image-messages states
//    "Maximum 1024 characters." for the image message `caption` field. D1 sends the studio render
//    as an IMAGE message with a caption (spec §4 — image + légende), so this is the field that
//    applies, not the plain-text `text.body` message type (a different, undocumented-limit field
//    D1 never uses).
//  - x (280): X's own, extremely stable, publicly documented standard post limit (unchanged since
//    doubling from 140 in Nov 2017) — https://help.x.com/en/rules-and-policies/counting-characters.
//    D1 targets the standard tier, not X Premium's extended (25,000-char) posts.
//  - tiktok (2,200): confirmed directly against TikTok's OWN current Content Posting API docs —
//    https://developers.tiktok.com/doc/content-posting-api-reference-direct-post states "The
//    maximum length is 2200 in UTF-16 runes." for the `post_info.title` (caption) field.
// ─────────────────────────────────────────────────────────────────────────────
export const SOCIAL_CHANNELS: Readonly<Record<Channel, SocialChannel>> = {
  facebook: {
    key: "facebook", label: "Facebook", context: "social_post", format: "fb_link",
    captionLimits: { min: 1, max: 63206, default: 400 },
    send: (input) => new StubChannel("facebook").send(input),
  },
  instagram: {
    key: "instagram", label: "Instagram", context: "social_post", format: "ig_square",
    captionLimits: { min: 1, max: 2200, default: 300 },
    send: (input) => new StubChannel("instagram").send(input),
  },
  whatsapp: {
    key: "whatsapp", label: "WhatsApp", context: "social_post", format: "wa_square",
    captionLimits: { min: 1, max: 1024, default: 300 },
    send: (input) => new StubChannel("whatsapp").send(input),
  },
  x: {
    key: "x", label: "X", context: "social_post", format: "x_landscape",
    captionLimits: { min: 1, max: 280, default: 260 },
    send: (input) => new StubChannel("x").send(input),
  },
  tiktok: {
    key: "tiktok", label: "TikTok", context: "social_post",
    // No dedicated "tiktok" FormatKey exists (lib/studio/formats.ts's FORMAT_PRESETS): "story"
    // (1080×1920, 9:16) is the closest fit — its label mentions only Instagram/WhatsApp, but the
    // PRESET is just dimensions, and 9:16 vertical is exactly TikTok's native content shape.
    format: "story",
    captionLimits: { min: 1, max: 2200, default: 300 },
    send: (input) => new StubChannel("tiktok").send(input),
  },
};

// Dev-time completeness guard — fails at IMPORT time, not just under `bun test`, if CHANNELS
// (lib/studio/tokens.ts) ever grows without a matching registry entry here.
for (const key of CHANNELS) {
  if (!SOCIAL_CHANNELS[key]) throw new Error(`Canal social sans entrée de registre : ${key}`);
}

export function getSocialChannel(key: Channel): SocialChannel {
  return SOCIAL_CHANNELS[key];
}
