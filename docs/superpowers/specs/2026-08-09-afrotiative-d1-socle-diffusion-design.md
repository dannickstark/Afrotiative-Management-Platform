# D1 — Socle de diffusion

**Date :** 2026-08-09
**Programme :** « Studio visuel & diffusion multicanale » (`2026-08-09-afrotiative-studio-diffusion-roadmap.md`)
**Sous-projet :** D1 — dépend de V1 (livré). Prérequis de D2 → D6.
**Statut :** validé

## Objectif

Tout ce qu'il faut pour diffuser un article vers un réseau social — **sauf** les réseaux eux-mêmes.
Le modèle de données, le registre de canaux, les réglages par canal, la génération IA des légendes,
le panneau *Diffusion* dans la page article, le planificateur automatique et le journal d'audit.

D1 se livre avec **zéro adaptateur réel**. Un canal de démonstration (`StubChannel`) enregistre un
envoi sans appeler le réseau, exactement comme V1 s'est livré sans interface. Cela rend le socle
vérifiable de bout en bout — panneau, réessais, planificateur, audit — et réduit D2 (Facebook) à
l'écriture d'un adaptateur derrière une interface déjà éprouvée.

C'est aussi la seule séquence honnête : la revue d'application Meta pour `pages_manage_posts` et
`instagram_content_publish` n'est pas obtenue, et rien dans D1 ne doit l'attendre.

## Hors portée

- Tout appel réseau vers Facebook, Instagram, WhatsApp, X ou TikTok (D2 → D6).
- Le worker WhatsApp et son service Railway séparé (D4).
- Les aperçus par réseau dans la page article : ils vivent **ici**, dans le panneau Diffusion, pas
  dans l'onglet *Aperçu final* de V3 — décision prise au brainstorming.

---

## §1 Modèle de données

`distributions` existe déjà avec `channel` en texte et un index unique **partiel** sur
`WHERE channel = 'wordpress'` — laissé délibérément ouvert pour les autres canaux. On l'étend
plutôt que de le remplacer, pour que WordPress continue de fonctionner sans modification.

**Colonnes ajoutées à `distributions` :**

| Colonne | Rôle |
|---|---|
| `renderId` uuid | le rendu diffusé. **Immuable** : c'est ce qui matérialise « on ne re-rend pas après diffusion » |
| `caption` text | la légende réellement envoyée, telle qu'éditée |
| `attempts` int | nombre de tentatives |
| `lastError` text | dernier message d'échec, en français |
| `scheduledFor` timestamp | pour un envoi planifié ; null pour un envoi manuel |
| `sentAt` timestamp | horodatage de l'envoi réussi |
| `triggeredBy` text | `manual` \| `scheduled` — pour l'audit |
| `actorId` → user.id | qui a cliqué ; null pour un envoi planifié |

**Un index unique partiel par canal social** — `unique(article_id, channel) WHERE channel <> 'wordpress' AND status IN ('pending','sent')` — pour qu'un article ne parte jamais deux fois sur le même réseau. C'est la garantie que le planificateur ne double pas un envoi manuel, et réciproquement.

`renderId` n'est **pas** une clé étrangère vers `renders`, pour la même raison que `renders.subjectId`
n'en est pas une vers `articles` : c'est un historique de diffusion, pas une jointure vivante.

**Nouvelle table `social_channel_settings`** — une ligne par canal, créée à la demande :

`channel` (pk), `enabled`, `captionMaxChars`, `captionPrompt` (surcharge optionnelle),
`autoEnabled`, `autoIntervalHours`, `autoMaxBacklogDays`, `autoWindowStartHour`,
`autoWindowEndHour`, `lastAutoSendAt`, `updatedAt`.

Pas d'enum PostgreSQL : `text` + unions TypeScript, comme partout ailleurs dans ce schéma
(raison documentée sur `alerts.type`).

## §2 Registre de canaux

```ts
export interface SocialChannel {
  readonly key: Channel;              // 'facebook' | 'instagram' | 'whatsapp' | 'x' | 'tiktok'
  readonly label: string;             // français
  readonly context: TemplateContext;  // toujours 'social_post' en D1
  readonly format: FormatKey;         // pour résoudre le bon gabarit
  readonly captionLimits: { min: number; max: number; default: number };
  send(input: SendInput): Promise<SendResult>;
}
```

`captionLimits` porte les bornes **officielles** de chaque plateforme, en dur dans le code, parce
qu'elles ne sont pas négociables : un réglage ne peut pas les dépasser. Les valeurs configurées par
l'utilisateur vivent dans `social_channel_settings.captionMaxChars` et sont bornées par elles.

