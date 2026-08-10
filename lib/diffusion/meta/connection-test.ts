// lib/diffusion/meta/connection-test.ts — Task 5 (D2+D3): the testable core behind the "Tester la
// connexion" affordance on /settings/social/facebook and /settings/social/instagram. Same overall
// shape as facebook.ts's/instagram.ts's own send(): a small function taking an injectable
// GraphClientConfig (so tests point it at a Bun.serve fake instead of the real network — see
// tests/diffusion-connection-test.test.ts, same idiom as tests/diffusion-facebook.test.ts), reading
// decrypted credentials SERVER-SIDE ONLY (getDecryptedCredentials — never returned to a client,
// never logged, per the Global Constraints), and reusing GraphClient/GraphApiError rather than a
// second HTTP path.
//
// FREE by construction, per the brief (modeled on lib/actions/integration-actions.ts's
// testIntegration, which is explicit that a connectivity check must never spend tokens): each
// function below makes EXACTLY ONE Graph call, a GET of the credentialed node's own basic public
// fields — never a POST, never anything under /photos, /media, or /media_publish. Reading a node's
// `id`/`name` (Page) or `id`/`username` (IG user) costs nothing beyond the normal Graph API rate
// limit, proves the token actually authenticates as that node, and returns nothing sensitive.
//
// Error mapping: reused verbatim from the real adapters (mapFacebookGraphError / mapInstagramGraphError)
// rather than a third copy of "if code === 190" — this is *why* an expired/invalid token (Graph code
// 190) reads identically here as it would from a failed real send, which is the brief's explicit
// requirement. One accepted rough edge from that reuse: the GENERIC (non-190) branch of those
// mappers says "La publication a échoué : …" even though this call is a GET, not a publish — kept
// as-is rather than forked into a near-duplicate mapper, since the brief asks to reuse the mapping
// and the message still surfaces the real underlying Graph error either way (the actionable part).
// The 190 branch — the common, expected case this affordance exists to catch — reads correctly on
// its own ("le jeton a expiré…"), with no mention of "publication" at all.
import { getDecryptedCredentials } from "../settings-core";
import { GraphClient, type GraphClientConfig } from "./graph-client";
import { mapFacebookGraphError } from "./facebook";
import { mapInstagramGraphError } from "./instagram";

export type ConnectionTestResult = { ok: boolean; detail: string };

const FACEBOOK_MISSING =
  "Identifiants Facebook manquants ou non enregistrés. Renseignez l'identifiant de la Page et le " +
  "jeton d'accès ci-dessus, cliquez sur « Enregistrer les identifiants », puis réessayez.";

const INSTAGRAM_MISSING =
  "Identifiants Instagram manquants ou non enregistrés. Renseignez l'identifiant utilisateur " +
  "Instagram et le jeton d'accès ci-dessus, cliquez sur « Enregistrer les identifiants », puis réessayez.";

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
