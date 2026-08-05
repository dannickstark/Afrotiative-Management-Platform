"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";
import { pipelineSettingsSchema, type PipelineSettingsInput } from "@/lib/validation";
import { persistPipelineSettings } from "@/lib/pipeline/settings-write";

// pipelineSettingsSchema lives in lib/validation.ts, not here — see the comment there for why (a
// file-level "use server" module may only export async functions). The upsert itself lives in
// lib/pipeline/settings-write.ts (persistPipelineSettings) so the actual DB write is unit-testable
// without a request context — see that file's comment.

async function guard() {
  const user = await requireUser();
  requirePermission(user.role, "pipeline", "configure");
  return user;
}

export async function updatePipelineSettings(input: PipelineSettingsInput) {
  await guard();
  // safeParse (not parse): the client already validates before calling, but a direct/future caller
  // could bypass that — a throwing parse() would leak the raw ZodError JSON straight into the form's
  // error <p> + toast. Surface a clean French message instead; the form's catch renders err.message.
  const parsed = pipelineSettingsSchema.safeParse(input);
  if (!parsed.success) throw new Error("Réglages invalides.");
  await persistPipelineSettings(parsed.data);
  revalidatePath("/settings/pipeline");

  // Best-effort: apply a scheduleCron change live in this running process, without a restart.
  // Must never fail the settings save itself — the save already succeeded above.
  try {
    const { reloadSchedule } = await import("@/lib/pipeline/scheduler");
    await reloadSchedule();
  } catch (e) {
    console.error("[scheduler] rechargement après mise à jour des réglages échoué:", e);
  }
}
