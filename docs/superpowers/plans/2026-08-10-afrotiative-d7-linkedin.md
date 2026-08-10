# D7 — LinkedIn adapter (company Page) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the studio render to a LinkedIn company Page — render as the image, article permalink appended to the caption — and close the credential debt the D2+D3 final review assigned to this sub-project before a third channel inherits it.

**Architecture:** D1's registry isolates an adapter behind one `send`. LinkedIn needs a four-step send (fetch bytes → `initializeUpload` → `PUT` bytes → poll to `AVAILABLE` → `POST /rest/posts`) because LinkedIn will not fetch our URL and its Images API has no synchronous mode. Two shared pieces change: credential *presence* becomes "all declared fields", and the caption pipeline learns to append a permalink for one channel.

**Tech Stack:** Next.js 16 App Router · TypeScript · Bun · Drizzle/Postgres · LinkedIn Community Management API (`/rest/images`, `/rest/posts`) · `Bun.serve` fakes

**Spec:** `docs/superpowers/specs/2026-08-10-afrotiative-d7-linkedin-design.md` — read the section named in each task before implementing it.

## Global Constraints

- **Read the Next.js docs** under `node_modules/next/dist/docs/01-app/` before writing or changing a Server Action — `AGENTS.md` requires it; this version has breaking changes vs. training data.
- **Every export of a `"use server"` module is an unauthenticated Server Action** (`lib/actions/taxonomy-actions.ts:5-11`). Guard first (`requireUser()` then `requirePermission(user.role, "social", "manage")`); raw writers stay in plain modules.
- **The human-review barrier is untouchable.** `tests/publish-due.test.ts` and `tests/wp-publish.test.ts` must stay green **and unmodified**.
- **Never log a credential**, not even truncated, and never return one to a client. A decrypted secret exists only inside a server-side call. The access token never appears in a URL — `Authorization: Bearer` only.
- All user-facing strings in **French**; **Base UI** (`render` prop, never `asChild`), shadcn preset `base-nova`.
- **No real network calls in tests.** `tests/diffusion-facebook.test.ts` and `tests/diffusion-connection-test.test.ts` are the precedent: a `Bun.serve` fake injected by base URL.
- **Never run two `bun test` invocations concurrently** (`test-setup.ts:38-40`). A full-suite count is not reproducible on this repo — see the roadmap's «&nbsp;Hygiène des tests&nbsp;»: a failure in a full run is **not** evidence of regression until the file is re-run alone.
- **Three suite failures are pre-existing**: `tests/pipeline-web-search.test.ts` (a) and (d), `tests/pipeline-pause-resume.test.ts` checkpoint (b). Never attribute them to your work; never try to fix them.
- Commit messages in **French**, prefix `feat(diffusion):` (or `fix(diffusion):` for the debt task), ending with:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`

## File Structure

| File | Responsibility |
|---|---|
| `lib/diffusion/settings-core.ts` (modify) | Add `credentialKeys` to the public settings type; refuse a mixed-key merge; keep never returning plaintext |
| `lib/validation.ts` (modify) | Validate credential keys against `credentialFields` + a value length bound; validate `channel` |
| `lib/actions/diffusion-settings-actions.ts` (modify) | Use the validators; expose `tokenExpiresAt` writes |
| `components/settings/social-channel-form.tsx` (modify) | Presence = all fields; token-expiry field |
| `app/(app)/settings/social/[channel]/page.tsx` (modify) | Guide collapse keyed off full presence |
| `db/schema.ts` + migration (modify) | `token_expires_at` timestamp on `social_channel_settings` |
| `lib/alerts/notify.ts` (modify) | New `AlertType` value `token_expiring` |
| `lib/diffusion/scheduler.ts` (modify) | Token-expiry check before the `autoEnabled` early return |
| `lib/diffusion/linkedin/rest-client.ts` (create) | Injectable-base-URL client that exposes response headers and PUTs bytes |
| `lib/diffusion/linkedin/linkedin.ts` (create) | The four-step send + French error mapping |
| `lib/diffusion/channels.ts` (modify) | LinkedIn `credentialFields` + real `send` |
| `lib/diffusion/caption.ts` (modify) | Append the permalink for LinkedIn, reserving its length before truncation |
| `lib/diffusion/meta/connection-test.ts` (modify) | Add a LinkedIn branch to the existing connection test |
| `lib/diffusion/setup-guide.ts` (modify) | Replace the LinkedIn placeholder with the real guide |
| `docs/DEPLOYMENT.md`, `README.md`, `.env.example` (modify) | `LINKEDIN_API_VERSION`, the LinkedIn prerequisites, adapter status |

Tests: `tests/diffusion-credentials-presence.test.ts`, `tests/diffusion-token-expiry.test.ts`, `tests/diffusion-linkedin.test.ts`, plus additions to `tests/diffusion-caption.test.ts`, `tests/diffusion-connection-test.test.ts`, `tests/diffusion-setup-guide.test.ts`.

---

### Task 1: Credential presence and validation (spec §5)

**Files:** `lib/diffusion/settings-core.ts`, `lib/validation.ts`, `lib/actions/diffusion-settings-actions.ts`, `components/settings/social-channel-form.tsx`, `app/(app)/settings/social/[channel]/page.tsx`, `tests/diffusion-credentials-presence.test.ts`

**Interfaces:**
- Consumes: `SocialChannelSettings` (`settings-core.ts:23`), `setChannelCredentialsCore` (`:189`), `getDecryptedCredentials` (`:241`), `SOCIAL_CHANNELS[channel].credentialFields` (`channels.ts:48`).
- Produces: `SocialChannelSettings.credentialKeys: string[]` — the **key names** present in the encrypted blob, never values. `hasAllCredentials(channel, settings): boolean`, exported from `settings-core.ts`, used by Tasks 4, 5 and 6 and by both UI files.

Read spec §5 first. All four items land here because LinkedIn's two-field credential set is what turns item 1 from theoretical into a real bug.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/diffusion-credentials-presence.test.ts
import { describe, expect, test } from "bun:test";
import { hasAllCredentials, getChannelSettings, setChannelCredentialsCore } from "@/lib/diffusion/settings-core";

describe("credential presence means ALL declared fields (D2+D3 final review, M6)", () => {
  test("saving only pageId leaves Facebook reported as NOT configured", async () => {
    await setChannelCredentialsCore("facebook", { pageId: "123" });
    const s = await getChannelSettings("facebook");
    expect(s.credentialKeys).toEqual(["pageId"]);          // the key IS reported
    expect(hasAllCredentials("facebook", s)).toBe(false);   // but the channel is not configured
  });

  test("saving both fields reports configured", async () => {
    await setChannelCredentialsCore("facebook", { pageId: "123", pageAccessToken: "tok" });
    const s = await getChannelSettings("facebook");
    expect(hasAllCredentials("facebook", s)).toBe(true);
  });

  test("credentialKeys never leaks a value", async () => {
    await setChannelCredentialsCore("facebook", { pageId: "123", pageAccessToken: "sup3rs3cret" });
    const s = await getChannelSettings("facebook");
    expect(JSON.stringify(s)).not.toContain("sup3rs3cret");
    expect(JSON.stringify(s)).not.toContain("123");
  });

  test("a channel with no declared fields is never 'configured'", async () => {
    const s = await getChannelSettings("x");
    expect(hasAllCredentials("x", s)).toBe(false);
  });
});

describe("a credential write refuses to create a mixed-key blob (M7)", () => {
  test("when the existing blob no longer decrypts, the write is refused in French", async () => {
    // written under the suite's valid key, then the key is swapped for a different valid one
    await setChannelCredentialsCore("facebook", { pageId: "123", pageAccessToken: "tok" });
    const original = process.env.CREDENTIALS_ENCRYPTION_KEY;
    process.env.CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    try {
      const res = await setChannelCredentialsCore("facebook", { pageId: "456" });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.message).toMatch(/déchiffr/i);
        expect(res.message).toMatch(/Supprimer/);   // names the way out
      }
    } finally {
      process.env.CREDENTIALS_ENCRYPTION_KEY = original;
    }
  });
});

describe("credential input validation (M8, M9)", () => {
  test("a key not declared for the channel is refused", async () => {
    const res = await setChannelCredentialsCore("facebook", { organizationUrn: "urn:li:organization:1" });
    expect(res.ok).toBe(false);
  });

  test("an over-long value is refused", async () => {
    const res = await setChannelCredentialsCore("facebook", { pageId: "x".repeat(4097) });
    expect(res.ok).toBe(false);
  });

  test("an unknown channel is refused with a French message, not a TypeError", async () => {
    // @ts-expect-error deliberately bypassing the type to reach the runtime guard
    const res = await setChannelCredentialsCore("not-a-channel", { pageId: "1" });
    expect(res.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `bun test tests/diffusion-credentials-presence.test.ts`
Expected: FAIL — `hasAllCredentials` is not exported; `credentialKeys` is undefined; the mixed-key write currently succeeds.

- [ ] **Step 3: Implement**

In `settings-core.ts`: extend the public type with `credentialKeys: string[]`, derived where the row is read — the existing `omitCredentials()` is the single place that strips the blob, so derive the key list there (`Object.keys(row.credentials ?? {})`) and keep the blob itself out of the return. Add:

```ts
// Presence = EVERY declared field, not any one of them (D2+D3 final review, M6). A channel with no
// declared fields (whatsapp, x, tiktok today) is never "configured": an empty list must not report
// as complete, which `every` on an empty array would.
export function hasAllCredentials(channel: Channel, settings: SocialChannelSettings): boolean {
  const declared = SOCIAL_CHANNELS[channel].credentialFields;
  if (declared.length === 0) return false;
  return declared.every((f) => settings.credentialKeys.includes(f.key));
}
```

In `setChannelCredentialsCore`: validate `channel` against `CHANNELS` and the incoming keys against that channel's `credentialFields` with a 4096-character value bound (put the schema in `lib/validation.ts` beside `channelCredentialsSchema`), then — before merging — attempt to decrypt each existing entry; on `DecryptionFailedError` return `{ ok: false, message: "Les identifiants déjà enregistrés ne peuvent plus être déchiffrés (la clé de chiffrement a changé ?). Utilisez « Supprimer » puis ressaisissez TOUS les champs." }`.

In the two UI files: replace every `credentialsSetAt ? … : …` decision about *configured-ness* with `hasAllCredentials(...)`. Keep `credentialsSetAt` for the «&nbsp;Défini le …&nbsp;» date itself. The guide's `defaultOpen` becomes `!hasAllCredentials(channel, settings)`, and *Tester la connexion* is disabled unless it is true.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `bun test tests/diffusion-credentials-presence.test.ts tests/diffusion-settings.test.ts tests/diffusion-settings-ui.test.ts tests/diffusion-crypto.test.ts`
Expected: PASS, output pristine.

- [ ] **Step 5: Commit**

```bash
git add lib/diffusion/settings-core.ts lib/validation.ts lib/actions/diffusion-settings-actions.ts components/settings/social-channel-form.tsx "app/(app)/settings/social/[channel]/page.tsx" tests/diffusion-credentials-presence.test.ts
git commit   # fix(diffusion): un canal n'est configuré que si TOUS ses champs sont posés (dette D2+D3)
```

---

### Task 2: Token-expiry tracking and alerting (spec §4)

**Files:** `db/schema.ts` + migration, `lib/diffusion/settings-core.ts`, `lib/actions/diffusion-settings-actions.ts`, `components/settings/social-channel-form.tsx`, `lib/alerts/notify.ts`, `lib/diffusion/scheduler.ts`, `tests/diffusion-token-expiry.test.ts`

**Interfaces:**
- Consumes: `hasAllCredentials` (Task 1), `createAlert` (`lib/alerts/notify.ts:30`), `triggerDiffusionTick` and `tickChannel` (`lib/diffusion/scheduler.ts:122` loop, `:173` early return).
- Produces: `socialChannelSettings.tokenExpiresAt` (nullable timestamp, plaintext); `TOKEN_EXPIRY_WARNING_DAYS = 7`; `AlertType` gains `"token_expiring"`.

Read spec §4. `tokenExpiresAt` is a **date, not a secret** — it lives in its own column, never in the encrypted blob, because the UI must display it.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/diffusion-token-expiry.test.ts — uses the real scheduler tick against a seeded settings row
describe("token expiry alerting (D7 spec §4)", () => {
  test("a channel whose token expires in 3 days raises exactly one alert", async () => {
    await seedConfiguredChannel("linkedin", { tokenExpiresAt: daysFromNow(3), autoEnabled: false });
    await triggerDiffusionTick();
    const rows = await alertsFor("linkedin");
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("token_expiring");
    expect(rows[0].detail).toMatch(/LinkedIn/);
  });

  test("auto-publish OFF still alerts — the common case must not be silent", async () => {
    await seedConfiguredChannel("facebook", { tokenExpiresAt: daysFromNow(2), autoEnabled: false, enabled: false });
    await triggerDiffusionTick();
    expect(await alertsFor("facebook")).toHaveLength(1);
  });

  test("a token expiring in 30 days raises nothing", async () => {
    await seedConfiguredChannel("linkedin", { tokenExpiresAt: daysFromNow(30) });
    await triggerDiffusionTick();
    expect(await alertsFor("linkedin")).toHaveLength(0);
  });

  test("a channel with no credentials raises nothing", async () => {
    await seedChannelWithoutCredentials("linkedin", { tokenExpiresAt: daysFromNow(1) });
    await triggerDiffusionTick();
    expect(await alertsFor("linkedin")).toHaveLength(0);
  });

  test("two ticks in the same day raise one alert, not two", async () => {
    await seedConfiguredChannel("linkedin", { tokenExpiresAt: daysFromNow(1) });
    await triggerDiffusionTick();
    await triggerDiffusionTick();
    expect(await alertsFor("linkedin")).toHaveLength(1);
  });

  test("saving credentials defaults tokenExpiresAt to ~60 days out", async () => {
    await setChannelCredentialsCore("linkedin", { organizationUrn: "urn:li:organization:1", accessToken: "tok" });
    const s = await getChannelSettings("linkedin");
    const days = (s.tokenExpiresAt!.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(59);
    expect(days).toBeLessThan(61);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `bun test tests/diffusion-token-expiry.test.ts`
Expected: FAIL — no `token_expires_at` column, no `token_expiring` alert type.

- [ ] **Step 3: Implement**

Migration via `bun run db:generate` after adding `tokenExpiresAt: timestamp("token_expires_at")` to `socialChannelSettings` — additive and nullable, so existing rows stay valid. `setChannelCredentialsCore` sets it to `now + 60 days` when it writes credentials and the caller passed no explicit date; the settings form exposes it as an editable date so an admin can correct it from LinkedIn's token generator or Meta's Access Token Debugger.

Add `"token_expiring"` to `AlertType`. In the scheduler, put the check in the **outer loop** (`:122`), before `tickChannel` — spec §4 is explicit that gating on `autoEnabled` would silence the alert for hand-published channels, and `tickChannel` returns at `:173` on exactly that condition:

```ts
// Runs for every channel with a full credential set, auto-publish or not: a token an operator uses
// by hand expires just the same. Placed HERE rather than in tickChannel, which returns early at
// scheduler.ts:173 when !enabled || !autoEnabled — the majority case.
async function warnIfTokenExpiring(channel: Channel, settings: SocialChannelSettings): Promise<void> {
  if (!hasAllCredentials(channel, settings)) return;
  if (!settings.tokenExpiresAt) return;
  const days = (settings.tokenExpiresAt.getTime() - Date.now()) / 86_400_000;
  if (days > TOKEN_EXPIRY_WARNING_DAYS) return;
  if (await hasRecentTokenAlert(channel)) return;  // an existing token_expiring for this channel < 24h old
  await createAlert({
    type: "token_expiring",
    title: `Jeton ${CHANNEL_LABELS[channel]} bientôt expiré`,
    detail: `Le jeton d'accès ${CHANNEL_LABELS[channel]} expire le ${formatDate(settings.tokenExpiresAt)}. Générez-en un nouveau et enregistrez-le sur /settings/social/${channel}.`,
    entityId: channel,
  });
}
```

- [ ] **Step 4: Run and confirm passing**

Run: `bun test tests/diffusion-token-expiry.test.ts tests/diffusion-scheduler.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add db/schema.ts db/migrations lib/diffusion/settings-core.ts lib/diffusion/scheduler.ts lib/alerts/notify.ts lib/actions/diffusion-settings-actions.ts components/settings/social-channel-form.tsx tests/diffusion-token-expiry.test.ts
git commit   # feat(diffusion): alerte avant l'expiration d'un jeton (Meta et LinkedIn)
```

---

### Task 3: LinkedIn REST client (spec §3.1)

**Files:** `lib/diffusion/linkedin/rest-client.ts`, `.env.example`, `tests/diffusion-linkedin.test.ts` (client cases)

**Interfaces:**
- Consumes: nothing from earlier tasks. Model it on `lib/diffusion/meta/graph-client.ts` — read that file first; it is the established shape, including its injectable `baseUrl` and its typed `GraphApiError`.
- Produces:

```ts
export type LinkedInResponse<T> = { body: T; headers: Headers; status: number };
export class LinkedInApiError extends Error {
  readonly status: number;
  readonly serviceErrorCode: number | null;   // LinkedIn's own code when present in the body
}
export class LinkedInClient {
  constructor(opts: { accessToken: string; baseUrl?: string; apiVersion?: string; fetchImpl?: typeof fetch });
  get<T>(path: string, params?: Record<string, string>): Promise<LinkedInResponse<T>>;
  post<T>(path: string, body: unknown, params?: Record<string, string>): Promise<LinkedInResponse<T>>;
  putBytes(absoluteUrl: string, bytes: ArrayBuffer, contentType: string): Promise<LinkedInResponse<null>>;
}
```

Three things differ from `GraphClient` and are the whole reason this file exists:

1. **`headers` is returned**, because `POST /rest/posts` carries the post id in `x-restli-id`, not in the body. A client that returns only parsed JSON silently loses it — spec §8 risk 3.
2. **`putBytes` takes an absolute URL**, because LinkedIn's `uploadUrl` is on `www.linkedin.com/dms-uploads/...`, a different host from the API base. It must still send `Authorization: Bearer` (LinkedIn requires the token for *image* upload, unlike video).
3. **Every request carries** `Authorization: Bearer <token>`, `Linkedin-Version: <apiVersion>` and `X-Restli-Protocol-Version: 2.0.0`. `apiVersion` defaults to `process.env.LINKEDIN_API_VERSION ?? "202607"` — spec §3.5: LinkedIn sunsets versions (202507 already is), so this is an env var and `docs/DEPLOYMENT.md` says it expires.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/diffusion-linkedin.test.ts — a Bun.serve fake standing in for BOTH hosts
test("every request carries the version and protocol headers, and the token is never in the URL", async () => {
  const seen: { url: string; headers: Headers }[] = [];
  const srv = fakeLinkedIn((req) => { seen.push({ url: req.url, headers: req.headers }); return json({ ok: 1 }); });
  const c = new LinkedInClient({ accessToken: "tok-abc", baseUrl: srv.url, apiVersion: "202607" });
  await c.get("/rest/images/urn:li:image:1");
  expect(seen[0].headers.get("authorization")).toBe("Bearer tok-abc");
  expect(seen[0].headers.get("linkedin-version")).toBe("202607");
  expect(seen[0].headers.get("x-restli-protocol-version")).toBe("2.0.0");
  expect(seen[0].url).not.toContain("tok-abc");
});

test("post() exposes the x-restli-id response header", async () => {
  const srv = fakeLinkedIn(() => new Response("", { status: 201, headers: { "x-restli-id": "urn:li:share:42" } }));
  const c = new LinkedInClient({ accessToken: "t", baseUrl: srv.url });
  const res = await c.post("/rest/posts", {});
  expect(res.status).toBe(201);
  expect(res.headers.get("x-restli-id")).toBe("urn:li:share:42");
});

test("putBytes sends the bytes and the bearer token to an absolute URL on another host", async () => {
  let received: ArrayBuffer | null = null; let auth: string | null = null;
  const uploads = Bun.serve({ port: 0, async fetch(req) { received = await req.arrayBuffer(); auth = req.headers.get("authorization"); return new Response("", { status: 201 }); } });
  const c = new LinkedInClient({ accessToken: "tok", baseUrl: "http://unused.invalid" });
  const bytes = new Uint8Array([1, 2, 3]).buffer;
  const res = await c.putBytes(`http://localhost:${uploads.port}/dms-uploads/x`, bytes, "image/png");
  expect(res.status).toBe(201);
  expect(new Uint8Array(received!)).toEqual(new Uint8Array([1, 2, 3]));
  expect(auth).toBe("Bearer tok");
  uploads.stop();
});

