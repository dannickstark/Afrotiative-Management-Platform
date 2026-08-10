// lib/diffusion/meta/graph-client.ts — Task 2 (D2+D3): a thin, injectable-base-URL wrapper around
// the Meta Graph API, shared by lib/diffusion/meta/facebook.ts and lib/diffusion/meta/instagram.ts.
// Modeled directly on lib/wp/client.ts (WordPressClient): a small typed `req`-style client whose
// base URL is a CONSTRUCTOR parameter, not a hardcoded literal — that single injection point is what
// makes a Bun.serve fake possible in tests/diffusion-facebook.test.ts and
// tests/diffusion-instagram.test.ts, exactly as the brief states ("it is the only reason the
// WordPress adapter is testable today").
//
// Endpoint shapes below (POST /{page-id}/photos response fields, the Graph error envelope's
// message/type/code/error_subcode/fbtrace_id, and code 190 = expired/invalid access token) were
// verified directly against Meta's OWN current developer docs (developers.facebook.com/docs/graph-
// api/reference/page/photos, developers.facebook.com/docs/graph-api/guides/error-handling — fetched
// 2026-08-10), not just recalled from training data — see the task report for exactly what was
// fetched vs. inferred. There is still no Meta app/app review in this environment (task brief), so
// none of this has been exercised against the real API — every test here runs against a Bun.serve
// fake (tests/diffusion-facebook.test.ts, tests/diffusion-instagram.test.ts), never the network.
const DEFAULT_BASE_URL = "https://graph.facebook.com/v26.0"; // current Graph API version as of 2026-08-10 (developers.facebook.com/docs/graph-api/changelog) — Meta's ~2-year deprecation window means this will need bumping periodically; see the task report.
const DEFAULT_TIMEOUT_MS = 20_000; // a hung Graph request must not hang a send() forever — no such guard existed to copy from lib/wp/client.ts, so this is new here.

// Mirrors the Graph API error envelope: `{ error: { message, type, code, error_subcode, fbtrace_id } }`
// (developers.facebook.com/docs/graph-api/guides/error-handling). `code`/`subcode` are what
// facebook.ts/instagram.ts branch on (190 = expired/invalid token) — see mapGraphErrorToFrench in
// each adapter. `graphMessage` is Graph's own human-readable `message`, folded into the thrown
// Error's `.message` too (so a raw `.message` read anywhere still shows something useful) but never
// itself a credential — Graph error bodies do not echo back the access_token.
export class GraphApiError extends Error {
  readonly status: number;
  readonly code: number | undefined;
  readonly subcode: number | undefined;
  readonly graphMessage: string;
  readonly fbtraceId: string | undefined;

  constructor(status: number, body: unknown, rawBody: string) {
    const err = (body && typeof body === "object" ? (body as { error?: Record<string, unknown> }).error : undefined) ?? undefined;
    const graphMessage = (typeof err?.message === "string" && err.message) || rawBody.trim().slice(0, 300) || `HTTP ${status}`;
    super(`Graph API error (${status}): ${graphMessage}`);
    this.name = "GraphApiError";
    this.status = status;
    this.code = typeof err?.code === "number" ? err.code : undefined;
    this.subcode = typeof err?.error_subcode === "number" ? err.error_subcode : undefined;
    this.graphMessage = graphMessage;
    this.fbtraceId = typeof err?.fbtrace_id === "string" ? err.fbtrace_id : undefined;
  }
}

export type GraphClientConfig = {
  // Injectable base URL (e.g. `http://localhost:<port>` in tests) — see this file's header comment.
  // Defaults to the real Graph API host/version in production.
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

// Thin typed wrapper around the Graph API — every request/response shape (which params, which
// response fields) is the CALLER's business (facebook.ts / instagram.ts), same split as
// WordPressClient vs. lib/wp/publish.ts. This class only knows how to serialize a POST/GET, parse a
// JSON response, and turn a non-2xx into a typed GraphApiError.
export class GraphClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(config: GraphClientConfig = {}) {
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  // POST with an application/x-www-form-urlencoded body — the shape every Graph write endpoint used
  // here (photos, media, media_publish) accepts, and the shape shown in Meta's own request examples.
  async post<T = unknown>(path: string, params: Record<string, string>): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    return this.parse<T>(res);
  }

  // GET with query-string params — used for the Instagram container status poll
  // (GET /{ig-container-id}?fields=status_code&access_token=...).
  async get<T = unknown>(path: string, params: Record<string, string>): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const res = await this.fetchImpl(url.toString(), { signal: AbortSignal.timeout(this.timeoutMs) });
    return this.parse<T>(res);
  }

  private async parse<T>(res: Response): Promise<T> {
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined; // non-JSON body (rare, but must not crash the error path below)
    }
    if (!res.ok) throw new GraphApiError(res.status, json, text);
    return (json ?? {}) as T;
  }
}
