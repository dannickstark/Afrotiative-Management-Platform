// Shared SSRF guard for any server-side fetch() driven by a user- or content-supplied URL
// (the WordPress featured-image download in lib/wp/publish.ts, the "test feed" action in
// lib/actions/feed-actions.ts). NON-"use server" plain module: a file-level "use server" module
// may only export async functions, and this is a synchronous predicate used from both a
// "use server" action file and a plain module.
//
// Best-effort only (no DNS-rebinding protection — a hostname that resolves to a private IP only
// at fetch time, after this string-level check passes, is out of scope), but cheap and blocks the
// common cases: non-http(s) schemes, localhost, loopback/link-local, and RFC1918 ranges.
const PRIVATE_HOST_PATTERNS: RegExp[] = [
  /^localhost$/i,
  /^127\./,
  /^0\.0\.0\.0$/,
  /^::1$/,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
];

export function isSafePublicHttpUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, ""); // strip IPv6 [] brackets
  if (PRIVATE_HOST_PATTERNS.some((re) => re.test(host))) return false;
  return true;
}
