# Portées des jetons MCP — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pouvoir émettre un jeton d'API MCP restreint — en lecture seule, et/ou sans accès aux articles — au lieu d'un jeton qui donne tout ce que son propriétaire peut faire.

**Architecture:** Deux booléens sur `api_tokens` (`can_write`, `can_read_articles`, défaut `true` = comportement actuel). Chaque outil du registre déclare un `domain` obligatoire (`"video"` | `"article"`) à côté de son `kind` existant. Une fonction pure `refusPourPortee(spec, scope)` porte toute la règle ; `registerTools` l'appelle après le contrôle de rôle, qui reste inchangé.

**Tech Stack:** Next.js (App Router, Server Actions), Drizzle ORM / Postgres, Zod 4, `@modelcontextprotocol/sdk`, Base UI + shadcn (`components/ui`), `bun test`.

**Spec:** [docs/superpowers/specs/2026-08-17-mcp-token-scopes-design.md](../specs/2026-08-17-mcp-token-scopes-design.md)

## Global Constraints

- **Branche `feat/mcp-token-scopes`, empilée sur `feat/video-mcp-category`.** Ne pas pousser ; ne pas rebaser les branches en dessous.
- Copie d'interface et commentaires **en français**, expliquant le POURQUOI, comme le code environnant.
- **Le rôle est le plancher, la portée est le plafond.** Le contrôle de rôle existant (`requirePermission(actor.role, "video", "manage")` pour les écritures) reste en place et s'exécute AVANT le contrôle de portée. Une portée ne doit jamais accorder ce qu'un rôle refuse.
- **Rétro-compatibilité stricte** : les deux colonnes valent `true` par défaut, donc un jeton déjà émis conserve exactement ses pouvoirs actuels. Un test doit le prouver.
- `domain` est **obligatoire** sur `ToolSpec` : un outil ajouté sans domaine ne doit pas compiler.
- Un module `"use server"` n'exporte QUE des actions gardées ; le cœur DB reste dans `lib/queries/mcp.ts`, sans directive.
- Les refus de portée sont des **messages français** levés comme les autres erreurs d'outil (une `Error`, que le SDK transforme en résultat `isError: true` portant le texte).
- Les tests qui touchent la base doivent nettoyer leurs lignes (base Neon distante et partagée) et rester HORS de l'allowlist `PURE_FILES` de `scripts/test-fast.ts` ; les tests purs y entrent.
- Ne PAS lancer la suite complète `bun test` dans les tâches : `bun run test:pure`, `bun run typecheck`, et les fichiers de test concernés.

---

### Task 1: Domaine des outils et règle de portée (pur)

Cette tâche ne touche ni la base ni l'authentification : elle pose le vocabulaire et la règle, testables seuls.

**Files:**
- Modify: `lib/mcp/registry.ts`
- Create: `lib/mcp/scope.ts`
- Test: `tests/mcp-scope.test.ts`

**Interfaces:**
- Consumes: `TOOL_REGISTRY`, `ToolSpec`, `ToolKind` (`lib/mcp/registry.ts`).
- Produces:
  - `export type ToolDomain = "video" | "article"` et le champ **obligatoire** `domain: ToolDomain` sur `ToolSpec` (`lib/mcp/registry.ts`).
  - `export type McpScope = { canWrite: boolean; canReadArticles: boolean }` (`lib/mcp/scope.ts`).
  - `export const FULL_SCOPE: McpScope` — la portée complète, réutilisée par les tests et par le repli de rétro-compatibilité.
  - `export function refusPourPortee(spec: Pick<ToolSpec, "kind" | "domain">, scope: McpScope): string | null` — le message français du refus, ou `null` si l'appel passe.

- [ ] **Step 1: Écrire les tests qui échouent**

Créer `tests/mcp-scope.test.ts` :

