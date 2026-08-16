# Design — Scripts vidéo, sous-projet 1 : contrat, brief & import

Date: 2026-08-16
Status: approved-for-planning (pending user spec review)
Branch: `feat/video-script-contrat-import`

Nouveau module **Vidéo** (`/video`) : un espace par vidéo, dans lequel l'écriture n'a **pas** lieu.
L'écriture et la recherche se font en amont, dans un chat Claude ; le module fournit les deux bouts
autour de ce chat — le **brief** (instructions de recherche + contrat JSON) qu'on colle dans le chat,
et l'**import** qui valide la réponse, la fusionne avec l'existant et la transforme en *beats*.

Ce spec couvre le **sous-projet 1 seulement**. Il pose en revanche le **modèle de données en entier**,
pour que les sous-projets 1 bis à 6 s'y branchent sans migration destructrice.

## Décisions verrouillées avec l'utilisateur

1. **Un script est une suite de beats typés**, pas un document. Narratif et interview partagent la même
   structure (approche A) ; le beat porte le texte parlé dans un champ riche, mais l'unité qui voyage
   jusqu'au monteur est le beat.
2. **Le contrat JSON est la pièce centrale**, dérivé d'un schéma Zod unique — jamais réécrit à la main.
3. **Entrée JSON stricte uniquement.** Ni Markdown, ni texte libre restructuré par IA.
4. **Ré-import = fusion par identifiant de beat**, avec diff et choix humain. Les éditions locales survivent.
5. **Le brief est un modèle éditable en Réglages** (style maison) + variables du projet ; le bloc de contrat,
   lui, est généré par le code et non modifiable.
6. **Origine double** : un projet peut dériver d'un article approuvé ou naître autonome.
7. **URLs médias** : vérification de vivacité et badge « lien mort » (sous-projet 3), et **l'utilisateur peut
   modifier n'importe quelle URL à la main, à tout moment**. Pas d'archivage R2 des médias externes.
   Le champ crédit/droits existe mais reste **optionnel**.
8. **Aucune IA dans l'application** pour l'écriture. L'IA est en amont, dans le chat.
9. **Le copier-coller reste** même après l'arrivée du MCP (sous-projet 1 bis) : même schéma, coût nul.

## Vocabulaire

