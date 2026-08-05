import { db, alerts } from "@/db";
import { desc, eq } from "drizzle-orm";

// SP9b — read-only queries backing the in-app notifications bell + dashboard banner. Alerts
// themselves are written ONLY by lib/alerts/notify.ts's createAlert() (SP9a); this module never
// inserts/updates — see lib/actions/alert-actions.ts for the mutations (markAlertRead/
// markAllAlertsRead). Both server-only, no RBAC check here — same convention as the rest of
// lib/queries/* (getFeeds, getPipelineSettings, …): the RBAC gate (pipeline:read) lives at the
// action/page call site, not the query itself.

export type Alert = typeof alerts.$inferSelect;

/** Count of currently-unread alerts — feeds the bell's badge. */
export async function getUnreadAlertCount(): Promise<number> {
  return db.$count(alerts, eq(alerts.read, false));
}

/** Most recent alerts (read + unread), newest first — feeds the bell's dropdown list. */
export async function getRecentAlerts(limit = 20): Promise<Alert[]> {
  return db.select().from(alerts).orderBy(desc(alerts.createdAt)).limit(limit);
}

/**
 * Most recent UNREAD alerts, newest first — feeds the dashboard banner's list. Deliberately
 * separate from getRecentAlerts (which returns read+unread for the bell): the banner must show the
 * same unread set that getUnreadAlertCount() counts, so both surfaces agree. Filtering
 * getRecentAlerts()'s top-N to `!read` client-side would diverge from the badge once more than N
 * total alerts exist and some of the recent N are already read (SP9b Finding 2).
 */
export async function getUnreadAlerts(limit = 20): Promise<Alert[]> {
  return db.select().from(alerts).where(eq(alerts.read, false)).orderBy(desc(alerts.createdAt)).limit(limit);
}
