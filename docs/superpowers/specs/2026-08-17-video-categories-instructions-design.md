# Design — Catégories de vidéo et instructions d'expert

Date: 2026-08-17
Status: approved-for-planning (pending user spec review)
Branch: `feat/video-categories-instructions`

Aujourd'hui, tout projet vidéo reçoit le même brief : le style maison éditable en Réglages
(`video_settings.brief_template`), plus les blocs Recherche et Contrat écrits en dur dans
`lib/video/brief.ts`. Un reportage d'investigation et une interview reçoivent donc mot pour mot les
mêmes consignes d'écriture.

Ce sous-projet ajoute des **catégories de vidéo** portant chacune les instructions d'un expert.
L'expert écrit une fois, en Réglages ; l'employé choisit une catégorie à la création d'un projet, et
les instructions se retrouvent **automatiquement** dans le brief qu'il copie vers le chat — ou que
l'agent MCP reçoit. C'est le mécanisme qui rend le savoir éditorial réutilisable sans qu'il soit
recopié à la main à chaque vidéo.

## Décisions verrouillées avec l'utilisateur

1. **Une seule entité** : une catégorie EST son bloc d'instructions (nom + description +
   instructions). Pas de bibliothèque de blocs composables — YAGNI tant qu'aucun besoin de partager
   un même fragment entre deux catégories ne s'est manifesté.
2. **Une seule catégorie par projet** : un menu déroulant, pas une sélection multiple. Empiler des
   instructions d'experts différents produit des consignes contradictoires que personne n'arbitre.
3. **Bloc automatique** : les instructions s'insèrent entre le style maison rendu et le bloc
   Recherche. Pas de variable `{{instructions_categorie}}` à placer soi-même — une variable oubliée
   ferait disparaître en silence le travail de l'expert.
4. **Optionnelle et modifiable après coup** : « Aucune catégorie » par défaut, changeable depuis la
   page projet. Les projets existants restent valides sans migration de données.
5. **Suppression franche**, pas d'archivage : supprimer une catégorie remet les projets concernés
   sur « aucune » (`on delete set null`). Un état « archivée » ajouterait un concept à expliquer
   pour un besoin qui n'existe pas encore.
6. **Les instructions ne sont pas validées comme du prompt** : texte libre, borné en longueur.
   L'expert répond de son contenu.

---

## 1. Données

Nouvelle table `video_categories` :

| Colonne | Type | Note |
|---|---|---|
| `id` | uuid PK | |
| `name` | text notNull | Unique, insensible à la casse (index unique sur `lower(name)`) — deux « Interview » dans un menu déroulant sont indiscernables pour l'employé qui choisit. |
| `description` | text nullable | Une ligne, affichée sous le nom dans le menu de sélection : ce qui aide à choisir. Distincte des instructions, qui ne sont jamais montrées à l'employé au moment du choix. |
| `instructions` | text notNull | Le texte de l'expert, inséré tel quel dans le brief. |
| `position` | integer notNull | Ordre du menu, défini en Réglages. |
| `createdAt` / `updatedAt` | timestamp | |
| `updatedBy` | text → `user.id` | Qui a touché aux instructions en dernier ; c'est du contenu éditorial, la traçabilité compte. |

Nouvelle colonne sur `video_projects` :

```
categoryId: uuid("category_id").references(() => videoCategories.id, { onDelete: "set null" })
```

`set null` et non `cascade` : supprimer une catégorie ne doit jamais détruire un projet vidéo.
Index sur `category_id` (la suppression et un futur filtre par catégorie le liront).

Migration Drizzle générée (`bun run db:generate`), commitée avec le code.

## 2. Assemblage du brief

