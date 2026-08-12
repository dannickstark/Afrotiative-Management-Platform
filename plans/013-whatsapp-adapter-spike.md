# Plan 013: WhatsApp diffusion adapter (D4) — design/spike

> **Executor instructions**: This is a **design/spike** plan — investigate, decide, and produce a build spec + a small proof, not a finished feature. Do NOT ship a real WhatsApp integration from this plan alone. STOP conditions halt you. Update this plan's row in `plans/README.md` when done.

## Status
- **Priority**: P2 (post-launch) · **Effort**: L · **Risk**: MED · **Depends on**: plan 001 (stub gating) · **Category**: direction
- **Planned at**: commit `d0fd009`, 2026-08-12

## Why this matters

WhatsApp is the roadmap's designated **primary** social channel (the only one that can post to a
channel/group) and carries an explicit operator requirement ("toutes les X heures, un article publié …
dans le canal WhatsApp"). Today it's a `StubChannel` (plan 001 makes the UI honest about that). Turning it
real is the flagship post-launch social capability — but it's genuinely L-effort and carries an
account-ban risk with unofficial libraries, so it deserves a spike before a build.

## Read first (intent)
- `docs/superpowers/specs/2026-08-09-afrotiative-studio-diffusion-roadmap.md` — the D-series roadmap; find the D4 WhatsApp section (worker service, session persistence, catch-up scheduler, at-least-once dedup, accepted ban risk).
- `lib/diffusion/channels.ts:120` (`whatsapp` → `StubChannel`) and a real adapter for shape reference: `lib/diffusion/meta/instagram.ts` / `lib/diffusion/linkedin/linkedin.ts` (the `send(input): Promise<SendResult>` contract to implement).
- `lib/diffusion/send-core.ts` (how `SendResult.externalId` is persisted; write it EARLY for idempotency).

## Spike deliverables (produce these; don't build the feature)
1. **Approach decision doc** (write to `docs/superpowers/specs/YYYY-MM-DD-d4-whatsapp-design.md`): official WhatsApp Cloud API (Business, template-message constraints, needs a Business account) **vs** unofficial library (`whatsapp-web.js` + headless Chromium on a second Railway service, `RemoteAuth` session persisted in Postgres). State trade-offs, cost, ban risk, and a recommendation grounded in the roadmap's stated constraints.
2. **Architecture sketch**: where the send runs (in-process vs a separate worker service — the roadmap calls for a worker), how the WhatsApp session is persisted and restored, how the catch-up scheduler dedups (reuse the `distributions` `externalId`/`status` idempotency already used by other channels).
3. **Interface contract**: the exact `WhatsAppChannel implements { send(input): Promise<SendResult> }` signature, and how it replaces `new StubChannel("whatsapp")` in `channels.ts` (channel becomes `available: true` — plan 001). **Prerequisite owned by the studio process:** a seeded, published `wa_square` `social_post` template must exist in `db/studio-templates.ts` (that file is owned by the separate Studio process — coordinate with them; do not edit it here) or WhatsApp diffusion resolves to no template and refuses.
4. **Risk + rollback**: number-ban mitigation, rate limits, and how to disable fast (the `available` flag + `autoEnabled`).
5. A **thin proof** only if safe: a local, credential-free dry-run of the chosen library's session bootstrap — no posting to a real number. If that can't be done safely, say so and stop at the design doc.

## Commands
| Purpose | Command | Expected |
|---|---|---|
| Deps check | `grep -n "whatsapp\|puppeteer" package.json` | currently none |
| Typecheck | `bun run typecheck` | green (spike adds a doc, maybe an interface stub) |

## Scope
**In scope:** the design doc; optionally a typed `WhatsAppChannel` skeleton implementing the contract (throwing "not configured") behind the `available:false` flag; NO real posting.
**Out of scope:** shipping the worker service, adding heavy deps to the main app, enabling the channel in production.

## Done criteria
- [ ] Decision doc committed with a clear recommendation and trade-offs
- [ ] Interface contract + integration points (channels.ts, send-core, scheduler, template seed) specified
- [ ] Ban-risk + rollback plan written
- [ ] `plans/README.md` row 013 → DONE (and a follow-up build plan proposed if approved)

## STOP conditions
- Do NOT add `whatsapp-web.js`/`puppeteer` to the app or post to any real WhatsApp number from this spike. If a proof requires either, STOP at the design doc and report.
- If the team chooses the official Cloud API, the worker-service architecture may be unnecessary — reflect that in the doc rather than following the unofficial-library shape by default.
