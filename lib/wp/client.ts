import type { WpConfig } from "./config";

export class WordPressError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = "WordPressError";
    this.status = status;
    this.body = body;
  }
}

export type WpTerm = { id: number; name: string };

export type WpPostStatus = "publish" | "draft" | "pending" | "future" | "private";

export type WpPostPayload = {
  title: string;
  content: string;
  excerpt?: string;
  status: WpPostStatus;
  categories?: number[];
  tags?: number[];
  featured_media?: number;
};

export type WpPostResult = { id: number; link: string };

// WordPress returns term names HTML-entity-encoded (e.g. "Bourse &amp; Marchés",
// "Fusions &amp; Acquisitions", curly apostrophe "&#8217;") while our input names — from the
// LLM/DB — are plain UTF-8. Decoding the WP-returned name before the case-insensitive compare
// prevents resolve-or-create from either creating a duplicate term or hitting a `term_exists`
// 400 on the POST. French finance taxonomy triggers this constantly (ampersands, apostrophes,
// accents). Native/no-dependency: covers the named entities WP commonly emits plus generic
// decimal (&#NNN;) and hex (&#xHH;) numeric references.
export function decodeWpEntities(s: string): string {
  return s
    .replace(/&amp;|&#0*38;/gi, "&")
    .replace(/&quot;|&#0*34;/gi, '"')
    .replace(/&#0*39;|&#8217;|&#8216;|&apos;/gi, "'")
    .replace(/&lt;|&#0*60;/gi, "<")
    .replace(/&gt;|&#0*62;/gi, ">")
    .replace(/&#8211;/g, "–")
    .replace(/&#8212;/g, "—")
    .replace(/&hellip;|&#8230;/gi, "…")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

// A filename is interpolated into a quoted Content-Disposition header; a `"` (or CR/LF/other
// control char) in an externally-derived name would break the header or allow header injection.
// Task 2 passes filenames derived from remote content, so sanitize before interpolation: replace
// `"` and `\` with `_`, and strip C0/DEL control characters entirely.
function sanitizeFilename(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/["\\]/g, "_").replace(/[\x00-\x1f\x7f]/g, "");
}

// Thin typed wrapper around the WordPress REST API v2 (wp-json/wp/v2). All requests carry
// the site's Application Password Basic-Auth header; any non-2xx response is surfaced as a
// WordPressError (French message, HTTP status, raw response body) so callers (Tasks 2-5) can
// decide whether to retry, fall back, or report the failure to the user.
export class WordPressClient {
  constructor(private readonly config: WpConfig) {}

  private async req<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.config.baseUrl}/wp-json/wp/v2${path}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), Authorization: this.config.authHeader },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new WordPressError(`Échec de la requête WordPress (${res.status}) sur ${path}.`, res.status, body);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  async getCategories(): Promise<WpTerm[]> {
    return this.req<WpTerm[]>("/categories?per_page=100");
  }

  async getTags(): Promise<WpTerm[]> {
    return this.req<WpTerm[]>("/tags?per_page=100");
  }

  private async resolveOrCreate(kind: "categories" | "tags", name: string): Promise<number> {
    const list = await this.req<WpTerm[]>(`/${kind}?search=${encodeURIComponent(name)}&per_page=100`);
    const target = name.toLowerCase();
    const existing = list.find((t) => decodeWpEntities(t.name).toLowerCase() === target);
    if (existing) return existing.id;
    const created = await this.req<WpTerm>(`/${kind}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    return created.id;
  }

  async resolveOrCreateCategory(name: string): Promise<number> {
    return this.resolveOrCreate("categories", name);
  }

  async resolveOrCreateTag(name: string): Promise<number> {
    return this.resolveOrCreate("tags", name);
  }

  async uploadMedia(
    bytes: Uint8Array | Buffer,
    filename: string,
    mime: string,
  ): Promise<{ id: number; sourceUrl: string }> {
    // Re-wrap into a plain Uint8Array<ArrayBuffer>: TS's DOM lib types fetch's BodyInit against
    // ArrayBufferView<ArrayBuffer> (excluding SharedArrayBuffer-backed views), which the caller's
    // Uint8Array<ArrayBufferLike> | Buffer<ArrayBufferLike> union doesn't structurally satisfy even
    // though both are always ArrayBuffer-backed at runtime here. This copy is cheap for media-sized
    // payloads and sidesteps the generic-TypedArray mismatch without an unsafe cast.
    const body = new Uint8Array(bytes);
    const json = await this.req<{ id: number; source_url: string }>("/media", {
      method: "POST",
      headers: {
        "Content-Disposition": `attachment; filename="${sanitizeFilename(filename)}"`,
        "Content-Type": mime,
      },
      body,
    });
    return { id: json.id, sourceUrl: json.source_url };
  }

  async createPost(payload: WpPostPayload): Promise<WpPostResult> {
    return this.req<WpPostResult>("/posts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  async updatePost(id: number, payload: Partial<WpPostPayload>): Promise<WpPostResult> {
    return this.req<WpPostResult>(`/posts/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  async setPostStatus(id: number, status: "publish" | "draft" | "trash"): Promise<void> {
    if (status === "trash") {
      await this.req(`/posts/${id}`, { method: "DELETE" });
      return;
    }
    await this.req(`/posts/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.req("/users/me?context=edit");
      return true;
    } catch (err) {
      if (err instanceof WordPressError && (err.status === 401 || err.status === 403)) return false;
      throw err;
    }
  }
}
