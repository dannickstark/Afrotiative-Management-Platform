export type WpConfig = { baseUrl: string; user: string; appPassword: string; authHeader: string };

export function getWpConfig(): WpConfig | null {
  const baseUrl = process.env.WP_BASE_URL?.replace(/\/$/, "");
  const user = process.env.WP_USER;
  const raw = process.env.WP_APP_PASSWORD;
  if (!baseUrl || !user || !raw) return null;
  const appPassword = raw.replace(/\s/g, ""); // WordPress strips spaces server-side
  const authHeader = "Basic " + Buffer.from(`${user}:${appPassword}`).toString("base64");
  return { baseUrl, user, appPassword, authHeader };
}

export class WordPressNotConfiguredError extends Error {
  constructor() {
    super("WordPress non configuré (WP_BASE_URL/WP_USER/WP_APP_PASSWORD manquants).");
    this.name = "WordPressNotConfiguredError";
  }
}
