# Afrotiative — Programme « Studio visuel & diffusion multicanale » — Feuille de route

**Date :** 2026-08-09
**Statut :** Décisions validées — exécution autonome sous-projet par sous-projet
**Portée :** Deux besoins liés — (a) un module type « Canva » pour définir des gabarits d'images
avec emplacements dynamiques, (b) la diffusion des articles vers WhatsApp, Facebook, Instagram, X,
TikTok et LinkedIn. Décomposés en sous-projets, chacun avec son propre spec → plan → exécution.

Ce document est le registre durable des décisions. Il fait suite au programme « Pipeline &
Observabilité v2 » (`2026-08-05-afrotiative-pipeline-program-roadmap.md`), désormais livré.

---

## Décisions produit (validées par l'utilisateur, 2026-08-09)

| Sujet | Décision |
|---|---|
| **Moteur du studio** | **Interne.** Scène JSON maison + éditeur maison, plutôt que CE.SDK (licence sur devis, sans palier public) ou Polotno. Aucun coût de licence, contrôle total du schéma, pas de dépendance à un fournisseur. |
| **Backend de rendu** | **Satori + resvg + sharp**, en Node, sans navigateur. ~100 ms par rendu, déterministe, exécutable en ligne dans une server action. Contrepartie assumée : l'éditeur reste dans le sous-ensemble CSS de Satori. |
| **Stockage** | **Cloudflare R2** (S3-compatible). Instagram et TikTok exigent une URL publiquement accessible — ce n'est pas optionnel. |
| **Thème par catégorie** | **Un gabarit par canal + jetons de thème de catégorie.** Le gabarit référence `{{category.color}}` ; la couleur vit sur la catégorie. ~5 gabarits au lieu de ~60. Une surcharge `(canal, catégorie)` reste possible pour une catégorie qui a besoin d'une *mise en page* différente, pas d'une couleur différente. |
| **Formats** | **Un gabarit = un format fixe** choisi parmi des préréglages. Pas de redimensionnement multi-variantes. |
| **Kit de marque** | **Assets et polices téléversables** (R2), administrables. Polices **TTF/OTF uniquement** — Satori ne lit pas le WOFF2. |
| **Résolution du gabarit** | `(contexte, canal, catégorie)` → `(contexte, canal, ∅)` → `(contexte, ∅, ∅)` → `∅` = image brute inchangée. |
| **Cycle de vie** | **Brouillon / publié + historique de versions.** Le résolveur ne lit **jamais** le brouillon de travail. |
| **Qui conçoit** | **Admins et éditeurs.** |
| **Contextes d'usage** | Quatre au-delà de l'image d'article : **cartes de citation**, **bandeaux de newsletter**, **cartes de récap/digest**. Impose des *slots nommés abstraits* plutôt qu'une liaison directe aux champs d'article. |
| **Champs injectables** | `title`, `excerpt`, `category.name`, `category.color`, `article.image`, `brand.logo`, `article.date`, `article.byline`, `source.names`, **`article.url` en QR code**. |
| **Déclenchement de la diffusion** | **Bouton explicite par canal**, avec légende éditable avant envoi. Pas d'envoi automatique au clic sur « Approuver & publier ». |
| **Légendes** | **Générées par IA, par canal.** Chaque canal a ses contraintes (nombre max de caractères), configurables en réglages avec valeurs par défaut et bornes min/max issues des règles officielles de la plateforme. |
| **Réglages par canal** | Chaque canal a **sa propre sous-page de réglages** : spécificités du canal + configuration de la publication automatique. |
| **Re-rendu** | **Non.** Un rendu déjà diffusé est immuable. Modifier l'image d'un article après publication ne met à jour aucun post. |
| **WhatsApp** | **whatsapp-web.js**, dans un **service worker séparé** (Chromium + session persistante). Choix assumé : bibliothèque non officielle, WhatsApp interdit les clients non officiels, le numéro peut être bloqué. Contrepartie : c'est le seul moyen de publier dans un **canal** ou un **groupe**. |
| **TikTok** | **Optionnel** (« nice to have »). Dernier de la file, sous réserve d'audit de l'application par TikTok. |
| **Comptes disponibles aujourd'hui** | **Page Facebook + compte Instagram Business lié** uniquement. Pas de compte développeur X (palier payant requis), pas d'application TikTok. |

