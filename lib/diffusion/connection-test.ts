// lib/diffusion/connection-test.ts — Task 5 (D2+D3), moved and extended in Task 6 (D7): the
// testable core behind the "Tester la connexion" affordance on /settings/social/facebook,
// /settings/social/instagram and (Task 6) /settings/social/linkedin. Same overall shape as each
// adapter's own send(): a small function taking an injectable client config (so tests point it at
// a Bun.serve fake instead of the real network — see tests/diffusion-connection-test.test.ts, same
// idiom as tests/diffusion-facebook.test.ts/diffusion-linkedin.test.ts), reading decrypted
// credentials SERVER-SIDE ONLY (getDecryptedCredentials — never returned to a client, never
// logged, per the Global Constraints), and reusing each channel's own client/error mapper rather
// than a second HTTP path.
//
// FREE by construction, per the brief (modeled on lib/actions/integration-actions.ts's
// testIntegration, which is explicit that a connectivity check must never spend tokens): each
// function below makes EXACTLY ONE HTTP call, a GET of the credentialed node's own basic public
// fields — never a POST, never anything under /photos, /media, /media_publish (Meta) or
// /rest/images, /rest/posts (LinkedIn). Reading a node's `id`/`name` (Facebook Page), `id`/
// `username` (IG user) or `id`/`localizedName` (LinkedIn organization) costs nothing beyond the
// normal API rate limit, proves the token actually authenticates as that node, and returns nothing
// sensitive.
//
// Error mapping: reused verbatim from the real adapters (mapFacebookGraphError /
// mapInstagramGraphError / mapLinkedInApiError) rather than a fourth copy of "if status/code is
// this, say that" — this is *why* an expired/invalid token (Graph code 190, LinkedIn 401) reads
// identically here as it would from a failed real send, which is the brief's explicit requirement.
// One accepted rough edge from that reuse, carried over from Task 5 unchanged: the GENERIC branch
// of these mappers can say "La publication a échoué : …"/"a échoué" even though this call is a
// GET, not a publish — kept as-is rather than forked into a near-duplicate mapper, since the brief
// asks to reuse the mapping and the message still surfaces the real underlying API error either
// way (the actionable part). The most common, expected failure (an expired token) reads correctly
// on its own in every mapper, with no mention of "publication" at all.
//
// ── Task 6 (D7) — file moved from lib/diffusion/meta/connection-test.ts to here ──
// Judgement call, made explicit rather than left implicit (per the task brief): adding a LinkedIn
// branch meant either (a) leaving this file under meta/ and importing lib/diffusion/linkedin/* into
// a directory whose own name says "Meta", or (b) moving it up to lib/diffusion/ — a sibling of
// settings-core.ts, channels.ts and setup-guide.ts, none of which are Meta- or LinkedIn-specific
// either. Chose (b): this module's whole reason to exist is that it is the SAME affordance across
// every channel that has a real adapter (one free read, the channel's own error mapping, gated by
// hasAllCredentials) — meta/ and linkedin/ are where each channel's OWN client/adapter/error-mapper
// live, not where cross-channel orchestration belongs. Leaving it under meta/ would have made the
// LinkedIn import read backwards (a LinkedIn call reaching INTO a directory named after a different
// platform) for no benefit — nothing about this file's logic is Meta-specific, and the directory
// split (meta/ vs linkedin/) exists to separate PLATFORM-specific code, which this file precisely
// is not. Every import of this module updated: tests/diffusion-connection-test.test.ts and
// lib/actions/diffusion-settings-actions.ts.
import { getDecryptedCredentials } from "./settings-core";
import { GraphClient, type GraphClientConfig } from "./meta/graph-client";
import { mapFacebookGraphError } from "./meta/facebook";
import { mapInstagramGraphError } from "./meta/instagram";
import { LinkedInClient, type LinkedInClientConfig } from "./linkedin/rest-client";
import { mapLinkedInApiError } from "./linkedin/linkedin";

export type ConnectionTestResult = { ok: boolean; detail: string };

const FACEBOOK_MISSING =
  "Identifiants Facebook manquants ou non enregistrés. Renseignez l'identifiant de la Page et le " +
  "jeton d'accès ci-dessus, cliquez sur « Enregistrer les identifiants », puis réessayez.";

const INSTAGRAM_MISSING =
  "Identifiants Instagram manquants ou non enregistrés. Renseignez l'identifiant utilisateur " +
  "Instagram et le jeton d'accès ci-dessus, cliquez sur « Enregistrer les identifiants », puis réessayez.";

const LINKEDIN_MISSING =
  "Identifiants LinkedIn manquants ou non enregistrés. Renseignez l'URN de l'organisation et le " +
  "jeton d'accès ci-dessus, cliquez sur « Enregistrer les identifiants », puis réessayez.";

