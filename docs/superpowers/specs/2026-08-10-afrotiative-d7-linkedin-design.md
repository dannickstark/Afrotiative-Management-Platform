# D7 — LinkedIn adapter (company Page) — Design

**Date:** 2026-08-10
**Status:** Validated with the user (2026-08-10) — ready for a plan
**Programme:** `2026-08-09-afrotiative-studio-diffusion-roadmap.md` — sub-project D7
**Depends on:** D1 (channel registry, `distributions`, scheduler, caption pipeline), D2+D3 (credential storage, the adapter shape, the `Bun.serve` fake-server test pattern)

**Goal.** Replace LinkedIn's `StubChannel` with a real adapter that publishes the studio render to a
company Page, and close the credential debt the D2+D3 final review assigned to this sub-project
before a third channel inherits it.

---

## 1. What makes LinkedIn different from Meta

Four differences drive the whole design. All four were verified against LinkedIn's current
documentation on 2026-08-10 (`learn.microsoft.com/en-us/linkedin/...`); §9 separates verified fact
from inference.

| | Meta (D2/D3) | LinkedIn (D7) |
|---|---|---|
| **Image delivery** | Meta fetches our public R2 URL | LinkedIn will not fetch a URL. We must **download the render and PUT the bytes**. |
| **Post identifier** | JSON body (`id` / `post_id`) | **`x-restli-id` response header** on a `201` |
| **Required headers** | none beyond auth | `Linkedin-Version: YYYYMM` **and** `X-Restli-Protocol-Version: 2.0.0` on every call |
| **Token renewal** | long-lived Page token, rotate by hand | 60-day token, rotate by hand — programmatic refresh is **partner-only**, so there is no automation path available to this project |

Two further facts constrain the flow:

- **The Images API does not support `SYNCHRONOUS_UPLOAD`.** Upload is asynchronous, with status
  `WAITING_UPLOAD` → `PROCESSING` → `AVAILABLE` | `PROCESSING_FAILED`.
- LinkedIn's own Assets documentation states the consequence plainly: *"It's required that image
  upload completes successfully before creating a UGC Post or Share. If the post is created before
  confirming image upload success and the image upload fails to process, the post won't be visible to
  members."* A post created too early therefore fails **silently** — it exists and is empty to
  members. So the adapter **must** poll to `AVAILABLE` before posting. This is structurally the same
  problem D3 solved for Instagram's container, and reuses that shape.

---

## 2. Post composition — decided

A LinkedIn post carries the studio render as the image **and** the article permalink appended to the
caption text, where LinkedIn makes it clickable.

`content.article` (a link post with a LinkedIn-generated preview card) was rejected: it would discard
the V1/V2 render entirely for this channel, and the render is the whole point of the studio.
`content.media` and `content.article` are mutually exclusive, so the URL has to live in the text.

**The URL is appended at caption generation, not in the adapter.** `generateCaption`
(`lib/diffusion/caption.ts`) already knows the channel and its 3 000-character budget. Appending
there means:

- the human **sees and can edit the final text** in the Diffusion panel before sending — the
  programme's review-gate principle («&nbsp;l'IA propose, l'humain dispose&nbsp;») applies to the URL
  too;
- the URL counts against the character budget **visibly**, not silently at send time;
- `SendInput` stays as D1 defined it — no interface change rippling across six adapters.

The permalink comes from the existing helper: `wpPostUrl(baseUrl, externalId)` of the article's
**`wordpress`** distribution row, exactly as `lib/studio/bindings.ts:59` already derives the
`article.url` token. An article not yet published to WordPress has no permalink; then nothing is
appended and the send proceeds — the same graceful absence `bindings.ts` implements, not an error.

**Order matters, and it is the one ambiguity worth nailing down:** the URL is reserved **before**
truncation, not appended after it. `truncateCaption` clamps the generated text to
`captionMaxChars − (URL length + separator)`, and the URL is then appended — so the result respects
the limit and the link is never the thing that gets cut. Appending after the clamp would produce a
caption over budget, or a truncated URL, depending on where the clamp ran.

