# V1 — Moteur de gabarits (sans interface)

**Date :** 2026-08-09
**Programme :** « Studio visuel & diffusion multicanale » (`2026-08-09-afrotiative-studio-diffusion-roadmap.md`)
**Sous-projet :** V1 — aucun prérequis
**Statut :** validé

## Objectif

Rendre une image à partir d'un **gabarit JSON** et d'un jeu de valeurs, en Node, sans navigateur et
sans interface. Le livrable se vérifie entièrement en test : « voici une scène, voici des valeurs,
produis le PNG attendu ». L'éditeur visuel (V2) et les surfaces d'aperçu (V3, D1) se brancheront
dessus ensuite.

V1 dé-risque délibérément le pari technique — Satori tient-il la charge esthétique ? — **avant**
d'investir des semaines dans un éditeur de canevas.

## Hors portée

- Toute interface. Les gabarits de départ sont écrits à la main en JSON et semés.
- Le téléversement d'assets et de polices (V2) — V1 lit `render_assets`, ne l'alimente pas.
- Le branchement dans `approveAndPublish` / la médiathèque WordPress (V3).
- Les contextes `quote_card`, `newsletter_header`, `recap_card` : leurs **jetons sont déclarés**
  dans le registre, mais leurs **fournisseurs de valeurs** arrivent avec le formulaire de saisie
  manuelle de V2. V1 livre les fournisseurs `article_image` et `social_post`.