`lib/video/brief.ts` est le producteur **unique** du brief, pour ses deux consommateurs : la page
projet (`app/(app)/video/[id]/page.tsx`, qui l'affiche à l'humain) et l'outil MCP
(`lib/mcp/tools.ts#construireBrief`, qui le remet à l'agent). Toute la logique tient donc là, et
les deux chemins en héritent sans effort.

```ts
export type BriefCategory = { name: string; instructions: string };

export function categoryBlock(category: BriefCategory): string
export function buildBrief(
  template: string, vars: BriefVars, category?: BriefCategory | null,
): { text: string; unknown: string[] }
```

Ordre du texte produit :

1. le modèle rendu (style maison, variables interpolées) ;
2. **`## Instructions de la catégorie — <nom>`** suivi des instructions brutes — *nouveau* ;
3. le bloc Recherche ;
4. le bloc Contrat.

Le bloc catégorie se place **avant** Recherche et Contrat, jamais après : le contrat de sortie JSON
est ce qui garantit que l'import fonctionne, et il doit rester le dernier mot du brief. Une
instruction d'expert ne peut pas le contredire par simple position dans le texte.

Sans catégorie (`null` ou `undefined`), le brief produit est **strictement identique** à celui
d'aujourd'hui — les tests existants de `tests/video-brief.test.ts` doivent passer sans être
retouchés. C'est la garantie de non-régression.

Une catégorie dont les `instructions` sont vides ou blanches ne produit **aucun** bloc : un titre de
section suivi du vide donne au modèle un signal parasite.

## 3. Réglages — CRUD des catégories

Carte « Catégories de vidéo » sur `/settings/video`, placée **avant** les cartes existantes
(Modèle de brief, Cadence) : c'est le contenu que l'équipe éditera le plus souvent.

- Tableau : nom, description, aperçu tronqué des instructions, nombre de projets qui l'utilisent.
- Dialogue créer / éditer (nom, description, instructions en `Textarea`).
- Suppression confirmée, annonçant le nombre de projets qui retomberont sur « aucune catégorie ».
- État vide explicite : à quoi servent les catégories et ce qu'un expert doit y écrire. **Pas de
  données de départ** — les instructions sont du contenu d'expert, pas du contenu par défaut, et
  une catégorie semée à moitié vide serait pire que pas de catégorie du tout.
- Réordonnancement : par un champ de position dans le dialogue d'édition. Pas de glisser-déposer
  pour un menu qui comptera une poignée d'entrées.

Motif suivi : `components/settings/taxonomy-tables.tsx` (tableau + dialogue) et
`lib/actions/taxonomy-actions.ts` (actions gardées).

**Découpage obligatoire** (motif déjà appliqué à `lib/video/persist.ts` / `lib/actions/video-actions.ts`) :

- `lib/queries/video-categories.ts` — lectures, **sans** `"use server"`.
- `lib/video/categories-persist.ts` — le cœur d'écriture DB, **sans** `"use server"`, réutilisable.
- `lib/actions/video-category-actions.ts` — `"use server"`, n'exporte QUE des actions gardées par
  `requireUser()` + `requirePermission(role, "video", "configure")`. Tout export d'un module
  `"use server"` est un point d'entrée réseau sans authentification propre : le writer brut n'y a
  pas sa place.

Permission `video` / `configure`, la même qui garde déjà `/settings/video` — éditer les
instructions d'un expert est un acte de configuration, pas de rédaction.

## 4. Choix de la catégorie

**À la création** — `components/video/new-project-dialog.tsx` gagne un menu « Catégorie », valeur
par défaut « Aucune catégorie », la `description` affichée sous chaque nom. La liste des catégories
est chargée par le Server Component `app/(app)/video/page.tsx` et passée en props, comme l'est déjà
la liste des articles.

**Après coup** — un sélecteur dans l'onglet Brief de la page projet, au-dessus du brief : changer la
catégorie déclenche une action serveur, la page se revalide, le brief affiché est réécrit avec le
nouveau bloc. C'est l'endroit où le changement est immédiatement visible ; le mettre dans l'en-tête
du projet forcerait l'utilisateur à deviner l'effet.

Cette action-là est gardée par `video` / `manage` (le journaliste choisit la catégorie de sa vidéo),
pas `configure` (qui reste réservé à l'écriture des instructions).

**Côté MCP** — `construireBrief` charge la catégorie du projet et la passe à `buildBrief`. Aucun
nouvel outil MCP : la catégorie se choisit dans le produit, pas par un agent.

## 5. Fichiers touchés

| Fichier | Nature |
|---|---|
| `db/schema.ts` + migration | Table `video_categories`, colonne `video_projects.category_id` |
| `lib/video/brief.ts` | `categoryBlock`, 3ᵉ argument de `buildBrief` |
| `lib/validation.ts` | `videoCategorySchema`, `categoryId` sur `createVideoProjectSchema`, schéma de changement de catégorie |
| `lib/queries/video-categories.ts` | *nouveau* — liste + comptage d'usage |
| `lib/video/categories-persist.ts` | *nouveau* — cœur d'écriture |
| `lib/actions/video-category-actions.ts` | *nouveau* — actions gardées |
| `lib/queries/video.ts` | `getVideoProject` remonte la catégorie du projet |
| `lib/video/persist.ts` | `createVideoProjectCore` accepte `categoryId` ; `setProjectCategoryCore` |
| `lib/actions/video-actions.ts` | `setProjectCategory` |
| `lib/mcp/tools.ts` | `construireBrief` charge et passe la catégorie |
| `components/video/category-manager.tsx` | *nouveau* — tableau + dialogue en Réglages |
| `components/video/project-category-select.tsx` | *nouveau* — sélecteur de la page projet |
| `components/video/new-project-dialog.tsx` | Menu « Catégorie » |
| `app/(app)/settings/video/page.tsx` | Charge et rend la carte Catégories |
| `app/(app)/video/page.tsx` | Charge les catégories pour le dialogue |
| `app/(app)/video/[id]/page.tsx` | Passe la catégorie à `buildBrief`, rend le sélecteur |

## 6. Validation

```ts
export const videoCategorySchema = z.object({
  name: z.string().min(1, "Nom requis").max(80),
  description: z.string().max(300).nullable(),
  instructions: z.string().min(1, "Les instructions ne peuvent pas être vides").max(20000),
  position: z.number().int().min(0).max(999),
});
```

Borne à 20 000 caractères, la même que `briefTemplate` : les deux finissent dans le même brief, et
une limite plus haute ici rendrait la borne de l'autre illusoire.

Le nom en double est refusé côté serveur (contrainte unique) et rendu en message français —
`{ ok: false, message: "Une catégorie porte déjà ce nom." }`, jamais une erreur Postgres brute.

## 7. Tests

TDD, en privilégiant `test:pure` pour tout ce qui ne touche pas la base.

**Purs :**
- `buildBrief` sans catégorie produit exactement le brief actuel (non-régression).
- `buildBrief` avec catégorie insère le bloc entre le modèle rendu et le bloc Recherche, et le
  contrat reste en dernier.
- Instructions vides ou blanches → aucun bloc.
- `videoCategorySchema` : nom vide, instructions vides, longueurs hors bornes.

**Base :**
- Création, édition, suppression d'une catégorie ; le nom dupliqué est refusé avec un message.
- Supprimer une catégorie utilisée met `category_id` à `null` sur ses projets, sans les supprimer.
- `createVideoProject` avec `categoryId` le persiste ; `setProjectCategory` le change et le remet
  à `null`.
- Gardes RBAC : un rôle sans `video`/`configure` ne peut pas écrire de catégorie ; sans
  `video`/`manage`, ne peut pas changer celle d'un projet.

## 8. Hors périmètre

- Filtrer ou grouper la liste `/video` par catégorie.
- Versionner les instructions, ou tracer quelle version d'une instruction a produit quel script.
  Le journal (`script_journal`) conserve déjà le payload brut de chaque import ; relier un script à
  l'état des instructions au moment de son écriture est un besoin distinct, non demandé.
- Des instructions par plateforme, ou croisant catégorie × plateforme.
- Un outil MCP de gestion des catégories.
