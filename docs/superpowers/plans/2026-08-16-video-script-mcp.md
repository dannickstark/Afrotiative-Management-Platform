# Scripts vidéo — sous-projet 1 bis : serveur MCP & réglages MCP — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Un chat Claude écrit directement dans la console — plus de copier-coller — par un serveur MCP authentifié par jeton, entièrement journalisé, et administré depuis un écran de réglages dédié.

**Architecture:** Une route handler Streamable HTTP (`/api/mcp`) authentifie un jeton porteur, vérifie l'interrupteur global, puis expose des outils qui **délèguent intégralement** au cœur livré au sous-projet 1 (`lib/video/persist.ts`, sans `"use server"`, et `lib/video/import.ts`, pur). Aucune logique de contrat, de fusion ou de persistance n'est réécrite ici. Un registre d'outils unique alimente à la fois le serveur et le catalogue affiché en réglages.

**Tech Stack:** Next.js 16.3 (route handlers Web Standard), `@modelcontextprotocol/sdk` 1.30.0 (`WebStandardStreamableHTTPServerTransport` + `McpServer.registerTool`), Zod 4.4.3, Drizzle 0.45.2 + Postgres/Neon, better-auth 1.6.25, Bun.

**Spec:** `docs/superpowers/specs/2026-08-16-video-script-mcp-design.md`

## Global Constraints

