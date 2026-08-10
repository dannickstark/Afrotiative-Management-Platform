"use server";
// lib/actions/diffusion-settings-actions.ts — the SOLE guarded gate onto social_channel_settings
// writes. Every export of a "use server" module is a Server Action callable WITHOUT its own
// authentication (see the comment at the top of lib/actions/taxonomy-actions.ts) — that's why the
// raw write (updateChannelSettingsCore) lives in lib/diffusion/settings-core.ts (NOT "use server",
// so it's not itself a network entry point) and why this export starts with requireUser() +
// requirePermission() before delegating to it.
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";
import { socialChannelSettingsSchema, channelCredentialsSchema } from "@/lib/validation";
import {
  updateChannelSettingsCore, type UpdateChannelSettingsPatch, type UpdateChannelSettingsResult,
  setChannelCredentialsCore, deleteChannelCredentialsCore, type SetCredentialsResult,
} from "@/lib/diffusion/settings-core";
import type { Channel } from "@/lib/studio";

// D1 spec §6: only "manage" may write channel settings (admin-only — the editor gets "send" from
// the article page, not this).
export async function updateChannelSettings(
  channel: Channel,
  patch: UpdateChannelSettingsPatch,
): Promise<UpdateChannelSettingsResult> {
  const user = await requireUser();
  requirePermission(user.role, "social", "manage");

  // safeParse (not parse): the form (components/settings/social-channel-form.tsx) already validates
  // before calling, but a direct/future caller could bypass that — a throwing parse() would leak
  // the raw ZodError JSON into the form's error <p> + toast. Surface a clean French message instead
  // (D1 final review, Important 4 — same reasoning as updatePipelineSettings,
  // lib/actions/pipeline-settings-actions.ts).
  const parsed = socialChannelSettingsSchema.safeParse(patch);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "Réglages invalides." };
  }

  const res = await updateChannelSettingsCore(channel, parsed.data);
  if (res.ok) {
    revalidatePath("/settings/social");
    revalidatePath(`/settings/social/${channel}`);
  }
  return res;
}

// Task 1 (D2+D3) — the write-only credential save. `values` is a channel-specific map (Facebook's
// page id + token, Instagram's IG user id, a future LinkedIn's org URN — see
// lib/diffusion/settings-core.ts's own comment on why field names live in each adapter, not here)
// that this action never returns: SetCredentialsResult's `settings` is the sanitized
// SocialChannelSettings type (lib/diffusion/settings-core.ts), which physically cannot carry the
// encrypted blob, let alone plaintext — see that module's comment on why the TYPE itself has no
// ciphertext-shaped hole to leak through, not just caller discipline. Admin-only, same guard as
// updateChannelSettings above (D1 spec §6: only "manage" writes channel settings).
export async function updateChannelCredentials(
  channel: Channel,
  values: Record<string, string>,
): Promise<SetCredentialsResult> {
  const user = await requireUser();
  requirePermission(user.role, "social", "manage");

  const parsed = channelCredentialsSchema.safeParse(values);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "Identifiants invalides." };
  }

  const res = await setChannelCredentialsCore(channel, parsed.data);
  if (res.ok) {
    revalidatePath("/settings/social");
    revalidatePath(`/settings/social/${channel}`);
  }
  return res;
}

// The brief's "Supprimer" action — clears every credential field stored for `channel`.
export async function deleteChannelCredentials(channel: Channel): Promise<SetCredentialsResult> {
  const user = await requireUser();
  requirePermission(user.role, "social", "manage");

  const res = await deleteChannelCredentialsCore(channel);
  if (res.ok) {
    revalidatePath("/settings/social");
    revalidatePath(`/settings/social/${channel}`);
  }
  return res;
}
