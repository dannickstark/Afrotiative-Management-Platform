# Afrotiative SP5 — WordPress Publishing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the loop — when an editor approves an article (or a scheduled article comes due), publish it to WordPress for real: two-step media upload, post create/update with category/tags/featured image/credit + sources footer, idempotent via the stored post id, with dépublier/republier and a secured scheduled-publish cron.

**Architecture:** A typed `WordPressClient` (raw `fetch`, Basic Auth via Application Password) behind a pluggable `PublishChannel` (`WordPressChannel`), driven by `publishArticle`/`unpublishArticle`/`republishArticle` over the existing `distributions` table. Wires the existing approve/quick-approve stubs to real posts. Human-review gate preserved: nothing publishes without prior human approval; scheduled publish only touches already-`approved` articles.

**Tech Stack:** TypeScript · Bun · Next.js 16 (on Node runtime) · Drizzle/Neon · raw `fetch` (no new deps) · WordPress REST API v2.

## Global Constraints

- **Runtime & toolchain: Bun** (`bun add`/`bun run`/`bun test`). Next runs on the **Node** runtime (SP4 fix — scripts are plain `next …`; Bun stays PM/test/scripts). `.env.local` auto-loaded (+ `test-setup.ts` preload which deletes provider `*_API_KEY` vars; WP tests must set/point at their own fixture creds). Never touch/commit `.env.local`; never `git clean`. Reseed (`bun run db:seed`) after any test/run that mutates rows.
- **UI language French;** publish errors surfaced to humans are French + plain (technical detail logged, not shown raw).
- **Human-review gate (non-negotiable):** publishing happens ONLY via `approveAndPublish`/`quickApprove` (a human clicked approve) or `publishDueArticles` (which publishes ONLY `status='approved'` articles a human already approved+scheduled). No path publishes an unapproved article. An article only becomes `published` AFTER a successful WP post.
- **RBAC:** publish/unpublish/republish = `article:publish` (Editor + Admin), server-enforced + role-gated buttons. The scheduled cron `POST /api/publish/due` = `Authorization: Bearer $PUBLISH_TRIGGER_SECRET` (401 if unset/wrong — never open).
- **Credentials (gitignored `.env.local`):** `WP_BASE_URL`, `WP_USER`, `WP_APP_PASSWORD` (WordPress strips spaces server-side — the client strips them too before base64), `PUBLISH_TRIGGER_SECRET`. `.env.example` documents the names (no secrets). **Not configured (no `WP_BASE_URL`/creds) → every publish returns a clear French "WordPress non configuré" error and the article stays `approved` — never a fake success.**
- **Idempotency:** re-publishing updates the existing WP post (via `distributions.externalId`), never a duplicate.
- **Category/tags resolved by NAME at publish time** (resolve-or-create against WP), NOT via the possibly-stale seeded `wp_categories.wpId` — SP5 is self-contained (does not depend on SP2 taxonomy sync). Optionally backfill the mirror's `wpId` with the real id.
- **Image failure is fail-soft:** publish without `featured_media` + log it, don't block the whole post.
- **DB:** pooled `DATABASE_URL`; additive migrations only (none expected — `distributions` already exists). No jsdom in this path → normal server actions (no dynamic import needed).
- **TDD where logic lives** (client HTTP against a `Bun.serve` fake WP, payload mapping, idempotent create-vs-update, due-article selection, RBAC/bearer guards). Real WP verification is Task 5 (needs `WP_BASE_URL` + creds).

---

## File Structure