```ts
import { describe, it, expect } from "bun:test";
import { TOOL_REGISTRY } from "@/lib/mcp/registry";
import { refusPourPortee, FULL_SCOPE, type McpScope } from "@/lib/mcp/scope";

const LECTURE_SEULE: McpScope = { canWrite: false, canReadArticles: true };
const SANS_ARTICLES: McpScope = { canWrite: true, canReadArticles: false };
const RIEN: McpScope = { canWrite: false, canReadArticles: false };

describe("domaine des outils", () => {
  // Sans cette assertion, un futur outil pourrait recevoir "video" par distraction et échapper à
  // l'axe articles sans que rien ne le signale.
  it("chaque outil du registre déclare un domaine connu", () => {
    for (const spec of TOOL_REGISTRY) {
      expect(["video", "article"]).toContain(spec.domain);
    }
  });

  it("seuls list_articles et get_article relèvent du domaine article", () => {
    const article = TOOL_REGISTRY.filter((t) => t.domain === "article").map((t) => t.name).sort();
    expect(article).toEqual(["get_article", "list_articles"]);
  });
});

describe("refusPourPortee", () => {
  it("une portée complète ne refuse aucun outil", () => {
    for (const spec of TOOL_REGISTRY) {
      expect(refusPourPortee(spec, FULL_SCOPE)).toBeNull();
    }
  });

  // Assertions écrites en ITÉRANT le registre : une liste de noms recopiée cesserait silencieusement
  // de tout couvrir au prochain outil ajouté.
  it("sans écriture, tous les outils d'écriture sont refusés et aucune lecture ne l'est", () => {
    for (const spec of TOOL_REGISTRY) {
      const refus = refusPourPortee(spec, LECTURE_SEULE);
      if (spec.kind === "ecriture") expect(refus).toBe("Ce jeton est en lecture seule. Créez un jeton avec l'écriture pour cette action.");
      else expect(refus).toBeNull();
    }
  });

  it("sans accès aux articles, seuls les outils du domaine article sont refusés", () => {
    for (const spec of TOOL_REGISTRY) {
      const refus = refusPourPortee(spec, SANS_ARTICLES);
      if (spec.domain === "article") expect(refus).toBe("Ce jeton n'a pas accès aux articles.");
      else expect(refus).toBeNull();
    }
  });

  it("portée vide : un seul message, celui de l'axe le plus spécifique", () => {
    // `get_article` est en lecture ET dans le domaine article : seul l'axe articles s'applique.
    const getArticle = TOOL_REGISTRY.find((t) => t.name === "get_article")!;
    expect(refusPourPortee(getArticle, RIEN)).toBe("Ce jeton n'a pas accès aux articles.");
    // Un outil d'écriture du domaine vidéo ne peut être refusé que par l'axe écriture.
    const createProject = TOOL_REGISTRY.find((t) => t.name === "create_video_project")!;
    expect(refusPourPortee(createProject, RIEN)).toBe("Ce jeton est en lecture seule. Créez un jeton avec l'écriture pour cette action.");
  });
});
```

- [ ] **Step 2: Lancer le test et vérifier qu'il échoue**

Run: `bun test tests/mcp-scope.test.ts`
Expected: FAIL — `lib/mcp/scope` introuvable.

- [ ] **Step 3: Ajouter le domaine au registre**

Dans `lib/mcp/registry.ts`, ajouter au-dessus de `ToolSpec` :

```ts
// Le DOMAINE de données auquel un outil touche — l'axe « articles » de la portée d'un jeton
// (lib/mcp/scope.ts) se lit ici, et nulle part ailleurs. OBLIGATOIRE : un outil ajouté sans domaine
// ne compile pas, exactement comme un outil ajouté au dispatch sans entrée de registre est attrapé
// par tests/mcp-registry.test.ts. Un pouvoir accordé en silence est le défaut que ce registre
// existe pour rendre impossible.
export type ToolDomain = "video" | "article";
```

puis le champ dans `ToolSpec` :

```ts
  domain: ToolDomain;
```

