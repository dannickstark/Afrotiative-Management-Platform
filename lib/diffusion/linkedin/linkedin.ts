// lib/diffusion/linkedin/linkedin.ts — Task 4 (D7): the LinkedIn company-Page adapter behind
// lib/diffusion/channels.ts's SocialChannel interface. Unlike Facebook/Instagram (../meta/*.ts),
// LinkedIn will NOT fetch our render from a URL — spec §1's whole "what makes LinkedIn different"
// table. This adapter must download the bytes itself and PUT them, which is why it is a FOUR-step
// flow, not Instagram's two or Facebook's one, and why it is the one adapter in this codebase that
// runs the SSRF guard (lib/url-guard.ts's isSafePublicHttpUrl) on `input.imageUrl` itself:
//
//   1. Download input.imageUrl (our own public R2 render), guarded, refuse a non-image content type.
//   2. POST /rest/images?action=initializeUpload — LinkedIn hands back an `uploadUrl` (a DIFFERENT
//      host, www.linkedin.com/dms-uploads/..., not the API host) and the `image` URN we will post.
//   3. PUT the bytes to that uploadUrl (rest-client.ts's putBytes — an absolute URL, not a path).
//   4. Poll GET /rest/images/{urn} until `status === "AVAILABLE"`, bounded, injectable sleep — same
//      shape as ../meta/instagram.ts's container poll (spec §1: "structurally the same problem").
//      Only THEN POST /rest/posts. LinkedIn's own Assets docs state plainly that posting before the
//      image finishes processing produces a post that "won't be visible to members" — a 201 that
//      LOOKS like success and is actually silently empty. The poll-timeout-never-posts test is the
//      guard against that failure mode; nothing here may weaken it.
//
// `x-restli-id` (rest-client.ts's whole reason for existing — spec §1: LinkedIn returns the created
// post's id in a RESPONSE HEADER, not the JSON body) is `externalId`. A 201 without that header is
// treated as a hard failure, never a success with an empty/undefined externalId — spec §3.2 step 5's
// own words: "we would otherwise record an empty externalId for a live public post."
//
// ── The duplicate-post window (read before touching this file; spec §3.4 — recorded honestly, NOT
//    claimed closed, same discipline as facebook.ts/instagram.ts) ──
// Wider than Instagram's: THREE network calls (initializeUpload, the PUT, the poll) precede the
// post, not one.
//   - A crash strictly before step 5 (POST /rest/posts) leaves an ORPHAN IMAGE ASSET on LinkedIn's
//     side. Unlike Instagram's orphan CONTAINER, this costs nothing but storage and is genuinely
//     inert: an uploaded image that is never attached to a post is not visible to anyone, ever, on
//     LinkedIn's own Feed — there is no equivalent of a container's 24h auto-expiry to reason about
//     because there is nothing time-sensitive about an unused image asset sitting unattached.
//   - The real, NOT-closed exposure is the same one Facebook's adapter documents: a crash AFTER
//     Graph — sorry, LinkedIn — returns 201 (the post is already live and public) but BEFORE
//     send-core.ts's DB write commits. The reaper (scheduler.ts's reclaimStalePendingDistributions)
//     eventually flips that row back to 'failed', and a retry calls send() again with no memory of
//     the first attempt (SendInput carries no prior externalId) — so it WILL create a second,
//     genuinely duplicate LinkedIn post. Closing this fully needs either SendInput/SendResult growing
//     an early-persistence hook (a D1-interface-level change touching every adapter, out of this
//     task's scope) or a LinkedIn-side "did I already post this?" query the Posts API does not offer.
//   - Mitigation, same as D2/D3: `externalId` is returned the INSTANT `x-restli-id` is read — no
//     second confirmatory call, no work between "LinkedIn's response is in hand" and returning
//     {ok:true, externalId} — and the image URN is folded into every failure message from step 2
//     onward (withImageUrn, below) so an operator can trace how far a failed send got, exactly like
//     Instagram's container id.
//
// ── What is VERIFIED vs. INFERRED here (spec §9 — do not conflate the two in reviews) ──
// Verified against LinkedIn's own current docs (2026-08-10, see the spec): the initializeUpload
// request/response shape, that byte upload is a PUT carrying the Authorization header, the image
// status vocabulary, the "won't be visible to members" consequence, the /rest/posts body shape and
// that its id returns in x-restli-id, the mandatory headers, the 60-day token lifespan, the
// Development Tier's 500-requests/day ceiling (one send costs four).
// INFERRED, unconfirmed against a real API call (Community Management access has not cleared for
// this project — same position D2/D3 shipped in): the poll interval/attempt count (3s × 10, no
// documented processing time exists to size this against); that a 403 on these two endpoints always
// means scope-or-admin rather than something subtler LinkedIn hasn't documented; that 429 cleanly
// means the daily tier quota and nothing else; the exact French wording, which only real failures
// will validate. A known, deliberate SCOPE CUT vs. the full design doc: spec §3.2 step 1 also
// mentions a 413/415 FROM LINKEDIN (not our own download) as deserving "a distinct French message
// rather than a generic failure" — the task brief's own self-review checklist enumerates exactly
// FOUR error classes to make distinguishable (401/403/429/PROCESSING_FAILED), and 413/415 is not
// among them. Left unmapped here rather than speculatively implemented: both fall into the generic
// `mapLinkedInApiError` branch (a truthful but less specific French message). Flagged for whoever
// picks this up next, not silently dropped.
import { getDecryptedCredentials } from "../settings-core";
import { DecryptionFailedError } from "../crypto";
import { isSafePublicHttpUrl } from "@/lib/url-guard";
import type { SendInput, SendResult } from "../channels";
import { LinkedInClient, LinkedInApiError, type LinkedInClientConfig } from "./rest-client";