```
lib/wp/config.ts        # getWpConfig() → {baseUrl,user,appPassword,authHeader} | null
lib/wp/client.ts        # WordPressClient (fetch): categories/tags resolve-or-create, media upload, post create/update, setStatus, testConnection
lib/wp/channel.ts       # PublishChannel interface + WordPressChannel
lib/wp/publish.ts       # publishArticle / unpublishArticle / republishArticle (map + distributions + article status)
lib/actions/publish-actions.ts   # unpublishArticleAction / republishArticleAction (RBAC) ; publishDueArticles
lib/actions/article-actions.ts   # approveAndPublish → publishArticle (replace stub)
lib/actions/queue-actions.ts     # quickApprove → publishArticle (replace stub)
app/api/publish/due/route.ts     # POST bearer — publish due scheduled articles
components/article/publish-controls.tsx   # Dépublier / Republier (published article)
tests/{wp-client,wp-publish,publish-due}.test.ts
.env.example            # WP_* + PUBLISH_TRIGGER_SECRET names
```

---

## Task 1: WordPress config + typed client

**Files:** Create `lib/wp/config.ts`, `lib/wp/client.ts`; Modify `.env.example`; Test `tests/wp-client.test.ts`

**Interfaces:**
- Produces: `getWpConfig(): { baseUrl, user, appPassword, authHeader } | null` (null when unconfigured); `class WordPressClient` with `getCategories()`, `getTags()`, `resolveOrCreateCategory(name)`, `resolveOrCreateTag(name)`, `uploadMedia(bytes, filename, mime)→{id,sourceUrl}`, `createPost(p)→{id,link}`, `updatePost(id,p)→{id,link}`, `setPostStatus(id, 'publish'|'draft'|'trash')`, `testConnection()→boolean`; `class WordPressError extends Error`.

- [ ] **Step 1: Config**

`lib/wp/config.ts`:
```ts
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
  constructor() { super("WordPress non configuré (WP_BASE_URL/WP_USER/WP_APP_PASSWORD manquants)."); this.name = "WordPressNotConfiguredError"; }
}
```

- [ ] **Step 2: Write the client test first (against a Bun.serve fake WP)**

`tests/wp-client.test.ts` — stand up a tiny `Bun.serve` that emulates the WP REST endpoints the client uses (GET `/wp-json/wp/v2/tags?search=`, POST `/tags`, POST `/media`, POST `/posts`, GET `/users/me`), assert:
```ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { WordPressClient } from "@/lib/wp/client";

let server: any; let base: string; const calls: any[] = [];
beforeAll(() => {
  server = Bun.serve({ port: 0, async fetch(req) {
    const url = new URL(req.url); calls.push({ method: req.method, path: url.pathname, search: url.search });
    if (url.pathname.endsWith("/users/me")) return Response.json({ id: 1, name: "bot" });
    if (url.pathname.endsWith("/tags") && req.method === "GET") return Response.json([]); // none exist
    if (url.pathname.endsWith("/tags") && req.method === "POST") return Response.json({ id: 42, name: "BRVM" });
    if (url.pathname.endsWith("/media") && req.method === "POST") return Response.json({ id: 99, source_url: `${base}/img.jpg` });
    if (url.pathname.endsWith("/posts") && req.method === "POST") return Response.json({ id: 7, link: `${base}/?p=7` });
    return new Response("not found", { status: 404 });
  }});
  base = `http://localhost:${server.port}`;
});
afterAll(() => server.stop(true));

function client() { return new WordPressClient({ baseUrl: base, user: "bot", appPassword: "x", authHeader: "Basic eA==" }); }