**Scope of the change:** LinkedIn only. Facebook and Instagram captions are untouched (links are not
clickable on Instagram, and Facebook's behaviour is deliberately left as D2 shipped it).

---

## 3. The adapter

New directory `lib/diffusion/linkedin/`, mirroring `meta/`.

### 3.1 `rest-client.ts`

A small client with an **injectable base URL** — the same seam that makes `meta/graph-client.ts`
testable and, before it, `lib/wp/client.ts`. It must do two things Meta's client never did:

- **Return response headers**, so `send` can read `x-restli-id`.
- **PUT raw bytes** to an arbitrary absolute URL (LinkedIn's `uploadUrl` is on a different host,
  `www.linkedin.com/dms-uploads/...`, not the API host — so the byte upload takes a full URL rather
  than a path joined to the base URL, and the fake server must be able to serve both).

The token travels in the `Authorization: Bearer` header on every call, including the byte upload
(LinkedIn's docs are explicit that image upload requires the token, unlike video upload). Never in a
query string — the D2+D3 final review's Important 3.

Every request carries `Linkedin-Version` and `X-Restli-Protocol-Version: 2.0.0`.

### 3.2 `linkedin.ts` — the send

1. **Fetch the render bytes** from `input.imageUrl` (our own R2 public URL), through
   `isSafePublicHttpUrl` (`lib/url-guard.ts`) — the same anti-SSRF guard `uploadFeaturedImage` and
   `testFeed` already use. Refuse a non-image content type. LinkedIn accepts JPG/PNG/GIF under
   36 152 320 pixels; the studio's format presets are far below that, so no resize logic is needed —
   but a `413`/`415` from LinkedIn maps to a distinct French message rather than a generic failure.
2. **`POST /rest/images?action=initializeUpload`** with
   `{"initializeUploadRequest": {"owner": "<organizationUrn>"}}` → `{value: {uploadUrl, image}}`.
   `image` is the `urn:li:image:...` we will post.
3. **`PUT <uploadUrl>`** with the bytes and the Bearer token.
4. **Poll `GET /rest/images/{urn}`** until `status === "AVAILABLE"`, bounded — default 10 attempts,
   3 s apart, with an **injectable sleep** so tests never wait on real timers (D3's pattern
   verbatim). `PROCESSING_FAILED` fails immediately with a distinct message; `WAITING_UPLOAD` and
   `PROCESSING` keep polling; exhausting the attempts is a French timeout message naming the image
   URN.
5. **`POST /rest/posts`** with:
   ```json
   {
     "author": "<organizationUrn>",
     "commentary": "<caption, URL already appended at generation>",
     "visibility": "PUBLIC",
     "distribution": { "feedDistribution": "MAIN_FEED", "targetEntities": [], "thirdPartyDistributionChannels": [] },
     "content": { "media": { "altText": "<article title, truncated>", "id": "<image urn>" } },
     "lifecycleState": "PUBLISHED",
     "isReshareDisabledByAuthor": false
   }
   ```
   A `201` carries the post URN in the **`x-restli-id`** header — that is `externalId`. A `201`
   without that header is a hard failure with its own message, not a silent success: we would
   otherwise record an empty `externalId` for a live public post.

### 3.3 Error mapping (all French)

- **401** — the token expired or was revoked. LinkedIn's equivalent of Meta's code 190; the message
  says so plainly and points at `/settings/social/linkedin`, because it recurs every ~60 days.
- **403 on `/rest/images` or `/rest/posts`** — the app lacks `w_organization_social`, or the
  authenticated member is not an ADMIN of the Page. These are different fixes from an expired token,
  so they get a different message.
- **429** — Community Management **Development Tier** allows 500 requests per app per day, and one
  send costs four. The message says the daily quota looks exhausted and suggests retrying tomorrow or
  upgrading the tier — a generic "publication failed" would send an operator hunting in the wrong
  place.
- **`PROCESSING_FAILED`** — LinkedIn rejected the image itself; the render, not the token, is the
  problem.

### 3.4 Duplicate-post window

Wider than Instagram's: three network calls precede the post. Recorded honestly rather than claimed
closed, as D2/D3 did.

- A crash before step 5 leaves an **orphan image asset**. It is inert — an uploaded image that is not
  attached to a post is not visible to anyone — so unlike Instagram's container it costs nothing but
  storage on LinkedIn's side.
- The real exposure is unchanged from Facebook's: a crash **after** the `201` but before the row is
  written. The reaper then marks the row `failed`, and a retry double-posts.
- Mitigation is the same as D2's: write `externalId` as early as the API allows (immediately on
  reading `x-restli-id`), and fold the image URN into failure messages so an operator can see how far
  a failed send got.

### 3.5 API version pinning

`LINKEDIN_API_VERSION` (format `YYYYMM`), env var with a default constant in code.

This is not gold-plating: LinkedIn **sunsets versions**, and 202507 is already sunset per its own
docs. A hardcoded constant is a time bomb that breaks publishing until someone ships a deploy; an env
var lets an operator restore service immediately. `docs/DEPLOYMENT.md` must say that this value
expires and where to find the current supported list.

---

## 4. Token-expiry alerting

Both platforms now issue ~60-day credentials, and neither exposes an expiry date on a cheap read
(Meta has `debug_token`, but it needs an app token this project does not store; LinkedIn returns
nothing useful on a node read). So the expiry is **tracked, not discovered**:

- `social_channel_settings` gains **`tokenExpiresAt`** — a plaintext timestamp, deliberately **not**
  inside the encrypted blob, because a date is not a secret and the UI must display it.
- On a credential write it defaults to `now + 60 days`, and the settings form lets an admin correct
  it (LinkedIn's token generator shows the real date; Meta's Access Token Debugger does too).
- The **existing 15-minute diffusion tick** checks every channel that **has credentials**, whether or
  not automatic publishing is enabled for it: if `tokenExpiresAt` is within 7 days,
  `createAlert({type: "token_expiring", …})`. This matters — auto-publish is off by default, so
  gating the check on `autoEnabled` would silence the alert for exactly the common case, a channel an
  operator publishes to by hand. The check therefore sits **before** the tick's `autoEnabled` early
  return, not inside the per-channel send path.
- New `AlertType` value `token_expiring` in `lib/alerts/notify.ts` — one line, reusing SP9's alert
  row + opt-in email path unchanged. `createAlert` already never throws, so alerting cannot break a
  tick.
- **At most one alert per channel per day**, so a week of ticks does not produce 672 alerts. The
  cheapest honest gate: look for an existing `token_expiring` alert for that channel newer than 24 h
  before inserting (`entityId` carries the channel key).

An expired token is not treated as an error state by the scheduler — the send itself already reports
401 clearly. This is a heads-up before the fact, nothing more.

---

## 5. Credential debt — the four items the D2+D3 review assigned here

LinkedIn adds a **two-field** credential set, which is exactly the shape that makes the first item a
real bug rather than a theoretical one.

1. **Presence must mean "all fields", not "any field".** `settings-core` starts returning **which
   keys are present** — a key list is not sensitive, unlike the values — and «&nbsp;Défini le&nbsp;»,
   the setup-guide collapse and the *Tester la connexion* button all key off *every* declared
   `credentialField` being present. Today saving only the organization URN would claim the channel is
   configured and offer to test it.
2. **A credential write refuses to create a mixed-key blob.** `setChannelCredentialsCore` verifies
   the existing entries still decrypt before merging; if they do not, it refuses with a French
   message telling the admin to use *Supprimer* first. Today a key change plus a partial re-entry
   produces a blob that never decrypts again, and only the documentation warns about it.
3. **Credential keys are validated** against that channel's `credentialFields`, with a maximum value
   length. The action already knows the channel.
4. **`channel` is validated** against `CHANNELS` in the credential actions, so a bogus value returns
   a French error instead of a raw `TypeError` crossing the Server Action boundary.

---

## 6. Setup guide

The LinkedIn placeholder becomes a real guide (`lib/diffusion/setup-guide.ts`), and it must state
things nobody would guess:

- Create a **new** developer application. Community Management **Development Tier** can only be
  requested by an app that has no other API products — an existing app makes the option grey out.
- Associate and verify the company Page; the authenticated member must be a Page **ADMIN**.
- Request Community Management Development Tier, then Standard Tier, which requires submitting a
  **screencast** demonstrating each declared use case. Say that this takes time.
- Generate the token with the Developer Portal's **Token Generator** — no OAuth implementation
  needed on our side — and note that it lasts **60 days**, that programmatic refresh is partner-only,
  and where to record the expiry date in our settings.
- Where to find the **organization URN** (the numeric id in the Page admin URL, or the Organization
  Lookup API).
- The Development Tier ceiling of **500 requests per app per day**, and that one publication costs
  four.

---

## 7. Tests

Fake LinkedIn served by `Bun.serve`, injected by base URL — `tests/diffusion-facebook.test.ts` is the
precedent, and the fake must serve **two hosts' worth of paths** (the API host and the `dms-uploads`
upload URL it hands back).