const SETTINGS_PATH = "/settings/social/linkedin";

const DEFAULT_POLL_MAX_ATTEMPTS = 10;
const DEFAULT_POLL_INTERVAL_MS = 3_000; // 10 × 3s = 30s worst case — INFERRED, see header comment: no documented LinkedIn image-processing time exists to size this against.

const DOWNLOAD_TIMEOUT_MS = 20_000; // same hang guard as lib/studio/images.ts's prepareImage / rest-client.ts's own client timeout — a stuck R2/CDN response must not hang a send() forever.

// altText has no source of its own in SendInput ({articleId, imageUrl, caption} — channels.ts:15-24):
// spec §3.2 step 5 says "<article title, truncated>", but no adapter is handed the article's title,
// only its id. Rather than invent an interface change every other adapter would also have to accept
// (SendInput is shared across all six channels), the caption itself — already the human-reviewed,
// final text for this exact post — is used as the alt text, truncated to a sane accessibility-guidance
// length. INFERRED: LinkedIn does not document an altText length ceiling; this cap is a defensive
// choice, not a documented limit.
const ALT_TEXT_MAX_CHARS = 300;

export function mapLinkedInApiError(err: unknown): string {
  if (err instanceof DecryptionFailedError) {
    return (
      "Impossible de déchiffrer les identifiants LinkedIn enregistrés : la clé de chiffrement du " +
      "serveur (CREDENTIALS_ENCRYPTION_KEY) a probablement changé depuis leur enregistrement. Dans " +
      `Réglages → Réseaux sociaux → LinkedIn (${SETTINGS_PATH}), cliquez sur « Supprimer » puis ` +
      "ressaisissez tous les champs d'identifiants."
    );
  }
  if (err instanceof LinkedInApiError) {
    // 401 — LinkedIn's equivalent of Meta's code 190 (spec §3.3): the token expired or was revoked.
    // Recurs roughly every 60 days (the documented access-token lifespan) — the message says so
    // plainly and points straight at the settings page.
    if (err.status === 401) {
      return (
        "Le jeton d'accès LinkedIn a expiré ou n'est plus valide (les jetons LinkedIn expirent " +
        "environ tous les 60 jours et leur renouvellement automatique n'est pas disponible pour ce " +
        `type d'application). Générez un nouveau jeton et enregistrez-le dans Réglages → Réseaux ` +
        `sociaux → LinkedIn (${SETTINGS_PATH}).`
      );
    }
    // 403 — a DIFFERENT fix from 401 (spec §3.3): the app lacks w_organization_social, or the
    // authenticated member isn't a Page ADMIN. Rotating the token would not fix either cause, so the
    // message must not point at the same remedy as 401.
    if (err.status === 403) {
      return (
        "LinkedIn a refusé la publication (accès refusé, 403) : soit l'application n'a pas la " +
        "permission w_organization_social, soit le compte propriétaire du jeton n'est pas " +
        "administrateur de la Page LinkedIn. Ce n'est pas un jeton expiré — vérifiez la permission " +
        "et le rôle du compte sur la Page avant de régénérer quoi que ce soit."
      );
    }
    // 429 — the Development Tier's 500-requests-per-app-per-day ceiling (spec §3.3); one send costs
    // four. A generic "publication failed" would send an operator hunting in the wrong place.
    if (err.status === 429) {
      return (
        "LinkedIn a refusé la requête : le quota quotidien de l'API semble épuisé (429). Le palier " +
        "de développement de l'API Community Management autorise 500 requêtes par application et par " +
        "jour, et une seule publication en consomme quatre. Réessayez demain, ou demandez le passage " +
        "au palier standard."
      );
    }
    return `La publication LinkedIn a échoué : ${err.message}`;
  }
  if (err instanceof Error) return `La publication LinkedIn a échoué : ${err.message}`;
  return "La publication LinkedIn a échoué : erreur inconnue.";
}

