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
    const existing = list.find((t) => t.name.toLowerCase() === name.toLowerCase());
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
        "Content-Disposition": `attachment; filename="${filename}"`,
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