- Four-step happy path: `externalId` comes from `x-restli-id`, the row is `sent`, and the request
  sequence is exactly initialize → PUT → poll → post.
- The PUT carries the bytes and the Bearer token; no token appears in any URL.
- Poll: `AVAILABLE` on a later attempt succeeds; `PROCESSING_FAILED` fails immediately without
  posting; exhaustion times out in French **without** posting (a post after a failed upload is the
  invisible-post failure mode, so this assertion is the important one).
- `201` without `x-restli-id` is a failure, not a success with an empty id.
- 401, 403 and 429 each produce their own actionable French message.
- Byte fetch: a non-image content type and an unreachable URL each fail before any LinkedIn call.
- Caption: the permalink is appended for LinkedIn when the article has a `wordpress` distribution
  with an `externalId`, is absent when it does not, and the appended result still respects the
  3 000-character clamp.
- Alerting: an alert fires inside the window, does not fire outside it, and does not fire twice in
  24 h.
- One test per debt item in §5, including that a partial credential write leaves the channel reported
  as **not** configured.
- Registry and guide completeness tests keep passing with LinkedIn's new `credentialFields`.

---

## 8. Risks

1. **Nothing can be verified against the real API until the Community Management review clears** —
   the same position D2/D3 shipped in, and the reports must say so rather than implying otherwise.
   The most likely thing to need retuning is the poll bound, since image processing time is not
   documented.