test("a LinkedIn error body becomes a typed LinkedInApiError carrying status and serviceErrorCode", async () => {
  const srv = fakeLinkedIn(() => json({ message: "…", status: 401, serviceErrorCode: 65601 }, 401));
  const c = new LinkedInClient({ accessToken: "t", baseUrl: srv.url });
  await expect(c.get("/rest/posts/1")).rejects.toMatchObject({ status: 401, serviceErrorCode: 65601 });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `bun test tests/diffusion-linkedin.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement** `rest-client.ts` to satisfy exactly the interface above. No retry logic, no backoff — `GraphClient` has none either, and the reaper plus the manual retry affordance already cover a failed send.

- [ ] **Step 4: Run and confirm passing.** Run: `bun test tests/diffusion-linkedin.test.ts`

- [ ] **Step 5: Commit**

```bash
git add lib/diffusion/linkedin/rest-client.ts .env.example tests/diffusion-linkedin.test.ts
git commit   # feat(diffusion): client LinkedIn — en-têtes versionnés, lecture d'en-tête de réponse, PUT d'octets
```

---

### Task 4: The LinkedIn adapter (spec §3.2, §3.3, §3.4)

**Files:** `lib/diffusion/linkedin/linkedin.ts`, `lib/diffusion/channels.ts`, `tests/diffusion-linkedin.test.ts` (adapter cases)

**Interfaces:**
- Consumes: `LinkedInClient` / `LinkedInApiError` (Task 3), `hasAllCredentials` (Task 1), `getDecryptedCredentials(channel)` (`settings-core.ts:241`), `isSafePublicHttpUrl` (`lib/url-guard.ts`), `SendInput` / `SendResult` (`channels.ts:15-24`).
- Produces: `LinkedInChannel` implementing `SocialChannel`, wired into `SOCIAL_CHANNELS.linkedin` with `credentialFields: [{ key: "organizationUrn", label: "URN de l'organisation (Page entreprise)" }, { key: "accessToken", label: "Jeton d'accès" }]`.

Read spec §3.2–§3.4. **`getDecryptedCredentials` must be inside a try/catch** — the D2+D3 final review's Important 1 was exactly this omission in `facebook.ts`/`instagram.ts`; do not reintroduce it. Read `lib/diffusion/meta/instagram.ts` for the bounded-poll-with-injectable-sleep shape; reuse it rather than reinventing.

The four steps, with the exact payloads:

1. Guard `input.imageUrl` with `isSafePublicHttpUrl`, fetch it, refuse a non-image `content-type`.
2. `POST /rest/images?action=initializeUpload` → `{"initializeUploadRequest":{"owner":"<organizationUrn>"}}`; read `value.uploadUrl` and `value.image`.
3. `putBytes(uploadUrl, bytes, contentType)`.
4. Poll `GET /rest/images/<urn>` until `status === "AVAILABLE"` (default 10 attempts, 3 s, injectable sleep). `PROCESSING_FAILED` → immediate distinct failure. Then `POST /rest/posts` with the body in spec §3.2 step 5, and take `externalId` from the `x-restli-id` header.

- [ ] **Step 1: Write the failing tests**

```ts
test("happy path: four calls in order, externalId from x-restli-id", async () => {
  const calls: string[] = [];
  const srv = fakeLinkedIn((req) => {
    const u = new URL(req.url); calls.push(`${req.method} ${u.pathname}${u.search}`);
    if (u.search.includes("initializeUpload")) return json({ value: { uploadUrl: `${srv.url}/dms-uploads/1`, image: "urn:li:image:9" } });
    if (u.pathname.startsWith("/dms-uploads")) return new Response("", { status: 201 });
    if (u.pathname.includes("/rest/images/")) return json({ id: "urn:li:image:9", status: "AVAILABLE" });
    if (u.pathname === "/rest/posts") return new Response("", { status: 201, headers: { "x-restli-id": "urn:li:share:77" } });
    return new Response("nope", { status: 500 });
  });
  const res = await linkedInChannelFor(srv).send({ articleId: "a1", imageUrl: renderUrl(srv), caption: "Bonjour" });
  expect(res).toEqual({ ok: true, externalId: "urn:li:share:77" });
  expect(calls).toEqual([
    "GET /render.png",
    "POST /rest/images?action=initializeUpload",
    "PUT /dms-uploads/1",
    "GET /rest/images/urn:li:image:9",
    "POST /rest/posts",
  ]);
});

test("the post body carries the image urn, the caption, PUBLIC and MAIN_FEED", async () => { /* assert the parsed body deep-equals spec §3.2's shape */ });

test("a timeout NEVER posts — an invisible post is worse than a failed send", async () => {
  const srv = fakeLinkedIn(/* status always PROCESSING */);
  const res = await linkedInChannelFor(srv, { pollMaxAttempts: 3, sleepImpl: async () => {} }).send(input);
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.message).toMatch(/n'a pas fini d'être traitée|délai/i);
  expect(pathsCalled(srv)).not.toContain("POST /rest/posts");
});

test("PROCESSING_FAILED fails immediately without posting", async () => { /* … */ });

test("201 without x-restli-id is a failure, not a success with an empty id", async () => {
  const res = await linkedInChannelFor(srvReturning201WithoutHeader).send(input);
  expect(res.ok).toBe(false);
});

test("401 says the token expired and points at the settings page", async () => {
  const res = await linkedInChannelFor(srv401).send(input);
  expect(res.ok).toBe(false);
  if (!res.ok) { expect(res.message).toMatch(/jeton/i); expect(res.message).toContain("/settings/social/linkedin"); }
});

test("403 blames the scope or Page admin rights, not the token", async () => { /* distinct message from 401 */ });
test("429 mentions the daily quota", async () => { /* … */ });

test("missing credentials refuse before any HTTP call", async () => {
  expect(requestCount).toBe(0);
});

test("a rotated encryption key returns a French failure instead of throwing (D2+D3 review, Important 1)", async () => {
  // mirror tests/diffusion-connection-test.test.ts:118-129 — write under one key, swap in another
  const res = await linkedInChannelFor(srv).send(input);
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.message).toMatch(/déchiffr/i);
});

