# Afrotiative — Programme « Studio visuel & diffusion multicanale » — Feuille de route

**Date :** 2026-08-09
**Statut :** Décisions validées — exécution autonome sous-projet par sous-projet
**Portée :** Deux besoins liés — (a) un module type « Canva » pour définir des gabarits d'images
avec emplacements dynamiques, (b) la diffusion des articles vers WhatsApp, Facebook, Instagram, X
et TikTok. Décomposés en huit sous-projets, chacun avec son propre spec → plan → exécution.

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

### V2 — Studio (éditeur visuel)
`/studio` : CRUD de gabarits, éditeur de canevas (glisser/redimensionner), panneau de calques,
interface de liaison des slots, bibliothèque d'assets et de polices, brouillon/publié + versions.
Aperçu « vrai rendu » via le moteur V1, en différé. Dépend de V1.

### V3 — Aperçu dans l'article
Onglets **Image originale** / **Aperçu final** dans `components/article/image-panel.tsx`. L'onglet
« original » garde l'existant (URL, crédit, lien source) ; l'onglet « aperçu » montre le rendu du
gabarit **du site**. Les aperçus par réseau social vivent dans le panneau Diffusion (D1), pas ici.
Dépend de V1.

### D1 — Socle de diffusion
`distributions` v2 (une ligne par canal, statut, réessais, charge utile, `render_id`, `externalId`),
registre de canaux, sous-pages `/settings/social/{canal}`, génération IA des légendes avec limites
par canal, panneau **Diffusion** sur la page article (bouton + légende éditable par canal), rendu à
l'envoi, planificateur automatique (dont la règle WhatsApp ci-dessus), journal d'audit. Dépend de V1.

### D2 — Adaptateur Facebook Page
Graph API. Comptes déjà disponibles. Nécessite la revue d'application Meta pour
`pages_manage_posts` — **à lancer immédiatement, en parallèle du développement**.

### D3 — Adaptateur Instagram
Content Publishing API, compte Business lié à la page Facebook. Exige une URL d'image publiquement
accessible (d'où R2). Nécessite `instagram_content_publish` — même revue Meta que D2.

### D4 — Adaptateur WhatsApp + service worker
Second service Railway : whatsapp-web.js, Chromium, `RemoteAuth` avec session persistée en
Postgres pour survivre aux redémarrages. Publication dans le canal/groupe + planificateur.

### D5 — Adaptateur X
API v2. **Bloqué** tant qu'un compte développeur sur palier payant n'existe pas.

### D6 — Adaptateur TikTok
Content Posting API, publication photo. **Bloqué** par l'audit d'application TikTok. Optionnel.

---

## Travaux hors code à lancer maintenant

Ces démarches ont des délais longs et bloqueront D2/D3/D5/D6 quelle que soit la vitesse de
développement :

1. **Revue d'application Meta** pour `pages_manage_posts` et `instagram_content_publish`.
2. **Compte développeur X** sur un palier payant (le palier gratuit est plafonné très bas en
   écriture).
3. **Audit d'application TikTok** pour la Content Posting API, si TikTok est confirmé.
4. **Numéro de téléphone dédié** pour le worker WhatsApp — à considérer comme sacrifiable.
5. **Compte Cloudflare R2** + bucket + clés (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
   `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_PUBLIC_BASE_URL`).
6. **Polices de marque en TTF ou OTF** (pas WOFF2) et logos, pour le kit de marque.

---

## Sous-projet annexe — Barre latérale `sidebar-02`

Indépendant du programme, demandé en même temps. La structure actuelle est `sidebar-07`
(`variant="inset" collapsible="icon"`, sous-menus repliables). On adopte de `sidebar-02` les
**sections de premier niveau repliables** — ce qui rend la navigation tenable alors que ce
programme ajoute ~8 entrées — **en conservant** la variante `inset`, le repli en icônes et le rail,
dont la perte serait une régression non demandée.

---

## Suivi

Exécution autonome, un sous-projet à la fois, commit par sous-projet, revue par tâche puis revue
finale (subagent-driven). Question à l'utilisateur uniquement sur un point bloquant qui ne peut pas
être tranché depuis le code.
