"use server";
import { db, alerts } from "@/db";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";

// SP9b — mutations for the in-app notifications surface (bell + dashboard banner). Alerts are a
// GLOBAL read-state (small team, no per-user tracking, per the SP9 plan) — "read" means "someone
// on the team has seen/dismissed it", not "this specific user has". Gated on pipeline:read (same
// permission as the read-only queries in lib/queries/alerts.ts and the rest of the
// pipeline-observability surface — lib/actions/pipeline-actions.ts's getRunDetailAction/
// getActiveRunAction) rather than pipeline:configure: viewing/dismissing alerts is not a
// configuration action, and every role that can already see /runs or /settings/feeds (editor,
// admin) should be able to clear them too.
//
// Both are best-effort: a failed update must never surface as a hard crash from what is, at
// worst, a "the badge didn't clear" cosmetic miss — mirrors createAlert's own best-effort
// philosophy (lib/alerts/notify.ts) and e.g. reprocessRawItem's isolated swallow-catch around its
// observability insert (lib/actions/pipeline-actions.ts).

async function guard() {
  const user = await requireUser();
  requirePermission(user.role, "pipeline", "read");
  return user;
}

// The three surfaces that read alert state: the bell (embedded in the (app) layout, so present on
// every one of these), the dashboard banner, and the run/feed pages the bell's items link to.
function revalidateAlertSurfaces() {
  revalidatePath("/dashboard");
  revalidatePath("/runs");
  revalidatePath("/settings/feeds");
}

export async function markAlertRead(id: string): Promise<void> {
  await guard();
  try {
    await db.update(alerts).set({ read: true }).where(eq(alerts.id, id));
  } catch (e) {
    console.error(`[alerts] échec du marquage comme lu (${id}) :`, e);
  }
  revalidateAlertSurfaces();
}

export async function markAllAlertsRead(): Promise<void> {
  await guard();
  try {
    await db.update(alerts).set({ read: true }).where(eq(alerts.read, false));
  } catch (e) {
    console.error("[alerts] échec du marquage global comme lu :", e);
  }
  revalidateAlertSurfaces();
}
