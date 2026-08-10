// lib/diffusion/meta/instagram.ts — Task 3 (D3): the Instagram feed-post adapter behind
// lib/diffusion/channels.ts's SocialChannel interface. Unlike Facebook (./facebook.ts, ONE Graph
// call), Instagram publishing is TWO steps, both verified directly against Meta's own current docs
// (developers.facebook.com/docs/instagram-platform/instagram-graph-api/content-publishing — fetched
// 2026-08-10; see the task report for exactly what was fetched vs. inferred):
//
//   1. POST /{ig-user-id}/media with `image_url` + `caption` (+ `access_token`) creates a MEDIA
//      CONTAINER — an object Instagram will asynchronously fetch the image into. Response: `{id}`,
//      the container id. `media_type` is NOT sent (confirmed: it defaults to IMAGE for a plain
//      image post — the docs only document it as REQUIRED for VIDEO/REELS/STORIES/CAROUSEL).
//   2. The container is asynchronous — Meta's own docs state that calling media_publish before the
//      container reaches `FINISHED` "may not return the published media ID" (their own, inferred-
//      sounding wording — see the report). So: GET /{container-id}?fields=status_code and poll until
//      `FINISHED`, bounded attempts, sleeping between polls (no busy-loop).
//   3. POST /{ig-user-id}/media_publish with `creation_id=<container-id>` (+ `access_token`)
//      actually publishes it. Response: `{id}`, the published media's id — this is `externalId`.
//
// Meta's documented status_code vocabulary (container status poll): FINISHED, IN_PROGRESS, ERROR,
// EXPIRED, PUBLISHED. FINISHED/IN_PROGRESS/ERROR are handled explicitly below (verified against the
// docs). EXPIRED ("container not published within 24 hours") is treated the same as ERROR here — it
// cannot occur within THIS adapter's own bounded poll (which times out in well under 24h and never
// itself sits on an old container across separate send() calls), so it is handled only as
// defense-in-depth, UNTESTED against a real container that has genuinely sat unpublished for a day.
// PUBLISHED is treated as "keep polling" (falls through to the default/unknown branch) rather than a
// terminal success on its own — INFERRED, not observed: this adapter never queries a container AFTER
// calling media_publish, so whether Instagram ever actually returns PUBLISHED to a call made BEFORE
// media_publish, or whether it's reachable at all from a container this adapter created and hasn't
// published yet, is untested against the real API.
//
// ── The duplicate-post window (read before touching this file) — sharper than Facebook's ──
// Facebook's window is "did the DB write commit after Graph accepted". Instagram's two-step flow
// adds a genuinely NEW failure mode: a crash strictly BETWEEN step 1 (container created) and step 3
// (media_publish called) leaves an ORPHAN CONTAINER — nothing public yet (a container alone is never
// visible on the feed), but real state on Meta's side that this process now has no memory of. A
// retry (fresh send() call, per SendInput/SendResult's stateless contract — see facebook.ts's same
// note) creates a SECOND container and, eventually, a genuinely duplicate published post — the
// first orphan just expires unpublished after 24h (Meta's own EXPIRED semantics) and is otherwise
// silently wasted, not merged with or deduplicated against the second attempt.
//
// "Record the container id as soon as it exists" is honored here the same way Facebook honors
// "write externalId as early as the API allows": the container id is captured in a local variable
// the INSTANT step 1's response is parsed, and if ANYTHING after that point fails (poll timeout,
// ERROR/EXPIRED status, or the media_publish call itself failing), that container id is folded into
// the returned French failure message — so it lands in `distributions.lastError` (send-core.ts) and
// is visible to an operator/support engineer for manual reconciliation via Meta's own tools, rather
// than being lost the moment this function returns. This is NOT the same as durably recording it in
// a structured column BEFORE the poll starts (which would need SendResult to grow a mid-flight
// persistence hook back into send-core.ts's `distributions` write — out of this task's file list:
// channels.ts's SendInput/SendResult contract is shared by every channel, StubChannel included, and
// widening it is a D1-interface-level change this task does not make). If the process is killed
// mid-poll (not just a Graph error), that container id is lost with the process — this remains open,
// exactly like Facebook's window, and for the same underlying reason: adapters have no direct DB
// access in this architecture.
import { getDecryptedCredentials } from "../settings-core";
import type { SendInput, SendResult } from "../channels";
import { GraphClient, GraphApiError, type GraphClientConfig } from "./graph-client";

