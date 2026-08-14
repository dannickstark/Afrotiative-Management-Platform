import { APICallError } from "ai";

/**
 * Classify an error thrown by the AI SDK / OpenRouter into a small set of
 * buckets the token-pool logic can react to.
 *
 * - "rate_limited": HTTP 429, or a message indicating rate limiting, quota
 *   exhaustion, or no available endpoints — these should trigger token
 *   rotation / backoff.
 * - "auth_failed": HTTP 401/403 — the token itself is bad.
 * - "error": anything else (including non-APICallError throws).
 */
export function classifyOpenRouterError(err: unknown): "rate_limited" | "auth_failed" | "error" {
  const status = APICallError.isInstance(err) ? err.statusCode : (err as any)?.statusCode;
  const msg = String((err as any)?.message ?? err ?? "");

  if (status === 429 || /rate.?limit|quota|exhaust|insufficient|no endpoints/i.test(msg)) {
    return "rate_limited";
  }
  if (status === 401 || status === 403) {
    return "auth_failed";
  }
  return "error";
}
