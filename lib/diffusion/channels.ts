// lib/diffusion/channels.ts — D1 §2's channel registry. Every SocialChannel entry's `send` today
// delegates to StubChannel (./stub-channel.ts): D2 → D6 each replace ONE channel's `send` with a
// real adapter behind this SAME interface, and NOTHING else — key/label/context/format/
// captionLimits stay exactly as defined here.
import { CHANNELS, CHANNEL_LABELS, type Channel, type TemplateContext, type FormatKey } from "@/lib/studio";
import { StubChannel } from "./stub-channel";
import { FacebookChannel } from "./meta/facebook";
import { InstagramChannel } from "./meta/instagram";
import { LinkedInChannel } from "./linkedin/linkedin";

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
  // Task 1 (D2+D3) — which fields /settings/social/[channel]'s credentials card asks the operator
  // for, and under what jsonb key (social_channel_settings.credentials — lib/diffusion/settings-
  // core.ts) each ends up ENCRYPTED. `[]` (WhatsApp, X, TikTok for now) means the
  // channel needs no stored credential yet — the card simply doesn't render. Purely additive
  // metadata, unlike key/label/context/format/captionLimits above: adding a field here (e.g.
  // LinkedIn's future "organizationUrn"/"accessToken") is a one-line code change, never a
  // migration — db/schema.ts's `credentials` column is a generic key→ciphertext map that already
  // accepts any key. Field keys are also the contract a channel's own `send()` reads back via
  // getDecryptedCredentials(channel) (e.g. Task 2's lib/diffusion/meta/facebook.ts expects
  // `credentials.pageId` / `credentials.pageAccessToken`).
  readonly credentialFields: readonly { key: string; label: string }[];
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
//  - linkedin (3,000): confirmed directly against LinkedIn's OWN current Help Center page —
//    https://www.linkedin.com/help/linkedin/answer/a528176 ("Post and share updates") states the
//    character limit for a post is 3,000 characters. The Community Management API's Posts
//    resource (`commentary` field — the one D2→D7's real adapters would write to; scope
//    `w_organization_social` for a Company Page, per LinkedIn's own Posts API docs, which is why
//    D7 needs the same app-review lead time as Meta) enforces this same ceiling server-side (a
//    documented FIELD_LENGTH_TOO_LONG error past it) — no separate, larger API-only limit exists.
// ─────────────────────────────────────────────────────────────────────────────
export const SOCIAL_CHANNELS: Readonly<Record<Channel, SocialChannel>> = {
  facebook: {
    key: "facebook", label: CHANNEL_LABELS.facebook, context: "social_post", format: "fb_link",
    captionLimits: { min: 1, max: 63206, default: 400 },
    // D2's Graph client posts to POST /{page-id}/photos with `access_token` — page id + a Page
    // Access Token are the two things that call needs (plan §Task 2).
    credentialFields: [
      { key: "pageId", label: "Identifiant de la Page Facebook (Page ID)" },
      { key: "pageAccessToken", label: "Jeton d’accès de la Page (Page Access Token)" },
    ],
    // D2 — real adapter (lib/diffusion/meta/facebook.ts). A fresh FacebookChannel per call (no
    // shared GraphClient state to worry about) — same "new X().method(input)" shape StubChannel
    // used, so this swap is the ONLY thing that changed for this channel (this file's own header
    // comment's promise).
    send: (input) => new FacebookChannel().send(input),
  },
  instagram: {
    key: "instagram", label: CHANNEL_LABELS.instagram, context: "social_post", format: "ig_square",
    captionLimits: { min: 1, max: 2200, default: 300 },
    // D3's two-step Graph flow (POST /{ig-user-id}/media then /media_publish) needs the IG user id
    // and "the SAME token" as Facebook (plan §Task 1/§Task 3) — reused here under the identical
    // "pageAccessToken" key so an operator who already saved Facebook's token knows to enter the
    // exact same value here (no automatic cross-channel copy in Task 1's scope).
    credentialFields: [
      { key: "igUserId", label: "Identifiant utilisateur Instagram (IG User ID)" },
      { key: "pageAccessToken", label: "Jeton d’accès (le même que celui de la Page Facebook liée)" },
    ],
    // D3 — real adapter (lib/diffusion/meta/instagram.ts): create container → poll status_code →
    // media_publish. Same "new X().method(input)" swap as Facebook above — nothing else here changed.
    send: (input) => new InstagramChannel().send(input),
  },
  whatsapp: {
    key: "whatsapp", label: CHANNEL_LABELS.whatsapp, context: "social_post", format: "wa_square",
    captionLimits: { min: 1, max: 1024, default: 300 },
    credentialFields: [], // no credential needed — see this file's header comment
    send: (input) => new StubChannel("whatsapp").send(input),
  },
  x: {
    key: "x", label: CHANNEL_LABELS.x, context: "social_post", format: "x_landscape",
    captionLimits: { min: 1, max: 280, default: 260 },
    credentialFields: [], // X is deferred (roadmap "Décisions D2 → D7") — no adapter/credentials yet
    send: (input) => new StubChannel("x").send(input),
  },
  tiktok: {
    key: "tiktok", label: CHANNEL_LABELS.tiktok, context: "social_post",
    // No dedicated "tiktok" FormatKey exists (lib/studio/formats.ts's FORMAT_PRESETS): "story"
    // (1080×1920, 9:16) is the closest fit — its label mentions only Instagram/WhatsApp, but the
    // PRESET is just dimensions, and 9:16 vertical is exactly TikTok's native content shape.
    format: "story",
    captionLimits: { min: 1, max: 2200, default: 300 },
    credentialFields: [], // TikTok is deferred (roadmap "Décisions D2 → D7") — no adapter/credentials yet
    send: (input) => new StubChannel("tiktok").send(input),
  },
  linkedin: {
    key: "linkedin", label: CHANNEL_LABELS.linkedin, context: "social_post", format: "li_link",
    captionLimits: { min: 1, max: 3000, default: 400 },
    // Task 4 (D7) — the real adapter's four-step flow (lib/diffusion/linkedin/linkedin.ts) needs the
    // company Page's organization URN (POST /rest/images's `owner` and /rest/posts's `author`) and
    // an access token (Authorization: Bearer on every LinkedIn call). This is the concrete
    // demonstration of Task 1's brief-set criterion: adding a channel's real fields here is a
    // one-line application-code change, never a migration — db/schema.ts's `credentials` column is
    // already a generic key→ciphertext map.
    credentialFields: [
      { key: "organizationUrn", label: "URN de l'organisation (Page entreprise)" },
      { key: "accessToken", label: "Jeton d'accès" },
    ],
    // D7 — real adapter (lib/diffusion/linkedin/linkedin.ts): download the render → initialize the
    // image upload → PUT the bytes → poll until AVAILABLE → POST the post. Same "new X().method
    // (input)" swap as Facebook/Instagram above — nothing else here changed.
    send: (input) => new LinkedInChannel().send(input),
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
