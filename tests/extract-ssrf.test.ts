import { describe, it, expect, afterEach } from "bun:test";
import { readabilityExtract } from "@/lib/extract/readability";

// Plan 003: readabilityExtract and backfillImages are fed feed-item URLs — content supplied by
// the feed publisher, not operator-vetted. Both must refuse private/link-local/non-http(s) URLs
// BEFORE calling fetch (SSRF guard, lib/url-guard.ts). A call-counting fetch spy proves the guard
// short-circuits before any network call, not just that the function resolves with an empty
// result (same technique as tests/diffusion-channels.test.ts).

describe("readabilityExtract SSRF guard (Plan 003)", () => {
  let realFetch: typeof fetch;
  let calls: number;

  function installSpy() {
    realFetch = globalThis.fetch;
    calls = 0;
    globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
      calls++;
      throw new Error("readabilityExtract appelé fetch() sur une URL non sûre.");
    }) as unknown as typeof fetch;
  }

  afterEach(() => {
    if (realFetch) globalThis.fetch = realFetch;
  });

  it("returns empty for a link-local URL (cloud metadata) without fetching", async () => {
    installSpy();
    const r = await readabilityExtract("http://169.254.169.254/latest/meta-data/");
    expect(r).toEqual({ title: "", text: "", images: [], via: "readability" });
    expect(calls).toBe(0);
  });

  it("returns empty for localhost without fetching", async () => {
    installSpy();
    const r = await readabilityExtract("http://localhost/");
    expect(r.text).toBe("");
    expect(r.images).toEqual([]);
    expect(calls).toBe(0);
  });

  it("returns empty for an RFC1918 private address without fetching", async () => {
    installSpy();
    const r = await readabilityExtract("http://10.0.0.5/internal");
    expect(r.text).toBe("");
    expect(calls).toBe(0);
  });

  it("returns empty for a non-http(s) scheme without fetching", async () => {
    installSpy();
    const r = await readabilityExtract("file:///etc/passwd");
    expect(r.text).toBe("");
    expect(calls).toBe(0);
  });
});
