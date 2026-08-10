// lib/diffusion/setup-guide.ts — Task 4 (D2+D3): the in-app "how do I connect this channel" guide,
// rendered on /settings/social/[channel] (components/settings/channel-setup-guide.tsx) beside the
// credential fields it walks the admin through filling (SOCIAL_CHANNELS[channel].credentialFields,
// ./channels.ts). Pure structured data — no JSX, no French-string-formatting logic — same split as
// channels.ts vs. social-channel-form.tsx: this file only says WHAT the steps are, the component
// says how to render them.
//
// Why this exists (roadmap, "Exigence transverse — guide de connexion dans le produit"): a token
// field with no instructions is not a self-serve integration. An admin who has never opened the
// Meta developer console does not know that an Instagram Business account must be linked to a
// Facebook Page before `instagram_content_publish` is even requestable, or that a Page access token
// comes from exchanging a short-lived user token twice, not from one click.
//
// ── Verification method for the Facebook/Instagram steps below (fetched 2026-08-10) ──
// Every permission name, dependency, endpoint shape, and token-exchange step below was checked
// directly against Meta's OWN current developer docs (not recalled from training data) — see the
// task report for the exact pages fetched. Two things worth flagging up front because they cut
// against what training data alone would suggest:
//   1. Meta now has TWO parallel Instagram login/permission sets: a newer "Instagram Login" path
//      (`instagram_business_basic` + `instagram_business_content_publish`, its own separate token,
//      no Facebook Page involved) and the older "Facebook Login" path (`instagram_basic` +
//      `instagram_content_publish` + `pages_read_engagement`, reusing the Page's own access token).
//      This codebase's InstagramChannel (./meta/instagram.ts) reads `credentials.pageAccessToken` —
//      the SAME key as Facebook — so it is unambiguously the second, Facebook Login path. The guide
//      below uses that path's permission names on purpose; the `instagram_business_*` names are a
//      different, unused integration and are deliberately not mentioned to avoid steering an admin
//      onto a token this adapter cannot use.
//   2. Meta's current docs state a Page access token derived from a long-lived USER token via
//      `/{user-id}/accounts` "does not have an expiration date" by itself — it is invalidated only
//      by specific events (password change, permission revocation, removal from the Page's admin
//      list, long disuse), not a fixed clock. That is a real, more precise statement than "~60 days"
//      — it does not contradict facebook.ts/instagram.ts's existing French error copy (which treats
//      an expired/invalid token, Graph error code 190, as recurring "environ tous les 60 jours" —
//      that copy is about the observed *symptom* and a safe *rotation cadence to check*, not a claim
//      about Meta's token-lifetime mechanism). This guide states the more precise mechanism and
//      still recommends the same ~60-day check-in, so the two pieces of copy read as consistent to
//      an admin, not contradictory.
import { CHANNELS, type Channel } from "@/lib/studio";

export type SetupGuideStep = {
  readonly title: string;
  readonly body: string; // French, plain text (no markdown) — the component decides how to wrap/link it
  readonly href?: string; // optional external link (Meta/LinkedIn/TikTok's own docs or console)
  // Optional « valeur à copier ici » pointer: names a KEY in that channel's
  // SOCIAL_CHANNELS[channel].credentialFields (./channels.ts), e.g. "pageId" — never a display
  // label. The component resolves it to that field's French label to render "→ Renseignez : …".
  // Absent on purely informational steps (create an app, request a review, read a prerequisite).
  readonly fieldHint?: string;
};