### Règle de publication automatique WhatsApp (à concevoir en D1)

Énoncé de l'utilisateur, conservé verbatim comme exigence :

> Toutes les X heures, un processus choisit automatiquement **un** article publié sur WordPress le
> jour même et le publie dans le canal WhatsApp s'il ne l'a pas déjà été. L'ordre est **du plus
> ancien au plus récent**. S'il n'y a plus rien à publier pour aujourd'hui, le processus regarde
> les articles de la veille non encore publiés sur le canal WhatsApp, et ainsi de suite.

Généralisable aux autres canaux ; la conception détaillée (fenêtre de rattrapage maximale,
verrouillage, heures d'envoi autorisées, comportement au redémarrage) appartient à **D1**.

---

## Faits d'ancrage (issus de l'exploration du code, 2026-08-09)

- **`distributions` est déjà le point d'extension** (`db/schema.ts:348`) : `channel` en texte avec
  défaut `wordpress`, plus un index unique **partiel** (`WHERE channel = 'wordpress'`) — les autres
  canaux sont volontairement non contraints. `lib/wp/channel.ts:7` déclare déjà l'interface
  `PublishChannel` avec le commentaire « WhatsApp/social — plus tard ».
- **La publication est mono-canal et synchrone.** `approveAndPublish`
  (`lib/actions/article-actions.ts:142`) pose `approved` + `scheduledAt` ; le cron
  `/api/publish/due` appelle `publishArticle` → WordPress. Ni file de travaux, ni réessai, ni
  statut par canal.
- **Aucun stockage d'objets n'existe dans le projet.** `articles.featuredImageUrl` est une URL
  distante ; `uploadFeaturedImage` la télécharge au moment de publier et la pousse dans la
  médiathèque WordPress. C'est la lacune principale pour tout ce programme.
- **`sharp` est déjà installé** (`node_modules/sharp`, et listé dans `trustedDependencies`).
- **Hébergement Railway**, un seul service web, sans volume (`railway.json`). Le worker WhatsApp
  imposera un second service.
- **`lib/url-guard.ts`** expose `isSafePublicHttpUrl`, déjà utilisé pour l'anti-SSRF côté
  `uploadFeaturedImage` et `testFeed` — à réutiliser pour toute récupération d'image du studio.
- **Interface en français** partout ; shadcn en preset `base-nova` (Base UI, prop `render` et non
  `asChild`).

### Contraintes de Satori vérifiées (documentation officielle)

Supporté : flexbox, `position: absolute`, `transform` (rotate/scale/skew), `border-radius`,
`box-shadow`, `text-shadow`, dégradés linéaires et radiaux, `objectFit`, `objectPosition`,
`lineClamp`, `textWrap`, `opacity`, `overflow: hidden`, `filter`, `clipPath`, polices TTF/OTF/WOFF.

**Non supporté :** CSS Grid, **`z-index`**, `calc()`, **`backdrop-filter` et les effets de flou**,
`min-content`/`max-content`/`fit-content`, `flexBasis: auto`, **WOFF2**, langues RTL, ligatures et
crénage OpenType.

Deux conséquences structurantes : l'ordre de peinture est **l'ordre du tableau de calques** (ce
qu'est déjà une liste de calques), et **le flou est appliqué en raster par `sharp`** avant
composition, pas en CSS.

---

## Sous-projets (ordre de construction)

### V1 — Moteur de gabarits (sans interface)
Schéma de scène + validation Zod, registre des slots et liaisons par contexte, résolveur
`(contexte, canal, catégorie)`, pipeline de rendu Satori/resvg/sharp, client R2, cache de rendus,
couleur de thème sur les catégories, gabarits de départ écrits à la main en JSON et semés.
**Livrable vérifiable sans aucune interface** : rendre un gabarit depuis du JSON. Dé-risque Satori
avant d'investir dans l'éditeur. Spec dédiée :
`2026-08-09-afrotiative-v1-moteur-gabarits-design.md`.

### V2 — Studio (éditeur visuel) — ✅ Livré (2026-08-09)
`/studio` : CRUD de gabarits, éditeur de canevas (glisser/redimensionner), panneau de calques,
interface de liaison des slots, bibliothèque d'assets et de polices, brouillon/publié + versions.
Aperçu « vrai rendu » via le moteur V1, en différé. Spec :
`2026-08-09-afrotiative-v2-studio-design.md`. Quinze tâches en quatre lots, toutes revues.

### V3 — Aperçu dans l'article — ✅ Livré (2026-08-09)
Onglets **Image originale** / **Aperçu final** dans `components/article/image-panel.tsx`. L'onglet
« original » garde l'existant (URL, crédit, lien source) ; l'onglet « aperçu » montre le rendu du
gabarit **du site**. Les aperçus par réseau social vivent dans le panneau Diffusion (D1), pas ici.
Spec : `2026-08-09-afrotiative-v3-apercu-article-design.md`. L'image effectivement publiée sur
WordPress est désormais **le rendu**, produit au clic sur « Approuver & publier ».

### D1 — Socle de diffusion
`distributions` v2 (une ligne par canal, statut, réessais, charge utile, `render_id`, `externalId`),
registre de canaux, sous-pages `/settings/social/{canal}`, génération IA des légendes avec limites
par canal, panneau **Diffusion** sur la page article (bouton + légende éditable par canal), rendu à
l'envoi, planificateur automatique (dont la règle WhatsApp ci-dessus), journal d'audit. Dépend de V1.

### D2 — Adaptateur Facebook Page — ✅ Livré (2026-08-10)
Graph API, client à URL de base injectable (`lib/diffusion/meta/graph-client.ts`), publication photo
sur la Page. Nécessite toujours la revue d'application Meta pour `pages_manage_posts` — **rien n'a
été vérifié contre la vraie API Graph** : tout est testé contre un faux serveur `Bun.serve`, par
construction. Spec et plan combinés : `../plans/2026-08-10-afrotiative-d2-d3-meta.md`.

### D3 — Adaptateur Instagram — ✅ Livré (2026-08-10)
Content Publishing API en deux étapes (conteneur média → sondage borné du `status_code` →
`media_publish`), compte Business lié à la page Facebook, URL d'image publique servie par R2.
Nécessite toujours `instagram_content_publish` — même revue Meta que D2, même réserve : aucun envoi
réel n'a eu lieu.

Livrés avec eux, dans le même sous-projet : le **stockage chiffré des identifiants** (AES-256-GCM,
`social_channel_settings.credentials`, clé en `CREDENTIALS_ENCRYPTION_KEY`), les **guides de
connexion dans le produit** pour les six canaux (`lib/diffusion/setup-guide.ts`), et un bouton
**Tester la connexion** qui fait un seul appel Graph gratuit.

### D4 — Adaptateur WhatsApp + service worker
Second service Railway : whatsapp-web.js, Chromium, `RemoteAuth` avec session persistée en
Postgres pour survivre aux redémarrages. Publication dans le canal/groupe + planificateur.

### D5 — Adaptateur X
API v2. **Bloqué** tant qu'un compte développeur sur palier payant n'existe pas.

### D6 — Adaptateur TikTok
Content Posting API, publication photo. **Bloqué** par l'audit d'application TikTok. Optionnel.

### D7 — Adaptateur LinkedIn — ✅ Livré (2026-08-10)
Community Management API. Envoi en quatre temps, imposé par LinkedIn : récupération des octets du
rendu (LinkedIn ne va pas chercher notre URL) → `initializeUpload` → `PUT` des octets → **sondage
borné jusqu'à `AVAILABLE`** → `POST /rest/posts`, l'identifiant du post venant de l'en-tête
`x-restli-id`. Le sondage n'est pas optionnel : l'API Images ne supporte pas `SYNCHRONOUS_UPLOAD` et
publier avant la fin du traitement produit, selon la documentation de LinkedIn elle-même, un post
**invisible aux membres** — un `201` qui ressemble à un succès. Le permalien de l'article est ajouté à
la légende **à la génération**, donc visible et modifiable avant envoi.

Livré avec l'adaptateur : la présence d'identifiants ne vaut que si **tous** les champs déclarés sont
posés (LinkedIn est le premier canal à deux champs), le refus d'un blob à clés mixtes, la validation
des clés et du canal, et une **alerte avant l'expiration d'un jeton** (les deux plateformes ont des
jetons de ~60 jours ; le rafraîchissement programmatique de LinkedIn est réservé aux partenaires).

Nécessite toujours la revue d'application LinkedIn (`w_organization_social`, programme Community
Management à deux paliers, le palier Standard exigeant une **vidéo de démonstration**). **Rien n'a été
vérifié contre la vraie API** : tout est testé contre un faux serveur `Bun.serve`. Spec :
`2026-08-10-afrotiative-d7-linkedin-design.md` ; plan : `../plans/2026-08-10-afrotiative-d7-linkedin.md`.

#### Dette reportée à l'issue de D7

Triage de la revue finale (2026-08-10), conservé ici parce que les répertoires de travail SDD sont
gitignorés. La revue a conclu « fusionnable avec correctifs » ; les trois points Important et trois
points mineurs ont été livrés dans `f489dbe`. Ce qui reste :

| Point | Où | Pour qui |
|---|---|---|
| `caption.ts` refuse le permalien quand il occuperait *exactement* tout le budget (`> 0` au lieu de `>= 0`) — erreur dans le sens sûr, non couverte par un test | `lib/diffusion/caption.ts` | cosmétique |
| `stripUrls` laisse une parenthèse orpheline ; une URL sans schéma (`www.x.com/…`) sous le plafond survit entière comme texte alternatif | `lib/diffusion/linkedin/linkedin.ts` | qualité du texte alternatif |
| `isConfigured` est stocké en état à côté de `credentialKeys` et resynchronisé à trois endroits, au lieu d'être dérivé | `components/settings/social-channel-form.tsx` | D4 |
| `getChannelSettings` est lu deux fois par canal et par tic (12 lectures au lieu de 6) | `lib/diffusion/scheduler.ts` | D4 |
| `tokenExpiresAt` fait l'aller-retour par le formulaire en date UTC seule : tout enregistrement du formulaire tronque l'horodatage à minuit UTC | `components/settings/social-channel-form.tsx` | D4 |
| `/:(\d+)$/` accepte `foo:123` et `urn:li:person:99` là où le guide et le message d'erreur parlent d'une URN d'organisation | `lib/diffusion/connection-test.ts` | cosmétique |
| Le rejet réseau de `fetch` remonte non typé au lieu d'un `LinkedInApiError` — même lacune que `GraphClient` | `lib/diffusion/linkedin/rest-client.ts` | les deux clients ensemble |
| Bords non testés : téléchargement d'image injoignable, `initializeUpload` sans `uploadUrl`/`image`, statut de sondage inconnu, image de zéro octet, repli `localizedName`, limite exacte des 7 jours, `LINKEDIN_API_VERSION=""`, identifiants partiels pour le test de connexion | tests | opportuniste |
| Le bloc de tests D7 de `diffusion-caption` n'exerce que le repli déterministe, jamais la branche fournisseur avec un permalien non nul | `tests/diffusion-caption.test.ts` | opportuniste |

**Défauts de mes propres documents relevés à l'exécution** (tous corrigés, consignés ici comme
avertissement pour la prochaine spec) : §4 imposait `entityId: channel` alors que `alerts.entity_id`
est un `uuid` et que `createAlert` avale toutes les erreurs — l'alerte n'aurait jamais existé,
silencieusement ; §3.2 réclamait un texte alternatif issu du titre de l'article, que `SendInput` ne
porte pas et qu'un adaptateur n'a pas le droit d'aller chercher ; la tâche 1 du plan demandait à un
composant `"use client"` d'appeler une fonction de `settings-core`, ce qui aurait tiré le pool `pg`
dans le paquet navigateur — **la troisième occurrence de cette erreur dans ce dépôt**. Le triptyque
`credentialKeys` + `hasAllCredentials` + `isConfigured` calculé côté serveur est désormais le motif
maison et devrait figurer dans le gabarit de plan.