D1 enregistre les cinq canaux avec un `send` qui délègue à `StubChannel` : il journalise, marque
`sent` et renvoie un `externalId` synthétique. Chaque adaptateur réel (D2 → D6) remplace ce `send`
et **rien d'autre**.

## §3 Légendes générées par IA

`generateCaption({ articleId, channel })` réutilise la chaîne IA existante (`lib/ai/`, ordre de
fournisseurs, repli mock — le pipeline tourne déjà sans clé). Le prompt est en français, prend le
titre, le chapô et la catégorie, et impose la limite de caractères du canal.

La légende est **toujours éditable avant envoi**. L'IA propose, l'humain dispose — cohérent avec la
barrière de revue humaine qui gouverne tout ce produit. Un canal sans clé IA disponible obtient un
repli déterministe (titre tronqué à la limite) plutôt qu'une erreur.

## §4 Panneau Diffusion

Dans `/article/[id]`, une carte par canal activé, sous les onglets image :

- l'aperçu du rendu **de ce canal** (gabarit `social_post` résolu pour son format) ;
- la légende, pré-remplie par l'IA, éditable, avec un compteur de caractères et la limite ;
- un bouton **Publier sur {canal}**, désactivé tant que l'article n'est pas `published` ;
- l'état : jamais envoyé / envoyé le … / échec (avec le message et un bouton *Réessayer*).

**L'envoi génère l'image à ce moment-là**, pas avant — c'est la demande explicite de l'utilisateur.
Le rendu passe par `renderForArticle(articleId, { context: 'social_post', channel })`, et son
`renderId` est figé sur la ligne `distributions`.

**Pourquoi le bouton exige `published` :** l'image sociale peut porter `{{article.url}}` en QR code,
et cette URL n'existe qu'après la publication WordPress. C'est la même contrainte d'ordonnancement
que V1 encode déjà dans `CONTEXT_TOKENS`.

## §5 Planificateur automatique

La règle de l'utilisateur, généralisée à tous les canaux :

> Toutes les X heures, choisir **un** article publié sur WordPress le jour même et non encore envoyé
> sur ce canal, du plus ancien au plus récent. S'il n'y en a plus pour aujourd'hui, remonter à la
> veille, et ainsi de suite.

**Sélection :** `articles.status = 'published'`, `publishedAt` dans
`[now - autoMaxBacklogDays, now]`, sans ligne `distributions` pour ce canal en statut
`pending`/`sent`, triés par `date_trunc('day', published_at)` **décroissant** puis `publishedAt`
**croissant**, `LIMIT 1`.
>
> **Correction post-revue finale (2026-08-09) :** la version initialement livrée de ce paragraphe
> affirmait qu'un tri croissant *unique* sur `publishedAt` suffisait — « un article d'hier non
> envoyé précède naturellement un article d'aujourd'hui ». C'était **faux dans l'autre sens** : ce
> tri fait aussi précéder un article vieux de plusieurs jours à TOUT ce qui est publié aujourd'hui,
> inversant la priorité que l'utilisateur a explicitement demandée (le jour même d'abord, la veille
> seulement si le jour même est épuisé). C'est un défaut de cette spec, pas de l'implémentation qui
> l'a suivie à la lettre — corrigé dans `lib/diffusion/schedule-core.ts` (revue finale D1,
> Important 1) avec le tri à deux clés ci-dessus : le JOUR calendaire d'abord (le plus récent en
> premier), le tri croissant par heure ne départageant qu'À L'INTÉRIEUR d'un même jour.

**Échéance :** `lastAutoSendAt` est null, ou `now - lastAutoSendAt >= autoIntervalHours`.

**Fenêtre horaire** (`autoWindowStartHour` / `autoWindowEndHour`) : hors fenêtre, le tic ne fait
rien et ne consomme pas l'intervalle — un média ne poste pas à 4 h du matin.

**Anti-doublon :** l'index unique partiel du §1 est la garantie dure. `lastAutoSendAt` est posé
**avant** l'envoi, pour qu'un tic suivant ne reparte pas sur le même article si l'envoi est lent.

**Redémarrage :** `lastAutoSendAt` est persisté en base, donc un redéploiement ne remet pas le
compteur à zéro et ne provoque pas de rafale.

**Pilotage :** on étend le planificateur in-app existant (`lib/pipeline/scheduler.ts`, démarré par
`instrumentation.ts`) plutôt que d'en créer un second. Un seul tic, mono-instance, cohérent avec le
déploiement Railway.

## §6 Réglages par canal

`/settings/social` liste les canaux ; `/settings/social/[channel]` porte le détail : activation,
limite de caractères (bornée par `captionLimits`), surcharge de prompt, et le bloc publication
automatique (activation, intervalle, profondeur de rattrapage, fenêtre horaire).