| Terme | Sens |
|---|---|
| **Projet vidéo** | Un sujet = un espace. Porte le titre, l'angle, le lien article optionnel. |
| **Variante** | Une déclinaison jouable du projet : YouTube long, Short, TikTok, Reel, Interview. Un projet a au moins une variante. |
| **Beat** | L'unité atomique : un morceau de parole, une question, un insert, une transition, un texte à l'écran. |
| **Brief** | Le prompt à coller dans le chat : style maison + paramètres du projet + contrat JSON. |
| **Journal** | L'historique de toute modification venue de l'extérieur (import collé, plus tard écriture d'agent), annulable. |

---

## 1. Modèle de données (`db/schema.ts`)

Posé en entier ici. Les tables marquées « ouverte au SP n » ne sont exploitées par aucune interface
au sous-projet 1, mais existent dès la première migration.

### 1.1 Enums

```ts
export const videoProjectStatus = pgEnum("video_project_status", [
  "brouillon", "en_ecriture", "pret_a_tourner", "tourne", "en_montage", "publie", "archive",
]);
export const scriptPlatform = pgEnum("script_platform", [
  "youtube_long", "youtube_short", "tiktok", "reel", "interview",
]);
export const beatKind = pgEnum("beat_kind", [
  "narration",   // texte dit face caméra ou en voix off
  "question",    // interview : la question posée (SP5)
  "reponse",     // interview : la réponse, rattachée à une question (SP5)
  "insert",      // image / graphique posé sur la parole
  "broll",       // plan d'illustration
  "transition",  // le beat EST la transition (volet, whip pan, écran noir)
  "texte_ecran", // incrustation seule, sans parole
  "son",         // lit musical, bruitage, point de ducking
  "note",        // consigne au monteur, jamais lue ni tournée
]);
export const takeStatus = pgEnum("take_status", ["bonne", "mauvaise", "a_revoir"]);
export const insertKind = pgEnum("insert_kind", ["image", "video", "extrait", "graphique", "fichier"]);
export const linkStatus = pgEnum("link_status", ["non_verifie", "ok", "mort", "interdit"]);
export const scriptJournalSource = pgEnum("script_journal_source", ["copier_coller", "mcp", "manuel"]);
export const scriptJournalOutcome = pgEnum("script_journal_outcome", ["rejete", "applique", "annule"]);
```

`linkStatus.interdit` = l'URL a été refusée par le garde SSRF (`lib/url-guard.ts`), distinct de `mort`
(l'URL est légitime mais ne répond plus). Les deux se lisent différemment côté monteur.

### 1.2 `video_projects`

| Colonne | Type | Note |
|---|---|---|
| `id` | uuid PK | |
| `title` | text notNull | |
| `subject` | text | le sujet/angle donné au chat |
| `status` | `video_project_status` notNull default `brouillon` | |
| `articleId` | uuid → `articles.id` | nullable — origine double (décision 6) |
| `createdBy` | text → `user.id` | |
| `createdAt` / `updatedAt` | timestamp notNull | |

Index : `video_projects_status_idx`, `video_projects_article_idx`.

### 1.3 `script_variants`

| Colonne | Type | Note |
|---|---|---|
| `id` | uuid PK | |
| `projectId` | uuid → `video_projects.id` notNull, cascade | |
| `platform` | `script_platform` notNull | |
| `targetDurationSec` | integer | nullable = pas de cible |
| `aspectRatio` | text notNull default `"16:9"` | `16:9` / `9:16` / `1:1` |
| `position` | integer notNull | |
| `derivedFromId` | uuid → self | nullable — **ouverte au SP6** (variantes dérivées) |
| `createdAt` / `updatedAt` | timestamp notNull | |

Contraintes : `unique(projectId, position)`, index `script_variants_project_idx`.

### 1.4 `script_beats`

| Colonne | Type | Note |
|---|---|---|
| `id` | uuid PK | |
| `variantId` | uuid → `script_variants.id` notNull, cascade | |
| `externalId` | text notNull | **l'identifiant stable venant du JSON** — la clé de fusion |
| `position` | integer notNull | |
| `kind` | `beat_kind` notNull | |
| `spokenText` | text notNull default `""` | HTML restreint, assaini par `lib/sanitize.ts` |
| `directionNote` | text | consigne de réalisation (cadrage, intention, regard) |
| `screenText` | text | incrustation / lower-third |
| `transitionIn` / `transitionOut` | text | vocabulaire libre au SP1 ; liste maison au SP2 |
| `estimatedDurationSec` | integer notNull default `0` | calculé à l'écriture (§4) |
| `durationOverrideSec` | integer | nullable — l'humain force la durée |
| `framing` | jsonb notNull default `{}` | **ouverte au SP6** : zones de sécurité 16:9 / 9:16 |
| `speakerId` | uuid → `interview_speakers.id` | nullable — **ouverte au SP5** |
| `answersBeatId` | uuid → self | nullable — **ouverte au SP5** : réponse → question |
| `sources` | jsonb notNull default `[]` | `string[]` d'URLs justifiant les affirmations du beat |
| `importedSnapshot` | jsonb | le fragment de payload **exactement tel qu'appliqué** au dernier import — la base de la fusion à trois voies (§5.3) |
| `locallyEditedAt` | timestamp | nullable ; posé dès qu'un humain modifie le beat dans l'app |
| `createdAt` / `updatedAt` | timestamp notNull | |

Contraintes : `unique(variantId, externalId)` et index `script_beats_variant_position_idx` sur
`(variantId, position)`. **Pas de contrainte d'unicité sur `position`** : un réordonnancement écrit
plusieurs lignes dans une même transaction et passerait par des états transitoirement en doublon ;
l'unicité différée est mal outillée côté Drizzle, et l'ordre est de toute façon reconstruit à chaque
écriture par `applyMerge`. La continuité de `position` est une invariante applicative, pas une contrainte SQL.

`interview_speakers` (§1.7) doit être déclarée **avant** `script_beats` dans `db/schema.ts`, pour que la
référence `speakerId` se résolve sans référence avant déclaration.

`importedSnapshot` est ce qui rend la fusion correcte plutôt qu'approximative : sans lui, on ne peut pas
distinguer « Claude a changé ce beat » de « l'humain l'a changé », et un ré-import écrase silencieusement.

### 1.5 `beat_inserts`

| Colonne | Type | Note |
|---|---|---|
| `id` | uuid PK | |
| `beatId` | uuid → `script_beats.id` notNull, cascade | |
| `kind` | `insert_kind` notNull | |
| `url` | text | **toujours éditable à la main** (décision 7) |
| `r2Key` | text | nullable — **ouverte au SP3** : fichier téléversé par le rédacteur |
| `tcIn` / `tcOut` | text | `HH:MM:SS` ou `HH:MM:SS.mmm`, validés par regex |
| `displayDurationSec` | integer | combien de temps l'insert reste à l'écran |
| `credit` | text | **optionnel** (décision 7) |
| `rightsNote` | text | **optionnel** |
| `linkStatus` | `link_status` notNull default `non_verifie` | posé par le SP3 |
| `linkCheckedAt` | timestamp | |
| `position` | integer notNull | |
| `createdAt` / `updatedAt` | timestamp notNull | |

Au SP1 ces lignes sont **créées par l'import et affichées en lecture** dans la vue auteur, avec l'URL
éditable. La vérification de vivacité et le téléversement arrivent au SP3.

### 1.6 `beat_takes` — ouverte au SP4

`id`, `beatId` (cascade), `number` integer notNull, `status` `take_status` notNull,
`startedAt` timestamp, `note` text, `createdAt`. Contrainte `unique(beatId, number)`.

### 1.7 `interview_speakers` — ouverte au SP5

`id`, `projectId` (cascade), `name` text notNull, `role` text, `consentGiven` boolean notNull default `false`,
`consentNote` text, `createdAt` / `updatedAt`.

### 1.8 `script_journal`

Une seule table pour **tout ce qui vient de l'extérieur** : import collé au SP1, écritures d'agent MCP
au SP1 bis. C'est ce qui rend l'écriture complète des agents réversible.

| Colonne | Type | Note |
|---|---|---|
| `id` | uuid PK | |
| `projectId` | uuid → `video_projects.id` notNull, cascade | |
| `variantId` | uuid → `script_variants.id` | nullable (un import peut créer la variante) |
| `source` | `script_journal_source` notNull | |
| `toolName` | text | **ouverte au SP1 bis** : quel outil MCP a écrit |
| `actorUserId` | text → `user.id` | qui a collé, ou à qui appartient le jeton d'API |
| `schemaVersion` | text | lu dans le payload |
| `rawPayload` | jsonb | le payload brut, **tel que reçu**, avant toute normalisation |
| `errorReport` | jsonb notNull default `[]` | `{ path, message, received }[]` |
| `diff` | jsonb notNull default `{}` | le diff calculé (§5.3) |
| `applied` | jsonb notNull default `{}` | ce qui a **réellement** été appliqué après choix humain |
| `outcome` | `script_journal_outcome` notNull | |
| `revertedAt` | timestamp | |
| `createdAt` | timestamp notNull | |

`rawPayload` est conservé brut délibérément : quand un import échoue, la seule façon de diagnostiquer
est de relire ce que le modèle a réellement produit, pas ce que le parseur en a compris.

### 1.9 `video_settings` (ligne unique)

`id` uuid PK, `briefTemplate` text notNull, `wordsPerMinute` integer notNull default `155`,
`updatedAt`, `updatedBy`. Modèle par défaut semé par `db/seed.ts`.

---

## 2. Le contrat JSON (`lib/video/schema.ts`)

**Une seule définition Zod**, dont quatre choses sont dérivées et jamais réécrites :

1. le validateur d'import (§5) ;
2. le bloc JSON-Schema injecté dans le brief — via `z.toJSONSchema()`, natif en Zod 4.4.3 (vérifié) ;
3. l'exemple rempli montré au chat ;
4. **les schémas d'entrée des outils MCP** (SP1 bis).

Si ces quatre-là sont écrits séparément, ils divergent, et la divergence se manifeste en import
inexplicablement refusé.

### 2.1 Forme du payload

```json
{
  "schema_version": "1.0",
  "projet": { "titre": "…", "sujet": "…", "angle": "…" },
  "variantes": [
    {
      "plateforme": "youtube_long",
      "duree_cible_sec": 720,
      "ratio": "16:9",
      "beats": [
        {
          "id": "b-01-accroche",
          "type": "narration",
          "texte": "…",
          "note_realisation": "plan serré, regard caméra",
          "texte_ecran": "Babadampulu — 2019",
          "transition_entree": null,
          "transition_sortie": "cut sec",
          "sources": ["https://…"],
          "inserts": [
            {
              "type": "video",
              "url": "https://…",
              "tc_in": "00:03:12",
              "tc_out": "00:03:19",
              "duree_affichage_sec": 7,
              "credit": "Bloomberg",
              "droits": "extrait court, citation"
            }
          ]
        }
      ]
    }
  ]
}
```

Les clés du payload sont **en français**, comme le reste du produit ; le mapping vers les colonnes
anglaises se fait dans `lib/video/import.ts` et nulle part ailleurs.

### 2.2 Règles portées par le schéma

- `schema_version` obligatoire à la racine. Une **majeure** inconnue est refusée d'emblée, avec un message
  explicite, plutôt qu'à moitié interprétée.
- `id` de beat : `^[a-z0-9][a-z0-9-]{1,63}$`, **unique dans la variante**. C'est la clé de fusion.
- `type` ∈ `beat_kind`. Une valeur inconnue est une erreur nommée, jamais un repli silencieux.
- `plateforme` ∈ `script_platform`, `ratio` ∈ `16:9` / `9:16` / `1:1`.
- `tc_in` / `tc_out` : `^\d{2}:\d{2}:\d{2}(\.\d{1,3})?$`, et `tc_out > tc_in` quand les deux sont présents.
- `url` : http/https uniquement, longueur bornée. La vivacité n'est **pas** vérifiée ici (SP3).
- Tout champ optionnel accepte `null` **et** l'absence — un modèle produit les deux indifféremment.
- `.strict()` sur chaque objet : une clé inventée est signalée, pas ignorée. C'est ce qui fait remonter
  une dérive de nommage au lieu de la laisser disparaître.

### 2.3 Versionnage

`SCHEMA_VERSION = "1.0"` exporté depuis `lib/video/schema.ts`. Politique : ajout de champ optionnel =
mineure (acceptée) ; suppression, renommage ou resserrement = majeure (refusée avec message).

---

## 3. Le brief (`lib/video/brief.ts`)

Trois blocs concaténés, dans cet ordre :

**Bloc 1 — style maison** (`video_settings.briefTemplate`, éditable en Réglages). Variables interpolées :
`{{titre}}`, `{{sujet}}`, `{{plateforme}}`, `{{duree_cible}}`, `{{ratio}}`, `{{article_titre}}`,
`{{article_url}}`, `{{article_extrait}}`. Une variable inconnue est **laissée telle quelle** et signalée
sous l'aperçu — remplacer par du vide ferait disparaître une faute de frappe dans un prompt qu'on colle
sans le relire.

**Bloc 2 — instructions de recherche**, générées par le code : chercher les faits, les chiffres et leurs
sources ; proposer pour chaque section des images et extraits vidéo réutilisables avec leur URL et leurs
timecodes ; citer les sources par beat.

**Bloc 3 — contrat**, généré par le code et **non modifiable** :
- le JSON-Schema issu de `z.toJSONSchema()` ;
- un exemple complet et valide ;
- les règles dures : *réponds uniquement par un objet JSON, sans texte autour, sans balises de code ;
  conserve les `id` de beat à l'identique entre deux générations d'un même script ; ne réutilise jamais
  un `id` pour un autre beat.*

L'instruction sur la stabilité des `id` est ce qui rend le ré-import fusionnable. Sans elle, chaque
génération produit des beats neufs et la fusion se dégrade en remplacement.

UI : un panneau **Brief** dans l'espace projet, avec l'aperçu du prompt final et un bouton
« Copier le brief ». Le texte copié est enregistré dans `script_journal` au moment de l'import auquel
il a donné lieu, pas à la copie.

---

## 4. Durée estimée (`lib/video/duration.ts`)

`estimatedDurationSec = ceil(mots(spokenText) / wordsPerMinute * 60)`, `wordsPerMinute` lu dans
`video_settings` (défaut 155, cadence de lecture française posée). Calculé et **stocké** à chaque écriture
du beat, pour que la vue montage et les exports (SP2) n'aient rien à recalculer.
`durationOverrideSec`, quand il est posé, l'emporte partout.

Module pur, sans accès base : `estimateSeconds(text, wpm)` et `countWords(html)` — le comptage
travaille sur le texte, balises retirées.

Cumul de variante = somme des beats. La vue auteur l'affiche face à `targetDurationSec` avec un écart
signé. Un beat de plus de 35 mots d'un seul tenant porte un avertissement discret (souffle) ; c'est un
signal, jamais un blocage.

---

## 5. Import & fusion (`lib/video/import.ts`)

Module **sans accès base**, entièrement testable en pur, et **partagé avec le handler MCP** du SP1 bis.
C'est la contrainte de conception principale de ce fichier.

### 5.1 Couche tolérante (entrée)

Avant validation, et uniquement ces normalisations, toutes réversibles et sans perte de sens :
retrait du BOM ; retrait des balises ```` ```json ```` / ```` ``` ```` englobantes ; retrait du texte
avant la première `{` et après la dernière `}` correspondante ; espaces de fin.

Rien d'autre. Pas de correction de clés, pas de devinette de type, pas de repli IA (décision 3).

### 5.2 Couche stricte (validation)

`payloadSchema.safeParse`. En cas d'échec, les erreurs Zod sont traduites en
`{ path: "variantes[0].beats[6].type", message: "type inconnu « bviroll »", received: "bviroll" }`.
**Aucun import partiel** : soit le payload entier est valide, soit rien n'est écrit. Un script à moitié
importé est pire qu'un import refusé, parce qu'il a l'air d'avoir marché.

À ne pas confondre avec l'application **sélective** du §5.3 : la validation est tout-ou-rien, le choix
de ce qu'on retient dans le diff est ensuite entièrement humain.

### 5.3 Fusion à trois voies

Pour chaque beat, clé `(variantId, externalId)`, trois versions :

- **base** = `script_beats.importedSnapshot` (ce que le dernier import avait posé) ;
- **nôtre** = la ligne actuelle en base (base + éditions humaines) ;
- **leur** = le fragment du nouveau payload.

| Cas | Classement | Comportement |
|---|---|---|
| `externalId` absent en base | **ajouté** | proposé, coché par défaut |
| `leur ≠ base`, `nôtre = base` | **modifié** | proposé, coché par défaut |
| `leur = base` | *inchangé* | non affiché |
| `leur ≠ base`, `nôtre ≠ base`, sur des champs disjoints | **modifié** | fusionné champ par champ, coché par défaut |
| `leur ≠ base`, `nôtre ≠ base`, **même champ** | **conflit** | affiché côte à côte, **non coché**, choix humain obligatoire |
| en base, absent du payload | **supprimé** | proposé, **non coché** par défaut |

Une suppression n'est jamais cochée d'avance : un modèle qui abrège sa réponse ne doit pas pouvoir
effacer un beat par omission.

Le réordonnancement suit `position` dans le payload, appliqué **après** les ajouts et suppressions retenus.

`computeMerge(base, current, next) → Diff` et `applyMerge(diff, selection) → Mutations` sont purs ;
seul `lib/actions/video-actions.ts` traduit `Mutations` en écritures, dans une transaction unique.

### 5.4 Interface consommée par le SP1 bis

Exportées et stables :

```ts
export function parseIncoming(raw: string | unknown): ParseResult   // tolérant + strict
export function computeMerge(...): Diff
export function applyMerge(...): Mutations
export const payloadSchema, SCHEMA_VERSION
```

Le handler MCP appellera exactement ces fonctions, renverra `errorReport` à l'agent pour qu'il se
corrige, et journalisera dans `script_journal` avec `source: "mcp"`. Aucune logique de contrat ne doit
exister ailleurs que dans ce module.

---

## 6. Interface (SP1)

**`/video`** — liste des projets : titre, plateforme(s), statut, durée estimée, article lié, date.
Bouton **+ Nouveau projet** → titre, sujet/angle, plateforme, durée cible, ratio, article lié optionnel
(recherche parmi les articles `approved` / `published`).

**`/video/[id]`** — espace projet, deux panneaux au SP1 :

- **Brief** — aperçu du prompt final, avertissements de variables, « Copier le brief ».
- **Écriture** — sélecteur de variante ; liste ordonnée des beats (numéro, type, texte, durée) avec
  inspecteur latéral : texte parlé (éditeur Tiptap restreint, même socle que l'article), note de
  réalisation, texte à l'écran, transitions, sources, inserts en lecture avec **URL éditable**.
  Réordonnancement par glisser-déposer. En-tête : durée cumulée / durée cible, écart signé.
  Un beat modifié localement porte un marqueur discret (`locallyEditedAt`).

**Importer** — coller ou déposer un `.json` → écran de validation (erreurs par chemin, lisibles) ou
écran de diff (§5.3) avec cases à cocher, puis application. L'historique des imports est consultable
avec, pour chacun, le payload brut et le résultat.

RBAC : ressource `video` ajoutée à `lib/permissions.ts`, accessible aux trois rôles existants
(`admin`, `editor`, `journalist`). Le rôle `Monteur` arrive au SP2.

Copie française, cohérente avec le reste de la console.

---

## 7. Fichiers

| Fichier | Rôle |
|---|---|
| `db/schema.ts` | tables et enums du §1 |
| `db/migrations/…` | migration générée par Drizzle |
| `lib/video/schema.ts` | **le contrat** — source unique |
| `lib/video/brief.ts` | modèle + variables + assemblage du prompt |
| `lib/video/import.ts` | parse tolérant, validation stricte, fusion à trois voies (pur) |
| `lib/video/duration.ts` | mots → secondes (pur) |
| `lib/queries/video.ts` | lectures |
| `lib/actions/video-actions.ts` | server actions : créer, éditer, importer, annuler |
| `lib/actions/video-settings-actions.ts` | modèle de brief, cadence de lecture |
| `app/(app)/video/page.tsx`, `app/(app)/video/[id]/page.tsx` | écrans |
| `components/video/*` | liste de beats, inspecteur, panneau brief, écran de diff |
| `lib/permissions.ts` | ressource `video` |

---

## 8. Cas limites décidés

- **Payload sans variante** → refusé (« au moins une variante »).
- **`id` de beat dupliqués dans une variante** → refusé, avec la liste des doublons.
- **Beat `reponse` sans question au SP1** → accepté et stocké ; `answersBeatId` reste nul jusqu'au SP5.
- **Payload visant une variante inexistante** → la variante est créée, à condition que `plateforme`,
  `duree_cible_sec` et `ratio` soient présents.
- **Deux imports concurrents sur le même projet** → le second est refusé s'il a été calculé sur un état
  périmé (comparaison de l'`updatedAt` de la variante), avec invitation à recalculer le diff.
- **Annulation d'une entrée de journal** → restaure `importedSnapshot` et les champs touchés pour les
  beats concernés ; refusée si un import postérieur a retouché les mêmes beats.
- **`spokenText`** passe par `lib/sanitize.ts` — le texte vient d'un modèle et transite par un éditeur riche.
- **URLs d'insert** : forme validée à l'import ; le garde SSRF (`lib/url-guard.ts`) ne s'applique qu'au SP3,
  au moment où le serveur va réellement chercher l'URL.

---

## 9. Tests (`bun run test:pure` — sans base ni réseau)

**`lib/video/schema.ts`** — payload de référence accepté ; majeure inconnue refusée ; `type` inconnu ;
`id` mal formé ; `id` dupliqués ; `tc_out ≤ tc_in` ; clé inventée signalée par `.strict()` ;
`null` et absence équivalents sur les champs optionnels.

**`lib/video/import.ts`** — dépouillement des balises de code, du BOM, du bavardage avant/après ;
JSON invalide → erreur lisible ; chemins d'erreur exacts ; fusion : ajout, modification, inchangé,
champs disjoints fusionnés, conflit sur un même champ non coché, suppression par omission non cochée,
réordonnancement ; `applyMerge` respecte la sélection humaine.

**`lib/video/duration.ts`** — comptage de mots balises retirées ; arrondi ; `durationOverrideSec`
prioritaire ; cumul de variante.

**`lib/video/brief.ts`** — interpolation, variable inconnue conservée et signalée, présence du bloc de
contrat et de l'exemple, exemple **validé par le schéma lui-même** (garantit que les quatre dérivations
ne divergent pas).

Les actions et requêtes ne sont testées qu'au niveau où elles touchent la base, hors `test:pure`.

---

## 10. Hors périmètre (sous-projets suivants)

Conducteur de montage, lien signé, rôle `Monteur`, exports Markdown/CSV (**SP2**) — serveur MCP, jeton
d'API, écriture d'agent journalisée (**SP1 bis**) — OAuth 2.1 + DCR pour claude.ai web (**SP1 ter**) —
vérification de vivacité des liens, téléversement R2 (**SP3**) — prompteur et journal de prises (**SP4**) —
intervenants, mapping question/réponse, consentement (**SP5**) — dérivation de variantes et zones de
sécurité (**SP6**).

## 11. Hypothèses vérifiées

- **Zod 4.4.3** installé : `z.toJSONSchema()` est natif, la dérivation du bloc de contrat ne demande
  aucune dépendance supplémentaire.
- **better-auth 1.6.25** installé, avec les plugins `mcp` et `oidc-provider` présents dans `node_modules` :
  le SP1 ter est réalisable sur la base d'authentification existante.
- **Next 16.3.0 / Drizzle 0.45.2** : App Router, server actions et migrations Drizzle comme partout ailleurs.
- Non vérifié, à confirmer au SP1 ter : la disponibilité des connecteurs personnalisés sur le plan
  claude.ai de l'utilisateur.