describe("WordPressClient", () => {
  it("resolveOrCreateTag creates when absent and returns id", async () => {
    expect(await client().resolveOrCreateTag("BRVM")).toBe(42);
  });
  it("uploadMedia posts binary and returns attachment id", async () => {
    const r = await client().uploadMedia(new Uint8Array([1,2,3]), "img.jpg", "image/jpeg");
    expect(r.id).toBe(99);
  });
  it("createPost returns the new post id", async () => {
    const r = await client().createPost({ title: "T", content: "<p>x</p>", status: "publish", categories: [3], tags: [42], featured_media: 99, excerpt: "e" });
    expect(r.id).toBe(7);
  });
  it("testConnection true on 200", async () => { expect(await client().testConnection()).toBe(true); });
});
```

- [ ] **Step 3: Run → FAIL** — `bun test tests/wp-client.test.ts` (module missing).

- [ ] **Step 4: Implement `lib/wp/client.ts`**

A class taking a `WpConfig`. `private async req(path, init)` sets `Authorization: authHeader`, throws `WordPressError` (French message + status + body) on non-2xx. Methods per the interface:
- `resolveOrCreateTag(name)` / `resolveOrCreateCategory(name)`: GET `?search=<name>&per_page=100`, exact case-insensitive match → its id; else POST `{name}` → id.
- `uploadMedia(bytes, filename, mime)`: POST `/media`, headers `Content-Disposition: attachment; filename="<filename>"`, `Content-Type: <mime>`, body = the bytes (NOT JSON/FormData) → `{id, source_url}`.
- `createPost`/`updatePost`: POST `/posts` (PUT `/posts/{id}`) JSON body → `{id, link}`.
- `setPostStatus(id, status)`: `'trash'` → DELETE `/posts/{id}` (moves to trash); else POST `/posts/{id}` `{status}`.
- `testConnection()`: GET `/users/me?context=edit` → true on 200, false on 401/403.
Provide full code.

- [ ] **Step 5: Run → PASS + typecheck** — `bun test tests/wp-client.test.ts && bun run typecheck`.

- [ ] **Step 6: `.env.example`** — append `WP_BASE_URL=""`, `WP_USER=""`, `WP_APP_PASSWORD=""`, `PUBLISH_TRIGGER_SECRET=""` (empty; comment that publishing is disabled until set).

- [ ] **Step 7: Commit** — `git add -A && git commit -m "feat(wp): typed WordPressClient (media upload, resolve-or-create cat/tags, posts) + config"`

---

## Task 2: Channel + publishArticle / unpublish / republish

**Files:** Create `lib/wp/channel.ts`, `lib/wp/publish.ts`; Test `tests/wp-publish.test.ts`

**Interfaces:**
- Consumes: `WordPressClient`, `getWpConfig`, `db` (`articles, articleSources, articleTags, wpCategories, wpTags, distributions, articleRevisions`).
- Produces: `publishArticle(articleId): Promise<{ok:boolean; message:string; postId?:number}>`; `unpublishArticle(articleId)`, `republishArticle(articleId)`; `buildPostBody({bodyHtml, sources, imageCredit, imageSourceUrl})` (PURE — assembles the post HTML content with the French Sources footer + image credit) for unit testing; `PublishChannel` + `WordPressChannel`.

- [ ] **Step 1: Pure payload builder test first**

`tests/wp-publish.test.ts` (pure part):
```ts
import { describe, it, expect } from "bun:test";
import { buildPostBody } from "@/lib/wp/publish";