const TOKEN_EXPIRED_CODE = 190; // same Graph OAuthException family as Facebook — see facebook.ts.
const SETTINGS_PATH = "/settings/social/instagram";

const DEFAULT_POLL_MAX_ATTEMPTS = 10;
const DEFAULT_POLL_INTERVAL_MS = 3_000; // 10 × 3s = 30s worst case — Meta's own guidance is "once per minute for up to 5 minutes" for a much heavier video container; a plain image container finishes far faster in practice, so a shorter/tighter bound is deliberate here rather than copied verbatim (INFERRED trade-off, not observed against real timing).

export function mapInstagramGraphError(err: unknown): string {
  if (err instanceof GraphApiError) {
    if (err.code === TOKEN_EXPIRED_CODE) {
      return (
        "Le jeton d'accès Instagram a expiré ou n'est plus valide (le même jeton que celui de la " +
        "Page Facebook liée, qui expire périodiquement, environ tous les 60 jours). Générez un " +
        `nouveau jeton et enregistrez-le dans Réglages → Réseaux sociaux → Instagram (${SETTINGS_PATH}).`
      );
    }
    return `La publication Instagram a échoué : ${err.graphMessage}`;
  }
  if (err instanceof Error) return `La publication Instagram a échoué : ${err.message}`;
  return "La publication Instagram a échoué : erreur inconnue.";
}

type ContainerStatus = { status_code?: string };

function withContainerId(message: string, containerId: string): string {
  return `${message} (identifiant du conteneur Instagram, pour vérification manuelle : ${containerId})`;
}

export type InstagramChannelConfig = GraphClientConfig & {
  // Test-only overrides — same "test injects, production omits, a sane default always exists"
  // convention as lib/diffusion/send-core.ts's renderStore/fetchImpl and GraphClient's own
  // baseUrl/fetchImpl. sleepImpl in particular is what makes the timeout test finish in
  // milliseconds instead of tests/diffusion-instagram.test.ts actually waiting out real timers —
  // "do not busy-loop" is satisfied by actually awaiting a delay between polls (never a tight
  // `while` re-checking with no wait), but that delay is itself swappable so a test can prove the
  // TIMEOUT behavior without paying its real-world wall-clock cost.
  pollMaxAttempts?: number;
  pollIntervalMs?: number;
  sleepImpl?: (ms: number) => Promise<void>;
};

// Never logs a credential (Global Constraint) — same discipline as facebook.ts.
export class InstagramChannel {
  private readonly pollMaxAttempts: number;
  private readonly pollIntervalMs: number;
  private readonly sleepImpl: (ms: number) => Promise<void>;