---

## Décisions D2 → D7 (validées par l'utilisateur, 2026-08-10)

| Sujet | Décision |
|---|---|
| **Stockage des identifiants** | **En base**, dans `social_channel_settings`. Un admin colle et fait tourner un jeton depuis `/settings/social/[canal]` sans redéploiement — décisif puisque les jetons Meta longue durée expirent tous les ~60 jours. **Contrepartie assumée : des secrets au repos dans Postgres.** Ils doivent donc être **chiffrés** (AES-256-GCM, clé en variable d'environnement), jamais renvoyés en clair au client, et l'interface n'affiche qu'une valeur masquée en n'acceptant que l'écriture. |
| **Cible WhatsApp** | **Un canal WhatsApp** (Channel), pas un groupe. |
| **Adaptateurs à construire** | **Facebook + Instagram** (même application Meta, même revue), **LinkedIn**, puis **WhatsApp**. **X et TikTok reportés** — X exige un palier payant absent, TikTok reste « nice to have ». |

### Faisabilité WhatsApp Channel — vérifiée (2026-08-10)

La prudence exprimée en D1 (« le support des canaux par whatsapp-web.js est plus faible que celui
des groupes ») est **levée**. La branche `main` de la bibliothèque expose bien `getChannels()`,
`getChannelByInviteCode()`, `createChannel()`, et `sendMessage()` vers un canal accepte
**texte, image, sticker, gif, vidéo, voix et sondage**. Image + légende — exactement ce dont la
diffusion a besoin — est donc réalisable.

**Réserve à lever en D4 :** ces méthodes sont sur `main` ; la version publiée sur npm peut être en
retard. D4 devra vérifier et, le cas échéant, installer depuis GitHub plutôt que depuis npm.

### Exigence transverse — guide de connexion dans le produit (2026-08-10)

Demande de l'utilisateur : un admin doit pouvoir **remplir des champs dans les réglages** pour
établir la connexion, et **chaque intégration doit porter ses instructions** — ce qu'il faut créer,
où, avec quels paramètres et quels droits.

Un champ « jeton » sans mode d'emploi n'est pas une intégration en libre-service. Chaque canal
expose donc, sur `/settings/social/[canal]`, un guide **structuré** (étapes ordonnées, lien externe
éventuel, et le champ de réglage que chaque étape permet de remplir), replié quand les identifiants
sont déjà posés, déplié sinon. Chaque guide dit : quoi créer et où, quelles permissions demander,
quelle revue est nécessaire et qu'elle prend du temps, où trouver chaque identifiant, comment
obtenir un jeton longue durée et quand il expire.

**Vaut pour les six canaux.** Un test vérifie que tout `Channel` possède un guide, sur le modèle du
test qui vérifie que tout `Channel` possède une entrée de registre — de sorte qu'un nouveau canal ne
puisse pas être livré sans mode d'emploi.

### Travail technique préalable aux adaptateurs

Indépendant des identifiants, à faire avant ou avec le premier adaptateur :

1. **Fondation « identifiants »** — colonnes chiffrées dans `social_channel_settings`, helpers de
   chiffrement/déchiffrement, interface masquée. Prérequis de tous les adaptateurs.
2. **Le problème du doublon au moins-une-fois** — le faucheur bascule `pending` → `failed` après
   10 min ; avec un vrai adaptateur, un crash *après* que l'API a accepté la publication laisse une
   ligne marquée en échec, et un réessai duplique alors un post public. `StubChannel` masque
   entièrement ce cas en réussissant toujours instantanément. Chaque adaptateur doit écrire
   `externalId` au plus tôt, et le seuil du faucheur doit être revu contre la latence réelle.
3. **Gabarits manquants** — seuls `fb_link`, `ig_square` et `li_link` sont semés. WhatsApp
   (`story`), X (`x_landscape`) et TikTok n'ont aucun gabarit `social_post` publié, et sans lui
   l'envoi est refusé.
4. **Expiration des jetons** — les jetons de Page Meta longue durée expirent vers 60 jours ; prévoir
   le renouvellement et une alerte avant échéance.

---

## Travaux hors code à lancer maintenant

Ces démarches ont des délais longs et bloqueront D2/D3/D5/D6/D7 quelle que soit la vitesse de
développement :

1. **Revue d'application Meta** pour `pages_manage_posts` et `instagram_content_publish`.
2. **Compte développeur X** sur un palier payant (le palier gratuit est plafonné très bas en
   écriture).
3. **Audit d'application TikTok** pour la Content Posting API, si TikTok est confirmé.
4. **Revue d'application LinkedIn** pour le scope `w_organization_social` (Community Management
   API), requise pour publier sur une Page entreprise LinkedIn — même nature de délai que la revue
   Meta.
