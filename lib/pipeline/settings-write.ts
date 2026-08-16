import { db, pipelineSettings } from "@/db";
import type { PipelineSettingsInput } from "@/lib/validation";

/**
 * Core upsert for the pipeline_settings singleton (row id=1). Extracted from
 * lib/actions/pipeline-settings-actions.ts's updatePipelineSettings so the actual DB write — and in
 * particular the per-field normalization that SP9b Finding 1 fixed (alert-email fields were missing
 * from the upsert `values`, making the Alertes settings group a silent no-op) — is unit-testable
 * WITHOUT a request context. The action itself can't be exercised under `bun test`: it starts with
 * requireUser() → next/headers, unavailable outside a Next.js request (same constraint documented
 * across the suite — tests/feed-actions.test.ts, tests/team-actions.test.ts). Lives in this plain
 * module (not the "use server" action file, which may only export async functions) for the same
 * reason validateFeedInput lives in lib/validation.ts.
 *
 * Takes an ALREADY-validated payload (the action runs pipelineSettingsSchema.safeParse first, then
 * hands the parsed output here); guard + revalidate + scheduler reload stay in the action around it.
 */
export async function persistPipelineSettings(data: PipelineSettingsInput): Promise<void> {
  // Normalize the two free-text/optional fields the same way: trim, and an empty string collapses
  // to NULL (the "unset" state in db/schema.ts) rather than persisting a bare "".
  const scheduleCron = data.scheduleCron?.trim() ? data.scheduleCron.trim() : null;
  const alertEmailRecipients = data.alertEmailRecipients?.trim() ? data.alertEmailRecipients.trim() : null;
  const values = {
    maxItemsPerRun: data.maxItemsPerRun,
    perOperationTimeoutMs: data.perOperationTimeoutMs,
    clusterThreshold: data.clusterThreshold,
    scoreThreshold: data.scoreThreshold,
    autoPublishEnabled: data.autoPublishEnabled,
    autoPublishMinSources: data.autoPublishMinSources,
    webSearchEnabled: data.webSearchEnabled,
    scheduleCron,
    alertEmailEnabled: data.alertEmailEnabled,
    alertEmailRecipients,
    defaultMaxItemAgeHours: data.defaultMaxItemAgeHours ?? null,
    regenerateImageMode: data.regenerateImageMode,
    updatedAt: new Date(),
  };
  await db.insert(pipelineSettings).values({ id: 1, ...values })
    .onConflictDoUpdate({ target: pipelineSettings.id, set: values });
}
