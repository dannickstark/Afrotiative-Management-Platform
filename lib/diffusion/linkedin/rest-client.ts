// lib/diffusion/linkedin/rest-client.ts — Task 3 (D7): a thin, injectable-base-URL wrapper around
// LinkedIn's REST API. Sibling to lib/diffusion/meta/graph-client.ts (read that file's header first)
// — same shape (constructor-injected baseUrl/fetchImpl so a Bun.serve fake can stand in for it in
// tests, a typed *ApiError, no retry/backoff logic), but three things differ, and they are the whole
// reason this file exists rather than just being GraphClient again (spec §3.1):
//
//  1. Every response is returned as { body, headers, status } — not just the parsed JSON body.
//     POST /rest/posts carries the created post's id in the `x-restli-id` RESPONSE HEADER, not the
//     JSON body (spec §8 risk 3: "headers are easy to lose through a wrapper that only returns
//     parsed JSON"). Task 4's send() reads res.headers.get("x-restli-id"); this client is what makes
//     that header reachable at all.
//  2. putBytes() takes an ABSOLUTE URL, not a path joined to baseUrl. LinkedIn's initializeUpload
//     hands back an `uploadUrl` on a different host (www.linkedin.com/dms-uploads/...) from the API
//     base (api.linkedin.com) — see spec §1's table. It still sends `Authorization: Bearer` on that
//     PUT: LinkedIn's own docs are explicit that image upload (unlike video upload) requires the
//     token on the byte upload itself, not just on initializeUpload.
//  3. Every request — GET, POST, and the putBytes upload — carries two mandatory headers this
//     project's other adapter never needed: `Linkedin-Version: <YYYYMM>` and
//     `X-Restli-Protocol-Version: 2.0.0`. A request LinkedIn can't version-negotiate is rejected
//     outright, so these are not optional the way Graph's are.
//
// The token NEVER goes in a URL (D2+D3 final review's Important 3, carried forward here from the
// start rather than fixed after the fact) — every call sends it as an `Authorization: Bearer`
// header, GET included. One test in tests/diffusion-linkedin.test.ts asserts the request URL never
// contains the token substring.
//
// This module knows nothing about credential storage, the image-upload poll loop, or
// SocialChannel — that is Task 4 (lib/diffusion/linkedin/linkedin.ts). It takes an access token as a
// plain constructor argument and has zero imports from settings-core.ts or @/db, so it is safe to
// import from anywhere, including code that must never touch the DB pool.

// spec §3.5: LinkedIn sunsets API versions on its own schedule (202507 is already sunset per its own
// docs, per this task's brief). A hardcoded version constant is a time bomb that silently breaks
// every publish until someone ships a code change; LINKEDIN_API_VERSION lets an operator restore
// service by editing an env var. This constant is only the fallback when that env var is unset.
const DEFAULT_API_VERSION = "202607";
const DEFAULT_BASE_URL = "https://api.linkedin.com";
const DEFAULT_TIMEOUT_MS = 20_000; // same hang guard as GraphClient — a stuck LinkedIn request must not hang a send() forever.

// Every parsed response, PLUS the raw Headers object — see header comment point 1. `status` is
// exposed too so callers can branch on 201-vs-200 without re-deriving it from other state.
export type LinkedInResponse<T> = { body: T; headers: Headers; status: number };

// Mirrors LinkedIn's error envelope: `{ message, status, serviceErrorCode }` (serviceErrorCode is
// LinkedIn's own code and is not always present in the body, per this task's brief). Never includes
// the access token — LinkedIn error bodies don't echo it back, same guarantee GraphApiError relies on.
export class LinkedInApiError extends Error {
  readonly status: number;
  readonly serviceErrorCode: number | null;

  constructor(status: number, body: unknown, rawBody: string) {
    const b = body && typeof body === "object" ? (body as Record<string, unknown>) : undefined;
    const apiMessage = (typeof b?.message === "string" && b.message) || rawBody.trim().slice(0, 300) || `HTTP ${status}`;
    super(`Erreur API LinkedIn (${status}) : ${apiMessage}`);
    this.name = "LinkedInApiError";
    this.status = status;
    this.serviceErrorCode = typeof b?.serviceErrorCode === "number" ? b.serviceErrorCode : null;
  }
}