function withImageUrn(message: string, imageUrn: string): string {
  return `${message} (identifiant d'image LinkedIn, pour vérification manuelle : ${imageUrn})`;
}

type ImageStatus = { status?: string };

export type LinkedInChannelConfig = Omit<LinkedInClientConfig, "accessToken"> & {
  // Test-only overrides — same "test injects, production omits, a sane default always exists"
  // convention as ../meta/instagram.ts's InstagramChannelConfig and send-core.ts's own
  // renderStore/fetchImpl. sleepImpl is what lets the timeout test finish in milliseconds instead of
  // paying the real poll interval, while exercising the exact same loop production runs.
  pollMaxAttempts?: number;
  pollIntervalMs?: number;
  sleepImpl?: (ms: number) => Promise<void>;
};

// Never logs a credential (Global Constraint) — accessToken is read once from the decrypted
// credentials, handed to LinkedInClient's constructor, and never otherwise touched: it does not
// appear in any thrown Error message this file constructs (LinkedInApiError.message comes from
// LinkedIn's own response body, which never echoes the token back — rest-client.ts's own guarantee).
export class LinkedInChannel {
  private readonly pollMaxAttempts: number;
  private readonly pollIntervalMs: number;
  private readonly sleepImpl: (ms: number) => Promise<void>;

