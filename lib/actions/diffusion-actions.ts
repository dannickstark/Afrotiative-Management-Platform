"use server";
// lib/actions/diffusion-actions.ts — the ONLY guarded door onto lib/diffusion/send-core.ts's
// sendToChannelCore. Every export of a "use server" module is an unauthenticated Server Action
// (see lib/actions/taxonomy-actions.ts:5-11) — this is why the raw writer lives in a plain module
// (send-core.ts) and why this file's export starts with requireUser() + requirePermission()
// before ever touching it, exactly like lib/actions/studio-actions.ts / diffusion-settings-actions.ts.
//
// The client sends only what it legitimately knows (articleId/channel/caption) — actorId and
// triggeredBy are ALWAYS derived here from the session, never accepted from the caller (Next.js
// Server Actions guide, "Data Security" — take the change, derive identity from the session, never
// trust a client-supplied actor/owner field).
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";
import { sendToChannelCore } from "@/lib/diffusion/send-core";
import { generateCaption, type GenerateCaptionResult } from "@/lib/diffusion/caption";
import { SOCIAL_CHANNELS } from "@/lib/diffusion/channels";
import type { Channel } from "@/lib/studio";

export type SendToChannelActionInput = { articleId: string; channel: Channel; caption: string };
export type SendToChannelActionResult = { ok: boolean; message: string };

// Shapes the rich, DB-flavored sendToChannelCore result down to exactly what the Server Actions
// guide recommends returning to the client: a French message, nothing else — the panel relies on
// revalidatePath's single-round-trip re-render (Next.js "Server Actions and Mutations" guide) for
// the definitive persisted state (status/sentAt/renderId/attempts/lastError), not on this return
// value, so raw DB fields never cross the RPC boundary.
export async function sendToChannel(input: SendToChannelActionInput): Promise<SendToChannelActionResult> {
  const user = await requireUser();
  requirePermission(user.role, "social", "send");

  const res = await sendToChannelCore({
    articleId: input.articleId,
    channel: input.channel,
    caption: input.caption,
    triggeredBy: "manual",
    actorId: user.id,
  });

  // Revalidate on BOTH outcomes — a failure still writes/updates the distributions row (status,
  // attempts, lastError) whenever it got past the render step, and the panel's "Réessayer" state
  // needs to reflect that on the very next render, not just a successful send.
  revalidatePath(`/article/${input.articleId}`);

  if (res.ok) return { ok: true, message: `Diffusé sur ${SOCIAL_CHANNELS[input.channel].label}.` };
  return { ok: false, message: res.message };
}

// Task 6's on-demand "Générer une légende" button — the Diffusion panel calls this instead of
// generating on page load: it costs a model call per channel, and most article views never send
// (Task 6 brief). Guarded on social:send (not social:read, which journalists don't have either):
// generating a caption is only useful in service of a send this same role can actually perform,
// same reasoning as gating the button itself on that permission (computeSendDisabledReason,
// components/article/diffusion-panel.tsx). No DB write, so no revalidatePath — the client sets its
// own caption draft state directly from the return value.
export async function generateCaptionForArticle(input: { articleId: string; channel: Channel }): Promise<GenerateCaptionResult> {
  const user = await requireUser();
  requirePermission(user.role, "social", "send");
  return generateCaption(input);
}