  constructor(private readonly clientConfig: InstagramChannelConfig = {}) {
    this.pollMaxAttempts = clientConfig.pollMaxAttempts ?? DEFAULT_POLL_MAX_ATTEMPTS;
    this.pollIntervalMs = clientConfig.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.sleepImpl = clientConfig.sleepImpl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async send(input: SendInput): Promise<SendResult> {
    const credentials = await getDecryptedCredentials("instagram");
    const igUserId = credentials?.igUserId;
    const pageAccessToken = credentials?.pageAccessToken;

    // Refuse BEFORE any HTTP call — same contract/test shape as facebook.ts (fake Graph server
    // receives zero requests; see tests/diffusion-instagram.test.ts).
    if (!igUserId || !pageAccessToken) {
      return {
        ok: false,
        message:
          "Identifiants Instagram manquants. Renseignez l'identifiant utilisateur Instagram et le " +
          `jeton d'accès dans Réglages → Réseaux sociaux → Instagram (${SETTINGS_PATH}).`,
      };
    }

    const client = new GraphClient(this.clientConfig);

    // Step 1 — create the container. Its id is captured immediately below and threaded into every
    // subsequent failure message (see this file's header comment on why that's the best available
    // mitigation within the current SocialChannel/SendResult contract).
    let containerId: string;
    try {
      const created = await client.post<{ id?: string }>(`/${igUserId}/media`, {
        image_url: input.imageUrl,
        caption: input.caption,
        access_token: pageAccessToken,
      });
      if (!created.id) {
        return { ok: false, message: "La création du conteneur Instagram a échoué : réponse inattendue de l'API Graph (identifiant absent)." };
      }
      containerId = created.id;
    } catch (err) {
      return { ok: false, message: mapInstagramGraphError(err) };
    }

    // Step 2 — poll until FINISHED, bounded, sleeping between attempts (no busy-loop).
    const pollResult = await this.pollUntilReady(client, containerId, pageAccessToken);
    if (!pollResult.ready) return { ok: false, message: pollResult.message };

    // Step 3 — publish.
    try {
      const published = await client.post<{ id?: string }>(`/${igUserId}/media_publish`, {
        creation_id: containerId,
        access_token: pageAccessToken,
      });
      if (!published.id) {
        return {
          ok: false,
          message: withContainerId(
            "La publication Instagram a échoué : réponse inattendue de l'API Graph (identifiant de publication absent).",
            containerId,
          ),
        };
      }
      return { ok: true, externalId: published.id };
    } catch (err) {
      // The crash-after-container-ready-before-publish-SUCCEEDS case this file's header comment
      // describes as "genuinely sharper than Facebook's window" is a process KILL here, which this
      // catch block cannot observe (there is no code left to run) — this branch only covers a
      // Graph-level REJECTION of the publish call itself (a real, observable failure), not a crash.
      return { ok: false, message: withContainerId(mapInstagramGraphError(err), containerId) };
    }
  }

  // A dedicated result type, not SendResult — FINISHED has no externalId of its own to report (the
  // published media id only exists after step 3), so reusing SendResult here would force an
  // awkward `externalId: ""` placeholder on the success branch.
  private async pollUntilReady(
    client: GraphClient, containerId: string, accessToken: string,
  ): Promise<{ ready: true } | { ready: false; message: string }> {
    for (let attempt = 1; attempt <= this.pollMaxAttempts; attempt++) {
      let status: ContainerStatus;
      try {
        status = await client.get<ContainerStatus>(`/${containerId}`, { fields: "status_code", access_token: accessToken });
      } catch (err) {
        return { ready: false, message: withContainerId(mapInstagramGraphError(err), containerId) };
      }

      if (status.status_code === "FINISHED") return { ready: true };
      if (status.status_code === "ERROR") {
        return {
          ready: false,
          message: withContainerId(
            "Instagram n'a pas pu traiter l'image du conteneur (statut : ERROR). Vérifiez que l'image est accessible publiquement, puis réessayez.",
            containerId,
          ),
        };
      }
      if (status.status_code === "EXPIRED") {
        // Defensive only — see this file's header comment: unreachable within this adapter's own
        // bounded poll in practice, untested against a real 24h-stale container.
        return {
          ready: false,
          message: withContainerId(
            "Le conteneur Instagram a expiré avant d'avoir pu être publié (statut : EXPIRED). Relancez l'envoi.",
            containerId,
          ),
        };
      }
      // IN_PROGRESS, PUBLISHED (see header comment), or any other/unknown value: keep polling —
      // never busy-loop, always actually wait between attempts.
      if (attempt < this.pollMaxAttempts) await this.sleepImpl(this.pollIntervalMs);
    }

    return {
      ready: false,
      message: withContainerId(
        "Le délai d'attente pour la préparation de l'image Instagram a été dépassé. L'image met " +
        "parfois plus de temps que prévu à être traitée par Instagram — réessayez dans quelques instants.",
        containerId,
      ),
    };
  }
}