5. **Numéro de téléphone dédié** pour le worker WhatsApp — à considérer comme sacrifiable.
6. **Compte Cloudflare R2** + bucket + clés (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
   `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_PUBLIC_BASE_URL`).
7. **Polices de marque en TTF ou OTF** (pas WOFF2) et logos, pour le kit de marque.

---

## Sous-projet annexe — Barre latérale `sidebar-02`

Indépendant du programme, demandé en même temps. La structure actuelle est `sidebar-07`
(`variant="inset" collapsible="icon"`, sous-menus repliables). On adopte de `sidebar-02` les
**sections de premier niveau repliables** — ce qui rend la navigation tenable alors que ce
programme ajoute ~8 entrées — **en conservant** la variante `inset`, le repli en icônes et le rail,
dont la perte serait une régression non demandée.

---

## Dette reportée à l'issue de V1

V1 est livré et jugé prêt à fusionner (revue de branche complète, 2026-08-09). Les points ci-dessous
ont été **délibérément reportés** après triage — ils ne bloquent pas la fusion, mais ils ne doivent
pas se perdre. Chacun indique le sous-projet qui devra le traiter.

### À traiter au démarrage de V2 (studio / éditeur)

| Point | Pourquoi maintenant |
|---|---|
| `parseScene` ne remonte que la **première** erreur Zod | Un éditeur visuel doit afficher toutes les erreurs d'une scène d'un coup ; acceptable sans interface, bloquant avec. |
| `lib/studio/render.ts` — `assets.imageUrl()` laisse fuir l'erreur brute (anglais) | Inatteignable tant que `NullAssetLoader` est le seul chargeur ; devient atteignable dès que V2 branche un chargeur sur `render_assets`. |
| `asSatoriFonts` est un cast non vérifié | V2 devra valider au téléversement que la graisse d'une police est dans {100…900}, sinon le cast devient un mensonge. |
| `computeInputHash` ne couvre ni `encode` ni l'état des polices | Sans objet en V1 ; dès qu'une police est téléversée, les rendus `degraded: true` déjà en cache continueraient d'être servis. |
| `wp_categories.color` n'a **aucun chemin d'écriture** | Ni interface, ni seed, ni synchronisation taxonomie. Toutes les catégories rendent donc `DEFAULT_CATEGORY_COLOR` — le jeton `{{category.color}}` reste théorique jusqu'à ce que V2 livre l'éditeur. |
| Dimensions de canevas non bornées (`lib/studio/scene.ts`) | Un canevas 20000×20000 traverse satori *et* resvg (~1,6 Go alloués) avant que sharp ne refuse. Entrée d'administrateur seulement ; à borner quand V2 pose ses propres limites. |