test("an unsafe image URL is refused before any LinkedIn call", async () => { /* isSafePublicHttpUrl */ });
test("a non-image content type is refused", async () => { /* … */ });
```

- [ ] **Step 2: Run and confirm failure.** Run: `bun test tests/diffusion-linkedin.test.ts`

- [ ] **Step 3: Implement** `linkedin.ts` and wire the registry. Note the registry's own guard: `tests/diffusion-channels.test.ts` keeps a `REAL_ADAPTER_CHANNELS` list (added in D2+D3) — LinkedIn joins it, so the "every channel returns ok:true" stub assumption no longer applies to it.

- [ ] **Step 4: Run and confirm passing.** Run: `bun test tests/diffusion-linkedin.test.ts tests/diffusion-channels.test.ts tests/diffusion-send.test.ts`

- [ ] **Step 5: Commit**

```bash
git add lib/diffusion/linkedin/linkedin.ts lib/diffusion/channels.ts tests/diffusion-linkedin.test.ts tests/diffusion-channels.test.ts
git commit   # feat(diffusion): adaptateur LinkedIn — téléversement d'image en trois temps puis publication (D7)
```

---

### Task 5: The article permalink in the LinkedIn caption (spec §2)

**Files:** `lib/diffusion/caption.ts`, `tests/diffusion-caption.test.ts`

**Interfaces:**
- Consumes: `generateCaption({ articleId, channel })` (`caption.ts:90`), `truncateCaption(text, maxChars)` (`:38`), `wpPostUrl(baseUrl, postId)` (`lib/wp/post-url.ts:4`), the article's `wordpress` `distributions` row.
- Produces: no signature change — `generateCaption` returns the same `{ ok: true, caption }`, with the permalink already inside it for LinkedIn.

Read spec §2, including the paragraph on ordering. **The URL's length is reserved before truncation**, never appended after it: `truncateCaption(text, maxChars − (url.length + separator.length))`, then append. Appending after the clamp produces either an over-budget caption or a truncated link.

- [ ] **Step 1: Write the failing tests**

```ts
test("LinkedIn: the permalink is appended when the article is published to WordPress", async () => {
  const id = await seedArticleWithWordpressDistribution({ externalId: "1234" });
  const res = await generateCaption({ articleId: id, channel: "linkedin" });
  expect(res.ok).toBe(true);
  if (res.ok) expect(res.caption).toContain("/?p=1234");
});

