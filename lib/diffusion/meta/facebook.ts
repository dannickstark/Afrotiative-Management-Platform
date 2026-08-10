// lib/diffusion/meta/facebook.ts — Task 2 (D2): the Facebook Page adapter behind
// lib/diffusion/channels.ts's SocialChannel interface. Publishes a PHOTO POST to the Page —
// `POST /{page-id}/photos` with `url` (the render's public R2 url — SendInput.imageUrl),
// `caption`, `access_token` — verified directly against Meta's own current docs (see graph-
// client.ts's header comment). ONE Graph call, unlike Instagram's two-step container flow
// (./instagram.ts): Graph both accepts and publishes the photo in the same response, and returns
// `post_id` (the id of the resulting page-feed post) in that same JSON body — "the created post id"
// the brief asks for.
//
// ── The at-least-once / duplicate-post window (read before touching this file) ──
// send-core.ts's step 5 already writes `externalId` to the `distributions` row the MOMENT
// `socialChannel.send()` resolves (sendToChannelCore, right after `const sendResult = await
// socialChannel.send(...)`) — that is architecturally the earliest point in this codebase a send
// result CAN be persisted, since SocialChannel.send() has no direct DB access of its own (by
// design — see channels.ts's header comment: adapters know nothing about `distributions`).
// "Write externalId as early as the API allows" is therefore addressed HERE, inside send(), by
// doing NOTHING beyond parsing Graph's response and returning: no second confirmatory call, no
// retry-with-backoff, no extra work between "Graph's HTTP response is in hand" and "return
// {ok:true, externalId}". That collapses the crash window down to essentially just: the tail of
// this function returning, plus send-core.ts's single `await db.update(...)` actually committing.
//
// What STILL remains open (this is NOT closed, and the brief asks for that to be said plainly):
// the instant Graph responds 200 to POST /{page-id}/photos, the post is ALREADY LIVE and PUBLIC on
// the Page — Graph has no "create but don't publish yet" step in this flow (unlike Instagram's
// container). If the process is killed between that response landing here and send-core.ts's DB
// UPDATE committing, the distributions row is left `pending` with a real public post that was
// never recorded. lib/diffusion/scheduler.ts's reclaimStalePendingDistributions() eventually flips
// that row back to `failed` (after DIFFUSION_STALE_PENDING_MINUTES) so it becomes retryable again —
// but a retry then calls send() again with no memory of the first attempt (SendInput carries no
// prior externalId/attempt id), so it WILL create a second, genuinely duplicate Facebook post. This
// is a real, unclosed gap — Meta's photos endpoint has no client-supplied idempotency-key parameter
// to de-duplicate against, so closing it fully would need either (a) SendInput/SendResult growing an
// early-persistence hook back into send-core.ts (out of this task's scope — channels.ts's
// SendInput/SendResult contract is shared by every channel, StubChannel included, and widening it
// touches D1's whole interface), or (b) some Facebook-side "did I already post this?" query before
// posting, which the Graph API does not offer for a Page's own photos. What's implemented here is
// the practical mitigation available within the existing interface: minimize the window to as close
// to zero as the single-call API allows, not eliminate it.
import { getDecryptedCredentials } from "../settings-core";
import { DecryptionFailedError } from "../crypto";
import type { SendInput, SendResult } from "../channels";
import { GraphClient, GraphApiError, type GraphClientConfig } from "./graph-client";

const TOKEN_EXPIRED_CODE = 190; // Graph's "OAuthException" family — code 190 = expired/invalid access token (verified against Meta's error-handling docs; subcodes 463/467 both fall under this same code and get the same message here, since the actionable advice — go rotate the token — is identical for both).

const SETTINGS_PATH = "/settings/social/facebook";