### À traiter au démarrage de V3 (aperçu dans l'article)

| Point | Pourquoi maintenant |
|---|---|
| `next.config.ts` ne liste pas `sharp`, `@resvg/resvg-js` ni `satori` dans `serverExternalPackages` | Aucun code applicatif n'importe `lib/studio` aujourd'hui. V3 sera le premier à le faire depuis une server action, et heurtera le regroupement Turbopack des binaires natifs `.node`. |
| Un article **sans image à la une** ou **sans catégorie** fait échouer le rendu | Comportement conforme au spec (§6, échec dur), mais l'interface devra le dire intelligiblement plutôt que d'afficher une erreur technique. |
| `process.cwd()` pour le chemin des polices | Incompatible avec `output: "standalone"` dans `next.config.ts`. À revoir si/quand V3 change la stratégie de build. |

### À traiter au démarrage de D1 (socle de diffusion)

| Point | Pourquoi maintenant |
|---|---|
| Faut-il conditionner `article.url` à `articles.status === "published"` ? | Un article dépublié conserve aujourd'hui un permalien WordPress résolvable mais périmé dans le contexte `social_post`. C'est D1 qui définit la convention de partage, donc D1 qui tranche. |

### Dette reportée à l'issue de V2 et V3

Triage des revues de lot, conservé ici parce que les répertoires de travail SDD sont gitignorés.

