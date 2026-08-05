"use server";
import { db, pipelineSettings } from "@/db";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";
import { pipelineSettingsSchema, type PipelineSettingsInput } from "@/lib/validation";

// pipelineSettingsSchema lives in lib/validation.ts, not here — see the comment there for why (a
// file-level "use server" module may only export async functions).

async function guard() {
  const user = await requireUser();
  requirePermission(user.role, "pipeline", "configure");
  return user;
}

export async function updatePipelineSettings(input: PipelineSettingsInput) {
  await guard();
  const data = pipelineSettingsSchema.parse(input);
  const scheduleCron = data.scheduleCron?.trim() ? data.scheduleCron.trim() : null;
  const values = {
    maxItemsPerRun: data.maxItemsPerRun,
    perOperationTimeoutMs: data.perOperationTimeoutMs,
    clusterThreshold: data.clusterThreshold,
    scoreThreshold: data.scoreThreshold,
    autoPublishEnabled: data.autoPublishEnabled,
    autoPublishMinSources: data.autoPublishMinSources,
    webSearchEnabled: data.webSearchEnabled,
    scheduleCron,
    updatedAt: new Date(),
  };
  await db.insert(pipelineSettings).values({ id: 1, ...values })
    .onConflictDoUpdate({ target: pipelineSettings.id, set: values });
  revalidatePath("/settings/pipeline");
}