Enfin, ajouter `domain:` à chacune des entrées de `TOOL_REGISTRY` : `"article"` pour `list_articles`
et `get_article`, `"video"` pour toutes les autres. Placer la ligne juste après `kind:`, pour que
les deux axes se lisent ensemble.

- [ ] **Step 4: Écrire la règle**

Créer `lib/mcp/scope.ts` :

```ts
import type { ToolSpec } from "@/lib/mcp/registry";

// La portée d'un jeton d'API : ce que CE jeton peut faire, indépendamment de ce que son propriétaire
// pourrait faire dans l'interface web. Le rôle reste le plancher (lib/mcp/tools.ts vérifie
// toujours "video"/"manage" avant les écritures) ; la portée est le plafond. Une portée n'accorde
// donc jamais rien — elle ne fait que retirer.
export type McpScope = { canWrite: boolean; canReadArticles: boolean };

// Le pouvoir d'un jeton d'avant les portées, et le défaut des colonnes en base : c'est ce qui rend
// la migration rétro-compatible sans réécrire une seule ligne.
export const FULL_SCOPE: McpScope = { canWrite: true, canReadArticles: true };

const REFUS_ECRITURE = "Ce jeton est en lecture seule. Créez un jeton avec l'écriture pour cette action.";
const REFUS_ARTICLES = "Ce jeton n'a pas accès aux articles.";

/**
 * Le message de refus, ou `null` si l'appel passe. Fonction PURE et isolée du serveur : la règle se
 * lit en un seul endroit et se teste sans base ni SDK MCP — dispersée dans le corps de
 * `registerTools`, elle n'aurait été vérifiable que de bout en bout.
 *
 * L'axe articles est évalué en PREMIER : pour un outil de lecture du domaine article, c'est le seul
 * axe qui puisse s'appliquer, et pour un outil d'écriture de ce domaine, « pas accès aux articles »
 * est plus précis que « lecture seule ». Un agent reçoit ainsi une cause actionnable, jamais deux
 * messages concaténés.
 */
export function refusPourPortee(
  spec: Pick<ToolSpec, "kind" | "domain">, scope: McpScope,
): string | null {
  if (spec.domain === "article" && !scope.canReadArticles) return REFUS_ARTICLES;
  if (spec.kind === "ecriture" && !scope.canWrite) return REFUS_ECRITURE;
  return null;
}
```

- [ ] **Step 5: Lancer les tests**

Run: `bun test tests/mcp-scope.test.ts`
Expected: PASS (6 tests)