| Point | Où | Pour qui |
|---|---|---|
| `previewTemplate` transmet son objet d'arguments en bloc au cœur, qui porte les crochets de test `fetchImpl`/`assets` | `lib/actions/studio-preview-actions.ts` | V2+ — déstructurer explicitement |
| `getTemplateById` lève brutalement sur une scène illisible → 500 sans retour possible | `lib/queries/studio.ts` | V2+ — bannière française plutôt qu'une trace |
| « Annuler » vers la scène de montage saute l'auto-enregistrement par égalité de référence : le brouillon en base peut désynchroniser d'une interface affichant « Enregistré » | `components/studio/editor-shell.tsx` | V2+ |
| Un geste de redimensionnement/rotation sans mouvement pousse quand même une entrée d'annulation | `hooks/use-layer-drag.ts` | V2+ |
| Pas de réessai ni d'affordance « Réessayer » après un auto-enregistrement en échec | `lib/studio/autosave.ts` | V2+ |
| Les flèches et `Suppr` n'agissent que si le canevas a le focus DOM | `components/studio/canvas.tsx` | V2+ |
| Le canevas ignore `image.overlay`, que le moteur composite bien | `components/studio/layer-view.tsx` | V2+ |
| La bannière « lecture seule » sans R2 surestime ce qui est réellement désactivé (l'auto-enregistrement et `deleteAsset` fonctionnent toujours) | `components/studio/storage-banner.tsx` | V2+ |
| `docs/DEPLOYMENT.md` ne donne aucune **procédure** R2 : création du bucket, portée du jeton, exposition publique | doc | ops |
| Réessai illimité du cron sur un rendu durablement en échec, motif persisté nulle part | `lib/wp/publish-due.ts` | D1 |
| Aucune couverture d'intégration du cas « aucun gabarit » (`url:null`) : le gabarit par défaut semé le rend inatteignable | `tests/wp-publish-render.test.ts` | D1 |
| Le commentaire de `putObject` présente le diagnostic `content-length` comme inconditionnel ; les preuves du lot 3 le contredisent | `lib/storage/r2.ts` | à adoucir |

**Point ouvert, non résolu.** Le bogue `content-length` de `lib/storage/r2.ts` (en-tête posé à la main
→ `undici InvalidArgumentError` une fois passé par le `fetch` patché de Next) était présent depuis le
premier commit du fichier, alors que le lot 3 a bel et bien téléversé des assets depuis un
navigateur. La relecture finale a identifié un mécanisme plausible — le chemin de reconstruction du
corps dans `patch-fetch.js` de Next 16.3 n'est emprunté que sous certaines conditions de contexte —
sans pouvoir le prouver. `putObject` n'a **aucune** couverture automatisée et ne peut pas en avoir
sous `bun test` (le patch de Next n'y est pas actif) : la seule défense reste la vérification
navigateur de l'étape 11 de `docs/DEPLOYMENT.md`.

### Dette reportée à l'issue de D2 + D3

Triage de la revue finale du sous-projet (2026-08-10). Rien de ce qui suit ne bloque la fusion — la
revue finale a conclu « fusionnable avec correctifs », et les correctifs (trois points Important, deux
Minor) ont été livrés dans `781e6d2`. Ce qui reste est conservé ici parce que les répertoires de
travail SDD sont gitignorés.

| Point | Où | Pour qui |
|---|---|---|
| `credentialsSetAt` bascule au **premier** champ enregistré : n'enregistrer que l'identifiant de Page affiche « Défini le … », replie le guide de connexion et **active « Tester la connexion »** alors que le jeton manque encore — c'est justement la séquence la plus probable. Le plus gênant des points reportés, puisqu'il abîme le libre-service | `settings-core.ts`, `social-channel-form.tsx`, `settings/social/[channel]/page.tsx` | D7 |
| `setChannelCredentialsCore` fusionne un nouveau chiffré dans le blob existant **sans vérifier** que les entrées existantes se déchiffrent encore : après un changement de clé, ne ressaisir qu'un champ produit un blob mixte définitivement illisible (contourné par la doc, pas par le code) | `lib/diffusion/settings-core.ts` | D7 |
| `channelCredentialsSchema` ne valide que la forme : ni les clés contre `credentialFields`, ni une longueur maximale | `lib/validation.ts` | D7 |
| `channel` n'est pas validé dans les actions d'identifiants (motif D1 préexistant, désormais sur un chemin d'écriture de secret) | `lib/actions/diffusion-settings-actions.ts` | D7 |
| Ni identifiant de clé (`v1:`) ni AAD liée à `${canal}:${champ}` dans le format stocké — bon marché maintenant, pénible une fois des lignes en production | `lib/diffusion/crypto.ts` | avant la première mise en production des identifiants |
| Les codes Graph transitoires (4/17/32/613, 5xx) tombent dans le mappeur générique, sans « réessayez plus tard » ni temporisation | `lib/diffusion/meta/*.ts` | D7 |
| Le mappeur générique dit « La publication … a échoué » même pour un test de connexion en lecture seule | `connection-test.ts`, `facebook.ts`, `instagram.ts` | cosmétique |
| Contenu de type bloc à l'intérieur du bouton `CollapsibleTrigger` (le motif du projet enveloppe un `span`) ; et le titre `<h1>` de la page s'affiche **sous** la carte du guide | `channel-setup-guide.tsx`, `settings/social/[channel]/page.tsx` | cosmétique |
| Filet de sécurité recommandé : un `try/catch` autour de `socialChannel.send()` pour qu'aucun adaptateur futur ne puisse enliser une ligne `pending` en levant. Écarté du sous-projet parce que c'est un fichier du socle D1 et que les gardes par adaptateur corrigent le vrai défaut | `lib/diffusion/send-core.ts:165` | D4 / D7 |

**Risque résiduel accepté à la fusion.** `Authorization: Bearer` remplace le jeton en paramètre
d'URL sur les GET Graph : vérifié dans la documentation de deux produits Meta voisins sur le même
hôte, **inféré** pour les points d'accès Page/photo et conteneur Instagram. Si l'inférence est
fausse, cela se voit comme un `401` propre traduit en français, pas comme une faille — et le bouton
« Tester la connexion » est le premier appel réel. **À vérifier dès que la revue d'application Meta
est accordée**, en même temps que les trois réglages inférés : le sondage Instagram (3 s × 10), le
repli `post_id`/`id` de Facebook, et `PUBLISHED` traité comme état terminal.

**Deux défauts du plan D2+D3 lui-même**, relevés par la revue finale : « paramétrer le seuil du
faucheur » avait déjà été livré par la vague de correctifs D1 (`0906cb7`), et « enregistrer
l'identifiant de conteneur au plus tôt » n'est pas réalisable dans `SocialChannel`, qui n'a
volontairement aucun accès à la base — il aurait fallu inscrire l'élargissement de `SendResult` dans
le périmètre.

### Hygiène des tests (transverse)

Les suites `tests/studio-*.test.ts` écrivent dans la branche Neon **dev partagée**. Le motif de
collision de portée est désormais contenu par `tests/studio-fixtures.ts` (suppression défensive
avant insertion, portées distinctes par fichier, plus aucun nom de canal réel utilisé comme
sentinelle). **Ne jamais lancer deux `bun test` en parallèle** — voir `test-setup.ts:38-40`.

Trois échecs **préexistants** subsistent, sans rapport avec ce programme, chacun attribué en
rejouant le fichier sur le point de départ de la branche (`09b8e4e`), où aucun de ces travaux
n'existe : `tests/pipeline-web-search.test.ts` cas (a) et cas (d), et
`tests/pipeline-pause-resume.test.ts` point de contrôle (b). Les deux sont sensibles à l'état
accumulé de la base de développement partagée.

**Le décompte d'une suite complète n'est pas reproductible** (constaté à la clôture de D2+D3,
2026-08-10). Trois exécutions du **même** commit ont donné 3, 12 puis 5 échecs. Les fichiers qui
apparaissent et disparaissent — `tests/publish-due.test.ts`, `tests/diffusion-schedule.test.ts`,
`tests/diffusion-scheduler.test.ts`, `tests/wp-publish-render.test.ts` — repassent **tous au vert
relancés seuls** (par exemple `wp-publish-render` : 7/7). Ils partagent la branche Neon dev et se
gênent mutuellement selon l'ordre et l'état laissé par le fichier précédent ; deux exécutions
concurrentes suffisent à en faire tomber neuf d'un coup.

Conséquence pratique : **un échec dans une suite complète n'est pas une preuve de régression** tant
que le fichier n'a pas été relancé seul, et un décompte global ne vaut pas comme critère de sortie.
La dette de fond — isoler l'état par fichier, sur le modèle de `tests/studio-fixtures.ts` — reste
ouverte et s'aggrave à chaque sous-projet qui ajoute des tests touchant la base.

---

## Suivi

Exécution autonome, un sous-projet à la fois, commit par sous-projet, revue par tâche puis revue
finale (subagent-driven). Question à l'utilisateur uniquement sur un point bloquant qui ne peut pas
être tranché depuis le code.
