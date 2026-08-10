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

// Per-channel, ordered. Facebook, Instagram and LinkedIn (full guide since Task 6, D7 — spec §6;
// Task 4 shipped a deliberately minimal placeholder, see that entry's own comment) are the three
// channels with a real adapter today and get a fieldHint-bearing guide. The other three get an
// honest placeholder — WhatsApp names what D4 will need so that task only fills the shape in; X and
// TikTok say plainly that the channel is deferred and why (roadmap "Décisions D2 → D7"). Every
// channel still gets at least one real step — even a placeholder must say something an admin (or
// the next task) can act on, never just "coming soon".
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
    // Task 4 (D7) shipped a deliberately minimal, honest 3-step placeholder here (fieldHint-bearing,
    // but silent on the tier path, the screencast, the Token Generator walkthrough, the URN lookup,
    // and the rate limit) — see git history for that version. Task 6 (D7, spec §6) replaces it with
    // the full guide below.
    //
    // ── Verification method (fetched 2026-08-10, in addition to the facts the task brief already
    //    supplied as pre-verified — see the task report for the full list of what came from which
    //    source) ──
    // learn.microsoft.com/en-us/linkedin/marketing/community-management-app-review (the access
    // request/screencast process — confirms "create a new app, you can't reuse a rejected one" and
    // "a super admin of the Page must verify the app" in LinkedIn's own words); .../marketing/
    // increasing-access (the Development/Standard tier table — confirms the exact figures the brief
    // gave: 500 API calls/app/24h, 100/member/24h for Development tier, and that Development tier
    // integration/testing must complete within twelve months of provisioning); .../marketing/
    // community-management/organizations/organization-lookup-api (GET /rest/organizations/{id}, the
    // same endpoint this task's connection test — ./connection-test.ts — reads); .../shared/
    // authentication/developer-portal-tools (the Token Generator); .../marketing/versioning (monthly
    // version cadence, minimum one year supported before sunset, and that using any version requires
    // an explicit Linkedin-Version header — no version applies by default).
    {
      title: "Créer une NOUVELLE application développeur LinkedIn",
      body:
        "Le palier de développement (« Development Tier ») de la Community Management API ne peut " +
        "être demandé que par une application qui ne porte AUCUN autre produit API — sur une " +
        "application déjà utilisée pour autre chose, l'option est grisée dans le portail développeur " +
        "et la demande est refusée. Créez donc une application dédiée à cette intégration, dans le " +
        "portefeuille Business de l'organisation, plutôt que de réutiliser une application existante.",
      href: "https://www.linkedin.com/developers/apps",
    },
    {
      title: "Associer et faire vérifier la Page entreprise LinkedIn",
      body:
        "Un super administrateur de la Page entreprise LinkedIn doit associer l'application à cette " +
        "Page et la faire vérifier (« Associer une application à une Page LinkedIn », ci-contre) — " +
        "LinkedIn contrôle cette association pendant l'examen de la demande d'accès. Le compte qui " +
        "génère ensuite le jeton (étape « Générer le jeton d'accès » ci-dessous) doit lui-même être " +
        "administrateur de cette même Page : sans ce rôle, chaque appel à /rest/images et /rest/posts " +
        "renvoie un refus 403, différent d'un jeton expiré.",
      href: "https://www.linkedin.com/help/linkedin/answer/a548360/associate-an-app-with-a-linkedin-page?lang=en",
    },
    {
      title: "Demander l'accès Community Management — palier de développement",
      body:
        "Depuis le portail développeur, sur l'application créée à l'étape 1, demandez l'accès à la " +
        "Community Management API, palier de développement (« Development Tier »). LinkedIn examine " +
        "le cas d'usage déclaré, l'adresse professionnelle et l'organisation vérifiée avant " +
        "d'accorder l'accès — comptez un délai d'examen, comme pour la revue d'application Meta. Ce " +
        "palier autorise 500 appels API par application et par jour, et 100 par membre et par jour " +
        "(voir la dernière étape ci-dessous pour ce que cela représente en publications), et impose " +
        "de finaliser l'intégration dans les douze mois suivant l'octroi de l'accès.",
      href: "https://learn.microsoft.com/en-us/linkedin/marketing/community-management-app-review",
    },
    {
      title: "Passer au palier standard — dossier ET enregistrement vidéo (screencast)",
      body:
        "Le palier de développement suffit pour tester, mais lève les restrictions de volume et de " +
        "production seulement au palier standard (« Standard Tier »). La demande de passage exige un " +
        "screencast — un enregistrement d'écran, en haute résolution, montrant chaque cas d'usage " +
        "déclaré dans le formulaire (le flux de connexion, puis la publication réelle) — en plus du " +
        "dossier écrit. Prévoyez ce délai en plus de celui du palier de développement : lancez cette " +
        "démarche dès que le palier de développement est validé, pas au moment de vouloir publier en " +
        "production sans restriction.",
      href: "https://learn.microsoft.com/en-us/linkedin/marketing/community-management-app-review",
    },
    {
      title: "Générer le jeton d'accès avec le Token Generator du portail développeur",
      body:
        "Une fois l'accès Community Management accordé, ouvrez l'onglet « OAuth 2.0 tools » de " +
        "l'application dans le portail développeur et utilisez le Token Generator (« Create token ») " +
        "avec le scope w_organization_social — aucune implémentation OAuth côté serveur n'est " +
        "nécessaire, le portail génère le jeton directement. Il dure environ 60 jours " +
        "(expires_in: 5184000) ; le renouvellement programmatique (refresh token) n'est ouvert " +
        "qu'aux partenaires LinkedIn, donc pas à ce projet — il n'existe aucun moyen d'automatiser " +
        "son renouvellement. Notez la date d'expiration affichée par le générateur et reportez-la " +
        "dans le champ « Date d'expiration du jeton » plus bas sur cette page (bouton « Enregistrer », " +
        "pas « Enregistrer les identifiants ») : c'est ce qui déclenche l'alerte envoyée 7 jours avant " +
        "l'échéance.",
      href: "https://learn.microsoft.com/en-us/linkedin/shared/authentication/developer-portal-tools",
      fieldHint: "accessToken",
    },
    {
      title: "Renseigner l'URN de l'organisation",
      body:
        "L'URN identifie la Page entreprise LinkedIn cible, sous la forme urn:li:organization:<id " +
        "numérique> — c'est la valeur envoyée comme propriétaire de chaque image téléversée et comme " +
        "auteur de chaque publication. Trouvez l'identifiant numérique dans l'URL d'administration de " +
        "la Page (linkedin.com/company/<id>/admin/…), ou interrogez l'Organization Lookup API " +
        "(GET /rest/organizations?q=vanityName&vanityName=<nom>) si seul le nom public est connu. " +
        "C'est ce même identifiant numérique — pas l'URN complète — que « Tester la connexion » " +
        "utilise pour lire l'organisation via GET /rest/organizations/{id}.",
      href: "https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/organization-lookup-api",
      fieldHint: "organizationUrn",
    },
    {
      title: "Quota du palier de développement : 500 requêtes par jour, une publication en coûte AU MOINS quatre",
      body:
        "Tant que le palier standard n'est pas accordé, l'application est plafonnée à 500 appels API " +
        "par jour au total. Chaque publication LinkedIn faite par ce projet — initialisation du " +
        "téléversement, envoi des octets de l'image, sondage de son statut, puis création de la " +
        "publication — en consomme AU MOINS quatre : quatre seulement si LinkedIn répond « prête » " +
        "dès le premier sondage, mais le sondage se répète (jusqu'à 10 fois) tant que l'image reste " +
        "en traitement — WAITING_UPLOAD/PROCESSING sont le déroulement normal, pas un cas limite —, " +
        "donc jusqu'à 13 requêtes pour une seule publication dans le pire cas. Une fois plusieurs " +
        "canaux automatiques actifs, ce plafond peut devenir la limite réelle avant même celle des " +
        "identifiants ou des permissions ; un 429 renvoyé par LinkedIn l'indique explicitement dans " +
        "le message d'erreur affiché ici.",
      href: "https://learn.microsoft.com/en-us/linkedin/marketing/increasing-access",
    },
    {
      title: "Ce que « Tester la connexion » prouve — et ce qu'elle ne prouve pas",
      body:
        "Une fois les deux champs ci-dessous enregistrés, « Tester la connexion » lit l'organisation " +
        "identifiée par l'URN (une seule requête, jamais une publication) et confirme que le jeton et " +
        "l'identifiant d'organisation sont valides. Elle ne prouve PAS que la publication elle-même " +
        "est autorisée : cela dépend en plus de la permission w_organization_social effectivement " +
        "accordée et du rôle administrateur du compte sur la Page — seul un envoi réel (bouton « Test » " +
        "sur l'onglet Diffusion d'un article, ou un envoi automatique) le vérifie.",
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