describe("buildPostBody", () => {
  it("appends the sources footer + image credit to the article body", () => {
    const html = buildPostBody({
      bodyHtml: "<p>Corps.</p>",
      sources: [{ mediaName: "Ecofin", url: "https://x/a" }],
      imageCredit: "Financial Afrik", imageSourceUrl: "https://fa/x",
    });
    expect(html).toContain("<p>Corps.</p>");
    expect(html.toLowerCase()).toContain("sources");
    expect(html).toContain("Ecofin");
    expect(html).toContain("Financial Afrik"); // credit present
  });
});
```

- [ ] **Step 2: Implement `lib/wp/publish.ts`**

`buildPostBody({bodyHtml, sources, imageCredit, imageSourceUrl})` → returns `bodyHtml` + a French "Sources" footer (media name linked to url) + an image credit line when present. Then:

`publishArticle(articleId)`:
1. `const cfg = getWpConfig(); if (!cfg) return {ok:false, message:"WordPress non configuré."}`.
2. Load article + category name (via categoryId→wpCategories) + tags + sources + image fields. Validate: category required (`"Choisissez une catégorie avant de publier."`), image credit required if image (`"Le crédit de l'image est obligatoire."`) → return `{ok:false, message}` on violation (article unchanged).
3. `const wp = new WordPressClient(cfg);`
4. Resolve category id by NAME (`wp.resolveOrCreateCategory(categoryName)`); resolve tag ids by name (`wp.resolveOrCreateTag`), collect. (Optionally backfill `wp_categories.wpId`/`wp_tags.wpId` + set `article_tags.is_new=false`.)
5. Featured image (fail-soft): if `featuredImageUrl`, `try { fetch → arrayBuffer + content-type → wp.uploadMedia → mediaId } catch { mediaId=undefined; note image failure }`.
6. Idempotency: look up an existing `distributions` row for (articleId, 'wordpress') with an `externalId`. If found → `wp.updatePost(externalId, payload)`; else `wp.createPost({...payload, status:'publish'})` → postId.
7. `payload` = `{ title, content: buildPostBody(...), excerpt, categories:[catId], tags: tagIds, featured_media: mediaId }`.
8. On success: upsert `distributions` (`status:'sent'`, `externalId: postId`, `at:now`); set article `status:'published'`, `publishedAt:now`; write a revision. Return `{ok:true, message:"Publié sur WordPress.", postId}`.
9. On any WP error: upsert `distributions` `status:'failed'`; article stays `approved` (do NOT flip to published); return `{ok:false, message: <french error>}`.

`unpublishArticle(articleId)`: needs a `distributions.externalId`; `wp.setPostStatus(externalId, 'draft')`; article → `approved`; distribution updated; revision. `republishArticle(articleId)`: `wp.updatePost(externalId, buildPostBody...)`; article stays `published`; revision. Both return `{ok, message}`; French errors; RBAC enforced by the calling actions (Task 3).

`WordPressChannel` implements the `PublishChannel` interface delegating to these.

- [ ] **Step 3: Add an integration test (Bun.serve fake WP) for publishArticle idempotency + fail-soft**

Extend `tests/wp-publish.test.ts`: with a fake WP (`Bun.serve`) + a temp seeded `approved` article (+ category/tags/image url pointing at the fixture), set `WP_BASE_URL`/`WP_USER`/`WP_APP_PASSWORD` to the fixture in-test, call `publishArticle`: assert it created a post, wrote `distributions` `sent`+externalId, and flipped the article to `published`. Call again → asserts it UPDATED (same externalId, no duplicate). Simulate a media 500 → asserts the post still publishes (fail-soft, no `featured_media`). Self-clean (delete temp article/distribution) + reseed. Restore env in afterAll.

- [ ] **Step 4: Run tests + typecheck** — `bun test tests/wp-publish.test.ts && bun run typecheck`. Reseed if mutated.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(wp): publishArticle/unpublish/republish channel — idempotent, fail-soft image, distributions"`

---

## Task 3: Wire the approve/publish actions + editor controls

**Files:** Modify `lib/actions/article-actions.ts`, `lib/actions/queue-actions.ts`; Create `lib/actions/publish-actions.ts`, `components/article/publish-controls.tsx`; Test `tests/wp-publish.test.ts` (guards) + manual (Task 5).

**Interfaces:**
- Produces: `approveAndPublish` + `quickApprove` now call `publishArticle`; `unpublishArticleAction(id)` / `republishArticleAction(id)` (RBAC `article:publish`); `<PublishControls article />` (Dépublier/Republier for a published article).

- [ ] **Step 1: Replace the publish stubs**