// Tests the credentials currently STORED for "facebook" (never whatever is unsaved in the form —
// there is nothing else to test server-side; see social-channel-form.tsx's own comment on why
// credential inputs are write-only). GET /{page-id}?fields=id,name.
//
// The WHOLE body is inside the try — not just the GraphClient.get call — same shape as
// testIntegration (lib/actions/integration-actions.ts:11-14), the brief's own named model. Fix for
// a review finding: getDecryptedCredentials (settings-core.ts) calls decryptSecret
// (lib/diffusion/crypto.ts), which THROWS DecryptionFailedError if CREDENTIALS_ENCRYPTION_KEY was
// rotated without re-entering credentials — documented in this same diff's own
// DEPLOYMENT.md/.env.example text as a real, if discouraged, production scenario. Left uncaught,
// that exception crosses the "use server" boundary (diffusion-settings-actions.ts's
// testChannelConnection) and Next.js redacts it to a generic, non-French message in production
// (node_modules/next/dist/docs/01-app/01-getting-started/10-error-handling.md: expected errors
// should be modeled as return values, not thrown) — breaking both the French-strings requirement
// and this feature's whole diagnostic purpose for exactly the "unconfigured/rotated encryption
// key" edge case. Every other error path in this file already returns { ok: false, detail }; this
// makes decryption failures no exception to that.
export async function testFacebookConnection(clientConfig: GraphClientConfig = {}): Promise<ConnectionTestResult> {
  try {
    const credentials = await getDecryptedCredentials("facebook");
    const pageId = credentials?.pageId;
    const pageAccessToken = credentials?.pageAccessToken;
    if (!pageId || !pageAccessToken) return { ok: false, detail: FACEBOOK_MISSING };

    const client = new GraphClient(clientConfig);
    const page = await client.get<{ id?: string; name?: string }>(`/${pageId}`, {
      fields: "id,name",
      access_token: pageAccessToken,
    });
    // Names which Page it actually reached — "so success is meaningful rather than a bare green
    // tick" (brief) — rather than just "ok".
    return {
      ok: true,
      detail: `Connexion Facebook vérifiée — Page « ${page.name ?? "(nom indisponible)"} » (id ${page.id ?? pageId}).`,
    };
  } catch (err) {
    return { ok: false, detail: mapFacebookGraphError(err) };
  }
}

// Tests the credentials currently STORED for "instagram". GET /{ig-user-id}?fields=id,username.
// Same whole-body try/catch as testFacebookConnection above, and for the identical reason
// (getDecryptedCredentials can throw DecryptionFailedError on a rotated/wrong encryption key).
export async function testInstagramConnection(clientConfig: GraphClientConfig = {}): Promise<ConnectionTestResult> {
  try {
    const credentials = await getDecryptedCredentials("instagram");
    const igUserId = credentials?.igUserId;
    const pageAccessToken = credentials?.pageAccessToken;
    if (!igUserId || !pageAccessToken) return { ok: false, detail: INSTAGRAM_MISSING };

    const client = new GraphClient(clientConfig);
    const account = await client.get<{ id?: string; username?: string }>(`/${igUserId}`, {
      fields: "id,username",
      access_token: pageAccessToken,
    });
    return {
      ok: true,
      detail: `Connexion Instagram vérifiée — compte @${account.username ?? "(nom indisponible)"} (id ${account.id ?? igUserId}).`,
    };
  } catch (err) {
    return { ok: false, detail: mapInstagramGraphError(err) };
  }
}

// Task 6 (D7) — tests the credentials currently STORED for "linkedin". GET
// /rest/organizations/{numeric id} (the organization node the stored organizationUrn names —
// verified against LinkedIn's own current Organization Lookup API docs, 2026-08-10: this exact
// path, and that a non-admin-scoped read still returns at least `id`/`localizedName` for an
// organization the caller can read). Same whole-body try/catch as the two functions above, and for
// the identical reason (getDecryptedCredentials can throw DecryptionFailedError on a rotated/wrong
// encryption key — mapLinkedInApiError already has a branch for it, reused here rather than
// duplicated, exactly as this file's header comment describes for the other two channels).
//
// organizationUrn is stored as the FULL urn:li:organization:<id> string (it is sent verbatim as
// `owner`/`author` by the real adapter, lib/diffusion/linkedin/linkedin.ts) — but the Organization
// Lookup path takes the bare numeric id, not the urn. The id is extracted here, locally, and never
// makes an HTTP call if it cannot be: a malformed URN fails BEFORE any request, the same
// zero-request-on-bad-input shape as the "missing credentials" branch just above it.
//
// Proves only that the token and the organization id resolve — it does NOT prove publish
// permission (w_organization_social + Page ADMIN rights), which only a real publish exercises. The
// setup guide (./setup-guide.ts) and DEPLOYMENT.md say this explicitly rather than let a green
// "Connexion vérifiée" imply more than it does.
export async function testLinkedInConnection(
  clientConfig: Omit<LinkedInClientConfig, "accessToken"> = {},
): Promise<ConnectionTestResult> {
  try {
    const credentials = await getDecryptedCredentials("linkedin");
    const organizationUrn = credentials?.organizationUrn;
    const accessToken = credentials?.accessToken;
    if (!organizationUrn || !accessToken) return { ok: false, detail: LINKEDIN_MISSING };

    const organizationId = /:(\d+)$/.exec(organizationUrn)?.[1];
    if (!organizationId) {
      return {
        ok: false,
        detail:
          `URN d'organisation LinkedIn invalide (« ${organizationUrn} ») : le format attendu est ` +
          "urn:li:organization:<identifiant numérique>. Corrigez la valeur enregistrée puis réessayez.",
      };
    }

    const client = new LinkedInClient({ ...clientConfig, accessToken });
    const org = await client.get<{ id?: number; localizedName?: string }>(`/rest/organizations/${organizationId}`);
    // Names which organization it actually reached — "so success is meaningful rather than a bare
    // green tick" (brief), same as the Facebook/Instagram branches above — rather than just "ok".
    return {
      ok: true,
      detail:
        `Connexion LinkedIn vérifiée — organisation « ${org.body.localizedName ?? "(nom indisponible)"} » ` +
        `(${organizationUrn}). Ceci confirme que le jeton et l'identifiant d'organisation sont ` +
        "valides — pas que la publication est autorisée : cela dépend en plus de la permission " +
        "w_organization_social et du rôle administrateur sur la Page, que seul un envoi réel vérifie.",
    };
  } catch (err) {
    return { ok: false, detail: mapLinkedInApiError(err) };
  }
}
