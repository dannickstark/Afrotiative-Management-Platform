# Catégories de vidéo et instructions d'expert — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permettre à un expert d'écrire, une fois pour toutes en Réglages, les instructions propres à un type de vidéo (storytelling, interview, investigation…), et les faire apparaître automatiquement dans le brief de tout projet rattaché à cette catégorie.

**Architecture:** Une table `video_categories` (nom + description + instructions + position) et une colonne `video_projects.category_id` en `on delete set null`. `lib/video/brief.ts` — producteur unique du brief pour la page projet ET l'outil MCP — reçoit un troisième argument optionnel et insère un bloc « Instructions de la catégorie » entre le style maison et le bloc Recherche. Un CRUD en Réglages, un menu à la création, un sélecteur sur la page projet.

**Tech Stack:** Next.js (App Router, Server Components + Server Actions), Drizzle ORM / Postgres, Zod, Base UI + shadcn (`components/ui`), `bun test`.

**Spec:** [docs/superpowers/specs/2026-08-17-video-categories-instructions-design.md](../specs/2026-08-17-video-categories-instructions-design.md)

## Global Constraints

- **Toute la copie d'interface est en français**, y compris les messages d'erreur remontés au client. Jamais d'erreur Postgres brute affichée.
- **Un module `"use server"` n'exporte QUE des actions gardées** par `requireUser()` + `requirePermission(...)`. Tout export d'un tel module est un point d'entrée réseau sans authentification propre. Le cœur DB vit dans un module sans `"use server"` (motif : `lib/video/persist.ts` ↔ `lib/actions/video-actions.ts`).
- **Permissions** : écrire/éditer/supprimer une catégorie = `requirePermission(role, "video", "configure")` (admin + éditeur). Changer la catégorie d'un projet = `requirePermission(role, "video", "manage")` (admin + éditeur + journaliste).
- **Longueur des instructions : 20 000 caractères max**, la même borne que `briefTemplate` dans `lib/validation.ts:329`.
- **Le bloc Contrat reste le dernier bloc du brief.** Aucune instruction de catégorie ne doit être insérée après lui.
- **Sans catégorie, le brief produit doit être identique au brief actuel, octet pour octet.** Les tests existants de `tests/video-brief.test.ts` ne doivent pas être retouchés.
- Tout nouveau fichier de test qui ne touche **ni la base ni le réseau** doit être ajouté à `PURE_FILES` dans `scripts/test-fast.ts` (l'allowlist commence ligne 46). Un fichier non listé part dans la voie DB, série et lente.
- Commandes : `bun test tests/<fichier>` pour un fichier, `bun run test:pure` pour la voie rapide, `bun run typecheck` avant chaque commit qui touche des types partagés.

---

### Task 1: Schéma — table `video_categories` et colonne `video_projects.category_id`

**Files:**
- Modify: `db/schema.ts` (après le bloc `videoSettings`, ~ligne 795, et dans `videoProjects`, ~ligne 661)
- Create: `db/migrations/<généré>.sql` (via `bun run db:generate`)
- Test: `tests/video-categories-schema.test.ts`

**Interfaces:**
- Consumes: rien.
- Produces: `videoCategories` (table Drizzle, exportée depuis `@/db`), avec les colonnes `id`, `name`, `description`, `instructions`, `position`, `createdAt`, `updatedAt`, `updatedBy`. `videoProjects.categoryId: uuid | null`.

- [ ] **Step 1: Écrire le test qui échoue**

Créer `tests/video-categories-schema.test.ts` :

```ts
import { describe, it, expect } from "bun:test";
import { videoCategories, videoProjects } from "@/db/schema";

describe("schéma des catégories de vidéo", () => {
  it("porte le nom, la description, les instructions et la position", () => {
    const cols = Object.keys(videoCategories);
    expect(cols).toContain("name");
    expect(cols).toContain("description");
    expect(cols).toContain("instructions");
    expect(cols).toContain("position");
    expect(cols).toContain("updatedBy");
  });

  it("le nom et les instructions sont obligatoires, la description non", () => {
    expect(videoCategories.name.notNull).toBe(true);
    expect(videoCategories.instructions.notNull).toBe(true);
    expect(videoCategories.description.notNull).toBe(false);
  });

  it("un projet peut n'avoir aucune catégorie", () => {
    // La catégorie est optionnelle (décision 4 de la spec) : les projets créés avant cette
    // fonctionnalité restent valides sans migration de données.
    expect(videoProjects.categoryId.notNull).toBe(false);
  });
});
```

- [ ] **Step 2: Lancer le test et vérifier qu'il échoue**

Run: `bun test tests/video-categories-schema.test.ts`
Expected: FAIL — `videoCategories` n'est pas exporté par `@/db/schema`.

- [ ] **Step 3: Ajouter la table et la colonne**

Dans `db/schema.ts`, **avant** la déclaration de `videoProjects` (elle la référence), ajouter :

```ts
// Les instructions d'un expert pour un type de vidéo (storytelling, interview, investigation…).
// Écrites une fois en Réglages, elles sont injectées automatiquement dans le brief de tout projet
// rattaché — c'est ce qui rend le savoir éditorial réutilisable sans recopie manuelle.
export const videoCategories = pgTable("video_categories", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  // Une ligne, montrée sous le nom dans le menu de sélection : ce qui aide à CHOISIR. Distincte des
  // instructions, jamais affichées au moment du choix.
  description: text("description"),
  instructions: text("instructions").notNull(),
  position: integer("position").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  // C'est du contenu éditorial : savoir qui a touché aux instructions en dernier compte.
  updatedBy: text("updated_by").references(() => user.id),
}, (t) => [
  // Insensible à la casse : deux « Interview » dans un menu déroulant sont indiscernables pour
  // l'employé qui choisit.
  uniqueIndex("video_categories_name_unique").on(sql`lower(${t.name})`),
  index("video_categories_position_idx").on(t.position),
]);
```

Vérifier que `sql` est bien importé en tête de `db/schema.ts` (`import { sql } from "drizzle-orm"`) ; l'ajouter sinon.

Puis dans `videoProjects`, après `articleId` :

```ts
  // `set null` et non `cascade` : supprimer une catégorie ne doit JAMAIS détruire un projet vidéo.
  categoryId: uuid("category_id").references(() => videoCategories.id, { onDelete: "set null" }),
```

et dans son tableau d'index :

```ts
  index("video_projects_category_idx").on(t.categoryId),
```

- [ ] **Step 4: Lancer le test et vérifier qu'il passe**

Run: `bun test tests/video-categories-schema.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Générer la migration et l'appliquer**

```bash
bun run db:generate
bun run db:migrate
```

Relire le `.sql` généré : il doit contenir `CREATE TABLE "video_categories"`, l'index unique sur `lower(name)`, et `ALTER TABLE "video_projects" ADD COLUMN "category_id" uuid` avec `ON DELETE set null`. Si l'index unique sur l'expression n'a pas été généré, l'ajouter à la main dans le fichier de migration :
`CREATE UNIQUE INDEX "video_categories_name_unique" ON "video_categories" (lower("name"));`

- [ ] **Step 6: Inscrire le test dans la voie rapide**

Dans `scripts/test-fast.ts`, ajouter `"video-categories-schema.test.ts"` à l'ensemble `PURE_FILES` (ligne ~76, à côté des autres entrées `video-*`).

Run: `bun run test:pure`
Expected: PASS, le nouveau fichier apparaît dans la voie pure.

- [ ] **Step 7: Commit**

```bash
git add db/schema.ts db/migrations tests/video-categories-schema.test.ts scripts/test-fast.ts
git commit -m "feat(video): table video_categories et rattachement des projets"
```

---

### Task 2: Le bloc catégorie dans le brief

**Files:**
- Modify: `lib/video/brief.ts`
- Test: `tests/video-brief.test.ts` (ajouts en fin de fichier ; **ne rien modifier** aux tests existants)

**Interfaces:**
- Consumes: rien (module pur).
- Produces:
  - `export type BriefCategory = { name: string; instructions: string }`
  - `export function categoryBlock(category: BriefCategory): string`
  - `export function buildBrief(template: string, vars: BriefVars, category?: BriefCategory | null): { text: string; unknown: string[] }` — le 3ᵉ argument est **optionnel**, tous les appels existants restent valides.

- [ ] **Step 1: Écrire les tests qui échouent**

Ajouter à la fin de `tests/video-brief.test.ts` :

```ts
import { categoryBlock, type BriefCategory } from "@/lib/video/brief";

const CATEGORIE: BriefCategory = {
  name: "Investigation",
  instructions: "Chaque affirmation doit citer deux sources indépendantes.",
};

describe("bloc catégorie", () => {
  it("titre la section avec le nom et reprend les instructions telles quelles", () => {
    const b = categoryBlock(CATEGORIE);
    expect(b).toContain("## Instructions de la catégorie — Investigation");
    expect(b).toContain("Chaque affirmation doit citer deux sources indépendantes.");
  });

  it("sans catégorie, le brief est identique à celui d'avant", () => {
    // Garantie de non-régression : c'est le brief que reçoivent tous les projets existants.
    expect(buildBrief(DEFAULT_BRIEF_TEMPLATE, VARS, null).text)
      .toBe(buildBrief(DEFAULT_BRIEF_TEMPLATE, VARS).text);
  });

  it("place les instructions APRÈS le style maison et AVANT le bloc Recherche", () => {
    const t = buildBrief(DEFAULT_BRIEF_TEMPLATE, VARS, CATEGORIE).text;
    const style = t.indexOf("Ligne éditoriale");
    const categorie = t.indexOf("## Instructions de la catégorie");
    const recherche = t.indexOf("## Recherche attendue");
    expect(style).toBeGreaterThan(-1);
    expect(categorie).toBeGreaterThan(style);
    expect(recherche).toBeGreaterThan(categorie);
  });

  it("laisse le contrat en dernier mot du brief", () => {
    // Le contrat garantit que l'import fonctionne : aucune instruction d'expert ne doit pouvoir le
    // contredire par simple position dans le texte.
    const t = buildBrief(DEFAULT_BRIEF_TEMPLATE, VARS, CATEGORIE).text;
    expect(t.indexOf("## Format de réponse")).toBeGreaterThan(t.indexOf("## Instructions de la catégorie"));
  });

  it("des instructions blanches ne produisent aucun bloc", () => {
    // Un titre de section suivi du vide est un signal parasite pour le modèle.
    const t = buildBrief(DEFAULT_BRIEF_TEMPLATE, VARS, { name: "Vide", instructions: "   \n " }).text;
    expect(t).not.toContain("## Instructions de la catégorie");
    expect(t).toBe(buildBrief(DEFAULT_BRIEF_TEMPLATE, VARS).text);
  });

  it("ne perturbe pas la détection des variables inconnues", () => {
    expect(buildBrief("Ton : {{inexistante}}", VARS, CATEGORIE).unknown).toEqual(["inexistante"]);
  });
});
```

Fusionner l'import ajouté en tête avec l'import existant de `@/lib/video/brief` plutôt que d'écrire deux lignes d'import du même module.

- [ ] **Step 2: Lancer les tests et vérifier qu'ils échouent**

Run: `bun test tests/video-brief.test.ts`
Expected: FAIL — `categoryBlock` n'est pas exporté.

- [ ] **Step 3: Implémenter**

Dans `lib/video/brief.ts`, ajouter après `RESEARCH_BLOCK` :

```ts
export type BriefCategory = { name: string; instructions: string };

export function categoryBlock(category: BriefCategory): string {
  return `## Instructions de la catégorie — ${category.name}

${category.instructions.trim()}`;
}
```

et remplacer `buildBrief` par :

```ts
/**
 * Le bloc de la catégorie s'insère entre le style maison et le bloc Recherche — jamais après le
 * contrat, qui doit rester le dernier mot du brief (c'est lui qui garantit que l'import fonctionne).
 * Catégorie absente ou instructions blanches ⇒ brief strictement identique à celui d'avant.
 */
export function buildBrief(
  template: string, vars: BriefVars, category?: BriefCategory | null,
): { text: string; unknown: string[] } {
  const rendered = renderTemplate(template, vars);
  const blocks = [rendered.text];
  if (category && category.instructions.trim() !== "") blocks.push(categoryBlock(category));
  blocks.push(RESEARCH_BLOCK, contractBlock());
  return { text: blocks.join("\n\n"), unknown: rendered.unknown };
}
```

- [ ] **Step 4: Lancer les tests et vérifier qu'ils passent**

Run: `bun test tests/video-brief.test.ts`
Expected: PASS — les 6 nouveaux tests **et** tous les anciens, non modifiés.

- [ ] **Step 5: Commit**

```bash
git add lib/video/brief.ts tests/video-brief.test.ts
git commit -m "feat(video): bloc d'instructions de catégorie dans le brief"
```

---

### Task 3: Validation Zod

**Files:**
- Modify: `lib/validation.ts` (à la suite de `createVideoProjectSchema`, ~ligne 340)
- Test: `tests/video-categories-validation.test.ts`

**Interfaces:**
- Consumes: rien.
- Produces:
  - `videoCategorySchema` : `{ name: string; description: string | null; instructions: string; position: number }`
  - `videoCategoryIdSchema` : `{ id: string }` (uuid)
  - `setProjectCategorySchema` : `{ projectId: string; categoryId: string | null }`
  - `createVideoProjectSchema` gagne `categoryId: z.string().uuid().nullable()`

- [ ] **Step 1: Écrire le test qui échoue**

Créer `tests/video-categories-validation.test.ts` :

```ts
import { describe, it, expect } from "bun:test";
import {
  videoCategorySchema, setProjectCategorySchema, createVideoProjectSchema,
} from "@/lib/validation";

const OK = { name: "Interview", description: "Entretien face caméra", instructions: "Poser des questions ouvertes.", position: 0 };
const UUID = "11111111-1111-4111-8111-111111111111";

describe("videoCategorySchema", () => {
  it("accepte une catégorie complète", () => {
    expect(videoCategorySchema.safeParse(OK).success).toBe(true);
  });

  it("accepte une description absente", () => {
    expect(videoCategorySchema.safeParse({ ...OK, description: null }).success).toBe(true);
  });

  it("refuse un nom vide", () => {
    expect(videoCategorySchema.safeParse({ ...OK, name: "" }).success).toBe(false);
  });

  it("refuse des instructions vides — une catégorie sans instructions n'a aucun effet", () => {
    expect(videoCategorySchema.safeParse({ ...OK, instructions: "" }).success).toBe(false);
  });

  it("borne les instructions à 20 000 caractères, comme le modèle de brief", () => {
    expect(videoCategorySchema.safeParse({ ...OK, instructions: "x".repeat(20001) }).success).toBe(false);
    expect(videoCategorySchema.safeParse({ ...OK, instructions: "x".repeat(20000) }).success).toBe(true);
  });
});

describe("setProjectCategorySchema", () => {
  it("accepte une catégorie et son retrait", () => {
    expect(setProjectCategorySchema.safeParse({ projectId: UUID, categoryId: UUID }).success).toBe(true);
    expect(setProjectCategorySchema.safeParse({ projectId: UUID, categoryId: null }).success).toBe(true);
  });

  it("refuse un identifiant qui n'est pas un uuid", () => {
    expect(setProjectCategorySchema.safeParse({ projectId: "abc", categoryId: null }).success).toBe(false);
  });
});

describe("createVideoProjectSchema", () => {
  const base = {
    title: "Titre", subject: null, platform: "youtube_long",
    targetDurationSec: null, aspectRatio: "16:9", articleId: null,
  };

  it("accepte un projet sans catégorie", () => {
    expect(createVideoProjectSchema.safeParse({ ...base, categoryId: null }).success).toBe(true);
  });

  it("accepte un projet avec catégorie", () => {
    expect(createVideoProjectSchema.safeParse({ ...base, categoryId: UUID }).success).toBe(true);
  });
});
```

- [ ] **Step 2: Lancer le test et vérifier qu'il échoue**

Run: `bun test tests/video-categories-validation.test.ts`
Expected: FAIL — `videoCategorySchema` n'est pas exporté.

- [ ] **Step 3: Implémenter**

Dans `lib/validation.ts`, après `createVideoProjectSchema`, ajouter :

```ts
// Catégories de vidéo : les instructions d'un expert, réutilisées à chaque projet de ce type.
export const videoCategorySchema = z.object({
  name: z.string().min(1, "Nom requis").max(80),
  description: z.string().max(300).nullable(),
  // MÊME borne que briefTemplate ci-dessus : les deux finissent dans le même brief, une limite plus
  // haute ici rendrait l'autre illusoire.
  instructions: z.string().min(1, "Les instructions ne peuvent pas être vides").max(20000),
  position: z.number().int().min(0).max(999),
});
export type VideoCategoryInput = z.infer<typeof videoCategorySchema>;

export const videoCategoryIdSchema = z.object({ id: z.string().uuid("Identifiant invalide") });

export const setProjectCategorySchema = z.object({
  projectId: z.string().uuid("Identifiant invalide"),
  // `null` = retirer la catégorie du projet.
  categoryId: z.string().uuid("Identifiant invalide").nullable(),
});
```

Et ajouter à l'objet de `createVideoProjectSchema` :

```ts
  categoryId: z.string().uuid().nullable(),
```

- [ ] **Step 4: Lancer les tests**

Run: `bun test tests/video-categories-validation.test.ts`
Expected: PASS (10 tests)

Puis vérifier qu'aucun appelant existant de `createVideoProjectSchema` ne casse :
Run: `bun run typecheck`
Expected: une erreur attendue dans `components/video/new-project-dialog.tsx` si le champ y est requis — elle sera corrigée à la Task 6. Si `typecheck` est rouge ici, laisser `categoryId` **optionnel-nullable** temporairement n'est PAS la solution : passer directement `categoryId: null` depuis le dialogue à la Task 6.

- [ ] **Step 5: Inscrire le test dans la voie rapide et commiter**

Ajouter `"video-categories-validation.test.ts"` à `PURE_FILES` dans `scripts/test-fast.ts`.

```bash
git add lib/validation.ts tests/video-categories-validation.test.ts scripts/test-fast.ts
git commit -m "feat(video): schémas de validation des catégories"
```

---

### Task 4: Cœur d'écriture et lectures

**Files:**
- Create: `lib/video/categories-persist.ts`
- Create: `lib/queries/video-categories.ts`
- Modify: `lib/video/persist.ts` (`createVideoProjectCore`, ~ligne 68)
- Test: `tests/video-categories-persist.test.ts` (voie DB — **ne pas** l'ajouter à `PURE_FILES`)

**Interfaces:**
- Consumes: `videoCategories`, `videoProjects` (Task 1) ; `RefusalError` (déjà exporté par `lib/video/persist.ts`).
- Produces:
  - `lib/queries/video-categories.ts` :
    - `export type VideoCategoryRow = { id: string; name: string; description: string | null; instructions: string; position: number; projectCount: number }`
    - `export type VideoCategoryOption = { id: string; name: string; description: string | null }`
    - `export async function listVideoCategories(): Promise<VideoCategoryRow[]>` — triée par `position`, puis `name`.
    - `export async function listVideoCategoryOptions(): Promise<VideoCategoryOption[]>` — pour les menus déroulants.
    - `export async function getBriefCategory(categoryId: string | null): Promise<BriefCategory | null>`
  - `lib/video/categories-persist.ts` :
    - `export async function createVideoCategoryCore(input: VideoCategoryInput & { userId: string | null }): Promise<string>`
    - `export async function updateVideoCategoryCore(input: VideoCategoryInput & { id: string; userId: string | null }): Promise<void>`
    - `export async function deleteVideoCategoryCore(id: string): Promise<void>`
    - `export async function setProjectCategoryCore(input: { projectId: string; categoryId: string | null }): Promise<void>`
    - Les trois premières lèvent `RefusalError("Une catégorie porte déjà ce nom.")` sur violation d'unicité.
  - `createVideoProjectCore` accepte désormais `categoryId: string | null`.

- [ ] **Step 1: Écrire le test qui échoue**

Créer `tests/video-categories-persist.test.ts` :

```ts
import { describe, it, expect, afterAll } from "bun:test";
import { db, videoCategories, videoProjects } from "@/db";
import { eq, inArray } from "drizzle-orm";
import {
  createVideoCategoryCore, updateVideoCategoryCore, deleteVideoCategoryCore, setProjectCategoryCore,
} from "@/lib/video/categories-persist";
import { createVideoProjectCore, RefusalError } from "@/lib/video/persist";
import { listVideoCategories, getBriefCategory } from "@/lib/queries/video-categories";

const created: string[] = [];
const projects: string[] = [];

async function newCategory(name: string, instructions = "Consignes de l'expert.") {
  const id = await createVideoCategoryCore({
    name, description: null, instructions, position: 0, userId: null,
  });
  created.push(id);
  return id;
}

async function newProject(title: string, categoryId: string | null) {
  const id = await createVideoProjectCore({
    title, subject: null, platform: "youtube_long", targetDurationSec: null,
    aspectRatio: "16:9", articleId: null, categoryId, userId: null,
  });
  projects.push(id);
  return id;
}

afterAll(async () => {
  if (projects.length) await db.delete(videoProjects).where(inArray(videoProjects.id, projects));
  if (created.length) await db.delete(videoCategories).where(inArray(videoCategories.id, created));
});

describe("CRUD des catégories", () => {
  it("crée, relit et édite une catégorie", async () => {
    const id = await newCategory(`Test-Storytelling-${Date.now()}`);
    await updateVideoCategoryCore({
      id, name: `Test-Récit-${Date.now()}`, description: "Récits longs",
      instructions: "Ouvrir sur une scène.", position: 3, userId: null,
    });
    const [row] = await db.select().from(videoCategories).where(eq(videoCategories.id, id));
    expect(row.instructions).toBe("Ouvrir sur une scène.");
    expect(row.position).toBe(3);
    expect(row.description).toBe("Récits longs");
  });

  it("refuse un nom déjà pris, quelle que soit la casse, avec un message français", async () => {
    const name = `Test-Interview-${Date.now()}`;
    await newCategory(name);
    // Le doublon doit être un refus métier lisible, pas une erreur Postgres brute remontée au client.
    await expect(newCategory(name.toUpperCase())).rejects.toBeInstanceOf(RefusalError);
  });

  it("compte les projets rattachés", async () => {
    const id = await newCategory(`Test-Compte-${Date.now()}`);
    await newProject("Test — projet catégorisé", id);
    const row = (await listVideoCategories()).find((c) => c.id === id);
    expect(row?.projectCount).toBe(1);
  });
});

describe("rattachement d'un projet", () => {
  it("persiste la catégorie à la création", async () => {
    const catId = await newCategory(`Test-Création-${Date.now()}`);
    const projectId = await newProject("Test — création avec catégorie", catId);
    const [p] = await db.select().from(videoProjects).where(eq(videoProjects.id, projectId));
    expect(p.categoryId).toBe(catId);
  });

  it("change puis retire la catégorie d'un projet", async () => {
    const catId = await newCategory(`Test-Changement-${Date.now()}`);
    const projectId = await newProject("Test — changement de catégorie", null);
    await setProjectCategoryCore({ projectId, categoryId: catId });
    expect((await db.select().from(videoProjects).where(eq(videoProjects.id, projectId)))[0].categoryId).toBe(catId);
    await setProjectCategoryCore({ projectId, categoryId: null });
    expect((await db.select().from(videoProjects).where(eq(videoProjects.id, projectId)))[0].categoryId).toBeNull();
  });

  it("supprimer une catégorie remet ses projets sur « aucune » sans les détruire", async () => {
    const catId = await newCategory(`Test-Suppression-${Date.now()}`);
    const projectId = await newProject("Test — survie à la suppression", catId);
    await deleteVideoCategoryCore(catId);
    const [p] = await db.select().from(videoProjects).where(eq(videoProjects.id, projectId));
    expect(p).toBeDefined();
    expect(p.categoryId).toBeNull();
  });
});

describe("getBriefCategory", () => {
  it("rend null sans catégorie", async () => {
    expect(await getBriefCategory(null)).toBeNull();
  });

  it("rend le nom et les instructions, rien d'autre", async () => {
    const id = await newCategory(`Test-Brief-${Date.now()}`, "Deux sources indépendantes.");
    expect(await getBriefCategory(id)).toEqual({
      name: expect.stringContaining("Test-Brief-"),
      instructions: "Deux sources indépendantes.",
    });
  });
});
```

- [ ] **Step 2: Lancer le test et vérifier qu'il échoue**

Run: `bun test tests/video-categories-persist.test.ts`
Expected: FAIL — `lib/video/categories-persist` introuvable.

- [ ] **Step 3: Écrire les lectures**

Créer `lib/queries/video-categories.ts` :

```ts
import { db, videoCategories, videoProjects } from "@/db";
import { asc, count, eq } from "drizzle-orm";
import type { BriefCategory } from "@/lib/video/brief";

// Lectures des catégories de vidéo. Aucune écriture ici — le cœur d'écriture vit dans
// lib/video/categories-persist.ts (même séparation que lib/queries/video.ts ↔ lib/video/persist.ts).

export type VideoCategoryRow = {
  id: string; name: string; description: string | null;
  instructions: string; position: number; projectCount: number;
};

export type VideoCategoryOption = { id: string; name: string; description: string | null };

// `projectCount` est ce qui permet d'annoncer, AVANT une suppression, combien de projets
// retomberont sur « aucune catégorie ».
export async function listVideoCategories(): Promise<VideoCategoryRow[]> {
  const rows = await db
    .select({
      id: videoCategories.id, name: videoCategories.name, description: videoCategories.description,
      instructions: videoCategories.instructions, position: videoCategories.position,
      projectCount: count(videoProjects.id),
    })
    .from(videoCategories)
    .leftJoin(videoProjects, eq(videoProjects.categoryId, videoCategories.id))
    .groupBy(videoCategories.id)
    .orderBy(asc(videoCategories.position), asc(videoCategories.name));
  return rows.map((r) => ({ ...r, projectCount: Number(r.projectCount) }));
}

export async function listVideoCategoryOptions(): Promise<VideoCategoryOption[]> {
  return db
    .select({ id: videoCategories.id, name: videoCategories.name, description: videoCategories.description })
    .from(videoCategories)
    .orderBy(asc(videoCategories.position), asc(videoCategories.name));
}

/**
 * La projection EXACTE que consomme buildBrief — nom + instructions, rien d'autre. Producteur
 * unique pour ses deux appelants (la page projet et l'outil MCP) : construite ligne à ligne des
 * deux côtés, elle aurait divergé à la première retouche, et l'agent aurait écrit sous un brief que
 * l'humain ne voit pas (même raison d'être que briefVarsFor dans lib/queries/video.ts).
 */
export async function getBriefCategory(categoryId: string | null): Promise<BriefCategory | null> {
  if (!categoryId) return null;
  const [row] = await db
    .select({ name: videoCategories.name, instructions: videoCategories.instructions })
    .from(videoCategories)
    .where(eq(videoCategories.id, categoryId));
  return row ?? null;
}
```

- [ ] **Step 4: Écrire le cœur d'écriture**

Créer `lib/video/categories-persist.ts` :

```ts
import { db, videoCategories, videoProjects } from "@/db";
import { eq } from "drizzle-orm";
import { RefusalError } from "@/lib/video/persist";
import type { VideoCategoryInput } from "@/lib/validation";

// Cœur d'écriture des catégories. PAS de "use server" ici : tout export d'un module "use server"
// est un point d'entrée réseau sans authentification propre. Les actions gardées vivent dans
// lib/actions/video-category-actions.ts et sont le seul chemin d'appel depuis le client.

// Postgres refuse le doublon par l'index unique sur lower(name) — c'est la base qui arbitre, pas
// une pré-lecture applicative (laquelle laisserait une fenêtre de concurrence). On convertit le
// code 23505 en refus métier français ; toute autre erreur relance telle quelle.
const UNIQUE_VIOLATION = "23505";

function asRefusal(e: unknown): never {
  if (typeof e === "object" && e !== null && (e as { code?: string }).code === UNIQUE_VIOLATION) {
    throw new RefusalError("Une catégorie porte déjà ce nom.");
  }
  throw e;
}

export async function createVideoCategoryCore(
  input: VideoCategoryInput & { userId: string | null },
): Promise<string> {
  try {
    const [row] = await db.insert(videoCategories).values({
      name: input.name.trim(),
      description: input.description?.trim() || null,
      instructions: input.instructions,
      position: input.position,
      updatedBy: input.userId,
    }).returning({ id: videoCategories.id });
    return row.id;
  } catch (e) { asRefusal(e); }
}

export async function updateVideoCategoryCore(
  input: VideoCategoryInput & { id: string; userId: string | null },
): Promise<void> {
  try {
    const updated = await db.update(videoCategories).set({
      name: input.name.trim(),
      description: input.description?.trim() || null,
      instructions: input.instructions,
      position: input.position,
      updatedAt: new Date(),
      updatedBy: input.userId,
    }).where(eq(videoCategories.id, input.id)).returning({ id: videoCategories.id });
    if (updated.length === 0) throw new RefusalError("Catégorie introuvable.");
  } catch (e) {
    if (e instanceof RefusalError) throw e;
    asRefusal(e);
  }
}

// Les projets rattachés retombent sur « aucune catégorie » par le ON DELETE SET NULL du schéma —
// rien à faire ici, et surtout aucune suppression en cascade de projets.
export async function deleteVideoCategoryCore(id: string): Promise<void> {
  await db.delete(videoCategories).where(eq(videoCategories.id, id));
}

export async function setProjectCategoryCore(
  input: { projectId: string; categoryId: string | null },
): Promise<void> {
  const updated = await db.update(videoProjects)
    .set({ categoryId: input.categoryId, updatedAt: new Date() })
    .where(eq(videoProjects.id, input.projectId))
    .returning({ id: videoProjects.id });
  if (updated.length === 0) throw new RefusalError("Projet introuvable.");
}
```

- [ ] **Step 5: Faire accepter `categoryId` à la création de projet**

Dans `lib/video/persist.ts`, `createVideoProjectCore` : ajouter `categoryId: string | null;` à la signature d'entrée (après `articleId`) et `categoryId: input.categoryId,` à l'objet `tx.insert(videoProjects).values({...})`.

- [ ] **Step 6: Lancer les tests et vérifier qu'ils passent**

Run: `bun test tests/video-categories-persist.test.ts`
Expected: PASS (8 tests)

Run: `bun test tests/video-actions.test.ts`
Expected: PASS — mais `newProject` y appelle `createVideoProjectCore` sans `categoryId`. Ajouter `categoryId: null,` à cet appel (`tests/video-actions.test.ts`, fonction `newProject`).

Run: `bun run typecheck`
Expected: seule reste l'erreur de `new-project-dialog.tsx` (Task 6).

- [ ] **Step 7: Commit**

```bash
git add lib/video/categories-persist.ts lib/queries/video-categories.ts lib/video/persist.ts tests/video-categories-persist.test.ts tests/video-actions.test.ts
git commit -m "feat(video): cœur d'écriture et lectures des catégories"
```

---

### Task 5: Actions serveur gardées

**Files:**
- Create: `lib/actions/video-category-actions.ts`
- Modify: `lib/actions/video-actions.ts` (ajout de `setProjectCategory`)
- Test: `tests/video-categories-rbac.test.ts`

**Interfaces:**
- Consumes: Task 3 (schémas) et Task 4 (cœur).
- Produces:
  - `createVideoCategory(input: unknown): Promise<{ ok: true; id: string } | { ok: false; message: string }>`
  - `updateVideoCategory(input: unknown): Promise<{ ok: true } | { ok: false; message: string }>`
  - `deleteVideoCategory(input: unknown): Promise<{ ok: true } | { ok: false; message: string }>`
  - `setProjectCategory(input: unknown): Promise<{ ok: true } | { ok: false; message: string }>` (dans `video-actions.ts`)

- [ ] **Step 1: Écrire le test qui échoue**

Créer `tests/video-categories-rbac.test.ts` — test **pur**, sur la matrice de permissions et sur la surface exportée :

```ts
import { describe, it, expect } from "bun:test";
import { can } from "@/lib/rbac";

describe("permissions des catégories de vidéo", () => {
  it("seuls admin et éditeur configurent les catégories", () => {
    // Écrire les instructions d'un expert est un acte de configuration, pas de rédaction.
    expect(can("admin", "video", "configure")).toBe(true);
    expect(can("editor", "video", "configure")).toBe(true);
    expect(can("journalist", "video", "configure")).toBe(false);
  });

  it("le journaliste choisit la catégorie de sa vidéo", () => {
    expect(can("journalist", "video", "manage")).toBe(true);
  });
});
```

`can(role, resource, action): boolean` est bien exporté par `lib/rbac.ts:41` — signature vérifiée.

- [ ] **Step 2: Lancer le test**

Run: `bun test tests/video-categories-rbac.test.ts`
Expected: PASS immédiatement (la matrice existe déjà) — c'est un test de verrouillage : il documente le choix de permission et cassera si quelqu'un ouvre `configure` au journaliste.

- [ ] **Step 3: Écrire les actions**

Créer `lib/actions/video-category-actions.ts` :

```ts
"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";
import { videoCategorySchema, videoCategoryIdSchema } from "@/lib/validation";
import {
  createVideoCategoryCore, updateVideoCategoryCore, deleteVideoCategoryCore,
} from "@/lib/video/categories-persist";
import { RefusalError } from "@/lib/video/persist";

// Ce module n'exporte QUE des actions gardées : le cœur DB vit dans lib/video/categories-persist.ts,
// sans "use server" (motif de lib/actions/taxonomy-actions.ts).

// "configure" et non "manage" : écrire les instructions d'un expert relève des réglages du module,
// pas de la rédaction d'un script. Même garde que /settings/video.
async function guard() {
  const u = await requireUser();
  requirePermission(u.role, "video", "configure");
  return u;
}

function revalidate(): void {
  revalidatePath("/settings/video");
  revalidatePath("/video");
  revalidatePath("/video/[id]", "page");
}

// Un refus métier (nom déjà pris, catégorie introuvable) revient en message français ; une vraie
// panne DB relance et devient une erreur serveur.
async function refusable<T>(run: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
  try {
    return { ok: true, value: await run() };
  } catch (e) {
    if (e instanceof RefusalError) return { ok: false, message: e.message };
    throw e;
  }
}

export async function createVideoCategory(
  input: unknown,
): Promise<{ ok: true; id: string } | { ok: false; message: string }> {
  const u = await guard();
  const parsed = videoCategorySchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Entrée invalide." };

  const res = await refusable(() => createVideoCategoryCore({ ...parsed.data, userId: u.id }));
  if (!res.ok) return res;
  revalidate();
  return { ok: true, id: res.value };
}

export async function updateVideoCategory(
  input: unknown,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const u = await guard();
  const parsed = videoCategorySchema.extend(videoCategoryIdSchema.shape).safeParse(input);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Entrée invalide." };

  const res = await refusable(() => updateVideoCategoryCore({ ...parsed.data, userId: u.id }));
  if (!res.ok) return res;
  revalidate();
  return { ok: true };
}

export async function deleteVideoCategory(
  input: unknown,
): Promise<{ ok: true } | { ok: false; message: string }> {
  await guard();
  const parsed = videoCategoryIdSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Entrée invalide." };

  await deleteVideoCategoryCore(parsed.data.id);
  revalidate();
  return { ok: true };
}
```

Dans `lib/actions/video-actions.ts`, ajouter (le fichier a déjà `guard()` en `video`/`manage`, `refusable` et `revalidateVideo`) :

```ts
export async function setProjectCategory(
  input: unknown,
): Promise<{ ok: true } | { ok: false; message: string }> {
  await guard();
  const parsed = setProjectCategorySchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Entrée invalide." };

  const res = await refusable(() => setProjectCategoryCore(parsed.data));
  if (!res.ok) return res;
  revalidateVideo();
  return { ok: true };
}
```

en important `setProjectCategorySchema` depuis `@/lib/validation` et `setProjectCategoryCore` depuis `@/lib/video/categories-persist`.

- [ ] **Step 4: Vérifier**

Run: `bun test tests/video-categories-rbac.test.ts && bun run typecheck`
Expected: tests PASS ; `typecheck` ne signale plus que `new-project-dialog.tsx`.

- [ ] **Step 5: Inscrire le test dans la voie rapide et commiter**

Ajouter `"video-categories-rbac.test.ts"` à `PURE_FILES`.

```bash
git add lib/actions/video-category-actions.ts lib/actions/video-actions.ts tests/video-categories-rbac.test.ts scripts/test-fast.ts
git commit -m "feat(video): actions serveur gardées pour les catégories"
```

---

### Task 6: Écran de gestion en Réglages

**Files:**
- Create: `components/video/category-manager.tsx`
- Modify: `app/(app)/settings/video/page.tsx`
- Modify: `components/video/video-settings-form.tsx` (retirer le `PageHeader`, voir Step 3)

**Interfaces:**
- Consumes: `listVideoCategories()` / `VideoCategoryRow` (Task 4), `createVideoCategory` / `updateVideoCategory` / `deleteVideoCategory` (Task 5).
- Produces: `export function CategoryManager({ categories }: { categories: VideoCategoryRow[] })`

- [ ] **Step 1: Écrire le composant**

Créer `components/video/category-manager.tsx` :

```tsx
"use client";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/shell/empty-state";
import {
  createVideoCategory, updateVideoCategory, deleteVideoCategory,
} from "@/lib/actions/video-category-actions";
import type { VideoCategoryRow } from "@/lib/queries/video-categories";

type FormState = { name: string; description: string; instructions: string; position: string };

const EMPTY: FormState = { name: "", description: "", instructions: "", position: "0" };

// Les catégories de vidéo : le savoir d'un expert, écrit une fois, injecté dans le brief de chaque
// projet rattaché. Édité ici parce que c'est un acte de configuration (permission video/configure),
// pas de rédaction.
export function CategoryManager({ categories }: { categories: VideoCategoryRow[] }) {
  const [editing, setEditing] = useState<VideoCategoryRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<VideoCategoryRow | null>(null);

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div className="space-y-1.5">
          <CardTitle>Catégories de vidéo</CardTitle>
          <CardDescription>
            Les instructions propres à un type de vidéo — storytelling, interview, investigation…
            Elles sont ajoutées automatiquement au brief de chaque projet rattaché.
          </CardDescription>
        </div>
        <Button onClick={() => setCreating(true)}><Plus aria-hidden /> Nouvelle catégorie</Button>
      </CardHeader>
      <CardContent>
        {categories.length === 0 ? (
          <EmptyState
            title="Aucune catégorie"
            hint="Créez une catégorie par type de vidéo et confiez ses instructions à la personne qui maîtrise ce format. Les rédacteurs n'auront plus qu'à choisir la catégorie."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nom</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Instructions</TableHead>
                <TableHead className="text-right">Projets</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {categories.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-medium">{c.name}</TableCell>
                  <TableCell className="text-muted-foreground">{c.description ?? "—"}</TableCell>
                  <TableCell className="max-w-md truncate text-muted-foreground">{c.instructions}</TableCell>
                  <TableCell className="text-right tabular-nums">{c.projectCount}</TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="icon" aria-label={`Modifier ${c.name}`} onClick={() => setEditing(c)}>
                      <Pencil aria-hidden />
                    </Button>
                    <Button variant="ghost" size="icon" aria-label={`Supprimer ${c.name}`} onClick={() => setDeleting(c)}>
                      <Trash2 aria-hidden />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <CategoryDialog
        open={creating || editing !== null}
        category={editing}
        onClose={() => { setCreating(false); setEditing(null); }}
      />
      <DeleteDialog category={deleting} onClose={() => setDeleting(null)} />
    </Card>
  );
}

function CategoryDialog({
  open, category, onClose,
}: { open: boolean; category: VideoCategoryRow | null; onClose: () => void }) {
  const [form, setForm] = useState<FormState>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, startSaving] = useTransition();
  // Réinitialisé à chaque ouverture : le dialogue sert alternativement à créer et à éditer, et un
  // état résiduel afficherait les instructions de la catégorie précédente.
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  const key = category?.id ?? "__new__";
  if (open && openedFor !== key) {
    setOpenedFor(key);
    setForm(category
      ? {
          name: category.name, description: category.description ?? "",
          instructions: category.instructions, position: String(category.position),
        }
      : EMPTY);
    setError(null);
  }

  function handleSave() {
    const payload = {
      name: form.name,
      description: form.description.trim() || null,
      instructions: form.instructions,
      position: Number(form.position) || 0,
    };
    startSaving(async () => {
      try {
        const res = category
          ? await updateVideoCategory({ ...payload, id: category.id })
          : await createVideoCategory(payload);
        if (!res.ok) { setError(res.message); toast.error(res.message); return; }
        toast.success(category ? "Catégorie modifiée." : "Catégorie créée.");
        setOpenedFor(null);
        onClose();
      } catch (err) {
        const message = err instanceof Error ? err.message : "Échec de l'enregistrement.";
        setError(message);
        toast.error(message);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) { setOpenedFor(null); onClose(); } }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{category ? "Modifier la catégorie" : "Nouvelle catégorie"}</DialogTitle>
          <DialogDescription>
            Les instructions sont reprises telles quelles dans le brief, sous le titre
            « Instructions de la catégorie ».
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-4">
            <div className="col-span-2 space-y-1.5">
              <Label htmlFor="cat-name">Nom</Label>
              <Input
                id="cat-name" value={form.name} disabled={isSaving} placeholder="Ex. Investigation"
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cat-position">Ordre</Label>
              <Input
                id="cat-position" type="number" min={0} max={999} value={form.position} disabled={isSaving}
                onChange={(e) => setForm((f) => ({ ...f, position: e.target.value }))}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cat-description">Description (optionnelle)</Label>
            <Input
              id="cat-description" value={form.description} disabled={isSaving}
              placeholder="Ce qui aide un rédacteur à choisir cette catégorie"
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cat-instructions">Instructions</Label>
            <Textarea
              id="cat-instructions" rows={14} value={form.instructions} disabled={isSaving}
              placeholder="Les consignes que le modèle doit suivre pour ce type de vidéo."
              onChange={(e) => setForm((f) => ({ ...f, instructions: e.target.value }))}
            />
          </div>
          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={isSaving}>Annuler</Button>
          <Button onClick={handleSave} disabled={isSaving}>
            {isSaving && <Loader2 className="animate-spin" aria-hidden />}
            {isSaving ? "Enregistrement…" : "Enregistrer"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDialog({ category, onClose }: { category: VideoCategoryRow | null; onClose: () => void }) {
  const [isDeleting, startDeleting] = useTransition();

  function handleDelete() {
    if (!category) return;
    startDeleting(async () => {
      const res = await deleteVideoCategory({ id: category.id });
      if (!res.ok) { toast.error(res.message); return; }
      toast.success("Catégorie supprimée.");
      onClose();
    });
  }

  return (
    <Dialog open={category !== null} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Supprimer « {category?.name} » ?</DialogTitle>
          <DialogDescription>
            {category && category.projectCount > 0
              ? `${category.projectCount} projet${category.projectCount > 1 ? "s" : ""} retombera${category.projectCount > 1 ? "ont" : ""} sur « aucune catégorie ». Aucun projet n'est supprimé.`
              : "Aucun projet n'utilise cette catégorie."}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={isDeleting}>Annuler</Button>
          <Button variant="destructive" onClick={handleDelete} disabled={isDeleting}>
            {isDeleting && <Loader2 className="animate-spin" aria-hidden />}
            Supprimer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

`EmptyState` prend bien `title` + `hint` (vérifié dans `components/shell/empty-state.tsx`). Ouvrir `components/ui/table.tsx` pour confirmer les noms des sous-composants exportés avant d'écrire le fichier ; ne pas inventer d'API.

- [ ] **Step 2: Câbler la page de réglages**

`app/(app)/settings/video/page.tsx` :

```tsx
import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";
import { getVideoSettings } from "@/lib/queries/video-settings";
import { listVideoCategories } from "@/lib/queries/video-categories";
import { PageHeader } from "@/components/shell/page-header";
import { CategoryManager } from "@/components/video/category-manager";
import { VideoSettingsForm } from "@/components/video/video-settings-form";

export default async function Page() {
  const user = await requireUser();
  requirePermission(user.role, "video", "configure");
  const [settings, categories] = await Promise.all([getVideoSettings(), listVideoCategories()]);
  return (
    <div className="max-w-2xl space-y-6">
      <PageHeader title="Vidéo" />
      <CategoryManager categories={categories} />
      <VideoSettingsForm settings={settings} />
    </div>
  );
}
```

- [ ] **Step 3: Retirer le `PageHeader` dupliqué du formulaire**

Dans `components/video/video-settings-form.tsx`, supprimer `<PageHeader title="Vidéo" />` et son import (il est désormais rendu par la page), et remplacer le conteneur `<div className="max-w-2xl space-y-6">` par `<div className="space-y-6">` — la largeur est désormais portée par la page.

- [ ] **Step 4: Vérifier dans le navigateur**

```bash
bun run typecheck
```

Puis, via l'outil de prévisualisation (jamais `bun run dev` en Bash) : ouvrir `/settings/video`, créer une catégorie « Investigation », la modifier, tenter d'en créer une seconde nommée « investigation » (doit afficher « Une catégorie porte déjà ce nom. »), puis la supprimer. Vérifier la console navigateur : aucune erreur.

- [ ] **Step 5: Commit**

```bash
git add components/video/category-manager.tsx "app/(app)/settings/video/page.tsx" components/video/video-settings-form.tsx
git commit -m "feat(video): écran de gestion des catégories en réglages"
```

---

### Task 7: Choix de la catégorie à la création

**Files:**
- Modify: `components/video/new-project-dialog.tsx`
- Modify: `app/(app)/video/page.tsx`

**Interfaces:**
- Consumes: `listVideoCategoryOptions()` / `VideoCategoryOption` (Task 4), `createVideoProject` avec `categoryId` (Tasks 3–4).
- Produces: `NewProjectDialog` accepte désormais `categories: VideoCategoryOption[]` en plus d'`articles`.

- [ ] **Step 1: Ajouter le menu au dialogue**

Dans `components/video/new-project-dialog.tsx` :

- signature : `export function NewProjectDialog({ articles, categories }: { articles: { id: string; title: string }[]; categories: VideoCategoryOption[] })`, avec `import type { VideoCategoryOption } from "@/lib/queries/video-categories";`
- `FormState` gagne `categoryId: string;` et `EMPTY` gagne `categoryId: ""`
- ajouter la constante `const NO_CATEGORY = "__none__";` à côté de `NO_ARTICLE`
- passer `categoryId: form.categoryId && form.categoryId !== NO_CATEGORY ? form.categoryId : null` à `createVideoProject`
- insérer ce champ **juste après** le champ « Sujet / angle » (la catégorie oriente l'écriture ; elle se lit avant les réglages techniques) :

```tsx
          <div className="space-y-1.5">
            <Label htmlFor="project-category">Catégorie</Label>
            <Select
              value={form.categoryId || NO_CATEGORY}
              onValueChange={(v) => setForm((f) => ({ ...f, categoryId: !v || v === NO_CATEGORY ? "" : v }))}
              disabled={isSaving}
            >
              <SelectTrigger id="project-category" className="w-full">
                <SelectValue placeholder="Aucune catégorie" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_CATEGORY}>Aucune catégorie</SelectItem>
                {categories.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                    {c.description && (
                      <span className="ml-2 text-xs text-muted-foreground">{c.description}</span>
                    )}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Les instructions de la catégorie seront ajoutées au brief de cette vidéo.
            </p>
          </div>
```

- [ ] **Step 2: Charger les catégories dans la page**

Dans `app/(app)/video/page.tsx`, ajouter `listVideoCategoryOptions()` au `Promise.all` existant et passer `categories={categories}` à `<NewProjectDialog />`.

- [ ] **Step 3: Vérifier**

Run: `bun run typecheck`
Expected: PASS — plus aucune erreur en attente.

Run: `bun test tests/video-project-list.test.ts`
Expected: PASS.

Dans le navigateur : créer une vidéo avec la catégorie « Investigation », puis une sans catégorie. Les deux doivent aboutir sur `/video/<id>`.

- [ ] **Step 4: Commit**

```bash
git add components/video/new-project-dialog.tsx "app/(app)/video/page.tsx"
git commit -m "feat(video): choix de la catégorie à la création d'un projet"
```

---

### Task 8: Brief catégorisé sur la page projet, sélecteur, et chemin MCP

**Files:**
- Create: `components/video/project-category-select.tsx`
- Modify: `app/(app)/video/[id]/page.tsx`
- Modify: `lib/mcp/tools.ts` (`construireBrief`, ~ligne 140-152)
- Test: `tests/video-categories-brief-integration.test.ts` (voie DB)

**Interfaces:**
- Consumes: `getBriefCategory` / `listVideoCategoryOptions` (Task 4), `setProjectCategory` (Task 5), `buildBrief(..., category)` (Task 2).
- Produces: `export function ProjectCategorySelect({ projectId, categoryId, categories }: { projectId: string; categoryId: string | null; categories: VideoCategoryOption[] })`

- [ ] **Step 1: Écrire le test qui échoue**

Créer `tests/video-categories-brief-integration.test.ts` :

```ts
import { describe, it, expect, afterAll } from "bun:test";
import { db, videoCategories, videoProjects } from "@/db";
import { eq, inArray } from "drizzle-orm";
import { createVideoCategoryCore } from "@/lib/video/categories-persist";
import { createVideoProjectCore } from "@/lib/video/persist";
import { getBriefCategory } from "@/lib/queries/video-categories";
import { briefVarsFor } from "@/lib/queries/video";
import { getVideoSettings } from "@/lib/queries/video-settings";
import { buildBrief } from "@/lib/video/brief";

const cats: string[] = [];
const projs: string[] = [];

afterAll(async () => {
  if (projs.length) await db.delete(videoProjects).where(inArray(videoProjects.id, projs));
  if (cats.length) await db.delete(videoCategories).where(inArray(videoCategories.id, cats));
});

describe("brief d'un projet catégorisé", () => {
  it("le brief construit depuis la base porte les instructions de l'expert", async () => {
    const catId = await createVideoCategoryCore({
      name: `Test-Intégration-${Date.now()}`, description: null,
      instructions: "Croiser deux sources indépendantes pour chaque chiffre.",
      position: 0, userId: null,
    });
    cats.push(catId);
    const projectId = await createVideoProjectCore({
      title: "Test — brief catégorisé", subject: null, platform: "youtube_long",
      targetDurationSec: null, aspectRatio: "16:9", articleId: null, categoryId: catId, userId: null,
    });
    projs.push(projectId);

    const [project] = await db.select().from(videoProjects).where(eq(videoProjects.id, projectId));
    const settings = await getVideoSettings();
    const vars = await briefVarsFor(project, null);
    const category = await getBriefCategory(project.categoryId);
    const brief = buildBrief(settings.briefTemplate, vars, category).text;

    expect(brief).toContain("## Instructions de la catégorie —");
    expect(brief).toContain("Croiser deux sources indépendantes pour chaque chiffre.");
    // Le contrat reste le dernier mot du brief.
    expect(brief.indexOf("## Format de réponse")).toBeGreaterThan(brief.indexOf("## Instructions de la catégorie"));
  });
});
```

- [ ] **Step 2: Lancer le test et vérifier qu'il échoue**

Run: `bun test tests/video-categories-brief-integration.test.ts`
Expected: FAIL tant que Task 2 et Task 4 ne sont pas en place ; s'il passe déjà, c'est normal — les deux tâches précédentes fournissent toutes les pièces, et ce test verrouille leur assemblage.

- [ ] **Step 3: Écrire le sélecteur**

Créer `components/video/project-category-select.tsx` :

```tsx
"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { setProjectCategory } from "@/lib/actions/video-actions";
import type { VideoCategoryOption } from "@/lib/queries/video-categories";

const NO_CATEGORY = "__none__";

// Placé dans l'onglet Brief, au-dessus du texte : c'est là que le changement est immédiatement
// visible — le brief se réécrit sous les yeux. Dans l'en-tête du projet, l'effet serait à deviner.
export function ProjectCategorySelect({
  projectId, categoryId, categories,
}: { projectId: string; categoryId: string | null; categories: VideoCategoryOption[] }) {
  const router = useRouter();
  const [isSaving, startSaving] = useTransition();

  function handleChange(value: string) {
    const next = !value || value === NO_CATEGORY ? null : value;
    startSaving(async () => {
      const res = await setProjectCategory({ projectId, categoryId: next });
      if (!res.ok) { toast.error(res.message); return; }
      toast.success("Catégorie mise à jour.");
      // Le brief est rendu côté serveur : il faut rafraîchir pour le voir se réécrire.
      router.refresh();
    });
  }

  return (
    <div className="flex items-center gap-3">
      <Label htmlFor="brief-category" className="shrink-0">Catégorie</Label>
      <Select value={categoryId ?? NO_CATEGORY} onValueChange={handleChange} disabled={isSaving}>
        <SelectTrigger id="brief-category" className="w-72">
          <SelectValue placeholder="Aucune catégorie" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_CATEGORY}>Aucune catégorie</SelectItem>
          {categories.map((c) => (
            <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
```

- [ ] **Step 4: Câbler la page projet**

Dans `app/(app)/video/[id]/page.tsx` :

- importer `getBriefCategory, listVideoCategoryOptions` depuis `@/lib/queries/video-categories` et `ProjectCategorySelect` ;
- après `const vars = await briefVarsFor(...)`, ajouter :

```tsx
  // La catégorie du projet — mêmes instructions que celles remises à l'agent MCP, parce que les deux
  // chemins passent par getBriefCategory + buildBrief.
  const [briefCategory, categoryOptions] = await Promise.all([
    getBriefCategory(project.categoryId),
    listVideoCategoryOptions(),
  ]);
```

- remplacer `const brief = buildBrief(settings.briefTemplate, vars);` par
  `const brief = buildBrief(settings.briefTemplate, vars, briefCategory);`
- dans le `<TabsContent value="brief">`, rendre le sélecteur **au-dessus** de `<BriefPanel ... />` :

```tsx
          <ProjectCategorySelect
            projectId={project.id}
            categoryId={project.categoryId}
            categories={categoryOptions}
          />
```

(Vérifier au passage que `getVideoProject` renvoie bien `categoryId` : il fait `db.select().from(videoProjects)` sans projection, donc la colonne arrive automatiquement — rien à modifier dans `lib/queries/video.ts`.)

- [ ] **Step 5: Câbler le chemin MCP**

Dans `lib/mcp/tools.ts`, `construireBrief` — ajouter l'import `getBriefCategory` depuis `@/lib/queries/video-categories`, puis :

```ts
  const vars = await briefVarsFor(project, variant);
  const settings = await getVideoSettings();
  // L'agent reçoit EXACTEMENT le brief affiché à l'humain, instructions de catégorie comprises :
  // même producteur (buildBrief), mêmes entrées. Sans cette ligne, l'agent écrirait sous un brief
  // que personne ne voit.
  const category = await getBriefCategory(project.categoryId);
  return { brief: buildBrief(settings.briefTemplate, vars, category).text, variantId: variant?.id ?? null };
```

- [ ] **Step 6: Vérifier**

Run: `bun test tests/video-categories-brief-integration.test.ts`
Expected: PASS.

Run: `bun run typecheck && bun run test:pure`
Expected: PASS.

Dans le navigateur : ouvrir un projet, onglet Brief. Le bloc « ## Instructions de la catégorie — … » doit apparaître entre le style maison et « ## Recherche attendue ». Changer la catégorie dans le sélecteur : le brief se réécrit. Choisir « Aucune catégorie » : le bloc disparaît.

- [ ] **Step 7: Commit**

```bash
git add components/video/project-category-select.tsx "app/(app)/video/[id]/page.tsx" lib/mcp/tools.ts tests/video-categories-brief-integration.test.ts
git commit -m "feat(video): brief catégorisé sur la page projet et côté MCP"
```

---

### Task 9: Vérification finale

**Files:** aucun (sauf correctifs).

- [ ] **Step 1: Suite complète**

Run: `bun test`
Expected: PASS. La suite complète est lente (base Neon partagée, exécution série) — c'est attendu, ne pas la réduire pour aller plus vite.

- [ ] **Step 2: Typecheck et build**

```bash
bun run typecheck
bun run build
```
Expected: PASS tous les deux.

- [ ] **Step 3: Parcours de bout en bout dans le navigateur**

1. `/settings/video` → créer « Interview » avec des instructions réelles.
2. `/video` → nouvelle vidéo, catégorie « Interview ».
3. Onglet Brief → les instructions apparaissent au bon endroit ; « Copier le brief » fonctionne.
4. Changer pour « Aucune catégorie » → le bloc disparaît.
5. `/settings/video` → supprimer « Interview » → le projet existe toujours, sans catégorie.

- [ ] **Step 4: Vérifier l'état du dépôt**

```bash
git status
```
Expected: arbre propre. **Ne pas pousser** : l'ouverture de la PR revient à l'utilisateur.