- Le **contenu répété** (les N lignes d'une carte de récap). V1 ne gère que des jetons scalaires ;
  une carte de récap s'écrit avec `recap.item1`, `recap.item2`, `recap.item3`. Un vrai moteur de
  répétition est une évolution ultérieure, pas une dette cachée.

---

## §1 Architecture

Sept modules sous `lib/studio/`, plus un client de stockage. La règle de dépendance : **`render.ts`
ne connaît pas la base de données**. Il reçoit une scène, des valeurs et un chargeur d'assets ; il
rend des octets. Tout ce qui touche Postgres vit dans `resolve.ts` et `store.ts`.

```
lib/studio/
  formats.ts    préréglages de format (largeur/hauteur)                    pur
  scene.ts      types Scene/Layer + schéma Zod + validation structurelle   pur
  tokens.ts     registre jeton → type, contexte → jetons disponibles       pur
  element.ts    sceneToElement(scene, resolved) → arbre Satori             pur
  images.ts     pré-passe sharp : fetch, recadrage, flou, teinte → data URI  I/O réseau
  fonts.ts      chargement des polices + cache mémoire                     I/O
  render.ts     orchestration du rendu → octets                            I/O
  bindings.ts   fournisseurs de valeurs par contexte (article → valeurs)   DB
  resolve.ts    résolution (contexte, canal, catégorie) → version publiée  DB
  store.ts      interface RenderStore + implémentation R2 + mémoire        I/O
  config.ts     getStudioConfig() — null si R2 non configuré               pur
  index.ts      API publique : renderForArticle()
lib/storage/r2.ts   client S3-compatible minimal (aws4fetch)
```

`store.ts` expose une **interface** `RenderStore` avec deux implémentations : `R2RenderStore` et
`MemoryRenderStore`. C'est ce qui rend tout le chemin de rendu testable sans compte R2 ni réseau —
même choix que celui qui rend `lib/wp/publish.ts` testable aujourd'hui.

### Dépendances nouvelles

| Paquet | Rôle | Note |
|---|---|---|
| `satori` | arbre d'éléments → SVG | moteur de mise en page maison, pas un navigateur |
| `@resvg/resvg-js` | SVG → PNG | binaires natifs préconstruits (napi), pas de compilation |
| `qrcode` | jeton `article.url` → QR | génère du SVG, embarqué en data URI |
| `aws4fetch` | signature S3v4 pour R2 | ~2 ko, recommandé par Cloudflare, contre plusieurs Mo pour `@aws-sdk/client-s3` |
| `sharp` | **déjà installé** | recadrage, flou, teinte, encodage final |

Trois polices **Noto Sans** (Regular 400 / SemiBold 600 / Bold 700) au format **TTF** sont commitées
sous `lib/studio/fonts/` comme repli intégré. Licence OFL. Choix délibéré, pas Inter comme prévu
initialement : les URLs visées pour des TTF statiques Inter ne résolvaient pas au moment de la
livraison. Ces polices ne remplacent pas le kit de marque téléversable (V2) — elles garantissent
qu'un rendu aboutit toujours, même sans aucun asset.

---

## §2 Modèle de données

Quatre tables neuves et une colonne. **Aucun nouvel enum PostgreSQL** : colonnes en `text` doublées
d'unions TypeScript, en suivant explicitement le précédent documenté sur `alerts.type`
(`db/schema.ts:337`) — un `ALTER TYPE … ADD VALUE` est un piège dans le `migrate()` mono-transaction
de drizzle sur une base neuve.

### `render_templates`

```ts
{
  id, name,
  context: text,          // 'article_image' | 'social_post' | 'quote_card' | 'newsletter_header' | 'recap_card'
  channel: text | null,   // 'facebook' | 'instagram' | 'whatsapp' | 'x' | 'tiktok' ; null = défaut du contexte
  categoryId: uuid | null → wp_categories (on delete cascade),  // null = défaut du couple (contexte, canal)
  format: text, width: int, height: int,   // figés à la création depuis formats.ts
  scene: jsonb,           // COPIE DE TRAVAIL (brouillon), jamais lue par le résolveur
  publishedVersion: int | null,  // numéro de version en vigueur ; null = jamais publié
  archived: boolean default false,
  createdBy → user.id, createdAt, updatedAt
}
```

Deux points non évidents :

**Pas de colonne `status`.** « Publié » ⟺ `publishedVersion IS NOT NULL`. Un gabarit publié qui a
des modifications en cours est l'état *normal*, pas une exception : `scene` est le brouillon,
`publishedVersion` désigne l'instantané en production. Une colonne `status` serait une seconde
source de vérité qui dériverait.

**Pas de clé étrangère vers la version.** `publishedVersion` stocke le **numéro** de version, pas
son `id`. Une FK créerait un cycle (`render_templates` → `render_template_versions` →
`render_templates`) pénible à migrer et sans bénéfice : le résolveur joint sur
`(template_id, version)`, qui est déjà unique.

**Unicité de la portée :**

```sql
UNIQUE NULLS NOT DISTINCT (context, channel, category_id) WHERE archived = false
```

Le `NULLS NOT DISTINCT` (PostgreSQL 15+, disponible sur Neon) est **indispensable** : sans lui,
deux gabarits `(social_post, facebook, NULL)` coexisteraient sans erreur, puisque PostgreSQL traite
les NULL comme distincts dans un index unique — exactement le piège déjà documenté sur
`pipeline_runs_one_running` (`db/schema.ts:252`). Le plan doit **vérifier** que drizzle 0.45 émet
bien `.nullsNotDistinct()` dans le SQL généré, et poser la contrainte en SQL brut sinon.

### `render_template_versions`

```ts
{ id, templateId → render_templates (cascade), version: int,
  scene: jsonb,           // INSTANTANÉ IMMUABLE
  publishedBy → user.id, publishedAt,
  unique(templateId, version) }
```

### `render_assets`

```ts
{ id, kind: text ('image'|'font'), name, storageKey, url, mime, bytes,
  width?, height?,                                   // images
  fontFamily?, fontWeight?, fontStyle?,              // polices
  uploadedBy → user.id, createdAt }
```

### `renders` — cache immuable des sorties

```ts
{ id, templateId, templateVersion, context,
  subjectType: text ('article'|'manual'), subjectId: uuid | null,
  inputHash: text UNIQUE,
  storageKey, url, width, height, bytes,
  degraded: boolean default false,
  createdAt }
```

`inputHash` = SHA-256 de la sérialisation canonique de `(templateId, templateVersion, valeurs
résolues triées par clé)`. Deux conséquences voulues : un appel identique renvoie la ligne
existante sans re-rendre, et **« on ne re-rend pas après diffusion » s'applique tout seul** — D1
stockera un `render_id` sur la ligne `distributions`, et cette ligne-là ne bouge plus jamais.

`subjectId` n'est **pas** une clé étrangère vers `articles` : un rendu doit survivre à la
suppression de son article (c'est un historique de diffusion, pas une jointure vivante) — même
raisonnement que `alerts.entityId` (`db/schema.ts:333`).

### `wp_categories.color`

`text`, nullable. C'est le jeton `{{category.color}}`. Une valeur absente retombe sur une constante
de marque (`DEFAULT_CATEGORY_COLOR`), jamais sur une erreur.

---

## §3 Schéma de scène

```ts
type Scene = {
  schemaVersion: 1;
  canvas: { width: number; height: number; background: string };
  layers: Layer[];   // ORDRE DE PEINTURE : index 0 = arrière-plan
};
```

L'ordre du tableau **est** l'ordre de peinture. Satori n'a pas de `z-index` ; ce n'est pas un pis-
aller, c'est exactement ce qu'exprime une liste de calques dans un éditeur.

Champs communs : `id`, `name`, `visible`, `locked`, `frame {x,y,w,h}` en pixels du canevas,
`rotation?`, `opacity?`.

**`image`** — `source` : `{kind:'asset', assetId}` | `{kind:'slot', slot}` | `{kind:'url', url}` ;
`fit: 'cover'|'contain'` ; `radius?` ; **`blur?`** (px) ; `overlay?` (couleur hex avec alpha).

**`text`** — `content` (peut contenir des `{{jetons}}`) ; `font {assetId?, family, size, weight,
italic?}` ; `color` (peut être un jeton) ; `align`, `vAlign` ; `lineHeight`, `letterSpacing?` ;
`maxLines?` ; `autoFit?` ; `shadow?` ; `stroke?`.

**`shape`** — `shape: 'rect'` ; `fill` : couleur (jeton accepté) ou dégradé linéaire
`{angle, stops[]}` ; `radius?` ; `border? {width, color, sides?}`.

**`qr`** — `slot` (doit être un jeton de type `url`), `fg`, `bg`, `margin`.

Validation Zod stricte à l'écriture **et** à la lecture : une scène en base est une donnée non
fiable dès lors qu'elle a pu être écrite par une version antérieure du code.

### L'exemple agribusiness, dans ce modèle

```
0  image  source=slot:article.image   fit=cover   blur=24   overlay=#000000A6
1  shape  rect  fill=transparent  border={width:12, color:"{{category.color}}"}
2  text   "{{article.title}}"   maxLines=3   autoFit   color=#FFFFFF
3  image  source=asset:logo-blanc
```

Quatre calques, **un seul gabarit**, toutes les catégories — la couleur vient de la taxonomie.

---

## §4 Jetons, contextes et liaisons

`tokens.ts` déclare deux tables pures.

**Type de chaque jeton** — `text` | `image` | `color` | `url` :

| Jeton | Type |
|---|---|
| `article.title`, `article.excerpt`, `article.date`, `article.byline`, `source.names` | `text` |
| `article.image`, `brand.logo` | `image` |
| `category.name` | `text` |
| `category.color` | `color` |
| `article.url` | `url` |
| `quote.text`, `quote.attribution` | `text` |
| `edition.title`, `edition.date` | `text` |
| `recap.title`, `recap.item1..3` | `text` |

**Jetons disponibles par contexte** — et c'est ici que se joue la contrainte d'ordonnancement :

| Contexte | Jetons | `article.url` ? |
|---|---|---|
| `article_image` | article.* (sauf url), category.*, source.names, brand.logo | **✗ interdit** |
| `social_post` | tout ce qui précède **+ `article.url`** | ✓ |
| `quote_card` | quote.*, article.title, category.*, brand.logo | ✗ |
| `newsletter_header` | edition.*, brand.logo | ✗ |
| `recap_card` | recap.*, brand.logo | ✗ |

L'image à la une du site se rend **avant** que WordPress n'existe ; l'URL de l'article n'existe donc
pas encore. Plutôt que de laisser le piège en place, `validateScene(scene, context)` refuse un
gabarit `article_image` qui référence `{{article.url}}`, avec un message français explicite, **au
moment où on tente de publier le gabarit** — pas au moment du rendu, devant un rédacteur.

La même fonction vérifie la **cohérence de type** : un calque `image` dont le slot est
`article.title` est refusé, un `color` alimenté par un jeton `text` aussi.

**Slots dérivés, jamais déclarés.** La liste des slots d'un gabarit est *calculée* en scannant la
scène. Aucune liste parallèle à maintenir, donc aucune dérive possible.

---

## §5 Pipeline de rendu

`renderScene({ scene, values, assets, store }) → { bytes, width, height, degraded }`

1. **Résolution des jetons** dans les textes, les couleurs et les sources d'image. Une valeur
   requise manquante lève une erreur typée qui **nomme les jetons manquants**.
2. **Pré-passe `sharp`**, en parallèle sur les calques image : récupération réseau protégée par
   `isSafePublicHttpUrl` (`lib/url-guard.ts` — réutilisé, pas réécrit), recadrage `cover`/`contain`
   **aux dimensions exactes du calque en pixels de sortie**, application du **flou** en raster,
   composition de la teinte `overlay`, sortie en data URI.
   Le rendu final est déjà à sa résolution native (1080–1600 px) : pas de suréchantillonnage, il
   coûterait de la mémoire sans gain visible.
   C'est cette étape qui rend l'exemple agribusiness possible — Satori n'a pas de `backdrop-filter`.
3. **`sceneToElement(scene, resolved)`** — fonction **pure** : calques → `div` en
   `position: absolute`, dans l'ordre du tableau.
4. **Polices** : V1 n'a pas de chargeur d'assets — `NullAssetLoader` (`lib/studio/fonts.ts`) répond
   toujours `null`, donc tout gabarit V1 s'appuie sur le repli embarqué. L'interface `AssetLoader`
   (méthode `font(assetId)`) existe déjà pour que V2 y branche un vrai chargeur lisant
   `render_assets` via R2 ; aucune ligne de code ne le fait encore. `embedFont: true` convertit les
   glyphes en tracés, donc resvg n'a jamais besoin des polices. Une police introuvable ou dont le
   chargement échoue retombe sur Noto Sans et marque le rendu `degraded`.
5. **satori → SVG → resvg → PNG → sharp** (JPEG q86 ou WebP, métadonnées supprimées).
6. **Stockage** sous `renders/{aaaa}/{mm}/{hash}.jpg`, insertion de la ligne `renders`, retour de
   l'URL publique.

**`autoFit`** effectue une recherche dichotomique sur la taille de police, 5 passes maximum de
Satori sur le seul calque texte (~20 ms). C'est la partie la plus incertaine du lot : si elle se
révèle instable, le repli est `maxLines` + ellipse, déjà présent, et on retire `autoFit`.

### Résolution du gabarit

**Quatre niveaux de repli**, pas trois — le troisième compte, ce n'est pas un simple raffinement du
deuxième :

```
resolveTemplate({ context, channel, categoryId })

  avec canal  : (context, channel, categoryId)  →  (context, channel, null)  →  (context, null, null)
  sans canal  : (context, null, categoryId)      →  (context, null, null)
```

Les deux chemins convergent sur le même repli final `(context, null, null)` ; un `null` en sortie
n'est pas une erreur, l'appelant utilise l'image brute inchangée.

Le niveau `(context, null, categoryId)` n'est pas un cas marginal : c'est le chemin **principal** du
contexte `article_image`, qui n'a **jamais** de canal (l'image à la une du site n'est diffusée sur
aucun réseau) — c'est donc bien lui qui fait dépendre le rendu de la couleur de la catégorie, avant
tout repli sur le gabarit générique du contexte.

Non archivés, `publishedVersion IS NOT NULL`, et le résolveur renvoie **l'instantané de la version
publiée**, jamais `render_templates.scene`.

### API publique

```ts
renderForArticle(articleId, { context, channel, store, fetchImpl }): Promise<
  | { ok: true; url: string; renderId: string; degraded: boolean }
  | { ok: true; url: null; renderId: null; degraded: false }  // aucun gabarit : utiliser l'image brute
  | { ok: false; message: string }                            // français, affichable tel quel
>
```

`store?: RenderStore` (défaut `R2RenderStore`) et `fetchImpl?: typeof fetch` sont des points
d'injection réservés aux tests — `MemoryRenderStore` pour vérifier bout en bout sans compte R2, et
`fetchImpl` pour atteindre un serveur fixture local sans jamais désactiver le garde SSRF partagé en
dehors des tests (voir `lib/studio/store.ts` et `lib/studio/images.ts`). En production, V3 (onglet
Aperçu) et D1 (panneau Diffusion) — les deux seuls appelants — ne fournissent ni l'un ni l'autre.

---

## §6 Erreurs

Le style de la maison, déjà établi par `getWpConfig()` : **une configuration absente désactive la
fonctionnalité proprement**, elle ne lève pas.

| Cas | Comportement |
|---|---|
| R2 non configuré | `{ ok:false, message:"Stockage R2 non configuré." }` |
| Aucun gabarit résolu | `{ ok:true, url:null }` — l'appelant garde l'image brute |
| Image source injoignable / URL refusée par le garde SSRF | **échec dur**, message français, réessayable |
| Jeton requis manquant | **échec dur**, message listant les jetons |
| Police introuvable | repli Noto Sans, `degraded: true` |
| Scène invalide en base | **échec dur** — refuser vaut mieux que rendre n'importe quoi |

L'écart assumé avec `uploadFeaturedImage`, qui est *fail-soft* : chaque rendu est déclenché par une
**action humaine délibérée** (« Approuver & publier », « Publier sur Facebook »). Diffuser
silencieusement une carte au fond manquant est pire qu'une erreur claire et réessayable.

---

## §7 Tests

`bun test`, sans réseau ni clé, avec `MemoryRenderStore` et des fixtures locales.

| Cible | Ce qui est vérifié |
|---|---|
| `sceneToElement` | instantané de l'arbre ; ordre de peinture = ordre du tableau |
| Résolution de jetons | valeurs manquantes, jeton inconnu, jeton dans une couleur, jeton dans un slot d'image |
| `validateScene` | `article.url` dans `article_image` **refusé** ; incohérences de type refusées |
| `resolveTemplate` | les quatre niveaux de repli ; archivés exclus ; non publiés exclus ; c'est bien l'instantané publié qui sort, pas le brouillon |
| `inputHash` | stable pour des entrées identiques ; change si la version ou une valeur change ; insensible à l'ordre des clés |
| Formats | largeur/hauteur figées à la création, insensibles à une modification ultérieure du préréglage |
| Rendu bout en bout | scène fixture + polices et images locales → dimensions PNG attendues + empreinte perceptuelle |
| Garde SSRF | une URL privée/loopback dans un calque image est refusée |

Ce découpage reprend celui qui rend `lib/wp/publish.ts` testable : une grosse fonction pure
(`buildPostBody` là, `sceneToElement` ici) plus des gardes isolés.

---

## §8 Configuration

```
R2_ACCOUNT_ID=""          # Cloudflare R2
R2_ACCESS_KEY_ID=""
R2_SECRET_ACCESS_KEY=""
R2_BUCKET=""
R2_PUBLIC_BASE_URL=""     # ex. https://media.afrotiative.com — base des URLs publiques
```

Les cinq vides ⇒ `getStudioConfig()` renvoie `null` ⇒ le studio est proprement désactivé, comme
WordPress l'est aujourd'hui sans ses quatre variables. À documenter dans `.env.example` et
`docs/DEPLOYMENT.md`.

## §9 Gabarits semés

Écrits à la main en JSON, insérés par un script dédié (**pas** par `db/seed.ts`, qui est destructif
et réservé au développement) :

1. `article_image` / défaut — 1200×675, l'exemple agribusiness générique.
2. `social_post` / `facebook` — 1200×630.
3. `social_post` / `instagram` — 1080×1080.

Ils servent de jeu d'essai à V1 et de point de départ à l'éditeur V2.