Admin uniquement — nouvelle ressource RBAC `social`, actions `read` / `manage` / `send`. L'éditeur
obtient `read` et `send` (il diffuse depuis la page article) mais pas `manage`.

## §7 Erreurs et audit

Style de la maison : les actions renvoient `{ ok: false, message }` en français, jamais de `throw`
vers l'interface.

- Un envoi échoué incrémente `attempts`, écrit `lastError`, laisse le statut `failed` — réessayable.
- Chaque envoi (réussi ou non) ajoute une entrée `article_revisions`, comme le fait déjà la
  publication WordPress. C'est le journal d'audit : qui, quand, quel canal, quelle issue.
- Un rendu en échec **empêche** l'envoi et remonte le message du moteur : diffuser une carte sans
  image serait pire qu'un échec clair.
- Canal désactivé, ou stockage R2 non configuré → le bouton est désactivé avec la raison affichée,
  pas une erreur au clic.

## §8 Tests

| Cible | Ce qui est vérifié |
|---|---|
| Index unique | deux envois concurrents sur le même (article, canal) — un seul passe |
| Sélection du planificateur | le jour même d'abord (le plus ancien du jour), la veille seulement si le jour même est épuisé ; article déjà envoyé exclu ; respect de `autoMaxBacklogDays` |
| Fenêtre horaire | hors fenêtre, aucun envoi **et** l'intervalle n'est pas consommé |
| Échéance | avant `autoIntervalHours`, rien ; après, un envoi |
| Redémarrage | `lastAutoSendAt` persisté empêche la rafale |
| Légendes | limite respectée ; repli déterministe sans clé IA ; la limite configurée ne peut pas dépasser `captionLimits.max` |
| RBAC | journaliste refusé sur `send` et `manage` ; éditeur refusé sur `manage` |
| Envoi | `renderId` figé ; un second envoi ne re-rend pas ; échec → `attempts` incrémenté et `lastError` posé |
| Barrière | un article non `published` ne peut pas être diffusé |
| WordPress | le canal `wordpress` existant est **inchangé** — ses suites restent vertes sans modification |

## §9 Découpage

1. **Données & registre** — migration `distributions` + `social_channel_settings`, `SocialChannel`,
   `StubChannel`, RBAC `social`.
2. **Envoi & panneau** — `sendToChannel`, génération de légende, panneau Diffusion dans l'article.
3. **Réglages** — `/settings/social` et la sous-page par canal.
4. **Planificateur** — sélection, échéance, fenêtre, anti-doublon, branchement sur le tic existant.

## Post-revue (revue finale, 2026-08-09)

Verdict : **prêt avec corrections** — aucun Critical, la barrière de revue humaine vérifiée intacte,
cinq Important corrigés (voir `.superpowers/sdd/2026-08-09-afrotiative-d1-socle-diffusion/
final-fix-report.md` pour le détail). Deux points à ne pas rouvrir en D2 :

- **Le second job croner (§5, "Pilotage") est confirmé, pas un défaut.** L'implémentation Tâche 9
  a démarré un DEUXIÈME `Cron` dédié à la diffusion (`lib/pipeline/scheduler.ts`'s
  `diffusionJob`/`DIFFUSION_TICK_CRON`) plutôt que de brancher un second callback sur le job
  pipeline existant, et avait elle-même signalé cet écart pour un second avis (voir
  `.superpowers/sdd/2026-08-09-afrotiative-d1-socle-diffusion/progress.md`). La revue finale l'a
  confirmé justifié, sans risque identifié : le job pipeline n'existe QUE si
  `pipeline_settings.scheduleCron` est configuré, donc y accrocher la diffusion automatique
  l'aurait rendue silencieusement dépendante d'un réglage optionnel et sans rapport. **Ne pas
  re-débattre ce choix en D2.**

- **Obligation D2 — `externalId` tôt, et revisiter le seuil de récupération `pending`.** Le seuil
  (paramétré `DIFFUSION_STALE_PENDING_MINUTES`, défaut 10 min — revue finale, Important 5) est sûr
  aujourd'hui car `StubChannel.send` ne fait aucun I/O. Dès qu'un adaptateur réel existe, ce seuil
  devient une hypothèse de latence, et un crash survenant APRÈS qu'un vrai POST a réussi laisserait
  une ligne que le récupérateur marque `failed` — une relance produirait alors un **doublon public**.
  Chaque adaptateur D2 → D6 doit donc écrire `externalId` **le plus tôt possible** (dès que l'appel
  réseau confirme l'acceptation, avant même le retour complet de `send()` si l'API le permet) pour
  qu'une relance puisse un jour être court-circuitée par sa présence, et le seuil lui-même doit être
  revisité contre la latence réelle du premier adaptateur livré, pas laissé à 10 min par défaut.
