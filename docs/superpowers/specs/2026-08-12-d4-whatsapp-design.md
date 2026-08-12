# D4 — Adaptateur WhatsApp : décision de conception (spike, pas de build)

**Date :** 2026-08-12
**Statut :** Spike livré — décision + contrat d'interface, aucune intégration réelle.
**Plan :** `plans/013-whatsapp-adapter-spike.md` · **Dépend de :** plan 001 (gating du stub).

Ce document répond aux 5 livrables du plan 013. Il ne modifie ni `lib/diffusion/channels.ts`, ni
`db/studio-templates.ts`, ni aucun fichier `lib/studio`/`components/studio` (processus Studio
séparé). Aucune dépendance n'a été ajoutée à `package.json`. Aucun message n'a été envoyé à un
numéro WhatsApp réel.

---

## 1. Décision : Cloud API officielle vs bibliothèque non officielle

| Critère | **WhatsApp Cloud API (Meta, officielle)** | **whatsapp-web.js + Chromium (non officielle)** |
|---|---|---|
| Coût | Gratuit jusqu'à un seuil de conversations/mois, puis facturé à la conversation | Gratuit (pas de facturation Meta), mais un second service Railway (CPU/RAM pour Chromium) a un coût d'hébergement continu |
| Cible « canal » WhatsApp (Channel) | **Non supporté.** L'API Cloud parle à des numéros individuels (messages 1:1) ou des groupes via des flux tiers limités — elle n'expose **aucune** primitive « WhatsApp Channel » (la fonctionnalité de diffusion façon chaîne). | **Supporté**, et vérifié en amont (roadmap, 2026-08-10) : `main` expose `getChannels()`, `getChannelByInviteCode()`, `createChannel()`, `sendMessage()` vers un canal avec texte+image. |
| Risque de bannissement du numéro | Nul — c'est l'API officielle | Réel — WhatsApp interdit contractuellement les clients non officiels et bannit des numéros automatisés détectés. Assumé explicitement dans la feuille de route D1. |
| Compte Business requis | Oui — Meta Business Account + numéro vérifié + revue d'application pour les gabarits de message hors fenêtre 24h | Non — un numéro WhatsApp ordinaire suffit (« sacrifiable », roadmap §"Travaux hors code") |
| Contrainte de contenu | Messages sortants hors fenêtre de service (24h) doivent utiliser des **gabarits pré-approuvés** par Meta — incompatible avec « image + légende générée par IA, éditable au dernier moment » (spec §"Légendes ... Générées par IA, par canal") sans repasser par une revue de gabarit à chaque changement de légende | Aucune contrainte de gabarit côté plateforme — image + légende libre, exactement le contrat `SendInput` de ce codebase |
| Session/état | Sans état côté nous — juste un jeton d'accès | Nécessite une session de navigateur persistée (`RemoteAuth`, cookies/clés de chiffrement WhatsApp Web) qui doit survivre aux redémarrages |
| Latence/fiabilité opérationnelle | Élevée (API HTTP standard) | Plus fragile — dépend du bon vouloir de Chromium headless, de la stabilité de whatsapp-web.js face aux changements internes non documentés de WhatsApp Web |

### Recommandation : **bibliothèque non officielle (whatsapp-web.js), inchangée par rapport à la feuille de route**

