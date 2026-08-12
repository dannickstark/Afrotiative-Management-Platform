# Plan 001: Deferred diffusion channels never report a fake "sent"

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm
> the expected result before the next step. If a STOP condition occurs, stop and report — do not
> improvise. When done, update this plan's status row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat d0fd009..HEAD -- lib/diffusion components/article/diffusion-panel.tsx`
> If any listed file changed since `d0fd009`, compare the "Current state" excerpts below against the
> live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status
- **Priority**: P0 · **Effort**: S · **Risk**: LOW · **Depends on**: none · **Category**: bug
- **Planned at**: commit `d0fd009`, 2026-08-12

## Why this matters

WhatsApp, X and TikTok are wired to a `StubChannel` that performs **no network I/O** and returns
`{ ok: true, externalId: "stub-…" }`. The send path treats that as success: it flips the distribution
row to `status:"sent"`, stamps `sentAt`, writes an audit revision "diffusé sur …", and the article
panel shows a green "Envoyé le …". At go-live an editor will click "Publier sur WhatsApp", see success,
and **nothing is posted anywhere**. This is silent data-integrity loss on the exact action the feature
exists for. The stubs are intentionally shipped (D1 socle); the bug is that they are *reachable from the
production UI with a success result*. Fix: mark channels without a real adapter as unavailable and gate
the send button on it, with a visible reason — the same "no click-time error" contract every other gate
already follows.

## Current state

- `lib/diffusion/channels.ts` — the `CHANNELS` registry. Facebook/Instagram/LinkedIn route `send` to
  real adapters; the three deferred channels route to `StubChannel`:
  ```ts
  // lib/diffusion/channels.ts:120-138
  whatsapp: { key: "whatsapp", label: CHANNEL_LABELS.whatsapp, context: "social_post", format: "wa_square",
    captionLimits: { min: 1, max: 1024, default: 300 }, credentialFields: [],
    send: (input) => new StubChannel("whatsapp").send(input) },
  x: { key: "x", …, send: (input) => new StubChannel("x").send(input) },
  tiktok: { key: "tiktok", …, send: (input) => new StubChannel("tiktok").send(input) },
  ```
  Real adapters (for reference): `facebook`/`instagram`/`linkedin` call `new FacebookChannel().send(...)` etc.
- `lib/diffusion/stub-channel.ts:16-24` — `send()` returns `{ ok: true, externalId }` with no I/O.
- `components/article/diffusion-panel.tsx:42-62` — `computeSendDisabledReason` gates on
  `alreadySent → canSend → isPublished → channelEnabled → r2Configured`. **No "adapter available" gate.**
  It is called at `:148-151` with `alreadySent: view.kind === "sent"`.
- `lib/diffusion/setup-guide.ts:290-324` already tells admins these three are "Adaptateur pas encore
  construit" — so the concept of "not built" exists; this plan makes the article page agree with it.

**Convention:** `computeSendDisabledReason` is a pure function returning a French reason string or
`null`; the panel disables the button and shows the reason when non-null. There is a pure test at
`tests/diffusion-panel.test.ts` (registered in `PURE_FILES`). Match its structure.

## Commands you will need
| Purpose | Command | Expected |
|---|---|---|
| Typecheck | `bun run typecheck` | no NEW errors (one pre-existing RouteContext error is expected) |
| Panel test | `bun test tests/diffusion-panel.test.ts` | all pass |
| Channels test | `bun test tests/diffusion-channels.test.ts` | all pass |
| Pure lane | `bun run test:pure` | all pass |

## Scope
**In scope:**
- `lib/diffusion/channels.ts` (add an `available` flag to registry entries)
- `components/article/diffusion-panel.tsx` (new gate in `computeSendDisabledReason` + pass the flag)
- `tests/diffusion-panel.test.ts` (add cases)

**Out of scope (do NOT touch):**
- `lib/diffusion/stub-channel.ts` — leave the stub as-is; it's used by tests and the socle.
- The real adapters (`lib/diffusion/meta/*`, `lib/diffusion/linkedin/*`).
- `lib/diffusion/scheduler.ts` auto-diffusion — the manual button is the launch risk; the auto path is
  gated by `autoEnabled=false` by default. (If time allows, apply the same `available` check there, but
  it is optional for this plan and must not change default behavior.)