// Exported (not just used internally) so tests/diffusion-facebook.test.ts can assert the exact
// message shape independently of constructing a whole GraphApiError through a fake HTTP round trip
// for every case, and so a future adapter reviewer can see the mapping in one place.
//
// Final-review finding (Important 1): getDecryptedCredentials (settings-core.ts) can THROW
// DecryptionFailedError (lib/diffusion/crypto.ts) — not just return null — when
// CREDENTIALS_ENCRYPTION_KEY has been rotated without re-entering credentials for this channel
// (settings-core.ts's own comment on this function used to claim a wrong key also just returns
// null; it doesn't — only a MISSING/malformed key short-circuits via getCryptoConfig(), a
// well-formed-but-wrong key reaches decryptSecret and throws). Before this fix, send() (below)
// called getDecryptedCredentials with no try/catch of its own, and sendToChannelCore
// (send-core.ts) has no try/catch around socialChannel.send() either — the throw would escape
// AFTER send-core.ts's step 4 already wrote status:'pending' to the distributions row, wedging it
// there (blocking every retry with "Un envoi est déjà en cours") until the reaper's
// DIFFUSION_STALE_PENDING_MINUTES cutoff, with none of step 5/6's lastError/attempts++/audit trail
// ever written. This DecryptionFailedError branch — reached from send()'s own try/catch around
// getDecryptedCredentials, added below — turns that crash into the same ordinary
// `{ok:false,message}` shape every other failure in this file already returns, with an actionable
// French message matching docs/DEPLOYMENT.md's recovery procedure (§2/§10).
export function mapFacebookGraphError(err: unknown): string {
  if (err instanceof DecryptionFailedError) {
    return (
      "Impossible de déchiffrer les identifiants Facebook enregistrés : la clé de chiffrement du " +
      "serveur (CREDENTIALS_ENCRYPTION_KEY) a probablement changé depuis leur enregistrement. Dans " +
      `Réglages → Réseaux sociaux → Facebook (${SETTINGS_PATH}), cliquez sur « Supprimer » puis ` +
      "ressaisissez tous les champs d'identifiants."
    );
  }
  if (err instanceof GraphApiError) {
    if (err.code === TOKEN_EXPIRED_CODE) {
      // Distinct and actionable, per the brief: this WILL happen roughly every 60 days (Meta long-
      // lived Page tokens expire on that cadence — roadmap decision, docs/DEPLOYMENT.md) — an admin
      // reading this must immediately understand it's a token rotation, not a transient failure, and
      // exactly where to go fix it.
      return (
        "Le jeton d'accès Facebook a expiré ou n'est plus valide (les jetons de Page Facebook " +
        "expirent périodiquement, environ tous les 60 jours). Générez un nouveau jeton et " +
        `enregistrez-le dans Réglages → Réseaux sociaux → Facebook (${SETTINGS_PATH}).`
      );
    }
    return `La publication Facebook a échoué : ${err.graphMessage}`;
  }
  if (err instanceof Error) return `La publication Facebook a échoué : ${err.message}`;
  return "La publication Facebook a échoué : erreur inconnue.";
}

// Never logs a credential (Global Constraint) — pageAccessToken is read, used once as a request
// param, and never passed to console.* / thrown into an Error message anywhere in this file. Graph
// error bodies (GraphApiError.graphMessage) come from META, not from us echoing the token back.
export class FacebookChannel {
  constructor(private readonly clientConfig: GraphClientConfig = {}) {}

  async send(input: SendInput): Promise<SendResult> {
    // Guarded (review finding, Important 1 — see mapFacebookGraphError's header comment above for
    // the full failure chain this closes): getDecryptedCredentials can throw DecryptionFailedError,
    // and send-core.ts has nothing catching send()'s own throw.
    let credentials: Record<string, string> | null;
    try {
      credentials = await getDecryptedCredentials("facebook");
    } catch (err) {
      return { ok: false, message: mapFacebookGraphError(err) };
    }
    const pageId = credentials?.pageId;
    const pageAccessToken = credentials?.pageAccessToken;

    // Refuse BEFORE constructing a GraphClient / making any HTTP call at all — the missing-
    // credentials test asserts the fake Graph server receives literally zero requests, not merely
    // that this returns an error (see the task report's self-review section on why that distinction
    // matters).
    if (!pageId || !pageAccessToken) {
      return {
        ok: false,
        message:
          "Identifiants Facebook manquants. Renseignez l'identifiant de la Page et le jeton " +
          `d'accès dans Réglages → Réseaux sociaux → Facebook (${SETTINGS_PATH}).`,
      };
    }

    const client = new GraphClient(this.clientConfig);
    try {
      const result = await client.post<{ id?: string; post_id?: string }>(`/${pageId}/photos`, {
        url: input.imageUrl,
        caption: input.caption,
        access_token: pageAccessToken,
      });
      // `post_id` is "the associated post identifier when the photo is published to the feed"
      // (Meta's own /page/photos reference, fetched 2026-08-10) — the actual page-feed POST id,
      // which is what "the created post id" means here. `id` (the photo's own object id) is the
      // fallback for the theoretical case Graph omits post_id (INFERRED — Meta's docs don't state
      // when/if that happens for a default `published=true` call, which is all this adapter ever
      // sends; never observed against the real API — see the task report).
      const externalId = result.post_id ?? result.id;
      if (!externalId) {
        return {
          ok: false,
          message: "La publication Facebook a échoué : réponse inattendue de l'API Graph (identifiant de publication absent).",
        };
      }
      return { ok: true, externalId };
    } catch (err) {
      return { ok: false, message: mapFacebookGraphError(err) };
    }
  }
}