C'est la décision déjà validée par l'utilisateur en D1/D4 (roadmap §"WhatsApp" et §"Décisions
D2 → D7"), et ce spike la confirme plutôt que de la rouvrir, pour une raison structurelle et non
négociable : **l'exigence produit cible explicitement un « canal » WhatsApp** (Channel), pas un
contact individuel — table "Décisions produit" du 2026-08-09, ligne "Cible WhatsApp". La Cloud API
officielle de Meta **n'a pas d'équivalent** pour cette primitive : elle adresse des numéros et,
via des intégrations tierces limitées, des groupes — jamais des Channels. Choisir l'API officielle
reviendrait à livrer une fonctionnalité différente de celle demandée (des DM ou un groupe, pas un
canal de diffusion one-to-many), pas une version « plus sûre » de la même fonctionnalité.

Le risque de bannissement est donc un coût **assumé consciemment**, pas ignoré :
- Le numéro dédié au worker est **explicitement qualifié de sacrifiable** dans la feuille de route
  (§"Travaux hors code à lancer maintenant", point 5) — c'est la mitigation de fond : ne jamais
  utiliser un numéro qui compte pour l'organisation.
- Le §5 de ce document détaille les mitigations opérationnelles et un chemin de repli rapide.

**Réserve technique héritée, à lever en implémentation (pas dans ce spike) :** les méthodes de
canal (`getChannels`, `createChannel`, `sendMessage` vers un canal) sont vérifiées sur la branche
`main` de whatsapp-web.js au 2026-08-10 ; la version publiée sur npm peut être en retard. Une
implémentation réelle devra vérifier la version npm au moment de l'installation et, si nécessaire,
installer depuis GitHub plutôt que depuis npm (roadmap, même section). Ce spike n'installe rien
(règle stricte du plan) et ne peut donc pas confirmer cet état à la date du présent document.

---

## 2. Architecture

### 2.1 Où le `send` s'exécute

**Un second service Railway séparé du service web principal** (roadmap §D4, §"Hébergement
Railway"), pas en-process dans l'app Next.js :
- Chromium headless (whatsapp-web.js en dépend) est lourd en CPU/RAM et n'a rien à faire dans le
  service qui sert les requêtes HTTP de l'app.
- Une session whatsapp-web.js est un état de processus long-vivant (le navigateur reste connecté
  en continu) — un modèle request/response classique (route Next.js, server action) ne convient
  pas à ce cycle de vie.
- Isolation de panne : un crash de Chromium ou un bannissement de numéro ne doit pas dégrader le
  service web principal (rendu Studio, publication WordPress, autres canaux).

Le worker expose une petite API interne (HTTP, authentifiée par un secret partagé côté variable
d'environnement — même famille de secret que `CREDENTIALS_ENCRYPTION_KEY`) que
`WhatsAppChannel.send()` (§3, dans le service principal) appelle. Le worker ne connaît rien du
domaine « articles/distributions » — il reçoit `{ imageUrl, caption }` et renvoie
`{ ok, externalId | message }`, exactement le contrat `SendResult` déjà utilisé par tous les
adaptateurs.

### 2.2 Persistance et restauration de la session

- `RemoteAuth` (module officiel de whatsapp-web.js prévu pour ça) avec un **store Postgres**
  (même base que le reste de l'app — pas un nouveau système de stockage) : la session
  (essentiellement les données d'authentification WhatsApp Web chiffrées côté client par la
  bibliothèque) est sérialisée périodiquement et écrite en base, puis relue au démarrage du worker.
- Ceci évite un rescan de QR code à chaque redéploiement/redémarrage Railway — un `RemoteAuth`
  perdu remettrait le canal en panne jusqu'à intervention humaine (scan manuel d'un QR code sur le
  téléphone lié).
- Le worker doit exposer un mode de bootstrap initial où un opérateur scanne le QR code une seule
  fois (interface minimale — même endpoint interne, ou logs contenant le QR en ASCII pour un
  premier lancement manuel). Ceci **n'est pas couvert par ce spike** (le plan interdit tout
  bootstrap réel de session ici — §5 explique pourquoi).

### 2.3 Dédoublonnage du planificateur de rattrapage

**Réutilisation intégrale du mécanisme existant** — rien de neuf à construire côté `distributions` :
- `distributions` a déjà `(articleId, channel, status, externalId)` avec un index unique
  **partiel** par canal (`db/schema.ts`, `distributions_one_active_per_article_channel`) qui
  garantit qu'un seul envoi peut être `pending`/`sent` à la fois pour une paire
  (article, whatsapp).
- Le planificateur de rattrapage (`lib/diffusion/schedule-core.ts::selectNextArticle`) exclut déjà
  tout article ayant une ligne `distributions` en `pending` ou `sent` pour le canal — c'est
  exactement la règle utilisateur ("le publie ... s'il ne l'a pas déjà été", roadmap
  §"Règle de publication automatique WhatsApp"). WhatsApp n'a besoin d'aucune logique de
  dédoublonnage propre : il hérite de celle qui sert déjà Facebook/Instagram/LinkedIn.
- `send-core.ts::sendToChannelCore` écrit la ligne `distributions` en `pending` **avant** d'appeler
  `channel.send()`, puis persiste `externalId` **dès que** `send()` répond `{ok:true}` — c'est le
  garde-fou at-least-once déjà en place (spec D2/D3, "chaque adaptateur doit écrire `externalId`
  au plus tôt"). `WhatsAppChannel.send()` doit suivre cette même discipline : renvoyer
  `{ok:true, externalId}` **immédiatement** après confirmation d'envoi par whatsapp-web.js, sans
  appel de confirmation supplémentaire entre-temps (même principe que `linkedin.ts`).
- Le seuil du faucheur de `pending` bloqués (`STALE_PENDING_FLOOR_MINUTES`,
  `lib/diffusion/scheduler.ts`) est actuellement calé sur le pire cas LinkedIn (≈5,1 min). Une
  implémentation réelle de WhatsApp devra mesurer sa propre latence pire cas (temps d'établissement
  de la session Chromium + envoi) et **revoir ce plancher si WhatsApp est plus lent** — sinon un
  envoi WhatsApp légitimement en cours pourrait être réclamé trop tôt et dupliqué au canal réel
  (le seul type de duplication qui compte : un message public déjà visible dans le canal). C'est un
  point de build, pas une réouverture de conception ici.
- `externalId` pour WhatsApp : whatsapp-web.js renvoie un identifiant de message (`msg.id.id` /
  `_serialized`) après `sendMessage()` réussi — c'est la valeur à écrire, du même rôle que
  `x-restli-id` pour LinkedIn ou l'id de post Graph pour Facebook/Instagram.

---

## 3. Contrat `WhatsAppChannel`

Remplace `send: (input) => new StubChannel("whatsapp").send(input)` dans
`lib/diffusion/channels.ts` (l'entrée `whatsapp` du registre `SOCIAL_CHANNELS`), et fait passer
son `available` de `false` à `true` (le comportement de gating "UI must refuse the send" ajouté par
le plan 001 disparaît automatiquement pour ce canal une fois `available:true` posé — rien d'autre
à toucher dans l'UI).

```ts
// lib/diffusion/whatsapp/whatsapp.ts (fichier futur — n'existe pas dans ce spike)
import type { SendInput, SendResult } from "../channels";

export class WhatsAppChannel {
  // Constructeur sans argument, comme FacebookChannel/InstagramChannel/LinkedInChannel — même
  // forme "new X().send(input)" que channels.ts impose à toute entrée du registre (voir le
  // commentaire d'en-tête de channels.ts : "NOTHING else... key/label/context/format/
  // captionLimits stay exactly as defined here").
  async send(input: SendInput): Promise<SendResult> {
    // 1. Récupère l'URL/secret du worker WhatsApp (variable d'environnement, PAS
    //    social_channel_settings.credentials — WhatsApp n'a AUCUN credentialFields déclaré dans
    //    channels.ts : "no credential needed — see this file's header comment". Le secret qui
    //    protège l'appel interne app -> worker est une config d'infrastructure, pas un identifiant
    //    par-opérateur au sens des cinq autres canaux).
    // 2. POST { imageUrl: input.imageUrl, caption: input.caption } vers le worker.
    // 3. Le worker répond { ok: true, externalId } ou { ok: false, message } — ce module ne fait
    //    QUE relayer cette réponse (SendResult), en mappant les erreurs réseau/timeout vers le
    //    même schéma { ok: false, message } que tous les autres adaptateurs (house style,
    //    channels.ts: "channels report failure as data, never throw").
    throw new Error("WhatsAppChannel non configuré — spike D4, aucune implémentation réelle (voir docs/superpowers/specs/2026-08-12-d4-whatsapp-design.md)");
  }
}
```

Points de contrat qui NE changent PAS (mêmes garanties que Facebook/Instagram/LinkedIn) :
- `SendInput` reste `{ articleId, imageUrl, caption }` — aucune extension d'interface. Le worker
  n'a pas besoin d'`articleId` pour envoyer, mais `send-core.ts` le passe déjà à tous les
  adaptateurs pour la corrélation de logs ; `WhatsAppChannel` peut le transmettre au worker pour le
  même usage.
- `SendResult` reste `{ok:true, externalId} | {ok:false, message}` — jamais de `throw` en sortie de
  `send()` (le squelette ci-dessus lève une erreur uniquement parce qu'il n'est PAS implémenté ;
  une vraie implémentation ne lèverait jamais).
- `format: "wa_square"` et `captionLimits: {min:1, max:1024, default:300}` dans
  `SOCIAL_CHANNELS.whatsapp` restent inchangés — seuls `available` et `send` changent à
  l'activation.
- `credentialFields: []` reste `[]` — la carte d'identifiants ne doit toujours PAS apparaître sur
  `/settings/social/whatsapp` (WhatsApp n'a pas de jeton par opérateur, contrairement à Meta/
  LinkedIn ; la configuration est au niveau infra du worker, pas au niveau `social_channel_settings`).

### Points d'intégration à toucher lors du build (hors scope de ce spike)

| Fichier | Changement |
|---|---|
| `lib/diffusion/channels.ts` | `available: true`, `send: (input) => new WhatsAppChannel().send(input)` sur l'entrée `whatsapp` |
| `lib/diffusion/whatsapp/whatsapp.ts` (nouveau) | Implémentation réelle du contrat ci-dessus |
| `db/studio-templates.ts` | **Propriété du processus Studio, ne pas éditer ici** — voir §4 |
| `lib/diffusion/scheduler.ts` | Revoir `STALE_PENDING_FLOOR_MINUTES` si la latence WhatsApp dépasse le pire cas LinkedIn (§2.3) |
| Un nouveau service Railway | Le worker whatsapp-web.js lui-même — hors du dépôt applicatif principal, ou dans un sous-répertoire séparé non bundlé avec l'app Next.js |
| `docs/DEPLOYMENT.md` | Nouvelle section pour le worker (variables d'environnement, bootstrap de session) — même convention que le §6.5 existant pour LinkedIn |

---

## 4. Prérequis gabarit — coordination avec le processus Studio

`sendToChannelCore` (`lib/diffusion/send-core.ts`, étape 3) appelle
`renderForArticle(articleId, {context:'social_post', channel:'whatsapp'})` ; si aucun gabarit
`social_post` publié n'existe pour le format `wa_square`, le rendu répond
`{ok:true, url:null}` et l'envoi est refusé avec le message
« Aucun gabarit « post social » n'est configuré pour WhatsApp. » — WhatsApp ne peut donc
**structurellement pas** être activé sans ce gabarit, indépendamment de tout code d'adaptateur.

Vérifié dans ce spike : `db/studio-templates.ts` ne sème aujourd'hui que trois gabarits
`social_post` — `fb_link`, `ig_square`, `li_link` (lignes 76-78). **Aucun gabarit `wa_square`
n'existe.** C'est exactement le manque déjà documenté dans la feuille de route (§"Gabarits
manquants" : « WhatsApp (`story`) [note : la feuille de route mentionne `story` mais le registre
`channels.ts` actuel déclare `format: "wa_square"` pour whatsapp — `wa_square` est la source de
vérité puisque c'est le format réellement utilisé par le code exécuté] ... n'ont aucun gabarit
`social_post` publié, et sans lui l'envoi est refusé »).

**Ce fichier appartient à un processus Studio séparé et n'a pas été modifié par ce spike**, comme
demandé. Coordination nécessaire avant qu'une implémentation réelle de D4 puisse être activée en
production : le processus Studio doit semer et publier un gabarit `social_post` au format
`wa_square` (même modèle que les trois gabarits existants — voir `FB_TEMPLATE`/`IG_TEMPLATE`/
`LI_TEMPLATE` dans ce fichier pour la forme attendue) avant que `available:true` ait un effet
utile pour un opérateur réel.

---

## 5. Risque de bannissement + repli

### Mitigations opérationnelles
- **Numéro sacrifiable** (déjà décidé, roadmap §"Travaux hors code", point 5) : jamais le numéro
  personnel/professionnel d'un opérateur. Un numéro dédié, à faible coût de remplacement.
- **Cadence humaine, pas de spam** : la règle de publication (roadmap §"Règle de publication
  automatique WhatsApp") est *au plus un message toutes les X heures* — bien en-deçà de tout seuil
  de détection anti-bot connu pour WhatsApp Web. Aucune rafale n'est prévue par la conception D1.
- **Fenêtre d'envoi configurable** (`autoWindowStartHour`/`autoWindowEndHour`,
  `schedule-core.ts::isWithinWindow`) — déjà générique à tout canal, WhatsApp en hérite sans code
  supplémentaire : évite un pattern d'envoi 24/7 mécanique qui ressemblerait davantage à un bot.
- **Session longue durée unique** (`RemoteAuth`) plutôt que des reconnexions fréquentes — les
  reconnexions répétées sont un signal de détection plus fort qu'une session stable.

### Plan de repli rapide
- Le flag **`available`** (`SOCIAL_CHANNELS.whatsapp.available`, `lib/diffusion/channels.ts`) est
  le coupe-circuit immédiat : le repasser à `false` fait réapparaître le refus d'envoi côté UI
  (plan 001) en un seul commit, sans toucher au worker ni à son état de session.
- **`autoEnabled`** par canal (`social_channel_settings`, déjà générique à tout canal) permet de
  couper la publication *automatique* seule, en laissant l'envoi manuel actif — utile si le
  problème est spécifiquement la cadence automatique et non le canal lui-même.
- Si le numéro est banni : c'est un événement **attendu et budgété** (le numéro est sacrifiable) —
  la réponse est de provisionner un nouveau numéro, rescanner le QR code sur le worker, et
  redémarrer. Aucune donnée applicative (articles, distributions passées) n'est perdue — seule la
  session WhatsApp elle-même doit être recréée. Les lignes `distributions` déjà `sent` restent un
  historique valide même si le canal est ensuite désactivé.
- Si whatsapp-web.js casse suite à un changement interne non documenté de WhatsApp Web (risque
  structurel d'une bibliothèque non officielle, indépendant du bannissement) : même levier
  `available:false` en attendant un correctif de la bibliothèque ou une mise à jour de version.

---

## 6. Preuve — non tentée, par choix

Le plan autorise une preuve technique « fine » (bootstrap de session sans identifiants, sans envoi
réel) **uniquement si elle peut être faite en toute sécurité**. Ce spike **s'arrête au document de
conception** sans tenter cette preuve, pour deux raisons cumulatives, chacune suffisante seule :

1. **Règle stricte du plan** : « Do NOT add `whatsapp-web.js`/`puppeteer` (or any dep) to
   package.json. » Tout bootstrap de session, même sans identifiants réels, nécessite d'installer
   whatsapp-web.js (et sa dépendance Chromium/Puppeteer) pour instancier un client — il n'existe
   pas de façon de faire tourner ne serait-ce que la phase de génération de QR code sans cette
   dépendance présente dans l'environnement d'exécution.
2. Même si la dépendance était temporairement installée puis retirée sans commit, lancer un client
   whatsapp-web.js **ouvre une session Chromium qui tente de se connecter aux serveurs WhatsApp
   Web réels** dès l'instanciation, avant même le scan d'un QR code — il n'y a pas de mode
   "purement local, aucun réseau" dans cette bibliothèque. Ce n'est donc pas une preuve
   "credential-free" au sens où le plan l'entend : c'est un contact réseau avec l'infrastructure
   WhatsApp, ce que le plan demande explicitement d'éviter en cas de doute ("If a proof requires
   either, STOP at the design doc and report").

Confirmation exécutée : `grep -n "whatsapp\|puppeteer" package.json` → aucune correspondance.
Aucune dépendance n'a été ajoutée ni retirée par ce spike.

---

## Résumé pour la suite

- **Décision** : whatsapp-web.js (non officielle) dans un second service Railway, session
  `RemoteAuth` persistée en Postgres — confirme la feuille de route, ne la rouvre pas.
- **Bloquant avant activation réelle** : gabarit `wa_square` `social_post` à semer côté Studio
  (§4) — aucun code d'adaptateur ne peut contourner ce refus structurel de `send-core.ts`.
- **Contrat d'interface figé** : `WhatsAppChannel.send(input): Promise<SendResult>`, même forme
  que les quatre adaptateurs réels existants — un futur plan de build peut l'implémenter sans
  retoucher `channels.ts` au-delà du remplacement `StubChannel` → `WhatsAppChannel` déjà documenté.
- **Ce qui reste à faire, hors scope ici** : le worker Railway lui-même, le bootstrap de session
  (scan QR), le store `RemoteAuth` Postgres, la revue du seuil du faucheur `pending` (§2.3) contre
  la latence réelle observée.