## Steps

### Step 1: Add an `available` flag to the channel registry
In `lib/diffusion/channels.ts`, add `available: true` to `facebook`, `instagram`, `linkedin`, and
`available: false` to `whatsapp`, `x`, `tiktok`. Add the field to the registry-entry type **defined in
`lib/diffusion/channels.ts`** (the object type describing each entry — `key`/`label`/`context`/`format`/
`credentialFields`/`send`). Do NOT modify the shared `Channel`/types imported from `@/lib/studio` — the
Studio module is owned by a separate process; keep this change inside `lib/diffusion`. Add a one-line
comment: `// available:false = no real adapter yet (StubChannel); UI must refuse the send — see plan 001`.

**Verify**: `bun run typecheck` → no new errors.

### Step 2: Add the gate to `computeSendDisabledReason`
In `components/article/diffusion-panel.tsx`, add a `channelAvailable: boolean` field to the input object
and a new branch — place it **after `alreadySent` and `canSend`** but before `isPublished` so an editor
who lacks permission still sees the permission reason first:
```ts
if (!input.channelAvailable) return `La diffusion automatique sur ${input.channelLabel} n'est pas encore disponible.`;
```
Then at the call site (~`:148`), pass `channelAvailable: <the channel's `available` flag>` — thread the
channel's `available` value from wherever the card maps over channels (the same place it reads
`channelEnabled`/`label`). If the component doesn't currently have the channel object there, import
`CHANNELS` from `@/lib/diffusion/channels` and read `CHANNELS[channelKey].available`.

**Verify**: `bun run typecheck` → no new errors.

### Step 3: Write the failing test first, then confirm the code satisfies it
In `tests/diffusion-panel.test.ts`, add cases to the `computeSendDisabledReason` describe block:
```ts
it("refuses a channel with no real adapter, with a visible reason", () => {
  expect(computeSendDisabledReason({ channelAvailable: false, isPublished: true, channelEnabled: true, r2Configured: true, canSend: true, channelLabel: "WhatsApp" }))
    .toBe("La diffusion automatique sur WhatsApp n'est pas encore disponible.");
});
it("allows an available, published, enabled channel", () => {
  expect(computeSendDisabledReason({ channelAvailable: true, isPublished: true, channelEnabled: true, r2Configured: true, canSend: true, channelLabel: "Facebook" }))
    .toBeNull();
});
it("permission reason still wins over unavailable", () => {
  expect(computeSendDisabledReason({ channelAvailable: false, isPublished: true, channelEnabled: true, r2Configured: true, canSend: false, channelLabel: "WhatsApp" }))
    .toBe("Vous n'avez pas la permission de diffuser sur les réseaux sociaux.");
});
```
Update the OTHER existing cases in this describe block to include `channelAvailable: true` so they keep
their expected results (the new field is required).

**Verify**: `bun test tests/diffusion-panel.test.ts` → all pass (including the 3 new cases).

### Step 4: Full gate check
**Verify**: `bun test tests/diffusion-channels.test.ts` → pass; `bun run test:pure` → pass; `bun run typecheck` → no new errors.

## Test plan
- New cases in `tests/diffusion-panel.test.ts` (pure lane, already registered): unavailable → reason;
  available → null; permission precedence. Model after the existing `computeSendDisabledReason` cases in
  that same file.
- No new test file, so no `PURE_FILES` change needed.

## Done criteria (ALL must hold)
- [ ] `bun run typecheck` → no new errors
- [ ] `bun test tests/diffusion-panel.test.ts` and `tests/diffusion-channels.test.ts` → pass
- [ ] `bun run test:pure` → pass
- [ ] `whatsapp`/`x`/`tiktok` entries in `lib/diffusion/channels.ts` have `available: false`; the three real ones `available: true`
- [ ] Only in-scope files modified (`git status`)
- [ ] `plans/README.md` status row for 001 updated to DONE

## STOP conditions
- If the channel registry type is shared/exported from `lib/studio` and adding `available` breaks other
  consumers you can't fully see, STOP and report — do not cast with `as any`.
- If `diffusion-panel.tsx` does not have access to the channel key at the `computeSendDisabledReason`
  call site and wiring it requires a structural refactor of the panel, STOP and report the shape you
  found instead of restructuring the component.
