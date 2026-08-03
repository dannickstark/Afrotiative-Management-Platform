// Maps a Better-Auth client sign-in error (the object returned by
// `signIn.email()` from @/lib/auth-client) to the user-facing French message.
//
// Verified against a live Better-Auth 1.6.25 instance (2026-08-03): the client
// (@better-fetch/fetch) spreads the API's JSON error body onto the error object,
// so `error.code` is "BANNED_USER" for a banned account and
// "INVALID_EMAIL_OR_PASSWORD" for both a wrong password AND an unknown email
// (same code for both → no account-existence leak). We match on `code` only:
// the banned code is confirmed, so a broad message substring match would only
// risk mislabeling unrelated errors as "disabled account".
export function loginErrorMessage(error: { code?: string; message?: string } | null): string {
  if (!error) return "";
  if (error.code === "BANNED_USER") return "Ce compte a été désactivé. Contactez un administrateur.";
  return "Email ou mot de passe incorrect.";
}
