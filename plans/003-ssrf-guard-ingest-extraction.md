# Plan 003: Apply the SSRF guard to the RSS ingest extraction fetch path

> **Executor instructions**: Follow step by step; run each verification. STOP conditions halt you. Update this plan's row in `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat d0fd009..HEAD -- lib/extract lib/url-guard.ts` — on any change, re-verify excerpts before proceeding.

## Status
- **Priority**: P0 · **Effort**: S · **Risk**: LOW · **Depends on**: none · **Category**: security
- **Planned at**: commit `d0fd009`, 2026-08-12

## Why this matters

The project already has an SSRF guard, `isSafePublicHttpUrl` (`lib/url-guard.ts:21`), and applies it to
web-search URLs, WordPress featured-image download, the feed-test action, LinkedIn images, and studio
images. The **one** place it's missing is the highest-volume automated fetch: RSS **ingest extraction**.
During a pipeline run, feed-item links (`item.url`, supplied by the feed publisher — content, not
operator-vetted) are fetched directly by `readabilityExtract` and by `backfillImages`. A followed feed
whose item links point at an internal/link-local address (e.g. cloud metadata at `169.254.169.254`, or an
internal service) causes the server to GET that address. It's a blind SSRF (the body is fed to AI, not
returned to the client), but internal reachability is real and cheap to close. The code's own comment
already treats direct fetch as the SSRF-sensitive operation for the `externalOnly` (web-search) path —
this plan extends the same reasoning to feed-item links.

## Current state
- `lib/url-guard.ts:21` — `export function isSafePublicHttpUrl(url: string): boolean` (blocks private/
  link-local/non-http(s)). This is the guard to reuse.
- `lib/extract/readability.ts:27-33`:
  ```ts
  export async function readabilityExtract(url: string): Promise<Extracted> {
    const res = await fetch(url, { headers: { "user-agent": "AfrotiativeBot/1.0" }, signal: AbortSignal.timeout(15000) });
    const html = await res.text();
    return readabilityFromHtml(html, url);
  }
  ```
- `lib/extract/index.ts:88-97` — `backfillImages(url)` does the same raw `fetch(url)` and runs on the
  non-`externalOnly` (feed ingest) path.
- `lib/extract/index.ts:11-18` — the existing comment establishing that direct fetch is the SSRF-sensitive
  path (used to justify skipping it under `externalOnly`).
- Callers on the ingest path: `lib/pipeline/run.ts:389` and `lib/pipeline/stages.ts:413` call
  `extract(m.item.url)` (no `externalOnly`), which can reach `readabilityExtract`/`backfillImages`.

**Convention:** guarded fetches return empty/refuse rather than throwing loudly — see
`lib/studio/images.ts:45` (`if (!guardBypassed && !isSafePublicHttpUrl(url)) …`).

## Commands
| Purpose | Command | Expected |
|---|---|---|
| Typecheck | `bun run typecheck` | no new errors |
| Extract tests | `bun test tests/extract-chain.test.ts tests/extract-images.test.ts` | pass |
| New guard test | `bun test tests/extract-ssrf.test.ts` | pass |
| Pure lane | `bun run test:pure` | pass, includes new file |

## Scope
**In scope:** `lib/extract/readability.ts`, `lib/extract/index.ts` (the `backfillImages` helper),
`tests/extract-ssrf.test.ts` (create), `scripts/test-fast.ts` (register the new test in `PURE_FILES` if it is DB-free).
**Out of scope:** the jina/firecrawl providers (they fetch from their own infra — no SSRF surface), the
`externalOnly` logic (already correct), and the callers in `lib/pipeline`.

## Steps
### Step 1: Guard `readabilityExtract`
At the top of `readabilityExtract` (`lib/extract/readability.ts`), before the `fetch`, return an empty
`Extracted` when the URL is unsafe:
```ts
import { isSafePublicHttpUrl } from "@/lib/url-guard";
// …
export async function readabilityExtract(url: string): Promise<Extracted> {
  if (!isSafePublicHttpUrl(url)) return { title: "", text: "", images: [], via: "readability" };
  const res = await fetch(url, { headers: { "user-agent": "AfrotiativeBot/1.0" }, signal: AbortSignal.timeout(15000) });
  // …unchanged
}
```
(Returning empty — rather than throwing — matches how the extract chain records a failed/empty provider attempt and moves on.)
**Verify**: `bun run typecheck` → no new errors.

### Step 2: Guard `backfillImages`
In `lib/extract/index.ts`, at the top of `backfillImages`, add `if (!isSafePublicHttpUrl(url)) return [];`
(import the guard if not already imported). Add a one-line comment referencing the same SSRF reasoning as the `externalOnly` comment above it.
**Verify**: `bun run typecheck` → no new errors.

### Step 3: Test the guard on the ingest path
Create `tests/extract-ssrf.test.ts` (DB-free → pure lane). It must NOT hit the network. Test the two
functions with an unsafe URL and assert they return empty without fetching. Inject/spy a fetch that
throws if called (mirror the "no network" technique in `tests/diffusion-channels.test.ts`), or simply
assert the empty return for a private URL like `http://169.254.169.254/latest/meta-data/` and
`http://localhost/`:
```ts
import { describe, it, expect } from "bun:test";
import { readabilityExtract } from "@/lib/extract/readability";
describe("readabilityExtract SSRF guard", () => {
  it("returns empty for a link-local URL without fetching", async () => {
    const r = await readabilityExtract("http://169.254.169.254/latest/meta-data/");
    expect(r.text).toBe(""); expect(r.images).toEqual([]);
  });
});
```
Register `"extract-ssrf.test.ts"` in the `PURE_FILES` set in `scripts/test-fast.ts` (keep alphabetical order).
**Verify**: `bun test tests/extract-ssrf.test.ts` → pass; `bun run test:pure 2>&1 | grep -c extract-ssrf` → ≥1.

### Step 4: Regression
**Verify**: `bun test tests/extract-chain.test.ts tests/extract-images.test.ts` → pass; `bun run test:pure` → pass.

## Test plan
- New `tests/extract-ssrf.test.ts`: unsafe URL → empty (no fetch) for `readabilityExtract`; if easily
  reachable, one case for `backfillImages` returning `[]`. Model network-free assertions after
  `tests/diffusion-channels.test.ts`.
- Ensure existing extract tests still pass (guard must not change behavior for normal public URLs).

## Done criteria (ALL)
- [ ] `isSafePublicHttpUrl` is called before the direct `fetch` in both `readabilityExtract` and `backfillImages`
- [ ] `bun test tests/extract-ssrf.test.ts` passes; file registered in `PURE_FILES`
- [ ] `bun test tests/extract-chain.test.ts tests/extract-images.test.ts` → pass
- [ ] `bun run test:pure` and `bun run typecheck` → green (no new errors)
- [ ] Only in-scope files modified
- [ ] `plans/README.md` row 003 → DONE

## STOP conditions
- If `isSafePublicHttpUrl` is async or its signature differs from `(url: string) => boolean`, STOP and report — do not reimplement the guard.
- If a normal public-URL extract test starts failing because the guard rejects it, STOP: the guard may be stricter than expected — report rather than loosening the guard.