2. **The invisible-post failure mode is the one that must not ship broken.** Posting before
   `AVAILABLE` produces a post that exists and shows nothing, with a `201` that looks like success.
   The timeout-does-not-post test is the guard.
3. **`x-restli-id` is a header, and headers are easy to lose** through a wrapper that only returns
   parsed JSON. The client change in §3.1 exists specifically to prevent that.
4. **Version sunsetting** will break this adapter on LinkedIn's schedule, not ours. The env var
   limits the blast radius to a variable change.
5. **Development Tier's 500/day** makes the automatic scheduler a plausible quota consumer once
   several channels are enabled. Worth watching, not worth engineering around yet.

---

## 9. Verified vs. inferred

**Verified** by fetching LinkedIn's current documentation on 2026-08-10: the `initializeUpload`
endpoint, request body and response shape; that the byte upload is a `PUT` **with** the
`Authorization` header (and that video upload differs); that the Images API does **not** support
`SYNCHRONOUS_UPLOAD`; the image status values; the "post won't be visible to members" consequence of
posting too early; the `/rest/posts` body and that the id returns in `x-restli-id` on a `201`; the
mandatory `Linkedin-Version` and `X-Restli-Protocol-Version` headers; the 60-day access-token
lifespan (`expires_in: 5184000`) and that programmatic refresh tokens are partner-only; the
Development/Standard tier structure, the screencast requirement, the 500-per-app rate limit, and that
Development Tier requires an app with no other products; the pixel and format limits; that
version 202507 is sunset.

**Inferred, and to be confirmed against the real API once access clears:** the poll interval and
attempt count (3 s × 10 — no documented processing time exists); that `403` on these endpoints always
means scope-or-admin rather than something subtler; that a `429` maps cleanly to the daily tier quota;
and the exact French wording that will prove most useful to an operator, which only real failures
will tell us.