// Per-channel, ordered. Facebook, Instagram and (Task 4, D7 — minimally, see that entry's own
// comment) LinkedIn are the three channels with a real adapter today and get a fieldHint-bearing
// guide. The other three get an honest placeholder — WhatsApp names what D4 will need so that task
// only fills the shape in; X and TikTok say plainly that the channel is deferred and why (roadmap
// "Décisions D2 → D7"). Every channel still gets at least one real step — even a placeholder must
// say something an admin (or the next task) can act on, never just "coming soon".
export const SETUP_GUIDES: Readonly<Record<Channel, readonly SetupGuideStep[]>> = {
  facebook: [
    {
      title: "Créer une application Meta for Developers",
      body:
        "Depuis le tableau de bord Meta for Developers, créez une application de type « Entreprise », " +
        "rattachée au portefeuille Business qui possède la Page Facebook (et, si vous configurez aussi " +
        "Instagram, le compte Instagram professionnel lié à cette même Page). C'est cette application " +
        "qui portera les permissions demandées ci-dessous.",
      href: "https://developers.facebook.com/apps/",
    },
    {
      title: "Demander les permissions pages_show_list, pages_read_engagement et pages_manage_posts",
      body:
        "Ajoutez ces trois permissions à l'application. pages_manage_posts (créer une publication sur " +
        "la Page) dépend explicitement des deux autres — sans elles, la demande de la troisième est " +
        "refusée. Tant qu'elles restent en mode développement, seuls les rôles admin/testeur de " +
        "l'application peuvent générer un jeton qui les porte.",
      href: "https://developers.facebook.com/docs/permissions/reference/pages_manage_posts",
    },
    {
      title: "Passer en revue d'application (App Review)",
      body:
        "Pour publier au nom de n'importe quel administrateur de la Page — pas seulement les comptes " +
        "déjà rattachés à l'application — Meta exige une revue : un descriptif du cas d'usage et un " +
        "enregistrement vidéo montrant le parcours de connexion puis l'utilisation réelle de chaque " +
        "permission. Comptez plusieurs semaines. Lancez cette démarche dès maintenant, en parallèle du " +
        "reste : elle ne bloque pas le développement, mais bloque la mise en production réelle.",
      href: "https://developers.facebook.com/docs/app-review",
    },
    {
      title: "Générer un jeton utilisateur puis l'échanger contre un jeton longue durée",
      body:
        "Générez un jeton d'accès utilisateur courte durée pour un compte administrateur de la Page " +
        "(par exemple via l'explorateur Graph API, avec les permissions ci-dessus cochées), puis " +
        "échangez-le côté serveur — jamais depuis un navigateur, la clé secrète de l'application y " +
        "transite — contre un jeton longue durée : GET /{version}/oauth/access_token?" +
        "grant_type=fb_exchange_token&client_id=<id app>&client_secret=<secret app>&" +
        "fb_exchange_token=<jeton courte durée>. Ce jeton UTILISATEUR longue durée dure environ 60 " +
        "jours d'après la documentation Meta.",
      href: "https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived",
    },
    {
      title: "Récupérer l'identifiant de la Page (Page ID)",
      body:
        "Avec ce jeton utilisateur longue durée, appelez GET /{version}/me/accounts : la réponse liste " +
        "chaque Page administrée par ce compte, avec son id et un jeton de Page dérivé pour chacune. " +
        "Copiez l'id de la bonne Page ici.",
      fieldHint: "pageId",
    },
    {
      title: "Copier le jeton de Page ici",
      body:
        "Dans cette même réponse /me/accounts, copiez le champ access_token associé à la Page — c'est " +
        "le jeton que cette application utilise pour publier. D'après la documentation Meta actuelle, " +
        "ce jeton de Page n'a pas de date d'expiration fixe une fois dérivé d'un jeton utilisateur " +
        "longue durée ; il est invalidé par un changement de mot de passe, une révocation de " +
        "permission ou un retrait du rôle sur la Page. Par prudence, vérifiez-le et régénérez-le " +
        "environ tous les 60 jours — le message affiché ici en cas de jeton expiré ou invalide part de " +
        "la même hypothèse.",
      fieldHint: "pageAccessToken",
    },
  ],
  instagram: [
    {
      title: "Lier le compte Instagram professionnel à la Page Facebook",
      body:
        "Le compte Instagram doit être un compte professionnel (Business ou Creator) relié à la Page " +
        "Facebook via Meta Business Suite. Sans ce lien, l'identifiant Instagram (IG User ID) n'existe " +
        "pas côté Graph API — cette étape doit être faite avant même de demander la permission de " +
        "publication. Si la Page a été créée récemment ou importée, Meta peut aussi exiger une " +
        "« autorisation de publication de Page » avant d'accepter des publications ; complétez-la si " +
        "l'API la signale.",
      href: "https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/content-publishing",
    },
    {
      title: "Demander les permissions instagram_basic, instagram_content_publish et pages_read_engagement",
      body:
        "Sur la même application Meta que Facebook (un seul portefeuille Business peut couvrir les " +
        "deux canaux), ajoutez ces trois permissions — c'est le jeu de permissions du parcours " +
        "« Connexion Facebook ». Un autre parcours plus récent, « Connexion Instagram », utilise des " +
        "permissions différentes (instagram_business_basic, instagram_business_content_publish) et un " +
        "jeton distinct : cette intégration ne l'utilise pas, elle réutilise le jeton de Page.",
      href: "https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/content-publishing",
    },
    {
      title: "Passer en revue d'application (App Review)",
      body:
        "Comme pages_manage_posts pour Facebook, ces permissions Instagram ne sortent du mode " +
        "développement qu'après la même revue Meta — un seul dossier peut décrire les deux cas " +
        "d'usage à la fois. Comptez plusieurs semaines ; lancez cette démarche dès maintenant.",
      href: "https://developers.facebook.com/docs/app-review",
    },
    {
      title: "Récupérer l'identifiant utilisateur Instagram (IG User ID)",
      body:
        "Avec le jeton de Page (voir le guide Facebook — c'est le même jeton), appelez GET " +
        "/{version}/{page-id}?fields=instagram_business_account. La réponse contient " +
        "instagram_business_account.id : c'est l'identifiant à copier ici.",
      fieldHint: "igUserId",
    },
    {
      title: "Réutiliser le jeton de Page Facebook",
      body:
        "Instagram ne demande pas de jeton distinct sur ce parcours : le même jeton de Page obtenu " +
        "pour Facebook fonctionne aussi ici, tant que les permissions Instagram ci-dessus lui sont " +
        "accordées. Il expire et s'invalide dans les mêmes conditions — voir le guide Facebook.",
      fieldHint: "pageAccessToken",
    },
  ],
  linkedin: [
    // Task 4 (D7) — the adapter is now real (lib/diffusion/linkedin/linkedin.ts), so this guide can
    // no longer say "not built yet"; it needs at least a minimal, HONEST fieldHint-bearing step for
    // each of the two credential fields channels.ts now declares (organizationUrn/accessToken), the
    // same reverse-coverage requirement tests/diffusion-setup-guide.test.ts already enforces for
    // facebook/instagram. This is DELIBERATELY minimal — the Community Management tier path, the
    // screencast requirement, the Token Generator walkthrough, the URN lookup, and the 500/day rate
    // limit are Task 6's job (spec §6), not backfilled here. Writing that content now, ahead of Task
    // 6, would risk duplicating/contradicting what Task 6 ships with more research behind it.
    {
      title: "Programme d'accès Community Management API",
      body:
        "LinkedIn publie sur une Page entreprise via la Community Management API (ressource Posts, " +
        "champ commentary), avec le scope w_organization_social. L'accès à cette API passe par un " +
        "programme à deux paliers (palier de développement puis palier standard, chacun avec son " +
        "propre dossier et enregistrement vidéo) — un délai comparable à la revue d'application Meta. " +
        "Le compte utilisé pour générer le jeton doit aussi être administrateur de la Page LinkedIn " +
        "ciblée.",
      href: "https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api",
    },
    {
      title: "Renseigner l'URN de l'organisation",
      body:
        "L'URN identifie la Page entreprise LinkedIn cible (forme urn:li:organization:<id>) — c'est " +
        "la valeur envoyée comme propriétaire de chaque image téléversée et comme auteur de chaque " +
        "publication.",
      fieldHint: "organizationUrn",
    },
    {
      title: "Renseigner le jeton d'accès",
      body:
        "Le jeton généré via le Développeur Portal de LinkedIn (portant le scope " +
        "w_organization_social) — il dure environ 60 jours et son renouvellement automatique n'est " +
        "pas disponible pour ce type d'application.",
      fieldHint: "accessToken",
    },
  ],
  whatsapp: [
    {
      title: "Adaptateur pas encore construit",
      body:
        "La publication vers WhatsApp n'est pas encore implémentée. Elle est prévue après LinkedIn, " +
        "une fois qu'un second service (un worker séparé exécutant whatsapp-web.js dans un navigateur " +
        "Chromium, avec une session persistée pour survivre aux redémarrages) sera en place. Cette " +
        "page n'a donc aucun champ d'identifiant à remplir pour l'instant.",
    },
    {
      title: "Ce qu'il faudra préparer en amont",
      body:
        "Contrairement à Facebook, Instagram et LinkedIn, WhatsApp n'utilisera pas une API officielle " +
        "mais whatsapp-web.js, une bibliothèque non officielle qui pilote un compte WhatsApp réel — " +
        "WhatsApp interdit les clients non officiels et peut bloquer le numéro utilisé. Il faudra un " +
        "numéro de téléphone dédié (à considérer comme sacrifiable) et un canal WhatsApp (Channel, pas " +
        "un groupe) déjà créé sur ce numéro avant la première publication automatique.",
    },
  ],
  x: [
    {
      title: "Canal reporté — accès à l'API d'écriture non disponible",
      body:
        "La publication vers X est reportée : publier via l'API X exige aujourd'hui un accès payant " +
        "(à l'usage ou par abonnement selon l'offre en vigueur au moment de la lecture) que ce projet " +
        "ne possède pas. Cette page n'a donc aucun champ d'identifiant à remplir tant que cet accès " +
        "n'est pas souscrit.",
      href: "https://docs.x.com/x-api/introduction",
    },
  ],
  tiktok: [
    {
      title: "Canal reporté — en attente d'audit d'application TikTok",
      body:
        "La publication vers TikTok est reportée : c'est un canal « nice to have », dernier de la " +
        "feuille de route, et la Content Posting API de TikTok exige un audit d'application par " +
        "TikTok avant tout usage en production. Cette démarche n'a pas encore été lancée ; cette page " +
        "n'a donc aucun champ d'identifiant à remplir pour l'instant.",
      href: "https://developers.tiktok.com/doc/content-posting-api-reference-direct-post",
    },
  ],
};

// Dev-time completeness guard, mirroring channels.ts's own — fails at IMPORT time, not just under
// `bun test`, if CHANNELS (lib/studio/tokens.ts) ever grows without a matching guide here. A new
// channel cannot ship without a guide, exactly as a new channel cannot ship without a registry entry.
for (const key of CHANNELS) {
  if (!SETUP_GUIDES[key]) throw new Error(`Canal social sans guide de connexion : ${key}`);
}

export function getSetupGuide(channel: Channel): readonly SetupGuideStep[] {
  return SETUP_GUIDES[channel];
}
