// ---- SP9a: optional email notification backend (Resend, raw fetch — no SDK dependency) ----
// Used exclusively by lib/alerts/notify.ts's createAlert() to best-effort email a run_failed/
// feed_dark alert when the admin has opted in (pipeline_settings.alertEmailEnabled + non-empty
// alertEmailRecipients) AND RESEND_API_KEY is configured server-side. Off by default and a no-op
// (never throws, never hits the network) whenever the key is absent — exactly like the pipeline's
// other optional providers (lib/search/brave.ts, lib/embeddings/jina.ts).

export type SendEmailInput = { to: string[]; subject: string; html: string };
export type ResendPayload = { from: string; to: string[]; subject: string; html: string };

// PURE — no I/O, no env reads. Maps sendEmail's input plus a resolved `from` address to the exact
// JSON body the Resend API (`POST https://api.resend.com/emails`) expects. Split out from
// sendEmail() specifically so it's unit-testable (tests/resend.test.ts) with no network call and
// no fetch mocking needed.
export function buildResendPayload(input: SendEmailInput & { from: string }): ResendPayload {
  return { from: input.from, to: input.to, subject: input.subject, html: input.html };
}

// Sends one email via Resend. NEVER throws — like every other best-effort pipeline provider, a
// missing key, a non-2xx response, a network error, or a timeout all resolve to `false` rather
// than propagating, since this is called from createAlert() (itself best-effort and never allowed
// to fail a run/feed-read/settings-save). Enforces its OWN key gate (not just relying on the
// caller's) so it's safe to call directly, including from tests.
export async function sendEmail(input: SendEmailInput): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return false;

  try {
    const from = process.env.ALERT_EMAIL_FROM || "alerts@afrotiative.local";
    const payload = buildResendPayload({ ...input, from });
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000), // never let a hung provider stall the caller indefinitely
    });
    if (!res.ok) {
      console.warn(`[email] Resend a répondu ${res.status} — email d'alerte non envoyé.`);
      return false;
    }
    return true;
  } catch (e) {
    console.warn(`[email] envoi de l'email d'alerte échoué : ${(e as Error).message}`);
    return false;
  }
}