- **Toute la copie d'interface, les commentaires et les messages d'erreur sont en français.**
- **Aucun sous-agent ne pousse quoi que ce soit** : pas de `git push`, pas de PR, pas de publication. Commits locaux uniquement.
- **`@modelcontextprotocol/sdk` doit être déclaré en dépendance directe** dans `package.json` (version `1.30.0`, déjà présente en transitive — s'appuyer sur une transitive est un piège).
- Chemins d'import du SDK : `@modelcontextprotocol/sdk/server/mcp.js` et `@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js`.
- **Le handler MCP n'écrit aucune logique métier** : il appelle `createVideoProjectCore`, `prepareImportCore`, `applyImportCore`, `updateBeatCore`, `reorderBeatsCore`, `updateBeatInsertCore` (`lib/video/persist.ts`) et `parseIncoming` / `computeMerge` / `applyMerge` (`lib/video/import.ts`).
- **L'ordre de verrouillage du SP1 est intangible** : `video_projects` < `script_variants` < `script_journal` < `script_beats` < `beat_inserts`, `FOR UPDATE` sur la variante en tête de toute transaction. Le serveur MCP **n'ouvre aucune transaction propre** ; il délègue au cœur qui les tient déjà.
- **`revert_journal_entry` n'est PAS exposé** en MCP. L'agent avance, seul un humain revient en arrière.
- Un jeton donne les droits de son porteur : `requirePermission(role, "video", "manage")` pour écrire. Aucun jeton ne donne `configure`.
- `lib/mcp/token.ts` et `lib/mcp/registry.ts` restent **purs** (aucun `@/db`, aucun réseau) et tournent dans la lane parallèle. `lib/mcp/auth.ts` et `lib/mcp/tools.ts` touchent la base.
- Chaque fichier de test sans base ni réseau est ajouté à `PURE_FILES` dans `scripts/test-fast.ts`.
- Les server actions suivent le motif de `lib/actions/openrouter-token-actions.ts` : `"use server"`, `requireUser()` + `requirePermission()` au début de **chaque** export, et **jamais** de secret en clair dans une valeur de retour.

---

### Task 1: Schéma — jetons, interrupteur, colonnes de journal

**Files:**
- Modify: `db/schema.ts` (ajouts en fin de fichier + deux colonnes sur des tables existantes)
- Create: `db/migrations/00XX_*.sql` (généré)
- Test: `tests/mcp-schema.test.ts`

**Interfaces:**
- Consumes: `videoSettings`, `scriptJournal`, `user` (tables existantes)
- Produces: table `apiTokens` ; colonne `mcpEnabled` sur `videoSettings` ; colonnes `toolArgs` et `reviewedAt` sur `scriptJournal`

- [ ] **Step 1: Écrire le test qui échoue**

`tests/mcp-schema.test.ts` :

```ts
import { describe, it, expect } from "bun:test";
import { apiTokens, videoSettings, scriptJournal } from "@/db/schema";

describe("schéma MCP", () => {
  it("la table des jetons porte ce qu'il faut pour attribuer et révoquer", () => {
    const cols = Object.keys(apiTokens);
    for (const c of ["userId", "name", "prefix", "tokenHash", "lastUsedAt", "revokedAt"]) {
      expect(cols).toContain(c);
    }
  });

  it("le haché est obligatoire, la révocation est optionnelle", () => {
    expect(apiTokens.tokenHash.notNull).toBe(true);
    expect(apiTokens.revokedAt.notNull).toBe(false);
  });

  it("l'interrupteur global vit dans les réglages vidéo, ouvert par défaut", () => {
    expect(Object.keys(videoSettings)).toContain("mcpEnabled");
    expect(videoSettings.mcpEnabled.notNull).toBe(true);
  });

  it("le journal peut porter les arguments d'outil et la date de relecture", () => {
    const cols = Object.keys(scriptJournal);
    expect(cols).toContain("toolArgs");
    expect(cols).toContain("reviewedAt");
  });
});
```

- [ ] **Step 2: Lancer le test pour vérifier qu'il échoue**

Run: `bun test tests/mcp-schema.test.ts`
Expected: FAIL — `apiTokens` n'est pas exporté par `@/db/schema`.

- [ ] **Step 3: Ajouter la table et les colonnes**

Dans `db/schema.ts`, à la suite des tables du module vidéo :

```ts
// ---- Sous-projet 1 bis : jetons d'API pour le serveur MCP ----
// DÉLIBÉRÉMENT différent de `openrouter_tokens`, qui CHIFFRE ses jetons parce qu'il doit les
// redonner en clair à un fournisseur tiers. Ici, personne n'a jamais besoin du jeton en clair après
// sa création : on n'en garde donc qu'un HACHÉ, et une fuite de base ne donne aucun accès.
export const apiTokens = pgTable("api_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  // Les premiers caractères du jeton, en clair : c'est ce qui permet de RETROUVER la ligne sans
  // parcourir toute la table, et à l'utilisateur de reconnaître son jeton dans la liste.
  prefix: text("prefix").notNull(),
  tokenHash: text("token_hash").notNull(),
  lastUsedAt: timestamp("last_used_at"),
  // Révocation DOUCE : la ligne survit, donc l'historique du journal continue de nommer la personne
  // qui a écrit. Une suppression dure ferait perdre cette attribution rétroactivement.
  revokedAt: timestamp("revoked_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("api_tokens_prefix_uq").on(t.prefix),
  index("api_tokens_user_idx").on(t.userId),
]);
```

Ajouter à `videoSettings` :

```ts
  // Interrupteur global du serveur MCP. Ouvert par défaut : le module n'a d'intérêt que branché.
  // Sa raison d'être est l'urgence — couper tous les agents d'un geste sans révoquer, puis
  // recréer, les jetons un par un.
  mcpEnabled: boolean("mcp_enabled").notNull().default(true),
```

Ajouter à `scriptJournal` :

```ts
  // Les arguments exacts reçus par l'outil MCP. Quand un agent se comporte mal, c'est la seule
  // façon de reconstituer ce qu'il a réellement demandé.
  toolArgs: jsonb("tool_args").$type<Record<string, unknown>>(),
  // Posé quand un humain ouvre le projet après une écriture d'agent. `null` = non relue.
  // Sans cette colonne, « non relue » serait une intention plutôt qu'un état.
  reviewedAt: timestamp("reviewed_at"),
```

- [ ] **Step 4: Lancer le test et vérifier qu'il passe**

Run: `bun test tests/mcp-schema.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Générer et appliquer la migration**

Run: `bun run db:generate` puis `bun run db:migrate` puis `bun run typecheck`
Expected: migration additive (1 `CREATE TABLE`, 3 `ALTER TABLE ... ADD COLUMN`), typecheck sans erreur.

- [ ] **Step 6: Inscrire le test dans la lane pure et commiter**

```bash
# ajouter "mcp-schema.test.ts" à PURE_FILES dans scripts/test-fast.ts
bun run test:pure
git add db/schema.ts db/migrations tests/mcp-schema.test.ts scripts/test-fast.ts
git commit -m "feat(mcp): table des jetons d'API, interrupteur global, colonnes de journal"
```

---

### Task 2: Jetons — génération et hachage (pur)

**Files:**
- Create: `lib/mcp/token.ts`
- Test: `tests/mcp-token.test.ts`

**Interfaces:**
- Consumes: `safeEqual` de `@/lib/timing-safe`
- Produces:
  - `TOKEN_NAMESPACE = "afro_vid_"`, `PREFIX_LENGTH = 15`
  - `generateToken(): { token: string; prefix: string; tokenHash: string }`
  - `hashToken(token: string): string`
  - `prefixOf(token: string): string | null`
  - `tokenMatches(token: string, storedHash: string): boolean`

- [ ] **Step 1: Écrire le test qui échoue**

`tests/mcp-token.test.ts` :

```ts
import { describe, it, expect } from "bun:test";
import {
  generateToken, hashToken, prefixOf, tokenMatches, TOKEN_NAMESPACE, PREFIX_LENGTH,
} from "@/lib/mcp/token";

describe("generateToken", () => {
  it("produit un jeton reconnaissable à l'œil", () => {
    const { token } = generateToken();
    expect(token.startsWith(TOKEN_NAMESPACE)).toBe(true);
    // Le point : un jeton qui fuit dans un dépôt ou un journal doit être identifiable comme tel.
    expect(token.length).toBeGreaterThan(40);
  });

  it("le préfixe rendu correspond au début du jeton", () => {
    const { token, prefix } = generateToken();
    expect(prefix).toBe(token.slice(0, PREFIX_LENGTH));
    expect(prefix.length).toBe(PREFIX_LENGTH);
  });

  it("le haché rendu est celui du jeton", () => {
    const { token, tokenHash } = generateToken();
    expect(tokenHash).toBe(hashToken(token));
  });

  it("le haché ne contient pas le jeton", () => {
    const { token, tokenHash } = generateToken();
    expect(tokenHash).not.toContain(token.slice(TOKEN_NAMESPACE.length));
  });

  it("deux appels ne produisent jamais le même jeton", () => {
    const a = new Set(Array.from({ length: 200 }, () => generateToken().token));
    expect(a.size).toBe(200);
  });

  it("n'utilise que des caractères sûrs en URL et en en-tête HTTP", () => {
    const { token } = generateToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("prefixOf", () => {
  it("extrait le préfixe d'un jeton bien formé", () => {
    const { token, prefix } = generateToken();
    expect(prefixOf(token)).toBe(prefix);
  });

  it("refuse un jeton d'un autre espace de noms", () => {
    expect(prefixOf("sk-quelque-chose-de-tres-long-mais-etranger")).toBeNull();
  });

  it("refuse un jeton trop court pour porter un préfixe", () => {
    expect(prefixOf("afro_vid_")).toBeNull();
  });
});

describe("tokenMatches", () => {
  it("reconnaît le bon jeton", () => {
    const { token, tokenHash } = generateToken();
    expect(tokenMatches(token, tokenHash)).toBe(true);
  });

  it("refuse un autre jeton", () => {
    const { tokenHash } = generateToken();
    expect(tokenMatches(generateToken().token, tokenHash)).toBe(false);
  });

  it("refuse un haché vide ou tronqué sans lever", () => {
    const { token } = generateToken();
    expect(tokenMatches(token, "")).toBe(false);
    expect(tokenMatches(token, "abcd")).toBe(false);
  });
});
```

- [ ] **Step 2: Lancer le test pour vérifier qu'il échoue**

Run: `bun test tests/mcp-token.test.ts`
Expected: FAIL — module introuvable.

- [ ] **Step 3: Implémenter**

`lib/mcp/token.ts` :

```ts
import { createHash, randomBytes } from "node:crypto";
import { safeEqual } from "@/lib/timing-safe";

// Module PUR : ni base, ni réseau. Le jeton est un secret À HAUTE ENTROPIE (32 octets aléatoires),
// pas un mot de passe : SHA-256 est le bon outil ici, et bcrypt/argon2 seraient un contresens
// (ils protègent contre la force brute d'un secret DEVINABLE, ce qu'un aléa de 256 bits n'est pas).
export const TOKEN_NAMESPACE = "afro_vid_";
// namespace (9) + 6 caractères aléatoires : assez pour reconnaître un jeton dans une liste, trop
// peu pour aider qui que ce soit à le reconstituer.
export const PREFIX_LENGTH = TOKEN_NAMESPACE.length + 6;

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function generateToken(): { token: string; prefix: string; tokenHash: string } {
  const token = TOKEN_NAMESPACE + randomBytes(32).toString("base64url");
  return { token, prefix: token.slice(0, PREFIX_LENGTH), tokenHash: hashToken(token) };
}

/**
 * Le préfixe sert à retrouver UNE ligne candidate au lieu de parcourir la table. Renvoie `null`
 * pour tout ce qui ne peut pas être un de nos jetons — on évite ainsi une requête inutile sur un
 * en-tête `Authorization` qui appartient à quelqu'un d'autre.
 */
export function prefixOf(token: string): string | null {
  if (!token.startsWith(TOKEN_NAMESPACE)) return null;
  if (token.length <= PREFIX_LENGTH) return null;
  return token.slice(0, PREFIX_LENGTH);
}

/**
 * Comparaison à TEMPS CONSTANT via safeEqual : un `===` sur les hachés court-circuite au premier
 * octet différent et laisse fuir, par le temps de réponse, combien d'octets de tête un candidat a
 * devinés. Même précaution que les deux secrets de cron (lib/timing-safe.ts).
 */
export function tokenMatches(token: string, storedHash: string): boolean {
  if (!storedHash) return false;
  return safeEqual(hashToken(token), storedHash);
}
```

- [ ] **Step 4: Lancer le test et vérifier qu'il passe**

Run: `bun test tests/mcp-token.test.ts`
Expected: PASS (12 tests)

- [ ] **Step 5: Inscrire dans la lane pure et commiter**

```bash
# ajouter "mcp-token.test.ts" à PURE_FILES dans scripts/test-fast.ts
bun run test:pure
git add lib/mcp/token.ts tests/mcp-token.test.ts scripts/test-fast.ts
git commit -m "feat(mcp): génération et vérification des jetons d'API"
```

---

### Task 3: Registre d'outils (pur)

**Files:**
- Create: `lib/mcp/registry.ts`
- Test: `tests/mcp-registry.test.ts`

**Interfaces:**
- Consumes: `payloadSchema`, `PLATFORMS`, `RATIOS`, `BEAT_KINDS` de `@/lib/video/schema`
- Produces:
  - `type ToolKind = "lecture" | "ecriture"`
  - `type ToolSpec = { name: string; kind: ToolKind; description: string; inputSchema: z.ZodRawShape }`
  - `TOOL_REGISTRY: readonly ToolSpec[]`
  - `toolByName(name: string): ToolSpec | undefined`

Le registre est la **source unique** dont dépendent le serveur (Task 5) et le catalogue affiché en réglages (Task 7). Un outil ajouté à l'un sans l'autre serait un pouvoir accordé en silence — un test le fait échouer.

- [ ] **Step 1: Écrire le test qui échoue**

`tests/mcp-registry.test.ts` :

```ts
import { describe, it, expect } from "bun:test";
import { TOOL_REGISTRY, toolByName } from "@/lib/mcp/registry";

const EXPECTED = [
  "list_video_projects", "get_script", "get_video_brief", "list_articles", "get_article",
  "create_video_project", "submit_script", "apply_script",
  "update_beat", "reorder_beats", "update_insert",
];

describe("registre d'outils MCP", () => {
  it("expose exactement les outils prévus par le spec", () => {
    expect(TOOL_REGISTRY.map((t) => t.name).sort()).toEqual([...EXPECTED].sort());
  });

  it("n'expose PAS l'annulation — seul un humain revient en arrière", () => {
    expect(toolByName("revert_journal_entry")).toBeUndefined();
    expect(TOOL_REGISTRY.some((t) => t.name.includes("revert"))).toBe(false);
  });

  it("n'expose aucun outil touchant aux réglages", () => {
    expect(TOOL_REGISTRY.some((t) => /setting|reglage|token|jeton/i.test(t.name))).toBe(false);
  });

  it("classe chaque outil en lecture ou en écriture", () => {
    for (const t of TOOL_REGISTRY) expect(["lecture", "ecriture"]).toContain(t.kind);
  });

  it("les cinq outils de lecture sont bien classés en lecture", () => {
    const lecture = TOOL_REGISTRY.filter((t) => t.kind === "lecture").map((t) => t.name).sort();
    expect(lecture).toEqual([
      "get_article", "get_script", "get_video_brief", "list_articles", "list_video_projects",
    ]);
  });

  it("chaque outil porte une description en français, utile et non vide", () => {
    for (const t of TOOL_REGISTRY) {
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.description).not.toMatch(/^[A-Z][a-z]+ the /); // pas d'anglais laissé passer
    }
  });

  it("chaque nom est unique", () => {
    expect(new Set(TOOL_REGISTRY.map((t) => t.name)).size).toBe(TOOL_REGISTRY.length);
  });

  it("chaque outil a un schéma d'entrée", () => {
    for (const t of TOOL_REGISTRY) expect(typeof t.inputSchema).toBe("object");
  });

  it("toolByName retrouve un outil et rejette l'inconnu", () => {
    expect(toolByName("submit_script")?.kind).toBe("ecriture");
    expect(toolByName("inexistant")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Lancer le test pour vérifier qu'il échoue**

Run: `bun test tests/mcp-registry.test.ts`
Expected: FAIL — module introuvable.

- [ ] **Step 3: Implémenter**

`lib/mcp/registry.ts` :

```ts
import { z } from "zod";
import { payloadSchema, PLATFORMS, RATIOS, BEAT_KINDS } from "@/lib/video/schema";

// LE registre. Le serveur (app/api/mcp/route.ts) enregistre ce qu'il contient, et l'écran de
// réglages affiche ce qu'il contient. Un outil ajouté à l'un sans l'autre serait un pouvoir accordé
// en silence — c'est pourquoi les deux dérivent d'ici et qu'un test vérifie leur correspondance.
export type ToolKind = "lecture" | "ecriture";
export type ToolSpec = {
  name: string;
  kind: ToolKind;
  description: string;
  inputSchema: z.ZodRawShape;
};

const uuid = z.string().uuid();

export const TOOL_REGISTRY: readonly ToolSpec[] = [
  {
    name: "list_video_projects",
    kind: "lecture",
    description: "Liste les espaces vidéo existants : titre, statut, plateformes et durée estimée.",
    inputSchema: {},
  },
  {
    name: "get_script",
    kind: "lecture",
    description:
      "Renvoie l'état actuel des beats d'une variante. À appeler avant toute révision : c'est ce qui permet de corriger un script plutôt que de le réécrire entièrement.",
    inputSchema: { variantId: uuid },
  },
  {
    name: "get_video_brief",
    kind: "lecture",
    description:
      "Renvoie le brief d'un projet : le style maison de la rédaction et le contrat JSON attendu en réponse.",
    inputSchema: { projectId: uuid },
  },
  {
    name: "list_articles",
    kind: "lecture",
    description: "Liste les articles approuvés ou publiés, pour partir d'un sujet déjà sourcé.",
    inputSchema: { search: z.string().max(200).optional(), limit: z.number().int().min(1).max(50).optional() },
  },
  {
    name: "get_article",
    kind: "lecture",
    description: "Renvoie le titre, le chapô, le corps et les sources d'un article.",
    inputSchema: { articleId: uuid },
  },
  {
    name: "create_video_project",
    kind: "ecriture",
    description:
      "Crée un espace vidéo et renvoie son brief dans la même réponse. Une variante par défaut est créée avec la plateforme, la durée cible et le cadrage donnés.",
    inputSchema: {
      title: z.string().min(1).max(200),
      subject: z.string().max(2000).optional(),
      platform: z.enum(PLATFORMS),
      targetDurationSec: z.number().int().min(5).max(14400).optional(),
      aspectRatio: z.enum(RATIOS).optional(),
      articleId: uuid.optional(),
    },
  },
  {
    name: "submit_script",
    kind: "ecriture",
    description:
      "Valide un script au format du contrat et prépare son import. Renvoie soit le diff de ce qui changerait, soit le rapport d'erreurs — chemin, message et valeur reçue — pour que tu corriges et resoumettes.",
    inputSchema: { projectId: uuid, variantId: uuid.optional(), payload: payloadSchema },
  },
  {
    name: "apply_script",
    kind: "ecriture",
    description:
      "Applique un import préparé. Sans sélection explicite, applique les ajouts et les modifications, jamais les suppressions ni les conflits — ceux-là doivent être demandés nommément.",
    inputSchema: { journalId: uuid, variantId: uuid, accept: z.array(z.string()).optional() },
  },
  {
    name: "update_beat",
    kind: "ecriture",
    description: "Retouche un beat : texte parlé, note de réalisation, texte à l'écran, transitions.",
    inputSchema: {
      beatId: uuid,
      spokenText: z.string().max(20000).optional(),
      directionNote: z.string().max(1000).nullable().optional(),
      screenText: z.string().max(300).nullable().optional(),
      transitionIn: z.string().max(120).nullable().optional(),
      transitionOut: z.string().max(120).nullable().optional(),
      kind: z.enum(BEAT_KINDS).optional(),
    },
  },
  {
    name: "reorder_beats",
    kind: "ecriture",
    description: "Réordonne les beats d'une variante, sans réécrire le script.",
    inputSchema: { variantId: uuid, order: z.array(uuid).min(1) },
  },
  {
    name: "update_insert",
    kind: "ecriture",
    description:
      "Corrige l'URL d'un insert. Le lien repasse à « non vérifié » : une URL changée à la main n'a jamais été contrôlée.",
    inputSchema: { insertId: uuid, url: z.string().nullable() },
  },
] as const;

export function toolByName(name: string): ToolSpec | undefined {
  return TOOL_REGISTRY.find((t) => t.name === name);
}
```

- [ ] **Step 4: Lancer le test et vérifier qu'il passe**

Run: `bun test tests/mcp-registry.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Inscrire dans la lane pure et commiter**

```bash
# ajouter "mcp-registry.test.ts" à PURE_FILES dans scripts/test-fast.ts
bun run test:pure
git add lib/mcp/registry.ts tests/mcp-registry.test.ts scripts/test-fast.ts
git commit -m "feat(mcp): registre des outils exposés, source unique du serveur et du catalogue"
```

---

### Task 4: Authentification et interrupteur (base)

**Files:**
- Create: `lib/mcp/auth.ts`
- Test: `tests/mcp-auth.test.ts` (**lane DB** — ne PAS ajouter à `PURE_FILES`)

**Interfaces:**
- Consumes: `prefixOf`, `tokenMatches` de `@/lib/mcp/token` ; `isSessionUsable` de `@/lib/session` ; `getVideoSettings` de `@/lib/queries/video-settings`
- Produces:
  - `type McpActor = { userId: string; role: Role; tokenId: string }`
  - `type AuthOutcome = { ok: true; actor: McpActor } | { ok: false; status: 401 | 403 | 503; message: string }`
  - `authenticateMcp(authorizationHeader: string | null): Promise<AuthOutcome>`

Comportement imposé :
- **L'interrupteur se vérifie AVANT le jeton** et renvoie 503. Inutile de faire travailler l'authentification quand la porte est close, et l'agent reçoit une cause actionnable plutôt qu'un 401 trompeur.
- Un jeton absent, malformé, inconnu, révoqué, ou dont le porteur est banni renvoie **le même** 401 et **le même** message. Distinguer « inconnu » de « révoqué » serait un oracle.
- `lastUsedAt` est mis à jour à chaque appel réussi.

- [ ] **Step 1: Écrire le test qui échoue**

`tests/mcp-auth.test.ts` :

```ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { db, apiTokens, videoSettings } from "@/db";
import { eq } from "drizzle-orm";
import { generateToken } from "@/lib/mcp/token";
import { authenticateMcp } from "@/lib/mcp/auth";

let tokenId: string;
let plain: string;
let userId: string;

beforeAll(async () => {
  const users = await db.query.user.findMany({ limit: 1 });
  userId = users[0].id;
  const t = generateToken();
  plain = t.token;
  const [row] = await db.insert(apiTokens)
    .values({ userId, name: "Test MCP", prefix: t.prefix, tokenHash: t.tokenHash })
    .returning();
  tokenId = row.id;
});

afterAll(async () => {
  await db.delete(apiTokens).where(eq(apiTokens.id, tokenId));
  const [s] = await db.select().from(videoSettings).limit(1);
  if (s) await db.update(videoSettings).set({ mcpEnabled: true }).where(eq(videoSettings.id, s.id));
});

describe("authenticateMcp", () => {
  it("accepte un jeton valide et rend son porteur", async () => {
    const r = await authenticateMcp(`Bearer ${plain}`);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.actor.userId).toBe(userId);
      expect(r.actor.tokenId).toBe(tokenId);
    }
  });

  it("met à jour la date de dernière utilisation", async () => {
    await authenticateMcp(`Bearer ${plain}`);
    const [row] = await db.select().from(apiTokens).where(eq(apiTokens.id, tokenId));
    expect(row.lastUsedAt).not.toBeNull();
  });

  it("refuse un en-tête absent", async () => {
    const r = await authenticateMcp(null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });

  it("refuse un jeton d'un autre espace de noms sans toucher la base", async () => {
    const r = await authenticateMcp("Bearer sk-quelque-chose-etranger-et-long");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });

  it("donne le MÊME message pour un jeton inconnu et pour un jeton révoqué", async () => {
    const inconnu = await authenticateMcp(`Bearer ${generateToken().token}`);
    await db.update(apiTokens).set({ revokedAt: new Date() }).where(eq(apiTokens.id, tokenId));
    const revoque = await authenticateMcp(`Bearer ${plain}`);
    await db.update(apiTokens).set({ revokedAt: null }).where(eq(apiTokens.id, tokenId));

    expect(inconnu.ok).toBe(false);
    expect(revoque.ok).toBe(false);
    // Le point : distinguer les deux dirait à un attaquant que son jeton a EXISTÉ.
    if (!inconnu.ok && !revoque.ok) expect(revoque.message).toBe(inconnu.message);
  });

  it("refuse tout, avec 503, quand l'interrupteur est fermé — même un jeton parfaitement valide", async () => {
    const [s] = await db.select().from(videoSettings).limit(1);
    await db.update(videoSettings).set({ mcpEnabled: false }).where(eq(videoSettings.id, s.id));
    const r = await authenticateMcp(`Bearer ${plain}`);
    await db.update(videoSettings).set({ mcpEnabled: true }).where(eq(videoSettings.id, s.id));

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(503);
      expect(r.message).toContain("désactivé");
    }
  });
});
```

- [ ] **Step 2: Lancer le test pour vérifier qu'il échoue**

Run: `bun test tests/mcp-auth.test.ts`
Expected: FAIL — `@/lib/mcp/auth` n'existe pas.

- [ ] **Step 3: Implémenter**

`lib/mcp/auth.ts` :

```ts
import { eq } from "drizzle-orm";
import { db, apiTokens, user as userTable } from "@/db";
import { prefixOf, tokenMatches } from "@/lib/mcp/token";
import { isSessionUsable } from "@/lib/session";
import { getVideoSettings } from "@/lib/queries/video-settings";
import type { Role } from "@/lib/auth";

export type McpActor = { userId: string; role: Role; tokenId: string };
export type AuthOutcome =
  | { ok: true; actor: McpActor }
  | { ok: false; status: 401 | 403 | 503; message: string };

// UN SEUL message pour tous les échecs d'authentification. Distinguer « jeton inconnu » de
// « jeton révoqué » dirait à un attaquant que son jeton a EXISTÉ — c'est un oracle, et il ne coûte
// rien à supprimer.
const REJECT = "Jeton d'API invalide ou révoqué.";

export async function authenticateMcp(authorizationHeader: string | null): Promise<AuthOutcome> {
  // L'interrupteur AVANT le jeton : inutile de faire travailler l'authentification quand la porte
  // est close, et l'agent reçoit une cause actionnable plutôt qu'un 401 trompeur.
  const settings = await getVideoSettings();
  if (!settings.mcpEnabled) {
    return { ok: false, status: 503, message: "Le serveur MCP est désactivé dans les réglages." };
  }

  const raw = authorizationHeader?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!raw) return { ok: false, status: 401, message: REJECT };

  // Un en-tête d'un autre espace de noms n'atteint jamais la base : on économise une requête sur
  // chaque sonde automatisée qui passe.
  const prefix = prefixOf(raw);
  if (!prefix) return { ok: false, status: 401, message: REJECT };

  const [row] = await db.select().from(apiTokens).where(eq(apiTokens.prefix, prefix)).limit(1);
  if (!row) return { ok: false, status: 401, message: REJECT };
  if (row.revokedAt) return { ok: false, status: 401, message: REJECT };
  if (!tokenMatches(raw, row.tokenHash)) return { ok: false, status: 401, message: REJECT };

  const [owner] = await db.select().from(userTable).where(eq(userTable.id, row.userId)).limit(1);
  if (!owner || !isSessionUsable(owner as { banned: boolean })) {
    return { ok: false, status: 401, message: REJECT };
  }

  await db.update(apiTokens).set({ lastUsedAt: new Date() }).where(eq(apiTokens.id, row.id));

  return {
    ok: true,
    actor: { userId: row.userId, role: (owner as { role: Role }).role, tokenId: row.id },
  };
}
```

- [ ] **Step 4: Lancer le test et vérifier qu'il passe**

Run: `bun test tests/mcp-auth.test.ts && bun run typecheck`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/mcp/auth.ts tests/mcp-auth.test.ts
git commit -m "feat(mcp): authentification par jeton porteur et garde de l'interrupteur"
```

---

### Task 5: Outils et route handler

**Files:**
- Create: `lib/mcp/tools.ts`, `app/api/mcp/route.ts`
- Modify: `package.json` (déclarer le SDK)
- Test: `tests/mcp-tools.test.ts` (**lane DB**)

**Interfaces:**
- Consumes: `TOOL_REGISTRY` (Task 3), `authenticateMcp` (Task 4), et le cœur du SP1 : `createVideoProjectCore`, `prepareImportCore`, `applyImportCore`, `updateBeatCore`, `reorderBeatsCore`, `updateBeatInsertCore` (`lib/video/persist.ts`) ; `buildBrief` (`lib/video/brief.ts`) ; `listVideoProjects`, `getVariantBeats` (`lib/queries/video.ts`)
- Produces: `registerTools(server: McpServer, actor: McpActor): void` (`lib/mcp/tools.ts`)

Comportement imposé :
- Chaque outil d'écriture appelle `requirePermission(actor.role, "video", "manage")` **avant** d'agir.
- Chaque écriture journalise `source: "mcp"`, `toolName`, `toolArgs`, `actorUserId`.
- `apply_script` sans `accept` calcule la sélection par défaut du produit : ajouts + modifications, **jamais** suppressions ni conflits.
- Les erreurs de `parseIncoming` remontent **telles quelles** (`path`, `message`, `received`) : c'est ce qui rend la boucle de correction utilisable.
- Un refus métier du cœur (péremption, entrée déjà appliquée) remonte avec son message français.

- [ ] **Step 1: Écrire le test qui échoue**

`tests/mcp-tools.test.ts` — teste les outils **via `registerTools`** sur un `McpServer` en mémoire, sans transport HTTP :

```ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { db, videoProjects, scriptVariants, scriptBeats, scriptJournal } from "@/db";
import { eq } from "drizzle-orm";
import { EXAMPLE_PAYLOAD } from "@/lib/video/schema";
import { callTool, makeActor, cleanupProject } from "./mcp-harness";

let projectId: string;
let actor: Awaited<ReturnType<typeof makeActor>>;

beforeAll(async () => { actor = await makeActor("editor"); });
afterAll(async () => { await cleanupProject(projectId); await actor.cleanup(); });

describe("outils MCP", () => {
  it("create_video_project crée l'espace ET renvoie le brief", async () => {
    const r = await callTool(actor, "create_video_project", {
      title: "Test MCP — Babadampulu", platform: "youtube_long", targetDurationSec: 720,
    });
    expect(r.projectId).toBeString();
    expect(r.brief).toContain("schema_version");
    projectId = r.projectId;
    const variants = await db.select().from(scriptVariants).where(eq(scriptVariants.projectId, projectId));
    expect(variants).toHaveLength(1);
  });

  it("submit_script renvoie le diff pour un payload valide", async () => {
    const r = await callTool(actor, "submit_script", { projectId, payload: EXAMPLE_PAYLOAD });
    expect(r.diff.added.length).toBeGreaterThan(0);
    expect(r.journalId).toBeString();
  });

  it("submit_script renvoie les erreurs AVEC leur chemin, pour que l'agent se corrige", async () => {
    const bad = structuredClone(EXAMPLE_PAYLOAD);
    bad.variantes[0].beats[0].type = "bviroll" as never;
    const r = await callTool(actor, "submit_script", { projectId, payload: bad });
    expect(r.ok).toBe(false);
    expect(r.issues[0].path).toContain("beats[0].type");
    expect(r.issues[0].received).toBe("bviroll");
  });

  it("apply_script sans sélection n'applique ni suppression ni conflit", async () => {
    const prep = await callTool(actor, "submit_script", { projectId, payload: EXAMPLE_PAYLOAD });
    const variantId = prep.variantId;
    await callTool(actor, "apply_script", { journalId: prep.journalId, variantId });

    const reduced = structuredClone(EXAMPLE_PAYLOAD);
    reduced.variantes[0].beats.pop(); // un beat disparaît → suppression proposée
    const prep2 = await callTool(actor, "submit_script", { projectId, payload: reduced });
    expect(prep2.diff.removed.length).toBe(1);
    await callTool(actor, "apply_script", { journalId: prep2.journalId, variantId });

    const beats = await db.select().from(scriptBeats).where(eq(scriptBeats.variantId, variantId));
    // Le point : la suppression a été PROPOSÉE, jamais appliquée sans demande nommée.
    expect(beats.length).toBe(EXAMPLE_PAYLOAD.variantes[0].beats.length);
  });

  it("chaque écriture est journalisée avec sa source, son outil et son auteur", async () => {
    const rows = await db.select().from(scriptJournal).where(eq(scriptJournal.projectId, projectId));
    const mcp = rows.filter((r) => r.source === "mcp");
    expect(mcp.length).toBeGreaterThan(0);
    expect(mcp[0].toolName).toBeString();
    expect(mcp[0].actorUserId).toBe(actor.userId);
    expect(mcp[0].toolArgs).not.toBeNull();
  });

  it("une application par agent reste « non relue »", async () => {
    const rows = await db.select().from(scriptJournal).where(eq(scriptJournal.projectId, projectId));
    const applied = rows.filter((r) => r.source === "mcp" && r.outcome === "applique");
    expect(applied.length).toBeGreaterThan(0);
    expect(applied.every((r) => r.reviewedAt === null)).toBe(true);
  });

  it("un porteur sans droit d'écriture est refusé", async () => {
    const lecteur = await makeActor("journalist", { revokeVideoManage: true });
    await expect(callTool(lecteur, "update_beat", { beatId: crypto.randomUUID(), spokenText: "x" }))
      .rejects.toThrow();
    await lecteur.cleanup();
  });

  it("l'annulation n'est pas exposée", async () => {
    await expect(callTool(actor, "revert_journal_entry", { journalId: crypto.randomUUID() }))
      .rejects.toThrow();
  });
});
```

Crée aussi `tests/mcp-harness.ts` (non-test) : `makeActor(role, opts?)` insère un utilisateur de test et son jeton et renvoie `{ userId, role, tokenId, cleanup }` ; `callTool(actor, name, args)` construit un `McpServer`, appelle `registerTools(server, actor)`, invoque l'outil et renvoie sa charge utile désérialisée ; `cleanupProject(id)` supprime le projet (les cascades font le reste).

- [ ] **Step 2: Lancer le test pour vérifier qu'il échoue**

Run: `bun test tests/mcp-tools.test.ts`
Expected: FAIL — `@/lib/mcp/tools` n'existe pas.

- [ ] **Step 3: Déclarer le SDK et implémenter les outils**

```bash
bun add @modelcontextprotocol/sdk@1.30.0
```

`lib/mcp/tools.ts` :

```ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TOOL_REGISTRY, toolByName } from "@/lib/mcp/registry";
import { requirePermission } from "@/lib/rbac";
import type { McpActor } from "@/lib/mcp/auth";

// Ce module ne contient AUCUNE logique de contrat, de fusion ni de persistance : il traduit un
// appel d'outil en appel du cœur du SP1, et rien d'autre. C'est la raison pour laquelle
// lib/video/persist.ts n'a jamais reçu de directive "use server".
export function registerTools(server: McpServer, actor: McpActor): void {
  for (const spec of TOOL_REGISTRY) {
    server.registerTool(
      spec.name,
      { title: spec.name, description: spec.description, inputSchema: spec.inputSchema },
      async (args: Record<string, unknown>) => {
        if (spec.kind === "ecriture") requirePermission(actor.role, "video", "manage");
        const payload = await dispatch(spec.name, args, actor);
        return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
      },
    );
  }
}
```

`dispatch` est un `switch` sur le nom, chaque branche appelant la fonction du cœur correspondante et
journalisant les écritures avec `source: "mcp"`, `toolName`, `toolArgs`, `actorUserId`.

`app/api/mcp/route.ts` :

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { authenticateMcp } from "@/lib/mcp/auth";
import { registerTools } from "@/lib/mcp/tools";

export const runtime = "nodejs";

// Sans état entre requêtes (pas de `sessionIdGenerator`) : chaque appel s'authentifie, agit et
// journalise. Rien à maintenir côté serveur — c'est aussi ce qui rendra le passage à OAuth
// (SP1 ter) indolore, la porte d'entrée étant le seul élément à changer.
async function handle(req: Request): Promise<Response> {
  const auth = await authenticateMcp(req.headers.get("authorization"));
  if (!auth.ok) {
    return Response.json({ error: auth.message }, { status: auth.status });
  }
  const server = new McpServer({ name: "afrotiative-video", version: "1.0.0" });
  registerTools(server, auth.actor);
  const transport = new WebStandardStreamableHTTPServerTransport({});
  await server.connect(transport);
  return transport.handleRequest(req);
}

export { handle as GET, handle as POST, handle as DELETE };
```

- [ ] **Step 4: Lancer le test et vérifier qu'il passe**

Run: `bun test tests/mcp-tools.test.ts && bun run typecheck`
Expected: PASS (8 tests)

- [ ] **Step 5: Vérifier la route de bout en bout**

Démarrer `bun run dev`, puis avec un jeton créé à la main en base :

```bash
curl -s -X POST http://localhost:3000/api/mcp -H "Authorization: Bearer <jeton>" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | head -40
```

Attendu : les 11 outils listés. Puis sans en-tête `Authorization` : `401`. Puis avec `mcpEnabled` à `false` en base : `503`.

- [ ] **Step 6: Commit**

```bash
git add package.json bun.lock lib/mcp/tools.ts app/api/mcp tests/mcp-tools.test.ts tests/mcp-harness.ts
git commit -m "feat(mcp): serveur Streamable HTTP et outils délégant au cœur du module vidéo"
```

---

### Task 6: Requêtes et actions de réglages

**Files:**
- Create: `lib/queries/mcp.ts`, `lib/actions/mcp-actions.ts`
- Modify: `lib/validation.ts`
- Test: `tests/mcp-actions.test.ts` (**lane DB**)

**Interfaces:**
- Consumes: `generateToken` (Task 2), `apiTokens`, `videoSettings`, `scriptJournal`
- Produces, dans `lib/queries/mcp.ts` (**sans** `"use server"`, appelable par les tests) :
  - `createApiTokenCore({ userId, name }): Promise<{ tokenId: string; token: string }>` — le seul endroit où le jeton en clair existe
  - `listTokensCore({ userId, seesAll }): Promise<TokenRow[]>` où `TokenRow = { id, userId, name, prefix, lastUsedAt, revokedAt, createdAt }` — **jamais** `tokenHash`
  - `revokeApiTokenCore({ tokenId, userId, seesAll }): Promise<{ ok: boolean; message?: string }>`
  - `setMcpEnabledCore({ enabled, userId }): Promise<void>`
  - `recentAgentActivityCore(limit): Promise<ActivityRow[]>` — journal filtré `source: "mcp"`
- Produits dans `lib/actions/mcp-actions.ts` (`"use server"`, gardés) : `createApiToken`, `revokeApiToken`, `setMcpEnabled`, chacun résolvant `seesAll = can(role, "video", "configure")`

Comportement imposé :
- `createApiToken` est le **seul** endroit où le jeton en clair existe ; il n'est ni journalisé, ni relu.
- Un membre ne peut révoquer que ses propres jetons ; `video:configure` peut révoquer ceux de l'équipe.
- `setMcpEnabled` exige `video:configure` et journalise qui a basculé, et quand.

- [ ] **Step 1: Écrire le test qui échoue**

`tests/mcp-actions.test.ts` :

```ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { db, apiTokens, videoSettings } from "@/db";
import { eq } from "drizzle-orm";
import { createApiTokenCore, revokeApiTokenCore, setMcpEnabledCore, listTokensCore } from "@/lib/queries/mcp";
import { authenticateMcp } from "@/lib/mcp/auth";
import { makeUser } from "./mcp-harness";

let editor: Awaited<ReturnType<typeof makeUser>>;
let journalist: Awaited<ReturnType<typeof makeUser>>;
const created: string[] = [];

beforeAll(async () => {
  editor = await makeUser("editor");
  journalist = await makeUser("journalist");
});

afterAll(async () => {
  for (const id of created) await db.delete(apiTokens).where(eq(apiTokens.id, id));
  const [s] = await db.select().from(videoSettings).limit(1);
  if (s) await db.update(videoSettings).set({ mcpEnabled: true }).where(eq(videoSettings.id, s.id));
  await editor.cleanup();
  await journalist.cleanup();
});

describe("createApiTokenCore", () => {
  it("rend un jeton utilisable, une seule fois", async () => {
    const r = await createApiTokenCore({ userId: editor.userId, name: "Portable" });
    created.push(r.tokenId);
    const auth = await authenticateMcp(`Bearer ${r.token}`);
    expect(auth.ok).toBe(true);
    if (auth.ok) expect(auth.actor.userId).toBe(editor.userId);
  });

  it("le jeton en clair n'apparaît JAMAIS dans la liste — seul le préfixe", async () => {
    const r = await createApiTokenCore({ userId: editor.userId, name: "Bureau" });
    created.push(r.tokenId);
    const rows = await listTokensCore({ userId: editor.userId, seesAll: false });
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(r.token);
    expect(serialized).toContain(r.token.slice(0, 15));
  });
});

describe("listTokensCore", () => {
  it("un membre ne voit que ses propres jetons", async () => {
    const mine = await createApiTokenCore({ userId: journalist.userId, name: "À moi" });
    created.push(mine.tokenId);
    const rows = await listTokensCore({ userId: journalist.userId, seesAll: false });
    expect(rows.every((r) => r.userId === journalist.userId)).toBe(true);
  });

  it("un porteur de video:configure voit ceux de toute l'équipe", async () => {
    const rows = await listTokensCore({ userId: editor.userId, seesAll: true });
    expect(rows.some((r) => r.userId === journalist.userId)).toBe(true);
  });
});

describe("revokeApiTokenCore", () => {
  it("un jeton révoqué cesse immédiatement de fonctionner", async () => {
    const r = await createApiTokenCore({ userId: editor.userId, name: "Jetable" });
    created.push(r.tokenId);
    await revokeApiTokenCore({ tokenId: r.tokenId, userId: editor.userId, seesAll: false });
    const auth = await authenticateMcp(`Bearer ${r.token}`);
    expect(auth.ok).toBe(false);
  });

  it("un membre ne peut pas révoquer le jeton d'un autre", async () => {
    const other = await createApiTokenCore({ userId: journalist.userId, name: "Pas à toi" });
    created.push(other.tokenId);
    const res = await revokeApiTokenCore({ tokenId: other.tokenId, userId: editor.userId, seesAll: false });
    expect(res.ok).toBe(false);
  });

  it("la révocation est douce : la ligne survit, l'attribution du journal garde son sens", async () => {
    const r = await createApiTokenCore({ userId: editor.userId, name: "Doux" });
    created.push(r.tokenId);
    await revokeApiTokenCore({ tokenId: r.tokenId, userId: editor.userId, seesAll: false });
    const [row] = await db.select().from(apiTokens).where(eq(apiTokens.id, r.tokenId));
    expect(row).toBeDefined();
    expect(row.revokedAt).not.toBeNull();
  });
});

describe("setMcpEnabledCore", () => {
  it("fermer l'interrupteur fait échouer un jeton parfaitement valide, en 503", async () => {
    const r = await createApiTokenCore({ userId: editor.userId, name: "Valide" });
    created.push(r.tokenId);
    await setMcpEnabledCore({ enabled: false, userId: editor.userId });
    const auth = await authenticateMcp(`Bearer ${r.token}`);
    await setMcpEnabledCore({ enabled: true, userId: editor.userId });

    expect(auth.ok).toBe(false);
    if (!auth.ok) expect(auth.status).toBe(503);
  });

  it("rouvrir l'interrupteur remet le même jeton en service", async () => {
    const r = await createApiTokenCore({ userId: editor.userId, name: "Reprise" });
    created.push(r.tokenId);
    await setMcpEnabledCore({ enabled: false, userId: editor.userId });
    await setMcpEnabledCore({ enabled: true, userId: editor.userId });
    const auth = await authenticateMcp(`Bearer ${r.token}`);
    expect(auth.ok).toBe(true);
  });
});
```

`makeUser(role)` est ajouté à `tests/mcp-harness.ts` (créé en Task 5) : insère un utilisateur de test
du rôle demandé et renvoie `{ userId, role, cleanup }`.

Note : les fonctions `*Core` testées ici vivent dans `lib/queries/mcp.ts` — **sans** `"use server"`.
Les server actions de `lib/actions/mcp-actions.ts` les enveloppent avec `requireUser()` +
`requirePermission()`, et calculent `seesAll` depuis `can(role, "video", "configure")`. Même
séparation qu'au SP1 : le writer brut n'est jamais un point d'entrée réseau.

- [ ] **Step 2: Lancer le test pour vérifier qu'il échoue**

Run: `bun test tests/mcp-actions.test.ts`
Expected: FAIL — modules introuvables.

- [ ] **Step 3: Implémenter**

Motif de `lib/actions/openrouter-token-actions.ts` : `"use server"`, garde en tête de chaque export,
et **aucun secret dans une valeur de retour** — sauf `createApiToken`, dont c'est précisément le
contrat, une seule fois.

- [ ] **Step 4: Lancer les tests**

Run: `bun test tests/mcp-actions.test.ts && bun run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/queries/mcp.ts lib/actions/mcp-actions.ts lib/validation.ts tests/mcp-actions.test.ts
git commit -m "feat(mcp): requêtes et actions des réglages MCP"
```

---

### Task 7: Écran Réglages → MCP

**Files:**
- Create: `app/(app)/settings/mcp/page.tsx`, `components/settings/mcp/connection-panel.tsx`, `token-list.tsx`, `tool-catalog.tsx`, `agent-activity.tsx`
- Modify: `components/shell/nav-items.ts` (`SETTINGS_CHILDREN`)
- Test: `tests/mcp-settings-ui.test.ts`

**Interfaces:**
- Consumes: `TOOL_REGISTRY` (Task 3), `listTokens` / `recentAgentActivity` (Task 6)
- Produces: `ConnectionPanel`, `TokenList`, `ToolCatalog`, `AgentActivity`

Quatre panneaux, dans l'ordre du spec §6 : Connexion, Jetons, Ce qu'un agent peut faire, Activité récente. Puis l'interrupteur.

- [ ] **Step 1: Écrire le test qui échoue**

`tests/mcp-settings-ui.test.ts` (rendu SSR, motif de `tests/empty-state.test.ts`) :

```ts
import { describe, it, expect } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolCatalog } from "@/components/settings/mcp/tool-catalog";
import { ConnectionPanel } from "@/components/settings/mcp/connection-panel";
import { TOOL_REGISTRY } from "@/lib/mcp/registry";

describe("ToolCatalog", () => {
  it("affiche TOUS les outils du registre — un outil absent serait un pouvoir accordé en silence", () => {
    const html = renderToStaticMarkup(React.createElement(ToolCatalog));
    for (const t of TOOL_REGISTRY) expect(html).toContain(t.name);
  });

  it("distingue lecture et écriture", () => {
    const html = renderToStaticMarkup(React.createElement(ToolCatalog));
    expect(html).toContain("Lecture");
    expect(html).toContain("Écriture");
  });

  it("dit explicitement que l'annulation n'est pas exposée", () => {
    const html = renderToStaticMarkup(React.createElement(ToolCatalog));
    expect(html).toContain("annuler");
  });
});

describe("ConnectionPanel", () => {
  const props = { serverUrl: "https://exemple.test/api/mcp", enabled: true };

  it("affiche l'adresse du serveur", () => {
    const html = renderToStaticMarkup(React.createElement(ConnectionPanel, props));
    expect(html).toContain("https://exemple.test/api/mcp");
  });

  it("ne contient JAMAIS de jeton réel dans les extraits de configuration", () => {
    const html = renderToStaticMarkup(React.createElement(ConnectionPanel, props));
    expect(html).not.toMatch(/afro_vid_[A-Za-z0-9_-]{10,}/);
    expect(html).toContain("VOTRE_JETON");
  });

  it("dit que claude.ai web attend OAuth", () => {
    const html = renderToStaticMarkup(React.createElement(ConnectionPanel, props));
    expect(html).toContain("OAuth");
  });

  it("signale un serveur désactivé", () => {
    const html = renderToStaticMarkup(React.createElement(ConnectionPanel, { ...props, enabled: false }));
    expect(html).toContain("désactivé");
  });
});
```

- [ ] **Step 2: Lancer le test pour vérifier qu'il échoue**

Run: `bun test tests/mcp-settings-ui.test.ts`
Expected: FAIL — composants introuvables.

- [ ] **Step 3: Implémenter les quatre panneaux**

`ToolCatalog` **itère `TOOL_REGISTRY`** ; il ne redéclare aucun nom d'outil. `ConnectionPanel`
affiche l'adresse (dérivée de la configuration d'exécution), l'état, et des extraits par client
avec l'emplacement `VOTRE_JETON`. `TokenList` crée (affichage unique, avec avertissement), liste et
révoque. `AgentActivity` liste les écritures d'agents avec le marqueur « non relue » et un lien vers
le projet. L'interrupteur n'apparaît que pour `video:configure`.

Page gardée : `requirePermission(user.role, "video", "manage")`. Entrée ajoutée à
`SETTINGS_CHILDREN` : `{ href: "/settings/mcp", label: "MCP", roles: ["admin", "editor", "journalist"] }`.

**Attention** : ajouter une entrée à `SETTINGS_CHILDREN` change les comptes par rôle que
`tests/shell-nav.test.ts` fige en dur. Mets-le à jour — c'est un fait qui change, pas un test à
affaiblir.

- [ ] **Step 4: Lancer les tests**

Run: `bun test tests/mcp-settings-ui.test.ts tests/shell-nav.test.ts tests/nav-sections.test.ts tests/settings-rbac.test.ts`
Expected: PASS, sans régression des trois derniers.

- [ ] **Step 5: Inscrire dans la lane pure et commiter**

```bash
# ajouter "mcp-settings-ui.test.ts" à PURE_FILES dans scripts/test-fast.ts
bun run test:pure
git add app/\(app\)/settings/mcp components/settings/mcp components/shell/nav-items.ts tests/mcp-settings-ui.test.ts tests/shell-nav.test.ts scripts/test-fast.ts
git commit -m "feat(mcp): écran de réglages MCP — connexion, jetons, catalogue, activité"
```

---

### Task 8: Marqueur « non relue »

**Files:**
- Modify: `lib/video/persist.ts` (marquage à l'ouverture), `lib/queries/video.ts`, `components/video/project-list.tsx`, `components/video/journal-history.tsx`, `app/(app)/video/[id]/page.tsx`
- Test: `tests/mcp-review-marker.test.ts` (**lane DB**)

**Interfaces:**
- Consumes: colonne `reviewedAt` (Task 1)
- Produces: `markProjectReviewedCore(projectId, userId)` ; `unreviewedAgentWrites(projectId)` ; champ `unreviewedCount` sur les lignes de `listVideoProjects`

Comportement imposé :
- Ouvrir `/video/[id]` pose `reviewedAt = now()` sur **toutes** les entrées `source: "mcp"` du projet qui l'avaient à `null`.
- Le marquage respecte l'ordre de verrouillage : il ne touche que `script_journal`, donc **aucune** transaction imbriquée avec les écritures de beats.
- La liste `/video` affiche un compteur par projet.

- [ ] **Step 1: Écrire le test qui échoue**

`tests/mcp-review-marker.test.ts` vérifie : une écriture d'agent naît avec `reviewedAt` à `null` ;
`markProjectReviewedCore` la marque ; une seconde écriture d'agent après relecture repasse le projet
en « non relue » ; le marquage n'affecte pas les entrées `source: "copier_coller"` ;
`unreviewedCount` compte juste.

- [ ] **Step 2: Lancer le test pour vérifier qu'il échoue**

Run: `bun test tests/mcp-review-marker.test.ts`
Expected: FAIL — `markProjectReviewedCore` n'existe pas.

- [ ] **Step 3: Implémenter**

`markProjectReviewedCore` : un seul `UPDATE ... WHERE projectId = ? AND source = 'mcp' AND reviewed_at IS NULL`.
Appelé depuis la page projet (Server Component), après le chargement, sans bloquer le rendu.
`listVideoProjects` renvoie `unreviewedCount` par projet.

- [ ] **Step 4: Lancer les tests**

Run: `bun test tests/mcp-review-marker.test.ts && bun run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/video/persist.ts lib/queries/video.ts components/video app/\(app\)/video tests/mcp-review-marker.test.ts
git commit -m "feat(mcp): marqueur « non relue » sur les écritures d'agents"
```

---

## Vérification finale du sous-projet

- [ ] `bun run typecheck` — sans erreur
- [ ] `bun run test:pure` — lane pure verte, 4 nouveaux fichiers inclus
- [ ] `bun test` — suite complète ; comparer le nombre d'échecs à la référence de la branche précédente (14 échecs préexistants, tous côté pipeline / rendu Studio / diffusion). **Tout échec nouveau touchant `mcp`, `video`, `beat` ou `dom-harness` est une régression de ce lot.**
- [ ] Parcours réel : créer un jeton depuis `/settings/mcp`, brancher Claude Code dessus, faire créer un projet et soumettre un script par le chat, vérifier que le diff apparaît dans l'app et que l'écriture est marquée « non relue »
- [ ] `grep -rn "@/db" lib/mcp/` ne renvoie que `auth.ts` et `tools.ts` — `token.ts` et `registry.ts` restent purs
- [ ] `grep -rn "revert" lib/mcp/registry.ts` ne renvoie rien