export type LinkedInClientConfig = {
  accessToken: string;
  // Injectable base URL (e.g. `http://localhost:<port>` in tests) — the same seam GraphClient and,
  // before it, WordPressClient use to make a Bun.serve fake possible.
  baseUrl?: string;
  // Defaults to LINKEDIN_API_VERSION, then DEFAULT_API_VERSION — see the header comment.
  apiVersion?: string;
  fetchImpl?: typeof fetch;
};

// Thin typed wrapper around LinkedIn's REST API — request/response SHAPES (which fields go in the
// initializeUpload body, the /rest/posts payload, how to read the image status) are the CALLER's
// business (Task 4's linkedin.ts), exactly the same split GraphClient keeps from facebook.ts/
// instagram.ts. This class only knows how to attach the mandatory headers, serialize a GET/POST/PUT,
// and turn a non-2xx into a typed LinkedInApiError.
export class LinkedInClient {
  private readonly accessToken: string;
  private readonly baseUrl: string;
  private readonly apiVersion: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: LinkedInClientConfig) {
    this.accessToken = config.accessToken;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    // `||`, not `??`: .env.example ships LINKEDIN_API_VERSION="" (the codebase-wide convention for
    // "unset" — see WP_BASE_URL/CREDENTIALS_ENCRYPTION_KEY), and an empty Linkedin-Version header
    // would fail every request rather than fall back to DEFAULT_API_VERSION.
    this.apiVersion = config.apiVersion || process.env.LINKEDIN_API_VERSION || DEFAULT_API_VERSION;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  // The three headers every LinkedIn request needs — see header comment point 3. `extra` layers on
  // request-specific headers (Content-Type) without duplicating this base set at each call site.
  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bearer ${this.accessToken}`,
      "Linkedin-Version": this.apiVersion,
      "X-Restli-Protocol-Version": "2.0.0",
      ...extra,
    };
  }

  private buildUrl(path: string, params?: Record<string, string>): string {
    const url = new URL(`${this.baseUrl}${path}`);
    if (params) for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url.toString();
  }

  // GET — used for the image status poll (Task 4). `path` is joined to baseUrl, never an absolute
  // URL (that's putBytes below).
  async get<T = unknown>(path: string, params?: Record<string, string>): Promise<LinkedInResponse<T>> {
    const res = await this.fetchImpl(this.buildUrl(path, params), {
      headers: this.headers(),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    return this.parseJson<T>(res);
  }

  // POST with a JSON body — used for initializeUpload and /rest/posts (Task 4). `params` covers
  // query-string actions like `?action=initializeUpload`, which LinkedIn expresses as a query param
  // rather than part of the body.
  async post<T = unknown>(path: string, body: unknown, params?: Record<string, string>): Promise<LinkedInResponse<T>> {
    const res = await this.fetchImpl(this.buildUrl(path, params), {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    return this.parseJson<T>(res);
  }

  // PUT raw bytes to an ABSOLUTE URL (LinkedIn's uploadUrl, a different host from baseUrl) — see
  // header comment point 2. Still carries the mandatory version headers and the bearer token; the
  // response body is not JSON (LinkedIn's byte-upload PUT returns no useful body on success), so
  // `body` is always `null` here — callers care about `status` and `headers`.
  async putBytes(absoluteUrl: string, bytes: ArrayBuffer, contentType: string): Promise<LinkedInResponse<null>> {
    const res = await this.fetchImpl(absoluteUrl, {
      method: "PUT",
      headers: this.headers({ "Content-Type": contentType }),
      body: bytes,
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) throw new LinkedInApiError(res.status, this.tryParseJson(text), text);
    return { body: null, headers: res.headers, status: res.status };
  }

  private async parseJson<T>(res: Response): Promise<LinkedInResponse<T>> {
    const text = await res.text();
    const json = this.tryParseJson(text);
    if (!res.ok) throw new LinkedInApiError(res.status, json, text);
    return { body: (json ?? {}) as T, headers: res.headers, status: res.status };
  }

  private tryParseJson(text: string): unknown {
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return undefined; // non-JSON body (rare, but must not crash the error path)
    }
  }
}
