// lib/diffusion/channel-availability.ts — client-safe slice of the channel registry.
// `available` (a real `send` adapter exists for the channel — vs. the StubChannel placeholder) is
// the ONE piece of SOCIAL_CHANNELS (lib/diffusion/channels.ts) that a CLIENT component needs:
// diffusion-panel.tsx reads it to decide whether the « Publier » button is offered or refused
// (computeSendDisabledReason). channels.ts itself is server-only — it imports the @/lib/studio
// barrel and, through it, @/db / sharp / @resvg/resvg-js (see the comment in lib/studio/tokens.ts).
// Importing it from a client component pulls pg/sharp/resvg into the browser bundle and breaks
// `next build` (Node builtins fs/net/tls/dns/util-types unresolved in the browser). This module
// imports NOTHING heavy — only the Channel type (erased at build) — so it is safe to import from the
// browser, and BOTH channels.ts (single source of truth for the registry) and the client panel read
// availability from HERE rather than duplicating a Record<Channel, boolean>.
import type { Channel } from "@/lib/studio/tokens";

export const CHANNEL_AVAILABLE: Record<Channel, boolean> = {
  facebook: true,
  instagram: true,
  whatsapp: false, // StubChannel — no real adapter yet (roadmap "Décisions D2 → D7")
  x: false, // StubChannel — deferred
  tiktok: false, // StubChannel — deferred
  linkedin: true,
};