test("LinkedIn: no WordPress distribution means no URL, and the send still works", async () => {
  const id = await seedArticleWithoutWordpressDistribution();
  const res = await generateCaption({ articleId: id, channel: "linkedin" });
  expect(res.ok).toBe(true);
  if (res.ok) expect(res.caption).not.toMatch(/https?:\/\//);
});

test("the URL is reserved BEFORE truncation — result within budget, link intact", async () => {
  const id = await seedArticleWithWordpressDistribution({ externalId: "1234", title: "x".repeat(5000) });
  await updateChannelSettingsCore("linkedin", { captionMaxChars: 300 });
  const res = await generateCaption({ articleId: id, channel: "linkedin" });
  expect(res.ok).toBe(true);
  if (res.ok) {
    expect(res.caption.length).toBeLessThanOrEqual(300);
    expect(res.caption).toContain("/?p=1234");   // the link is never what gets cut
  }
});

test("Facebook and Instagram captions are untouched", async () => {
  const id = await seedArticleWithWordpressDistribution({ externalId: "1234" });
  for (const channel of ["facebook", "instagram"] as const) {
    const res = await generateCaption({ articleId: id, channel });
    if (res.ok) expect(res.caption).not.toContain("/?p=1234");
  }
});
```

- [ ] **Step 2: Run and confirm failure.** Run: `bun test tests/diffusion-caption.test.ts`

- [ ] **Step 3: Implement** in `generateCaption`: for `channel === "linkedin"` only, look up the article's `wordpress` distribution `externalId`, build the URL with `wpPostUrl(getWpConfig()?.baseUrl, externalId)`, subtract its length plus `"\n\n"` from the clamp budget, then append. A null URL changes nothing.

- [ ] **Step 4: Run and confirm passing.** Run: `bun test tests/diffusion-caption.test.ts tests/diffusion-panel.test.ts`

- [ ] **Step 5: Commit**

```bash
git add lib/diffusion/caption.ts tests/diffusion-caption.test.ts
git commit   # feat(diffusion): permalien de l'article ajouté à la légende LinkedIn, avant troncature
```

---

### Task 6: Connection test, setup guide, documentation (spec §6, §3.5)

**Files:** `lib/diffusion/meta/connection-test.ts` (or a shared move — see below), `lib/diffusion/setup-guide.ts`, `docs/DEPLOYMENT.md`, `README.md`, `.env.example`, `tests/diffusion-connection-test.test.ts`, `tests/diffusion-setup-guide.test.ts`

**Interfaces:**
- Consumes: `LinkedInClient` (Task 3), `hasAllCredentials` (Task 1), the existing `testChannelConnection` action and `connection-test.ts`'s per-channel branch structure.
- Produces: a `linkedin` branch in the connection test, and a real `linkedin` guide entry.

**One judgement call to make and justify in your report:** `connection-test.ts` currently lives under `meta/`. Adding a LinkedIn branch either moves it up to `lib/diffusion/connection-test.ts` or leaves a LinkedIn call inside a `meta/` directory. Pick one and say why; do not leave it implicit.

The LinkedIn connection test is **one free GET** — `GET /rest/organizations/{id}` (or the organization node the URN names) — proving the token works and naming the organization reached. It must not post.

- [ ] **Step 1: Write the failing tests**

```ts
test("LinkedIn connection test makes exactly one GET and no post", async () => {
  const res = await testLinkedInConnection({ baseUrl: srv.url });
  expect(res.ok).toBe(true);
  expect(requestCount).toBe(1);
  expect(lastMethod).toBe("GET");
  expect(pathsCalled).not.toContain("/rest/posts");
});

test("LinkedIn connection test names the organization reached", async () => {
  if (res.ok) expect(res.detail).toContain("Afrotiative");
});

test("every channel still has a guide, and LinkedIn's is no longer a placeholder", () => {
  const g = SETUP_GUIDES.linkedin;
  expect(g.steps.length).toBeGreaterThan(3);
  expect(JSON.stringify(g)).toMatch(/Community Management/);
  expect(JSON.stringify(g)).toMatch(/nouvelle application/i);   // Dev Tier needs a NEW app
  expect(JSON.stringify(g)).toMatch(/60 jours/);
  const fieldKeys = SOCIAL_CHANNELS.linkedin.credentialFields.map((f) => f.key);
  for (const s of g.steps) if (s.fieldHint) expect(fieldKeys).toContain(s.fieldHint);
});
```

- [ ] **Step 2: Run and confirm failure.** Run: `bun test tests/diffusion-connection-test.test.ts tests/diffusion-setup-guide.test.ts`

- [ ] **Step 3: Implement.** The guide must state, per spec §6: create a **new** developer app (Development Tier cannot be granted to an app holding other products — the option greys out); associate and verify the company Page with the member as **ADMIN**; request Community Management Development Tier, then Standard Tier with a **screencast**, and that this takes time; generate the token with the Developer Portal **Token Generator**; that it lasts **60 days** and programmatic refresh is partner-only; where to find the **organization URN**; and the **500 requests/app/day** Development Tier ceiling, of which one publication costs four.

Docs: `LINKEDIN_API_VERSION` in `.env.example` and `docs/DEPLOYMENT.md` **with the warning that LinkedIn sunsets versions** (202507 already is) and where the supported list lives; the LinkedIn prerequisites section; `README.md`'s adapter status now reads Facebook, Instagram and LinkedIn real, WhatsApp/X/TikTok stubbed.

- [ ] **Step 4: Run and confirm passing.** Run: `bun test tests/diffusion-connection-test.test.ts tests/diffusion-setup-guide.test.ts`, then the **full suite once**: `bun test`.

- [ ] **Step 5: Commit**

```bash
git add lib/diffusion tests docs/DEPLOYMENT.md README.md .env.example
git commit   # feat(diffusion): test de connexion LinkedIn, guide de connexion réel et documentation (D7)
```

---

## Self-Review

**Spec coverage:** §1 differences → Tasks 3 and 4. §2 URL in caption → Task 5. §3.1 client → Task 3. §3.2–3.4 send, errors, duplicate window → Task 4. §3.5 version pinning → Tasks 3 (env read) and 6 (docs). §4 token alerting → Task 2. §5 four debt items → Task 1. §6 setup guide → Task 6. §7 tests → distributed, one test block per task. §8 risks → risk 2 (invisible post) is Task 4's timeout-never-posts test; risk 3 (`x-restli-id`) is Task 3's header test. §9 verified/inferred → each task's report must repeat the distinction for what it touched.

**Ordering:** Task 1 before 2 (both need `hasAllCredentials`, and 2's alert gate depends on it). Task 3 before 4. Task 5 is independent of 3/4 but after 1. Task 6 last — it needs the client, the adapter and the credential fields to exist.

**Placeholders:** none. Where a test body is elided with `/* … */`, the assertion it must make is stated in prose in the same line and its full sibling appears immediately above — the elision is repetition, not an unspecified requirement.

**Type consistency:** `hasAllCredentials(channel, settings)` is used with that exact signature in Tasks 1, 2, 4 and 6. `credentialKeys: string[]` is named identically in Tasks 1 and 2. `LinkedInResponse<T>` / `LinkedInApiError` / `putBytes` as defined in Task 3 are what Task 4 consumes. `tokenExpiresAt` is the same name in the schema, the type, the UI and the scheduler.

**Known risk this plan carries:** nothing here can be verified against the real LinkedIn API until Community Management access clears, exactly as D2+D3 shipped. Every task's report must say what it verified against live documentation versus inferred — and must not claim end-to-end verification.
