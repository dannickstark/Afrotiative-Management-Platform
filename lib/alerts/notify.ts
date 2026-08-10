import { db, alerts } from "@/db";
import { getPipelineSettings } from "@/lib/queries/settings";
import { sendEmail } from "@/lib/email/resend";

// ---- SP9a: alert creation + optional email notification ----
// Called from sites deep inside best-effort machinery — lib/pipeline/run.ts's executeRun finalize
// (run_failed), lib/pipeline/feed-health.ts's updateFeedHealth (feed_dark), and (D1 final review,
// Important 2) lib/diffusion/scheduler.ts's tickChannel (diffusion_blocked) — so createAlert must
// NEVER throw: alerting is a side channel reporting on a run/feed-read/diffusion-tick, never part
// of it.

// diffusion_blocked (D1 final review, Important 2): a scheduled send refused BEFORE
// send-core.ts ever wrote a distributions row (render failure, R2 unconfigured, no `social_post`
// template) — without this alert, that candidate would be reselected identically on every future
// due tick with no trace anywhere but a console.error, silently wedging the whole channel.
//
// token_expiring (Task 2, D7 spec §4): a configured channel's tokenExpiresAt (social_channel_
// settings, lib/diffusion/scheduler.ts's warnIfTokenExpiring) is within TOKEN_EXPIRY_WARNING_DAYS.
// Meta and LinkedIn both issue ~60-day credentials with no cheap way to read the real expiry back,
// so this is the only heads-up an operator gets before a send starts failing with 401.
export type AlertType = "run_failed" | "feed_dark" | "diffusion_blocked" | "token_expiring";

export type CreateAlertInput = {
  type: AlertType;
  title: string; // French, short
  detail: string; // French, one-sentence specifics
  entityId?: string | null; // the run or feed id this alert is about
};

// Inserts the alert row, THEN — only if the admin opted in (alertEmailEnabled), at least one
// recipient is configured, AND RESEND_API_KEY is set — best-effort emails it via
// lib/email/resend.ts's sendEmail() (itself already never-throwing). The WHOLE body is wrapped in
// ONE try/catch: any failure (a bad insert, a settings-read blip, an unexpected throw from the
// email step) is logged `[alerts]` and swallowed rather than propagated to the caller.
export async function createAlert(input: CreateAlertInput): Promise<void> {
  try {
    await db.insert(alerts).values({
      type: input.type,
      title: input.title,
      detail: input.detail,
      entityId: input.entityId ?? null,
    });

    const settings = await getPipelineSettings();
    const recipients = (settings.alertEmailRecipients ?? "")
      .split(",").map((s) => s.trim()).filter(Boolean);

    if (settings.alertEmailEnabled && recipients.length > 0 && process.env.RESEND_API_KEY) {
      await sendEmail({
        to: recipients,
        subject: input.title,
        html: `<p>${input.detail}</p>`,
      });
    }
  } catch (e) {
    console.error(`[alerts] échec de création/notification d'alerte (${input.type}) : ${(e as Error).message}`);
  }
}