In `lib/actions/article-actions.ts` `approveAndPublish` and `lib/actions/queue-actions.ts` `quickApprove`: keep `requireUser()` + `requirePermission(role,"article","publish")` and the field validation, but REPLACE the `distributions:'stubbed'` + immediate `status:'published'` block with `const res = await publishArticle(id);` — if `!res.ok` throw an Error with `res.message` (so the UI toasts the French error and the article stays approved); on success `publishArticle` already set `published` + wrote `distributions:'sent'`. `revalidatePath` as before. (approveAndPublish should first persist the article's approved state / current edits, then publish — keep the existing save-then-approve ordering.)

- [ ] **Step 2: Unpublish/republish actions**

`lib/actions/publish-actions.ts`:
```ts
"use server";
import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";
import { revalidatePath } from "next/cache";
import { unpublishArticle, republishArticle } from "@/lib/wp/publish";

export async function unpublishArticleAction(id: string) {
  const u = await requireUser(); requirePermission(u.role, "article", "publish");
  const res = await unpublishArticle(id);
  revalidatePath(`/article/${id}`); revalidatePath("/queue"); revalidatePath("/published"); revalidatePath("/dashboard");
  return res;
}
export async function republishArticleAction(id: string) {
  const u = await requireUser(); requirePermission(u.role, "article", "publish");
  const res = await republishArticle(id);
  revalidatePath(`/article/${id}`); revalidatePath("/dashboard");
  return res;
}
```

- [ ] **Step 3: Editor publish controls**

`components/article/publish-controls.tsx` (client) — rendered in the editor when `article.status === "published"` (read-only mode), inside `RoleGate allow={["admin","editor"]}`: a **Dépublier** button (ConfirmDialog naming the consequence → `unpublishArticleAction`, toast) and a **Republier** button (→ `republishArticleAction`, toast). Wire into `editor-shell.tsx` where the published read-only state currently shows the "Dépublier/Republier placeholder" (replace the placeholder). French; `startTransition`; toasts.

- [ ] **Step 4: Guard test + typecheck + build**

Add to `tests/wp-publish.test.ts`: `can("editor","article","publish")===true`, `can("journalist","article","publish")===false`. Run `bun test tests/wp-publish.test.ts && bun run typecheck && bun run build`.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(wp): wire approve/quick-approve to real publish + editor dépublier/republier"`

---

## Task 4: Scheduled auto-publish

**Files:** Create `app/api/publish/due/route.ts`; add `publishDueArticles` to `lib/actions/publish-actions.ts`; Test `tests/publish-due.test.ts`

**Interfaces:**
- Produces: `publishDueArticles(): Promise<{published:number; failed:number}>` (publishes `status='approved' AND scheduledAt<=now` via `publishArticle`, per-article try/catch); `POST /api/publish/due` (bearer `PUBLISH_TRIGGER_SECRET`; 401 if unset/wrong).

- [ ] **Step 1: Due-selection test first**

`tests/publish-due.test.ts` — pure/query test: insert 2 temp articles (one `approved` with `scheduledAt` = 1h ago, one `approved` with `scheduledAt` = 1h future), point WP env at a `Bun.serve` fake, call `publishDueArticles`, assert ONLY the past-due one got published (`published:1`), and a `pending`/future one is untouched. Also assert `can` guard for the route is bearer-based (the route test can assert 401 without secret). Self-clean + reseed. (Confirms the human-review gate: never publishes a non-approved article — include a `pending` scheduled row and assert it's NOT published.)

- [ ] **Step 2: Implement `publishDueArticles`**

```ts
export async function publishDueArticles() {
  const { db, articles } = await import("@/db");
  const { and, eq, lte, isNotNull } = await import("drizzle-orm");
  const { publishArticle } = await import("@/lib/wp/publish");
  const due = await db.select({ id: articles.id }).from(articles)
    .where(and(eq(articles.status, "approved"), isNotNull(articles.scheduledAt), lte(articles.scheduledAt, new Date())));
  let published = 0, failed = 0;
  for (const a of due) { try { const r = await publishArticle(a.id); r.ok ? published++ : failed++; } catch { failed++; } }
  return { published, failed };
}
```

- [ ] **Step 3: Route**

`app/api/publish/due/route.ts`:
```ts
import { NextRequest, NextResponse } from "next/server";
import { publishDueArticles } from "@/lib/actions/publish-actions";

export async function POST(req: NextRequest) {
  const secret = process.env.PUBLISH_TRIGGER_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const res = await publishDueArticles();
  return NextResponse.json(res);
}
export const maxDuration = 300;
```

- [ ] **Step 4: Run tests + typecheck + build** — `bun test tests/publish-due.test.ts && bun run typecheck && bun run build`. Reseed if mutated.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(wp): scheduled auto-publish — publishDueArticles + bearer-secured cron route"`

---

## Task 5: End-to-end verification against the real WordPress site

**Files:** none (verification). **Requires `WP_BASE_URL` + valid creds in `.env.local`.**

> If `WP_BASE_URL` is still empty, STOP and report NEEDS_CONTEXT (the site URL) — do NOT invent one; the unit tests (Tasks 1–4) already prove the logic against a fake WP.

- [ ] **Step 1: Green baseline** — `bun run typecheck && bun test && bun run build` all pass.

- [ ] **Step 2: Connection test** — a throwaway `bun -e` calling `new WordPressClient(getWpConfig()!).testConnection()` → true. Report the WP user/roles seen. If 401/403, STOP and report (bad creds / role).

- [ ] **Step 3: Real publish of one seeded article** — pick a seeded `approved` article (or approve one), call `publishArticle(id)` (or drive "Approuver & publier" in the app). Then VERIFY on the live WP (via the REST API GET `/posts/<id>` with auth, or the WordPress MCP if connected): the post exists with the right title, category, tags, featured image, image credit + sources footer, and the DB article is `published` with `distributions:'sent'`+externalId. Paste the post link + a snippet as evidence.

- [ ] **Step 4: Update + unpublish** — `republishArticle(id)` (change the title/body first) → confirm the SAME post id updated (no duplicate). Then `unpublishArticle(id)` → confirm the WP post is now `draft`/`trash` and the DB article is back to `approved`.

- [ ] **Step 5: Scheduled path (optional, if time)** — set one `approved` article's `scheduledAt` to the past, `curl -X POST $WP.../api/publish/due -H "Authorization: Bearer $PUBLISH_TRIGGER_SECRET"` (dev server up) → it publishes; confirm 401 without the bearer.

- [ ] **Step 6: Cleanup** — **trash/delete the test post(s) on WordPress** (don't leave test content on the live site) and `bun run db:seed` to restore the DB baseline; confirm no leftover verification rows. Remove throwaway scripts.

- [ ] **Step 7: Final commit / tag** — `git add -A && git commit -m "chore: SP5 verified — real WordPress publish/update/unpublish + scheduled end-to-end" || echo "nothing to commit"; git tag sp5-complete`

---

## Self-Review Notes (coverage map)

- **Spec §3 config / not-configured** → Task 1. **§4 WordPressClient** → Task 1. **§5 channel + publish/unpublish/republish (idempotent, fail-soft, resolve-by-name)** → Task 2. **§6 wire approve/quick-approve + editor controls** → Task 3. **§7 scheduled auto-publish** → Task 4. **§8 distributions (no new table)** → Tasks 2,4. **§9 error handling (French, article-never-broken)** → Tasks 2,3. **§10 tests/verification** → each task + Task 5.
- **Human-review gate:** publish only via human approve (Task 3) or `publishDueArticles` restricted to `approved` (Task 4, asserted in its test); article flips to `published` only AFTER a successful post (Task 2).
- **RBAC:** `article:publish` on all publish actions (Task 3); bearer on the cron (Task 4).
- **Requires creds:** Task 5 (real verify) needs `WP_BASE_URL`; Tasks 1–4 prove logic against a fake WP.
- **Deferred:** Settings→Intégrations UI (SP2/P2); WhatsApp/social channels (SP6); SP0+SP1 Tasks 14–15.
```