Run: `bun test tests/mcp-registry.test.ts && bun run typecheck`
Expected: PASS — le registre reste cohérent, et `domain` obligatoire ne casse aucun appelant (le seul producteur d'entrées est le registre lui-même).

- [ ] **Step 6: Inscrire le test pur et commiter**

Ajouter `"mcp-scope.test.ts"` à l'ensemble `PURE_FILES` de `scripts/test-fast.ts`, à sa place alphabétique parmi les entrées `mcp-*`.

Run: `bun run test:pure`
Expected: PASS.

```bash
git add lib/mcp/registry.ts lib/mcp/scope.ts tests/mcp-scope.test.ts scripts/test-fast.ts
git commit -m "feat(mcp): domaine par outil et règle de portée des jetons"
```

---

### Task 2: Persistance de la portée

**Files:**
- Modify: `db/schema.ts` (table `apiTokens`, ~ligne 836), migration générée
- Modify: `lib/queries/mcp.ts` (`createApiTokenCore`, `TokenRow`, `listTokensCore`)
- Modify: `lib/validation.ts` (`apiTokenNameSchema`)
- Modify: `lib/actions/mcp-actions.ts` (`createApiToken`)
- Test: `tests/mcp-actions.test.ts` (fichier existant, voie DB)

**Interfaces:**
- Consumes: `McpScope`, `FULL_SCOPE` (Task 1).
- Produces:
  - `apiTokens.canWrite`, `apiTokens.canReadArticles` — `boolean notNull default(true)`.
  - `createApiTokenCore({ userId, name, scope }: { userId: string; name: string; scope: McpScope })` — **`scope` requis**, pas optionnel : le seul appelant est l'action, qui le reçoit du formulaire. Un défaut ici rendrait invisible un appelant qui l'oublie.
  - `TokenRow` gagne `canWrite: boolean; canReadArticles: boolean`.
  - `createApiToken(input: unknown)` — l'action prend désormais un OBJET `{ name, canWrite, canReadArticles }` et non plus une chaîne.
  - `apiTokenSchema` dans `lib/validation.ts` : `{ name, canWrite, canReadArticles }`.

- [ ] **Step 1: Écrire les tests qui échouent**

Ajouter à `tests/mcp-actions.test.ts` (suivre les conventions du fichier : il appelle les fonctions `*Core` directement, sans session) :

```ts
describe("portée d'un jeton", () => {
  it("persiste la portée demandée et la remonte dans la liste", async () => {
    const { tokenId } = await createApiTokenCore({
      userId: USER_ID, name: `Test-Portée-${Date.now()}`,
      scope: { canWrite: false, canReadArticles: false },
    });
    const row = (await listTokensCore({ userId: USER_ID, seesAll: false })).find((t) => t.id === tokenId);
    expect(row?.canWrite).toBe(false);
    expect(row?.canReadArticles).toBe(false);
  });

  it("un jeton créé avec la portée complète a les pouvoirs d'avant les portées", async () => {
    const { tokenId } = await createApiTokenCore({
      userId: USER_ID, name: `Test-Complète-${Date.now()}`, scope: FULL_SCOPE,
    });
    const row = (await listTokensCore({ userId: USER_ID, seesAll: false })).find((t) => t.id === tokenId);
    expect(row?.canWrite).toBe(true);
    expect(row?.canReadArticles).toBe(true);
  });

  it("une ligne écrite sans portée explicite est complète — rétro-compatibilité des jetons déjà émis", async () => {
    // Insertion DIRECTE, sans passer par createApiTokenCore : c'est l'exacte forme des lignes qui
    // existaient avant la migration. Le défaut de colonne est ce qui garantit qu'aucun agent ne casse.
    const t = generateToken();
    const [row] = await db.insert(apiTokens)
      .values({ userId: USER_ID, name: `Test-Ancien-${Date.now()}`, prefix: t.prefix, tokenHash: t.tokenHash })
      .returning();
    expect(row.canWrite).toBe(true);
    expect(row.canReadArticles).toBe(true);
  });
});
```

Reprendre du fichier ses propres helpers de nettoyage : chaque jeton créé ici doit être supprimé en `afterAll`, comme le font les tests existants. Importer `FULL_SCOPE` depuis `@/lib/mcp/scope`, `generateToken` depuis `@/lib/mcp/token`, `db`/`apiTokens` depuis `@/db`, et réutiliser la constante d'utilisateur de test déjà en place dans le fichier plutôt que d'en créer une seconde.

- [ ] **Step 2: Lancer le test et vérifier qu'il échoue**

Run: `bun test tests/mcp-actions.test.ts`
Expected: FAIL — `createApiTokenCore` n'accepte pas `scope`.

- [ ] **Step 3: Colonnes et migration**

Dans `db/schema.ts`, table `apiTokens`, après `tokenHash` :

```ts
  // La portée du JETON, distincte du rôle de son propriétaire (lib/mcp/scope.ts). Défaut `true` des
  // DEUX côtés : c'est ce qui rend la migration rétro-compatible sans réécrire une ligne — un jeton
  // émis avant les portées conserve exactement les pouvoirs qu'il avait.
  canWrite: boolean("can_write").notNull().default(true),
  canReadArticles: boolean("can_read_articles").notNull().default(true),
```

```bash
bun run db:generate
bun run db:migrate
```

Relire le SQL généré : deux `ALTER TABLE "api_tokens" ADD COLUMN … boolean NOT NULL DEFAULT true`.

- [ ] **Step 4: Cœur, validation, action**

`lib/queries/mcp.ts` :

```ts
export async function createApiTokenCore(
  { userId, name, scope }: { userId: string; name: string; scope: McpScope },
): Promise<{ tokenId: string; token: string }> {
  const t = generateToken();
  const [row] = await db.insert(apiTokens)
    .values({
      userId, name, prefix: t.prefix, tokenHash: t.tokenHash,
      canWrite: scope.canWrite, canReadArticles: scope.canReadArticles,
    })
    .returning({ id: apiTokens.id });
  return { tokenId: row.id, token: t.token };
}
```

Ajouter `canWrite: apiTokens.canWrite` et `canReadArticles: apiTokens.canReadArticles` à la projection de `listTokensCore`, et les deux champs à `TokenRow`.

`lib/validation.ts` — remplacer `apiTokenNameSchema` (ligne 445) et son type par un schéma qui porte aussi la portée. La ligne du nom est reprise **telle quelle**, messages compris :

```ts
export const apiTokenSchema = z.object({
  name: z.string().trim().min(1, "Le nom du jeton est requis.").max(120, "Nom trop long (max 120 caractères)."),
  canWrite: z.boolean(),
  canReadArticles: z.boolean(),
});
export type ApiTokenInput = z.infer<typeof apiTokenSchema>;
```

`apiTokenNameSchema` et `ApiTokenNameInput` n'ont qu'un seul appelant, `lib/actions/mcp-actions.ts:27` (vérifié) : les supprimer plutôt que de laisser deux schémas concurrents pour le même formulaire.

`lib/actions/mcp-actions.ts` — `createApiToken` prend un objet :

```ts
export async function createApiToken(
  input: unknown,
): Promise<{ ok: true; tokenId: string; token: string } | { ok: false; message: string }> {
  const { user } = await guard();
  const parsed = apiTokenSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0].message };

  const { tokenId, token } = await createApiTokenCore({
    userId: user.id,
    name: parsed.data.name,
    scope: { canWrite: parsed.data.canWrite, canReadArticles: parsed.data.canReadArticles },
  });
  revalidatePath("/settings/mcp");
  return { ok: true, tokenId, token };
}
```

- [ ] **Step 5: Vérifier**

Run: `bun test tests/mcp-actions.test.ts`
Expected: PASS, nettoyage compris.

Run: `bun run typecheck`
Expected: une erreur attendue dans `components/settings/mcp/token-list.tsx`, qui appelle encore `createApiToken(name)` avec une chaîne. Elle est corrigée à la Task 4 — NE PAS la contourner en rendant les champs optionnels.

- [ ] **Step 6: Commit**

```bash
git add db/schema.ts db/migrations lib/queries/mcp.ts lib/validation.ts lib/actions/mcp-actions.ts tests/mcp-actions.test.ts
git commit -m "feat(mcp): portée persistée à la création d'un jeton"
```

---

### Task 3: Application au dispatch

**Files:**
- Modify: `lib/mcp/auth.ts`
- Modify: `lib/mcp/tools.ts` (`registerTools`)
- Test: `tests/mcp-tools.test.ts` (fichier existant, voie DB, harnais `tests/mcp-harness.ts`)

**Interfaces:**
- Consumes: `refusPourPortee`, `McpScope`, `FULL_SCOPE` (Task 1) ; les colonnes (Task 2).
- Produces: `McpActor` gagne `scope: McpScope`.

- [ ] **Step 1: Écrire les tests qui échouent**

Ajouter à `tests/mcp-tools.test.ts`, en suivant la façon dont le fichier construit déjà ses acteurs et ses appels d'outils (harnais `tests/mcp-harness.ts`, qui transforme une `Error` levée en résultat `isError: true` portant le texte) :

```ts
describe("portée du jeton au dispatch", () => {
  it("un jeton en lecture seule est refusé à l'écriture, avec un message actionnable", async () => {
    const r = await appelerOutil("create_video_project",
      { title: "Test — refus de portée", platform: "youtube_long" },
      { scope: { canWrite: false, canReadArticles: true } });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Ce jeton est en lecture seule.");
  });

  it("le même jeton lit sans encombre", async () => {
    const r = await appelerOutil("list_video_projects", {},
      { scope: { canWrite: false, canReadArticles: true } });
    expect(r.isError).toBeFalsy();
  });

  it("un jeton sans accès aux articles est refusé sur get_article", async () => {
    const r = await appelerOutil("get_article", { articleId: UN_UUID },
      { scope: { canWrite: true, canReadArticles: false } });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Ce jeton n'a pas accès aux articles.");
  });

  it("le même jeton garde le domaine vidéo", async () => {
    const r = await appelerOutil("list_video_categories", {},
      { scope: { canWrite: true, canReadArticles: false } });
    expect(r.isError).toBeFalsy();
  });
});
```

Adapter `appelerOutil` / la construction de l'acteur aux helpers réels du fichier — ne pas inventer une API de test qui n'existe pas. Si les helpers existants ne prennent pas de portée, les étendre avec un défaut `FULL_SCOPE`, de sorte qu'aucun test existant ne change.

- [ ] **Step 2: Lancer le test et vérifier qu'il échoue**

Run: `bun test tests/mcp-tools.test.ts`
Expected: FAIL — la portée n'est ni transportée ni appliquée ; les appels réussissent alors qu'ils devraient être refusés.

- [ ] **Step 3: Transporter la portée**

Dans `lib/mcp/auth.ts` :

```ts
import type { McpScope } from "@/lib/mcp/scope";

export type McpActor = { userId: string; role: Role; tokenId: string; scope: McpScope };
```

et dans la valeur de retour de `authenticateMcp` :

```ts
    actor: {
      userId: row.userId, role: owner.role, tokenId: row.id,
      scope: { canWrite: row.canWrite, canReadArticles: row.canReadArticles },
    },
```

- [ ] **Step 4: Appliquer**

Dans `lib/mcp/tools.ts`, `registerTools` :

```ts
      async (args: Record<string, unknown>) => {
        // Le RÔLE d'abord, la PORTÉE ensuite : la portée d'un jeton ne doit jamais pouvoir accorder
        // ce que le rôle refuse — elle ne fait que retirer (lib/mcp/scope.ts).
        if (spec.kind === "ecriture") requirePermission(actor.role, "video", "manage");
        const refus = refusPourPortee(spec, actor.scope);
        if (refus) throw new Error(refus);
        const payload = await dispatch(spec.name, args, actor);
        return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
      },
```

- [ ] **Step 5: Vérifier**

Run: `bun test tests/mcp-tools.test.ts tests/mcp-scope.test.ts`
Expected: PASS — les nouveaux tests ET les anciens, ces derniers non modifiés (leurs acteurs portent la portée complète par défaut).

Run: `bun run typecheck`
Expected: seule reste l'erreur de `token-list.tsx` (Task 4).

- [ ] **Step 6: Commit**

```bash
git add lib/mcp/auth.ts lib/mcp/tools.ts tests/mcp-tools.test.ts
git commit -m "feat(mcp): appliquer la portée du jeton à chaque appel d'outil"
```

---

### Task 4: Réglages — choisir et voir la portée

**Files:**
- Modify: `components/settings/mcp/token-list.tsx`
- Modify: `components/settings/mcp/tool-catalog.tsx`

**Interfaces:**
- Consumes: `createApiToken({ name, canWrite, canReadArticles })` (Task 2) ; `TokenRow.canWrite` / `.canReadArticles` (Task 2) ; `ToolSpec.domain` (Task 1).
- Produces: rien que d'autres tâches consomment.

- [ ] **Step 1: Les interrupteurs à la création**

Dans `components/settings/mcp/token-list.tsx`, sous le champ du nom, deux interrupteurs **cochés par défaut** — le comportement d'aujourd'hui reste le geste par défaut, la restriction est un choix délibéré. Utiliser `components/ui/switch.tsx` avec un `Label` associé, comme le fait déjà `components/settings/mcp/mcp-switch.tsx` (lire ce fichier pour la forme exacte des props avant d'écrire).

État local à ajouter à côté de `name` :

```tsx
  const [canWrite, setCanWrite] = useState(true);
  const [canReadArticles, setCanReadArticles] = useState(true);
```

Les libellés disent ce que la case RETIRE quand on la décoche — c'est la privation qui surprend, six mois plus tard, quand un agent échoue :

- « Écriture » — aide : « Décoché, ce jeton ne pourra que lire : ni création de projet, ni import de script. »
- « Accès aux articles » — aide : « Décoché, ce jeton ne pourra pas lister ni lire les articles de la rédaction. »

L'appel devient `createApiToken({ name: name.trim(), canWrite, canReadArticles })`, et les deux
interrupteurs se réinitialisent à `true` après une création réussie, comme le champ du nom.

- [ ] **Step 2: La portée dans la liste**

Sur chaque ligne de jeton, afficher la portée **seulement quand elle est restreinte** — un jeton complet n'a rien à signaler, et décorer les lignes ordinaires noierait les lignes intéressantes :

```tsx
  {!token.canWrite && <Badge variant="secondary">Lecture seule</Badge>}
  {!token.canReadArticles && <Badge variant="secondary">Sans articles</Badge>}
```

Les placer près du nom du jeton, avec les indicateurs existants de la ligne (révoqué, etc.). Vérifier
les variantes réellement exposées par `components/ui/badge.tsx` avant de choisir `variant`.

- [ ] **Step 3: Le domaine dans le catalogue d'outils**

Dans `components/settings/mcp/tool-catalog.tsx`, afficher le `domain` de chaque outil à côté de son `kind` déjà rendu. C'est ce qui permet à un administrateur de savoir quels outils un jeton « sans articles » perd, sans lire le code. Suivre exactement la forme de rendu du `kind` existant.

- [ ] **Step 4: Vérifier**

Run: `bun run typecheck`
Expected: PASS — plus aucune erreur en attente.

Run: `bun run test:pure`
Expected: PASS.

Dans le navigateur (outils de prévisualisation, jamais un serveur lancé par Bash) : sur `/settings/mcp`, créer un jeton avec les deux cases cochées (aucun badge dans la liste), puis un jeton « écriture » décochée (badge « Lecture seule »), puis un jeton sans articles (badge « Sans articles »). Vérifier que le catalogue d'outils montre bien le domaine. Révoquer les jetons de test à la fin.

- [ ] **Step 5: Commit**

```bash
git add components/settings/mcp/token-list.tsx components/settings/mcp/tool-catalog.tsx
git commit -m "feat(mcp): choisir la portée d'un jeton et la voir dans la liste"
```

---

### Task 5: Vérification finale

**Files:** aucun (sauf correctifs).

- [ ] **Step 1: Suite complète**

Run: `bun test`
Expected: les seuls échecs sont ceux, préexistants et instables, des familles `pipeline-*`, `reprocess`, `regen-store`, `dashboard-queries`, `satori` (base Neon partagée, pool de jetons OpenRouter vide). Pour chaque échec, vérifier qu'il ne concerne aucun fichier touché par cette branche, et le dire avec la preuve. Ne réparer aucun test préexistant.

- [ ] **Step 2: Typecheck et build**

```bash
bun run typecheck
bun run build
```

- [ ] **Step 3: Preuve de bout en bout de la restriction**

Un test automatisé prouve déjà le refus au dispatch (Task 3). Vérifier en plus, dans le navigateur, qu'un jeton créé en lecture seule s'affiche bien comme tel après un rechargement complet de la page — c'est la seule chose que les tests ne couvrent pas : la portée choisie dans le formulaire est bien celle persistée.

- [ ] **Step 4: État du dépôt**

```bash
git status
```
Expected: propre. **Ne pas pousser** : l'ouverture de la PR revient à l'utilisateur.