  constructor(private readonly clientConfig: LinkedInChannelConfig = {}) {
    this.pollMaxAttempts = clientConfig.pollMaxAttempts ?? DEFAULT_POLL_MAX_ATTEMPTS;
    this.pollIntervalMs = clientConfig.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.sleepImpl = clientConfig.sleepImpl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async send(input: SendInput): Promise<SendResult> {
    // Guarded (D2+D3 final review, Important 1 — see facebook.ts's/instagram.ts's header comments
    // for the full failure chain this closes): getDecryptedCredentials can THROW
    // DecryptionFailedError, and send-core.ts has nothing catching send()'s own throw. This is
    // deliberately the FIRST thing send() does — before even attempting the image download — so a
    // rotated key, exactly like missing credentials, refuses before any HTTP call of any kind.
    let credentials: Record<string, string> | null;
    try {
      credentials = await getDecryptedCredentials("linkedin");
    } catch (err) {
      return { ok: false, message: mapLinkedInApiError(err) };
    }
    const organizationUrn = credentials?.organizationUrn;
    const accessToken = credentials?.accessToken;

    if (!organizationUrn || !accessToken) {
      return {
        ok: false,
        message:
          "Identifiants LinkedIn manquants. Renseignez l'URN de l'organisation et le jeton d'accès " +
          `dans Réglages → Réseaux sociaux → LinkedIn (${SETTINGS_PATH}).`,
      };
    }

    // Step 1 — download the render bytes ourselves; LinkedIn will not fetch a URL for us (spec §1).
    // guardBypassed mirrors lib/studio/images.ts's prepareImage EXACTLY (same convention, read that
    // file before changing this): fetchImpl alone is never enough to lift the SSRF guard — it also
    // requires NODE_ENV === "test", so a future production caller that happens to inject a custom
    // fetchImpl (a cache/retry wrapper, say) cannot silently disable the guard. In production,
    // clientConfig.fetchImpl is always undefined (SOCIAL_CHANNELS.linkedin.send constructs a bare
    // `new LinkedInChannel()`), so the guard is unconditionally active there.
    const fetchImpl = this.clientConfig.fetchImpl ?? fetch;
    const guardBypassed = !!this.clientConfig.fetchImpl && process.env.NODE_ENV === "test";
    if (!guardBypassed && !isSafePublicHttpUrl(input.imageUrl)) {
      return {
        ok: false,
        message: `Image refusée : l'URL du rendu (« ${input.imageUrl} ») n'est pas une adresse publique autorisée.`,
      };
    }

    let bytes: ArrayBuffer;
    let contentType: string;
    try {
      const res = await fetchImpl(input.imageUrl, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
      if (!res.ok) {
        return { ok: false, message: `Le téléchargement de l'image du rendu a échoué (HTTP ${res.status}).` };
      }
      contentType = res.headers.get("content-type") ?? "";
      if (!contentType.toLowerCase().startsWith("image/")) {
        return {
          ok: false,
          message:
            `Le rendu à publier n'est pas une image exploitable (type de contenu reçu : « ${contentType || "inconnu"} »). ` +
            "LinkedIn accepte les images JPG, PNG ou GIF.",
        };
      }
      bytes = await res.arrayBuffer();
    } catch (err) {
      return { ok: false, message: `Le téléchargement de l'image du rendu a échoué : ${(err as Error).message}` };
    }

    const client = new LinkedInClient({ ...this.clientConfig, accessToken });

    // Step 2 — initialize the upload. The image urn is captured the INSTANT the response is parsed
    // (see this file's header comment on the duplicate-post window) and threaded into every
    // subsequent failure message.
    let uploadUrl: string;
    let imageUrn: string;
    try {
      const init = await client.post<{ value?: { uploadUrl?: string; image?: string } }>(
        "/rest/images",
        { initializeUploadRequest: { owner: organizationUrn } },
        { action: "initializeUpload" },
      );
      if (!init.body.value?.uploadUrl || !init.body.value?.image) {
        return {
          ok: false,
          message: "L'initialisation du téléversement de l'image LinkedIn a échoué : réponse inattendue de l'API (uploadUrl ou image absents).",
        };
      }
      uploadUrl = init.body.value.uploadUrl;
      imageUrn = init.body.value.image;
    } catch (err) {
      return { ok: false, message: mapLinkedInApiError(err) };
    }

    // Step 3 — PUT the bytes to the (separate-host) uploadUrl.
    try {
      await client.putBytes(uploadUrl, bytes, contentType);
    } catch (err) {
      return { ok: false, message: withImageUrn(mapLinkedInApiError(err), imageUrn) };
    }

    // Step 4 — poll until AVAILABLE, bounded, sleeping between attempts (no busy-loop). A timeout
    // here must NEVER fall through to step 5 — see this file's header comment and spec §1: posting
    // before the image is ready produces a post that "won't be visible to members", a 201 that looks
    // like success and is not.
    const pollResult = await this.pollUntilAvailable(client, imageUrn);
    if (!pollResult.ready) return { ok: false, message: pollResult.message };

    // Step 5 — post. A 201 without x-restli-id is a hard failure, not a success with an empty id
    // (spec §3.2 step 5's own words) — we would otherwise record an empty externalId for a post that
    // is, in fact, live and public.
    try {
      const postRes = await client.post<unknown>("/rest/posts", {
        author: organizationUrn,
        commentary: input.caption,
        visibility: "PUBLIC",
        distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
        content: { media: { altText: truncateAltText(input.caption), id: imageUrn } },
        lifecycleState: "PUBLISHED",
        isReshareDisabledByAuthor: false,
      });
      const externalId = postRes.headers.get("x-restli-id");
      if (!externalId) {
        return {
          ok: false,
          message: withImageUrn(
            "La publication LinkedIn a échoué : réponse inattendue de l'API (en-tête x-restli-id absent).",
            imageUrn,
          ),
        };
      }
      return { ok: true, externalId };
    } catch (err) {
      return { ok: false, message: withImageUrn(mapLinkedInApiError(err), imageUrn) };
    }
  }

  // A dedicated result type, not SendResult — mirrors ../meta/instagram.ts's pollUntilReady exactly
  // (same bounded-poll-with-injectable-sleep shape, spec §1's explicit instruction to reuse it).
  private async pollUntilAvailable(
    client: LinkedInClient, imageUrn: string,
  ): Promise<{ ready: true } | { ready: false; message: string }> {
    for (let attempt = 1; attempt <= this.pollMaxAttempts; attempt++) {
      let status: ImageStatus;
      try {
        const res = await client.get<ImageStatus>(`/rest/images/${imageUrn}`);
        status = res.body;
      } catch (err) {
        return { ready: false, message: withImageUrn(mapLinkedInApiError(err), imageUrn) };
      }

      if (status.status === "AVAILABLE") return { ready: true };
      if (status.status === "PROCESSING_FAILED") {
        // LinkedIn rejected the IMAGE itself here — not the token (spec's own distinction, Global
        // Constraints) — the message says so explicitly to stop an operator from rotating a fine token.
        return {
          ready: false,
          message: withImageUrn(
            "LinkedIn a rejeté l'image du rendu elle-même (statut : PROCESSING_FAILED) — ce n'est pas " +
            "un problème de jeton. Vérifiez le format et le poids du fichier, puis réessayez.",
            imageUrn,
          ),
        };
      }
      // WAITING_UPLOAD, PROCESSING, or any other/unknown value: keep polling — never busy-loop,
      // always actually await a delay between attempts (the sleepImpl call below).
      if (attempt < this.pollMaxAttempts) await this.sleepImpl(this.pollIntervalMs);
    }

    return {
      ready: false,
      message: withImageUrn(
        "Le délai d'attente pour le traitement de l'image LinkedIn a été dépassé : elle n'a pas fini " +
        "d'être traitée par LinkedIn (statut jamais passé à AVAILABLE). Réessayez dans quelques instants.",
        imageUrn,
      ),
    };
  }
}

function truncateAltText(caption: string): string {
  return caption.length > ALT_TEXT_MAX_CHARS ? `${caption.slice(0, ALT_TEXT_MAX_CHARS - 1)}…` : caption;
}
