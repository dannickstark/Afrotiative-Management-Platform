# OAuth 2.1 + DCR pour le serveur MCP (SP1 ter) — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ajouter la porte OAuth 2.1 (PKCE + enregistrement dynamique de client) au serveur MCP existant pour débloquer claude.ai web, sans toucher au dispatch ni aux outils.

**Architecture:** On monte le plugin `mcp()` de better-auth (non déprécié ; réutilise `OIDCOptions` via `oidcConfig`) sur le handler d'auth existant. La porte unique `authenticateMcp` gagne une branche OAuth qui produit exactement le même `McpActor`. Les deux axes de portée (`canWrite`/`canReadArticles`) sont choisis sur une page de consentement maison et stockés dans une table `mcp_oauth_scope`, parce que l'endpoint de consentement du plugin est tout-ou-rien.

**Tech Stack:** Next.js (App Router, route handlers Web `Request`/`Response`), better-auth 1.6.25 (`mcp` + `oidc-provider` sous-jacent), Drizzle ORM + Postgres, shadcn/ui, tests `bun test`.

**Spec:** `docs/superpowers/specs/2026-08-20-mcp-oauth-dcr-design.md`

## Global Constraints

- **Copie UI en français.** Toutes les chaînes visibles sont en français.
- **`McpActor` inchangé** = `{ userId: string; role: Role; tokenId: string; scope: McpScope }`. Toute nouvelle porte DOIT produire exactement cette forme. `McpScope = { canWrite: boolean; canReadArticles: boolean }`.
- **`AuthOutcome` inchangé** = `{ ok: true; actor: McpActor } | { ok: false; status: 401 | 403 | 503; message: string }`. `authenticateMcp` ne lève jamais et ne renvoie jamais de `Response`.
- **Le coupe-circuit `mcpEnabled`** est vérifié en tête de `authenticateMcp` — la branche OAuth en hérite, ne pas le redupliquer.
- **Ne PAS toucher** : `lib/mcp/tools.ts` (dispatch), `lib/mcp/scope.ts` (`refusPourPortee`), `lib/mcp/registry.ts`, `lib/video/*`. Le rôle reste le plancher (`requirePermission` au dispatch), la portée le plafond.
- **Ids utilisateur = `text`** (convention better-auth), entités applicatives = `uuid`. Une FK vers `user.id` utilise `text("user_id").references(() => user.id, { onDelete: "cascade" })`.
- **Import DB** via `@/db` (ré-exporte tout le schéma). **Migrations** : éditer `db/schema.ts` puis `bun run db:generate` (drizzle-kit numérote automatiquement — prochain = `0028`). Ne jamais numéroter à la main.
- **Tests purs** (sans DB ni réseau) : inscrire le nom de fichier nu dans le `Set` `PURE_FILES` de `scripts/test-fast.ts`. Les tests touchant la DB ne sont inscrits nulle part (voie lente par défaut). Signal vert = `bun run typecheck` + `bun run test:pure`.
- **Portées OAuth advertises** : on garde les scopes par défaut de better-auth (`openid`, `profile`, `email`, `offline_access`). Les deux axes métier NE transitent PAS par les chaînes de portée OAuth — ils vivent dans `mcp_oauth_scope`.
- **Défaut de portée conservateur** pour une connexion OAuth : `canWrite = true`, `canReadArticles = false`.

---

## File Structure

| Fichier | Rôle | Action |
|---|---|---|
| `lib/auth.ts` | Config better-auth | Modifier — ajouter `mcp()` au tableau `plugins` |
| `db/schema.ts` | Schéma Drizzle | Modifier — 3 tables plugin (`oauthApplication`, `oauthAccessToken`, `oauthConsent`) + `mcpOauthScope` |
| `db/migrations/0028_*.sql` | Migration | Créer (généré) |
| `app/.well-known/oauth-authorization-server/route.ts` | Métadonnées serveur d'autorisation | Créer |
| `app/.well-known/oauth-protected-resource/route.ts` | Métadonnées ressource protégée | Créer |
| `lib/mcp/oauth-scope.ts` | Mapping pur session → portée/acteur | Créer |
| `lib/queries/mcp-oauth.ts` | Cœurs DB (upsert/get/list/revoke portée) sans `"use server"` | Créer |
| `lib/mcp/auth.ts` | Porte unique | Modifier — branche OAuth |
| `lib/actions/mcp-oauth-actions.ts` | Server actions consentement + révocation | Créer |
| `app/(app)/oauth/authorize/page.tsx` | Page de consentement (server) | Créer |
| `components/oauth/consent-form.tsx` | Formulaire de consentement (client) | Créer |
| `components/settings/mcp/oauth-connections.tsx` | Panneau « Connexions OAuth » (client) | Créer |
| `app/(app)/settings/mcp/page.tsx` | Page réglages MCP | Modifier — monter le panneau OAuth |
| `components/settings/mcp/connection-panel.tsx` | Extraits de connexion | Modifier — copie claude.ai web |
| `scripts/test-fast.ts` | Allowlist tests purs | Modifier — nouveaux fichiers purs |

---

## Task 1: Monter le plugin `mcp()` dans better-auth

**Files:**
- Modify: `lib/auth.ts:1-20`
- Test: `tests/oauth-plugin-mounted.test.ts`

**Interfaces:**
- Consumes: `auth` (better-auth instance).
- Produces: `auth.api.getMcpSession`, `auth.api.oAuthConsent`, `auth.api.getMcpOAuthConfig`, `auth.api.getMCPProtectedResource` deviennent disponibles ; endpoints `/api/auth/oauth2/authorize|token|register|consent` montés via le catch-all existant.

Notes de config (verbatim depuis better-auth 1.6.25) : `mcp(options: { loginPage: string; resource?: string; oidcConfig?: OIDCOptions })`. `oidcConfig` accepte `{ requirePKCE?, allowDynamicClientRegistration?, consentPage?, accessTokenExpiresIn?, refreshTokenExpiresIn?, scopes?, ... }`. On dérive l'URL de ressource de `BETTER_AUTH_URL`.

- [ ] **Step 1: Écrire le test qui échoue**

Créer `tests/oauth-plugin-mounted.test.ts` :

```ts
import { expect, test } from "bun:test";
import { auth } from "@/lib/auth";

test("le plugin mcp expose les endpoints OAuth sur auth.api", () => {
  expect(typeof auth.api.getMcpSession).toBe("function");
  expect(typeof auth.api.oAuthConsent).toBe("function");
  expect(typeof auth.api.getMcpOAuthConfig).toBe("function");
  expect(typeof auth.api.getMCPProtectedResource).toBe("function");
});
```

- [ ] **Step 2: Lancer le test et vérifier qu'il échoue**

Run: `bun test tests/oauth-plugin-mounted.test.ts`
Expected: FAIL — `getMcpSession` n'existe pas encore (`undefined`, pas `function`).

- [ ] **Step 3: Monter le plugin**

Dans `lib/auth.ts`, ajouter l'import et l'entrée du tableau `plugins` (après `adminPlugin({...})`) :

```ts
import { admin as adminPlugin, mcp } from "better-auth/plugins";

// ... dans betterAuth({ plugins: [ adminPlugin({...}),
    mcp({
      loginPage: "/login",
      resource: `${process.env.BETTER_AUTH_URL ?? ""}/api/mcp`,
      oidcConfig: {
        requirePKCE: true,
        allowDynamicClientRegistration: true,
        consentPage: "/oauth/authorize",
      },
    }),
// ] })
```

- [ ] **Step 4: Lancer le test et vérifier qu'il passe**

Run: `bun test tests/oauth-plugin-mounted.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: exit 0, aucune nouvelle erreur.

- [ ] **Step 6: Commit**

```bash
git add lib/auth.ts tests/oauth-plugin-mounted.test.ts
git commit -m "feat(mcp): monter le plugin OAuth (mcp) de better-auth"
```

Note : NE PAS ajouter ce test au `PURE_FILES` — il importe `auth` → `@/db` (crée un Pool). Laisser en voie lente.

---

## Task 2: Tables OAuth + `mcp_oauth_scope` + migration

**Files:**
- Modify: `db/schema.ts` (ajouter 4 tables après `apiTokens`, ~ligne 857)
- Create: `db/migrations/0028_*.sql` (généré par drizzle-kit)
- Test: `tests/oauth-schema.test.ts`

**Interfaces:**
- Produces: exports Drizzle `oauthApplication`, `oauthAccessToken`, `oauthConsent`, `mcpOauthScope` (tous ré-exportés par `@/db`).

Les noms de **propriété** (clés JS) DOIVENT correspondre exactement aux noms de champ better-auth (sinon l'adaptateur ne trouve pas les colonnes) ; les noms de **colonne** SQL sont en snake_case. Noms de champ vérifiés depuis `node_modules/better-auth/dist/plugins/oidc-provider/schema.mjs`.

- [ ] **Step 1: Écrire le test qui échoue**

Créer `tests/oauth-schema.test.ts` :

```ts
import { expect, test } from "bun:test";
import { oauthApplication, oauthAccessToken, oauthConsent, mcpOauthScope } from "@/db";

test("les tables OAuth exposent les colonnes attendues", () => {
  expect(oauthApplication.clientId).toBeDefined();
  expect(oauthApplication.redirectUrls).toBeDefined();
  expect(oauthAccessToken.accessToken).toBeDefined();
  expect(oauthAccessToken.scopes).toBeDefined();
  expect(oauthConsent.consentGiven).toBeDefined();
  expect(mcpOauthScope.canWrite).toBeDefined();
  expect(mcpOauthScope.canReadArticles).toBeDefined();
  expect(mcpOauthScope.clientId).toBeDefined();
});
```

- [ ] **Step 2: Lancer le test et vérifier qu'il échoue**

Run: `bun test tests/oauth-schema.test.ts`
Expected: FAIL — imports indéfinis.

- [ ] **Step 3: Ajouter les tables au schéma**

Dans `db/schema.ts`, après la définition de `apiTokens`, ajouter :

```ts
// --- OAuth 2.1 / MCP (SP1 ter) — tables gérées par le plugin better-auth ---
export const oauthApplication = pgTable("oauth_application", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  icon: text("icon"),
  metadata: text("metadata"),
  clientId: text("client_id").notNull().unique(),
  clientSecret: text("client_secret"),
  redirectUrls: text("redirect_urls").notNull(),
  type: text("type").notNull(),
  disabled: boolean("disabled").notNull().default(false),
  userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [index("oauth_application_client_idx").on(t.clientId)]);

export const oauthAccessToken = pgTable("oauth_access_token", {
  id: text("id").primaryKey(),
  accessToken: text("access_token").notNull().unique(),
  refreshToken: text("refresh_token").notNull().unique(),
  accessTokenExpiresAt: timestamp("access_token_expires_at").notNull(),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at").notNull(),
  clientId: text("client_id").notNull().references(() => oauthApplication.clientId, { onDelete: "cascade" }),
  userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
  scopes: text("scopes").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [index("oauth_access_token_client_idx").on(t.clientId), index("oauth_access_token_user_idx").on(t.userId)]);

export const oauthConsent = pgTable("oauth_consent", {
  id: text("id").primaryKey(),
  clientId: text("client_id").notNull().references(() => oauthApplication.clientId, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  scopes: text("scopes").notNull(),
  consentGiven: boolean("consent_given").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [index("oauth_consent_client_idx").on(t.clientId), index("oauth_consent_user_idx").on(t.userId)]);

// --- Portée par connexion OAuth (source de vérité de nos deux axes) ---
export const mcpOauthScope = pgTable("mcp_oauth_scope", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  clientId: text("client_id").notNull(),
  canWrite: boolean("can_write").notNull().default(true),
  canReadArticles: boolean("can_read_articles").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at"),
}, (t) => [
  uniqueIndex("mcp_oauth_scope_user_client_uq").on(t.userId, t.clientId),
  index("mcp_oauth_scope_user_idx").on(t.userId),
]);
```

Note : `id` des trois tables plugin est `text` (better-auth génère l'id). `mcpOauthScope.id` est `uuid` (table applicative).

- [ ] **Step 4: Générer la migration**

Run: `bun run db:generate`
Expected: crée `db/migrations/0028_*.sql` + snapshot + entrée journal. Ouvrir le `.sql` généré et vérifier qu'il contient `CREATE TABLE "oauth_application"`, `"oauth_access_token"`, `"oauth_consent"`, `"mcp_oauth_scope"` et les FK/index. Aucun `CREATE TYPE`/enum (sinon revoir).

- [ ] **Step 5: Lancer le test et le typecheck**

Run: `bun test tests/oauth-schema.test.ts && bun run typecheck`
Expected: PASS + exit 0.

- [ ] **Step 6: Appliquer la migration en dev**

Run: `bun run db:migrate`
Expected: applique `0028` sans erreur.

- [ ] **Step 7: Commit**

```bash
git add db/schema.ts db/migrations
git commit -m "feat(mcp): tables OAuth (client/token/consent) et portée par connexion"
```

---

## Task 3: Routes de métadonnées `.well-known`

**Files:**
- Create: `app/.well-known/oauth-authorization-server/route.ts`
- Create: `app/.well-known/oauth-protected-resource/route.ts`
- Test: `tests/oauth-metadata-routes.test.ts`

**Interfaces:**
- Consumes: `auth` (Task 1), `oAuthDiscoveryMetadata`, `oAuthProtectedResourceMetadata` (better-auth).
- Produces: `GET /.well-known/oauth-authorization-server`, `GET /.well-known/oauth-protected-resource`.

Rappel doc Next.js (bundled) : un segment statique `app/.well-known/.../route.ts` sert le chemin correspondant ; handler = `export const GET = ...` renvoyant une `Response`. Ces helpers better-auth renvoient déjà `(request) => Promise<Response>`.

- [ ] **Step 1: Vérifier qu'aucun middleware n'avale `.well-known`**

Run: `ls middleware.ts proxy.ts 2>/dev/null; grep -rn "matcher" middleware.ts proxy.ts 2>/dev/null`
Expected: aucun fichier, ou un matcher qui n'intercepte pas `/.well-known/*`. Si un matcher l'intercepte, l'exclure (`'/((?!.well-known).*)'`). Noter le résultat.

- [ ] **Step 2: Écrire le test qui échoue**

Créer `tests/oauth-metadata-routes.test.ts` :

```ts
import { expect, test } from "bun:test";
import { GET as asMeta } from "@/app/.well-known/oauth-authorization-server/route";
import { GET as prMeta } from "@/app/.well-known/oauth-protected-resource/route";

test("métadonnées serveur d'autorisation exposent les endpoints", async () => {
  const res = await asMeta(new Request("https://x.test/.well-known/oauth-authorization-server"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.registration_endpoint).toContain("/oauth2/register");
  expect(body.authorization_endpoint).toContain("/oauth2/authorize");
});

test("métadonnées ressource protégée référencent le serveur d'autorisation", async () => {
  const res = await prMeta(new Request("https://x.test/.well-known/oauth-protected-resource"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body.authorization_servers)).toBe(true);
});
```

- [ ] **Step 3: Lancer le test et vérifier qu'il échoue**

Run: `bun test tests/oauth-metadata-routes.test.ts`
Expected: FAIL — modules de route introuvables.

- [ ] **Step 4: Créer les routes**

`app/.well-known/oauth-authorization-server/route.ts` :

```ts
import { auth } from "@/lib/auth";
import { oAuthDiscoveryMetadata } from "better-auth/plugins";

export const GET = oAuthDiscoveryMetadata(auth);
```

`app/.well-known/oauth-protected-resource/route.ts` :

```ts
import { auth } from "@/lib/auth";
import { oAuthProtectedResourceMetadata } from "better-auth/plugins";

export const GET = oAuthProtectedResourceMetadata(auth);
```

- [ ] **Step 5: Lancer le test et vérifier qu'il passe**

Run: `bun test tests/oauth-metadata-routes.test.ts`
Expected: PASS. (Si les endpoints ne sont pas préfixés comme attendu, ajuster l'assertion au `registration_endpoint` réellement renvoyé — le mécanisme, pas la chaîne exacte, est ce qu'on teste.)

- [ ] **Step 6: Typecheck et commit**

Run: `bun run typecheck`

```bash
git add "app/.well-known" tests/oauth-metadata-routes.test.ts
git commit -m "feat(mcp): routes de métadonnées OAuth .well-known"
```

Note : NE PAS inscrire au `PURE_FILES` (importe `auth` → `@/db`).

---

## Task 4: Portée par connexion — cœurs DB et mapping pur

**Files:**
- Create: `lib/mcp/oauth-scope.ts` (pur)
- Create: `lib/queries/mcp-oauth.ts` (DB, sans `"use server"`)
- Test: `tests/oauth-scope-map.test.ts` (pur), `tests/oauth-scope-core.test.ts` (DB)
- Modify: `scripts/test-fast.ts` (ajouter `oauth-scope-map.test.ts`)

**Interfaces:**
- Consumes: `McpScope`, `FULL_SCOPE` (`lib/mcp/scope.ts`) ; tables Task 2 ; `db` (`@/db`).
- Produces:
  - `scopeFromRow(row: { canWrite: boolean; canReadArticles: boolean } | null): McpScope` — pur ; défaut conservateur si `null`.
  - `upsertOauthScopeCore(input: { userId: string; clientId: string; scope: McpScope }): Promise<void>`
  - `getOauthScopeCore(input: { userId: string; clientId: string }): Promise<McpScope>`
  - `touchOauthScopeCore(input: { userId: string; clientId: string }): Promise<void>` (met `lastUsedAt`)
  - `listOauthConnectionsCore(input: { userId: string; seesAll: boolean }): Promise<OauthConnectionRow[]>`
  - `revokeOauthConnectionCore(input: { scopeId: string; userId: string; seesAll: boolean }): Promise<{ ok: boolean; message?: string }>`
  - Type `OauthConnectionRow = { id: string; userId: string; ownerName: string | null; clientId: string; clientName: string | null; canWrite: boolean; canReadArticles: boolean; createdAt: Date; lastUsedAt: Date | null }`.

- [ ] **Step 1: Écrire le test pur qui échoue**

Créer `tests/oauth-scope-map.test.ts` :

```ts
import { expect, test } from "bun:test";
import { scopeFromRow } from "@/lib/mcp/oauth-scope";

test("défaut conservateur quand aucune ligne", () => {
  expect(scopeFromRow(null)).toEqual({ canWrite: true, canReadArticles: false });
});

test("reflète les deux axes de la ligne", () => {
  expect(scopeFromRow({ canWrite: false, canReadArticles: true })).toEqual({
    canWrite: false,
    canReadArticles: true,
  });
});
```

- [ ] **Step 2: Lancer et vérifier l'échec**

Run: `bun test tests/oauth-scope-map.test.ts`
Expected: FAIL — module introuvable.

- [ ] **Step 3: Écrire le mapping pur**

Créer `lib/mcp/oauth-scope.ts` :

```ts
import type { McpScope } from "@/lib/mcp/scope";

/** Portée d'une connexion OAuth. Défaut conservateur : écriture oui, articles non. */
export function scopeFromRow(
  row: { canWrite: boolean; canReadArticles: boolean } | null,
): McpScope {
  if (!row) return { canWrite: true, canReadArticles: false };
  return { canWrite: row.canWrite, canReadArticles: row.canReadArticles };
}
```

- [ ] **Step 4: Lancer et vérifier le succès**

Run: `bun test tests/oauth-scope-map.test.ts`
Expected: PASS.

- [ ] **Step 5: Écrire les cœurs DB**

Créer `lib/queries/mcp-oauth.ts` :

```ts
import { and, desc, eq } from "drizzle-orm";
import { db, mcpOauthScope, oauthApplication, user } from "@/db";
import type { McpScope } from "@/lib/mcp/scope";
import { scopeFromRow } from "@/lib/mcp/oauth-scope";

export type OauthConnectionRow = {
  id: string;
  userId: string;
  ownerName: string | null;
  clientId: string;
  clientName: string | null;
  canWrite: boolean;
  canReadArticles: boolean;
  createdAt: Date;
  lastUsedAt: Date | null;
};

export async function upsertOauthScopeCore(
  { userId, clientId, scope }: { userId: string; clientId: string; scope: McpScope },
): Promise<void> {
  await db
    .insert(mcpOauthScope)
    .values({ userId, clientId, canWrite: scope.canWrite, canReadArticles: scope.canReadArticles })
    .onConflictDoUpdate({
      target: [mcpOauthScope.userId, mcpOauthScope.clientId],
      set: { canWrite: scope.canWrite, canReadArticles: scope.canReadArticles },
    });
}

export async function getOauthScopeCore(
  { userId, clientId }: { userId: string; clientId: string },
): Promise<McpScope> {
  const [row] = await db
    .select({ canWrite: mcpOauthScope.canWrite, canReadArticles: mcpOauthScope.canReadArticles })
    .from(mcpOauthScope)
    .where(and(eq(mcpOauthScope.userId, userId), eq(mcpOauthScope.clientId, clientId)))
    .limit(1);
  return scopeFromRow(row ?? null);
}

export async function touchOauthScopeCore(
  { userId, clientId }: { userId: string; clientId: string },
): Promise<void> {
  await db
    .update(mcpOauthScope)
    .set({ lastUsedAt: new Date() })
    .where(and(eq(mcpOauthScope.userId, userId), eq(mcpOauthScope.clientId, clientId)));
}

export async function listOauthConnectionsCore(
  { userId, seesAll }: { userId: string; seesAll: boolean },
): Promise<OauthConnectionRow[]> {
  const rows = await db
    .select({
      id: mcpOauthScope.id,
      userId: mcpOauthScope.userId,
      ownerName: user.name,
      clientId: mcpOauthScope.clientId,
      clientName: oauthApplication.name,
      canWrite: mcpOauthScope.canWrite,
      canReadArticles: mcpOauthScope.canReadArticles,
      createdAt: mcpOauthScope.createdAt,
      lastUsedAt: mcpOauthScope.lastUsedAt,
    })
    .from(mcpOauthScope)
    .leftJoin(user, eq(user.id, mcpOauthScope.userId))
    .leftJoin(oauthApplication, eq(oauthApplication.clientId, mcpOauthScope.clientId))
    .where(seesAll ? undefined : eq(mcpOauthScope.userId, userId))
    .orderBy(desc(mcpOauthScope.createdAt));
  return rows;
}

export async function revokeOauthConnectionCore(
  { scopeId, userId, seesAll }: { scopeId: string; userId: string; seesAll: boolean },
): Promise<{ ok: boolean; message?: string }> {
  const [row] = await db.select().from(mcpOauthScope).where(eq(mcpOauthScope.id, scopeId)).limit(1);
  if (!row) return { ok: false, message: "Connexion introuvable." };
  if (!seesAll && row.userId !== userId) {
    return { ok: false, message: "Vous ne pouvez révoquer que vos propres connexions." };
  }
  // better-auth n'expose pas d'API de révocation : on supprime directement les jetons + le
  // consentement du plugin pour ce couple (utilisateur, client), puis notre ligne de portée.
  const { oauthAccessToken, oauthConsent } = await import("@/db");
  await db.delete(oauthAccessToken).where(
    and(eq(oauthAccessToken.userId, row.userId), eq(oauthAccessToken.clientId, row.clientId)),
  );
  await db.delete(oauthConsent).where(
    and(eq(oauthConsent.userId, row.userId), eq(oauthConsent.clientId, row.clientId)),
  );
  await db.delete(mcpOauthScope).where(eq(mcpOauthScope.id, scopeId));
  return { ok: true };
}
```

Note : l'`import("@/db")` dynamique n'est là que pour regrouper — remplacer par un import statique en tête (`oauthAccessToken, oauthConsent`) si le linter le préfère ; les deux marchent.

- [ ] **Step 6: Écrire le test DB des cœurs**

Créer `tests/oauth-scope-core.test.ts`. Il insère un utilisateur + une application OAuth, teste upsert → get → list → revoke, et nettoie après (DB partagée). Modèle :

```ts
import { afterAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db, user, oauthApplication, mcpOauthScope } from "@/db";
import {
  upsertOauthScopeCore, getOauthScopeCore, listOauthConnectionsCore, revokeOauthConnectionCore,
} from "@/lib/queries/mcp-oauth";

const uid = "test-oauth-user-1";
const cid = "test-oauth-client-1";

afterAll(async () => {
  await db.delete(mcpOauthScope).where(eq(mcpOauthScope.userId, uid));
  await db.delete(oauthApplication).where(eq(oauthApplication.clientId, cid));
  await db.delete(user).where(eq(user.id, uid));
});

test("upsert → get → list → revoke", async () => {
  await db.insert(user).values({ id: uid, name: "Testeur", email: "t-oauth@x.test" }).onConflictDoNothing();
  await db.insert(oauthApplication).values({
    id: "app-1", name: "Claude test", clientId: cid, redirectUrls: "https://claude.ai/cb", type: "web",
  }).onConflictDoNothing();

  await upsertOauthScopeCore({ userId: uid, clientId: cid, scope: { canWrite: true, canReadArticles: false } });
  expect(await getOauthScopeCore({ userId: uid, clientId: cid })).toEqual({ canWrite: true, canReadArticles: false });

  await upsertOauthScopeCore({ userId: uid, clientId: cid, scope: { canWrite: false, canReadArticles: true } });
  expect(await getOauthScopeCore({ userId: uid, clientId: cid })).toEqual({ canWrite: false, canReadArticles: true });

  const list = await listOauthConnectionsCore({ userId: uid, seesAll: false });
  expect(list.find((r) => r.clientId === cid)?.clientName).toBe("Claude test");

  const [row] = await db.select().from(mcpOauthScope).where(and(eq(mcpOauthScope.userId, uid), eq(mcpOauthScope.clientId, cid))).limit(1);
  const res = await revokeOauthConnectionCore({ scopeId: row.id, userId: uid, seesAll: false });
  expect(res.ok).toBe(true);
  expect(await getOauthScopeCore({ userId: uid, clientId: cid })).toEqual({ canWrite: true, canReadArticles: false }); // défaut après suppression
});
```

- [ ] **Step 7: Inscrire le test pur et lancer**

Ajouter `"oauth-scope-map.test.ts"` au `Set` `PURE_FILES` de `scripts/test-fast.ts` (à côté des autres entrées `mcp-*`). NE PAS y ajouter `oauth-scope-core.test.ts` (DB).

Run: `bun test tests/oauth-scope-core.test.ts && bun run test:pure && bun run typecheck`
Expected: PASS + exit 0.

- [ ] **Step 8: Commit**

```bash
git add lib/mcp/oauth-scope.ts lib/queries/mcp-oauth.ts tests/oauth-scope-map.test.ts tests/oauth-scope-core.test.ts scripts/test-fast.ts
git commit -m "feat(mcp): cœurs de portée par connexion OAuth et mapping pur"
```

---

## Task 5: Branche OAuth dans la porte `authenticateMcp`

**Files:**
- Create: `lib/mcp/oauth-actor.ts` (construction pure de l'acteur)
- Modify: `lib/mcp/auth.ts` (aiguillage OAuth)
- Test: `tests/oauth-actor.test.ts` (pur), extension de `tests/mcp-auth.test.ts` si présent (sinon `tests/oauth-door.test.ts`, DB)
- Modify: `scripts/test-fast.ts` (ajouter `oauth-actor.test.ts`)

**Interfaces:**
- Consumes: `auth.api.getMcpSession` (Task 1) ; `getOauthScopeCore`, `touchOauthScopeCore` (Task 4) ; `McpActor`, `AuthOutcome` (`lib/mcp/auth.ts`) ; `isSessionUsable` (`lib/session.ts`).
- Produces: `buildOauthActor(input: { session: { userId: string; clientId: string } | null; owner: { role: Role; banned: boolean } | null; scope: McpScope }): AuthOutcome` — pur.

Rappel : `auth.api.getMcpSession({ headers })` renvoie `{ userId, clientId, scopes } | null` en lisant l'en-tête `Authorization: Bearer`. On construit un `Headers` depuis la chaîne reçue (la porte garde sa signature `string | null`).

- [ ] **Step 1: Écrire le test pur qui échoue**

Créer `tests/oauth-actor.test.ts` :

```ts
import { expect, test } from "bun:test";
import { buildOauthActor } from "@/lib/mcp/oauth-actor";

const scope = { canWrite: true, canReadArticles: false };

test("session absente → 401", () => {
  expect(buildOauthActor({ session: null, owner: null, scope })).toEqual({
    ok: false, status: 401, message: "Jeton d'API invalide ou révoqué.",
  });
});

test("propriétaire banni → 401", () => {
  const r = buildOauthActor({
    session: { userId: "u1", clientId: "c1" },
    owner: { role: "journalist", banned: true },
    scope,
  });
  expect(r).toEqual({ ok: false, status: 401, message: "Jeton d'API invalide ou révoqué." });
});

test("session valide → acteur avec clientId comme tokenId", () => {
  const r = buildOauthActor({
    session: { userId: "u1", clientId: "c1" },
    owner: { role: "editor", banned: false },
    scope,
  });
  expect(r).toEqual({ ok: true, actor: { userId: "u1", role: "editor", tokenId: "c1", scope } });
});
```

- [ ] **Step 2: Lancer et vérifier l'échec**

Run: `bun test tests/oauth-actor.test.ts`
Expected: FAIL — module introuvable.

- [ ] **Step 3: Écrire la construction pure**

Créer `lib/mcp/oauth-actor.ts` :

```ts
import type { Role } from "@/lib/auth";
import type { McpScope } from "@/lib/mcp/scope";
import type { AuthOutcome } from "@/lib/mcp/auth";

const REJECT = "Jeton d'API invalide ou révoqué.";

export function buildOauthActor(
  { session, owner, scope }: {
    session: { userId: string; clientId: string } | null;
    owner: { role: Role; banned: boolean } | null;
    scope: McpScope;
  },
): AuthOutcome {
  if (!session) return { ok: false, status: 401, message: REJECT };
  if (!owner || owner.banned) return { ok: false, status: 401, message: REJECT };
  return {
    ok: true,
    actor: { userId: session.userId, role: owner.role, tokenId: session.clientId, scope },
  };
}
```

Note : `AuthOutcome` doit être `export`é depuis `lib/mcp/auth.ts` (il l'est déjà). Pour éviter un cycle de type à l'exécution, `oauth-actor.ts` n'importe QUE le type (`import type`).

- [ ] **Step 4: Lancer et vérifier le succès**

Run: `bun test tests/oauth-actor.test.ts`
Expected: PASS.

- [ ] **Step 5: Câbler la branche OAuth dans la porte**

Dans `lib/mcp/auth.ts`, modifier `authenticateMcp` : après le rejet du préfixe personnel, au lieu de renvoyer `401` directement, tenter OAuth. Remplacer le bloc `const prefix = prefixOf(raw); if (!prefix) return {...401...};` par un aiguillage :

```ts
import { auth } from "@/lib/auth";
import { getOauthScopeCore, touchOauthScopeCore } from "@/lib/queries/mcp-oauth";
import { buildOauthActor } from "@/lib/mcp/oauth-actor";
// ... imports existants ...

// (dans authenticateMcp, après avoir extrait `raw`)
const prefix = prefixOf(raw);
if (!prefix) {
  // Pas un jeton personnel → tenter le jeton d'accès OAuth (claude.ai web).
  const headers = new Headers(authorizationHeader ? { authorization: authorizationHeader } : {});
  const oauthSession = await auth.api.getMcpSession({ headers });
  if (!oauthSession) return { ok: false, status: 401, message: REJECT };
  const [owner] = await db.select().from(userTable).where(eq(userTable.id, oauthSession.userId)).limit(1);
  const scope = await getOauthScopeCore({ userId: oauthSession.userId, clientId: oauthSession.clientId });
  const outcome = buildOauthActor({
    session: { userId: oauthSession.userId, clientId: oauthSession.clientId },
    owner: owner ? { role: owner.role, banned: owner.banned } : null,
    scope,
  });
  if (outcome.ok) {
    await touchOauthScopeCore({ userId: oauthSession.userId, clientId: oauthSession.clientId });
  }
  return outcome;
}
// ... suite inchangée : lookup du jeton personnel par prefix ...
```

Laisser tout le chemin jeton personnel (lookup par `prefix`) intact en dessous.

- [ ] **Step 6: Vérifier que le chemin jeton personnel n'a pas régressé**

Run: `bun test tests/mcp-auth.test.ts` (ou le fichier couvrant `authenticateMcp` ; sinon sauter et s'appuyer sur l'étape 7)
Expected: PASS — les cas jeton personnel existants passent toujours.

- [ ] **Step 7: Typecheck + test:pure**

Ajouter `"oauth-actor.test.ts"` au `PURE_FILES`.

Run: `bun run typecheck && bun run test:pure`
Expected: exit 0 + PASS.

- [ ] **Step 8: Commit**

```bash
git add lib/mcp/oauth-actor.ts lib/mcp/auth.ts tests/oauth-actor.test.ts scripts/test-fast.ts
git commit -m "feat(mcp): la porte accepte les jetons d'accès OAuth"
```

---

## Task 6: Page de consentement + actions

**Files:**
- Create: `lib/actions/mcp-oauth-actions.ts` (`"use server"`)
- Create: `app/(app)/oauth/authorize/page.tsx` (server)
- Create: `components/oauth/consent-form.tsx` (client)
- Test: `tests/oauth-consent-form.test.ts` (pur, dom-harness)
- Modify: `scripts/test-fast.ts`

**Interfaces:**
- Consumes: `requireUser` (`lib/session.ts`), `upsertOauthScopeCore` (Task 4), `auth.api.oAuthConsent`, `db`/`oauthApplication`.
- Produces:
  - `approveOauthConsent(input: { clientId: string; consentCode: string; canWrite: boolean; canReadArticles: boolean }): Promise<{ ok: false; message: string }>` (redirige en cas de succès).
  - `denyOauthConsent(consentCode: string): Promise<{ ok: false; message: string }>` (redirige en cas de succès).

Rappel flux : better-auth redirige vers `consentPage?consent_code=…&client_id=…&scope=…`. On lit ces paramètres, on affiche le nom du client (depuis `oauthApplication`), l'utilisateur choisit les deux axes, puis `auth.api.oAuthConsent({ body: { accept, consent_code }, headers })` renvoie `{ redirectURI }`.

- [ ] **Step 1: Écrire le test pur qui échoue (état par défaut du formulaire)**

Créer `tests/oauth-consent-form.test.ts` (suivre le modèle des tests `*-settings-ui`/`dom-harness` existants ; rendre le composant et vérifier les valeurs par défaut) :

```ts
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ConsentForm } from "@/components/oauth/consent-form";

test("le formulaire affiche le nom du client et les deux axes, écriture cochée / articles non", () => {
  const html = renderToStaticMarkup(
    <ConsentForm clientName="Claude (web)" clientId="c1" consentCode="code1" />,
  );
  expect(html).toContain("Claude (web)");
  expect(html).toContain("Écriture");
  expect(html).toContain("Lire les articles");
  expect(html).toContain("Autoriser");
  expect(html).toContain("Refuser");
});
```

- [ ] **Step 2: Lancer et vérifier l'échec**

Run: `bun test tests/oauth-consent-form.test.ts`
Expected: FAIL — composant introuvable.

- [ ] **Step 3: Écrire les server actions**

Créer `lib/actions/mcp-oauth-actions.ts` :

```ts
"use server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireUser } from "@/lib/session";
import { upsertOauthScopeCore } from "@/lib/queries/mcp-oauth";

const approveSchema = z.object({
  clientId: z.string().min(1),
  consentCode: z.string().min(1),
  canWrite: z.boolean(),
  canReadArticles: z.boolean(),
});

export async function approveOauthConsent(
  input: { clientId: string; consentCode: string; canWrite: boolean; canReadArticles: boolean },
): Promise<{ ok: false; message: string }> {
  const u = await requireUser(); // tout utilisateur connecté non banni
  const parsed = approveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Requête de consentement invalide." };
  await upsertOauthScopeCore({
    userId: u.id,
    clientId: parsed.data.clientId,
    scope: { canWrite: parsed.data.canWrite, canReadArticles: parsed.data.canReadArticles },
  });
  const res = await auth.api.oAuthConsent({
    body: { accept: true, consent_code: parsed.data.consentCode },
    headers: await headers(),
  });
  redirect(res.redirectURI);
}

export async function denyOauthConsent(consentCode: string): Promise<{ ok: false; message: string }> {
  await requireUser();
  if (!consentCode) return { ok: false, message: "Code de consentement manquant." };
  const res = await auth.api.oAuthConsent({
    body: { accept: false, consent_code: consentCode },
    headers: await headers(),
  });
  redirect(res.redirectURI);
}
```

- [ ] **Step 4: Écrire le formulaire client**

Créer `components/oauth/consent-form.tsx` :

```tsx
"use client";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { approveOauthConsent, denyOauthConsent } from "@/lib/actions/mcp-oauth-actions";

export function ConsentForm(
  { clientName, clientId, consentCode }: { clientName: string; clientId: string; consentCode: string },
) {
  const [canWrite, setCanWrite] = useState(true);
  const [canReadArticles, setCanReadArticles] = useState(false);
  const [pending, start] = useTransition();

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Autoriser <span className="font-medium text-foreground">{clientName}</span> à accéder à
        votre espace MAIMP ?
      </p>
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <Label htmlFor="canWrite">Écriture (créer / modifier des projets vidéo)</Label>
          <Switch id="canWrite" checked={canWrite} onCheckedChange={setCanWrite} />
        </div>
        <div className="flex items-center justify-between">
          <Label htmlFor="canReadArticles">Lire les articles éditoriaux</Label>
          <Switch id="canReadArticles" checked={canReadArticles} onCheckedChange={setCanReadArticles} />
        </div>
      </div>
      <div className="flex gap-3">
        <Button variant="outline" disabled={pending}
          onClick={() => start(() => { void denyOauthConsent(consentCode); })}>
          Refuser
        </Button>
        <Button disabled={pending}
          onClick={() => start(() => { void approveOauthConsent({ clientId, consentCode, canWrite, canReadArticles }); })}>
          Autoriser
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Écrire la page serveur**

Créer `app/(app)/oauth/authorize/page.tsx` :

```tsx
import { eq } from "drizzle-orm";
import { db, oauthApplication } from "@/db";
import { requireUser } from "@/lib/session";
import { ConsentForm } from "@/components/oauth/consent-form";

export default async function OAuthAuthorizePage(
  { searchParams }: { searchParams: Promise<{ client_id?: string; consent_code?: string; scope?: string }> },
) {
  await requireUser(); // redirige vers /login si non connecté
  const { client_id, consent_code } = await searchParams;

  if (!client_id || !consent_code) {
    return <p className="p-8 text-sm text-muted-foreground">Requête d'autorisation incomplète.</p>;
  }
  const [client] = await db
    .select({ name: oauthApplication.name })
    .from(oauthApplication)
    .where(eq(oauthApplication.clientId, client_id))
    .limit(1);

  return (
    <div className="mx-auto max-w-md p-8">
      <h1 className="mb-6 font-serif text-2xl">Autoriser l'accès</h1>
      <ConsentForm
        clientName={client?.name ?? client_id}
        clientId={client_id}
        consentCode={consent_code}
      />
    </div>
  );
}
```

- [ ] **Step 6: Lancer le test et vérifier qu'il passe**

Run: `bun test tests/oauth-consent-form.test.ts`
Expected: PASS. (Si le rendu `Switch`/`Label` de shadcn diffère, ajuster les `toContain` sur le texte des libellés, pas sur la structure.)

- [ ] **Step 7: Inscrire le test pur, typecheck, test:pure**

Ajouter `"oauth-consent-form.test.ts"` au `PURE_FILES`.

Run: `bun run typecheck && bun run test:pure`
Expected: exit 0 + PASS.

- [ ] **Step 8: Commit**

```bash
git add lib/actions/mcp-oauth-actions.ts "app/(app)/oauth" components/oauth tests/oauth-consent-form.test.ts scripts/test-fast.ts
git commit -m "feat(mcp): page de consentement OAuth avec choix de portée"
```

---

## Task 7: Panneau « Connexions OAuth » + révocation

**Files:**
- Modify: `lib/actions/mcp-oauth-actions.ts` (ajouter `revokeOauthConnection`)
- Create: `components/settings/mcp/oauth-connections.tsx` (client)
- Modify: `app/(app)/settings/mcp/page.tsx` (monter le panneau)
- Test: `tests/oauth-connections-ui.test.ts` (pur, dom-harness)
- Modify: `scripts/test-fast.ts`

**Interfaces:**
- Consumes: `listOauthConnectionsCore`, `revokeOauthConnectionCore` (Task 4) ; `requireUser`, `can` (`lib/rbac.ts`) ; `OauthConnectionRow`.
- Produces: `revokeOauthConnection(scopeId: string): Promise<{ ok: boolean; message?: string }>` ; composant `OAuthConnections`.

- [ ] **Step 1: Écrire le test pur qui échoue (rendu de la liste)**

Créer `tests/oauth-connections-ui.test.ts` :

```ts
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { OAuthConnections } from "@/components/settings/mcp/oauth-connections";

const rows = [{
  id: "s1", userId: "u1", ownerName: "Awa", clientId: "c1", clientName: "Claude (web)",
  canWrite: true, canReadArticles: false, createdAt: new Date("2026-08-20"), lastUsedAt: null,
}];

test("liste le client, affiche le badge « Sans articles » et le bouton Révoquer", () => {
  const html = renderToStaticMarkup(<OAuthConnections connections={rows} showOwner={false} />);
  expect(html).toContain("Claude (web)");
  expect(html).toContain("Sans articles");
  expect(html).toContain("Révoquer");
});

test("état vide", () => {
  const html = renderToStaticMarkup(<OAuthConnections connections={[]} showOwner={false} />);
  expect(html).toContain("Aucune connexion");
});
```

- [ ] **Step 2: Lancer et vérifier l'échec**

Run: `bun test tests/oauth-connections-ui.test.ts`
Expected: FAIL — composant introuvable.

- [ ] **Step 3: Ajouter l'action de révocation**

Dans `lib/actions/mcp-oauth-actions.ts`, ajouter :

```ts
import { revalidatePath } from "next/cache";
import { can } from "@/lib/rbac";
import { revokeOauthConnectionCore } from "@/lib/queries/mcp-oauth";

export async function revokeOauthConnection(scopeId: string): Promise<{ ok: boolean; message?: string }> {
  const u = await requireUser();
  const seesAll = can(u.role, "video", "configure");
  const res = await revokeOauthConnectionCore({ scopeId, userId: u.id, seesAll });
  if (res.ok) revalidatePath("/settings/mcp");
  return res;
}
```

- [ ] **Step 4: Écrire le composant**

Créer `components/settings/mcp/oauth-connections.tsx` (miroir de `token-list.tsx` : `"use client"`, `ConfirmDialog` destructif, badges de portée, `useTransition` + `toast` + `router.refresh()`) :

```tsx
"use client";
import { useTransition } from "react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { revokeOauthConnection } from "@/lib/actions/mcp-oauth-actions";
import type { OauthConnectionRow } from "@/lib/queries/mcp-oauth";

export function OAuthConnections(
  { connections, showOwner }: { connections: OauthConnectionRow[]; showOwner: boolean },
) {
  const router = useRouter();
  const [pending, start] = useTransition();

  if (connections.length === 0) {
    return <p className="text-sm text-muted-foreground">Aucune connexion OAuth active.</p>;
  }

  return (
    <ul className="divide-y">
      {connections.map((c) => (
        <li key={c.id} className="flex items-center justify-between py-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="font-medium">{c.clientName ?? c.clientId}</span>
              {!c.canWrite && <Badge variant="secondary">Lecture seule</Badge>}
              {!c.canReadArticles && <Badge variant="secondary">Sans articles</Badge>}
            </div>
            <p className="text-xs text-muted-foreground">
              {showOwner && c.ownerName ? `${c.ownerName} · ` : ""}
              {c.lastUsedAt ? `Dernier appel ${c.lastUsedAt.toLocaleDateString("fr-FR")}` : "Jamais utilisée"}
            </p>
          </div>
          <ConfirmDialog
            trigger={<Button variant="ghost" size="sm" disabled={pending}>Révoquer</Button>}
            title="Révoquer cette connexion ?"
            description="Le client OAuth perdra immédiatement l'accès. Il devra être ré-autorisé."
            confirmLabel="Révoquer"
            destructive
            onConfirm={() => start(async () => {
              const res = await revokeOauthConnection(c.id);
              if (res.ok) { toast.success("Connexion révoquée."); router.refresh(); }
              else toast.error(res.message ?? "Échec de la révocation.");
            })}
          />
        </li>
      ))}
    </ul>
  );
}
```

Vérifier les chemins d'import réels (`@/components/confirm-dialog`, `sonner`) contre `token-list.tsx` et aligner si besoin.

- [ ] **Step 5: Monter le panneau dans la page réglages**

Dans `app/(app)/settings/mcp/page.tsx`, charger les connexions et rendre le panneau à côté de la liste des jetons. La page est un server component qui a déjà `requireUser()` + `seesAll`. Ajouter :

```tsx
import { listOauthConnectionsCore } from "@/lib/queries/mcp-oauth";
import { OAuthConnections } from "@/components/settings/mcp/oauth-connections";
// ... après avoir résolu `user` et `seesAll` :
const connections = await listOauthConnectionsCore({ userId: user.id, seesAll });
// ... dans le JSX, une nouvelle section :
<section className="space-y-3">
  <h2 className="font-serif text-lg">Connexions OAuth</h2>
  <p className="text-sm text-muted-foreground">
    Applications reliées via OAuth (claude.ai web). Révoquez pour couper l'accès.
  </p>
  <OAuthConnections connections={connections} showOwner={seesAll} />
</section>
```

Suivre le motif de la page pour récupérer `user`/`seesAll` (comme la liste des jetons). Ne pas dupliquer `requireUser`.

- [ ] **Step 6: Lancer les tests, inscrire le pur, typecheck**

Ajouter `"oauth-connections-ui.test.ts"` au `PURE_FILES`.

Run: `bun test tests/oauth-connections-ui.test.ts && bun run test:pure && bun run typecheck`
Expected: PASS + exit 0.

- [ ] **Step 7: Commit**

```bash
git add lib/actions/mcp-oauth-actions.ts components/settings/mcp/oauth-connections.tsx "app/(app)/settings/mcp/page.tsx" tests/oauth-connections-ui.test.ts scripts/test-fast.ts
git commit -m "feat(mcp): panneau Connexions OAuth avec révocation"
```

---

## Task 8: Mettre à jour la copie « claude.ai web »

**Files:**
- Modify: `components/settings/mcp/connection-panel.tsx:107-112`
- Test: le test couvrant `connection-panel` (probablement `tests/mcp-settings-ui.test.ts`) — mettre à jour l'assertion

**Interfaces:** aucune nouvelle.

- [ ] **Step 1: Mettre à jour le test d'abord**

Localiser le test qui vérifie la copie actuelle :

Run: `grep -rln "OAuth\|Authorization posé\|claude.ai" tests/`

Dans ce fichier, remplacer l'assertion qui attend « ne peut pas utiliser ces extraits » par une assertion attendant la nouvelle copie (ex. `expect(html).toContain("claude.ai (web) se connecte via OAuth")`). Lancer le test et vérifier qu'il ÉCHOUE contre l'ancienne copie.

Run: `bun test tests/mcp-settings-ui.test.ts` (ou le fichier trouvé)
Expected: FAIL.

- [ ] **Step 2: Mettre à jour la copie**

Dans `components/settings/mcp/connection-panel.tsx`, remplacer le bloc lignes 107-112 par :

```tsx
          <p className="text-xs text-muted-foreground">
            Remplacez {PLACEHOLDER} par un jeton créé ci-dessous — affiché une seule fois à sa
            création. claude.ai (web) se connecte via OAuth : ajoutez ce serveur comme connecteur
            MCP et autorisez l'accès depuis votre compte, sans coller de jeton. Claude Desktop et
            Claude Code utilisent le jeton porteur ci-dessus.
          </p>
```

- [ ] **Step 3: Lancer le test et vérifier qu'il passe**

Run: `bun test tests/mcp-settings-ui.test.ts`
Expected: PASS.

- [ ] **Step 4: test:pure + commit**

Run: `bun run test:pure && bun run typecheck`

```bash
git add components/settings/mcp/connection-panel.tsx tests/
git commit -m "feat(mcp): claude.ai web se connecte désormais via OAuth (copie réglages)"
```

---

## Task 9: Vérification finale

**Files:** aucun (vérification).

- [ ] **Step 1: Suite pure + typecheck + build**

Run: `bun run typecheck && bun run test:pure && bun run build`
Expected: exit 0 partout. Le build DOIT résoudre les routes `app/.well-known/...` et `app/(app)/oauth/authorize`.

- [ ] **Step 2: Tests DB ciblés**

Run: `bun test tests/oauth-scope-core.test.ts tests/oauth-plugin-mounted.test.ts tests/oauth-metadata-routes.test.ts`
Expected: PASS (nettoyage inclus — DB partagée). Ne pas lancer `bun test` complet (voie lente, infra-flaky).

- [ ] **Step 3: Preuve de bout en bout (navigateur / client MCP)**

Ce que les tests ne couvrent pas : la boucle DCR → authorize → consent → token → appel réel. Vérifier manuellement :
1. `GET /.well-known/oauth-protected-resource` et `/.well-known/oauth-authorization-server` renvoient du JSON cohérent (issuer = `BETTER_AUTH_URL`).
2. Depuis claude.ai web, ajouter le connecteur MCP pointant sur `<BETTER_AUTH_URL>/api/mcp` → il déclenche l'enregistrement dynamique, la connexion (login si besoin), puis la page de consentement `/oauth/authorize` avec les deux cases.
3. Décocher « Lire les articles », autoriser → un outil `list_video_projects` renvoie les projets mais nulle le titre d'article (portée articles refusée) ; un outil d'écriture fonctionne si le rôle le permet.
4. Réglages → MCP → « Connexions OAuth » liste la connexion ; Révoquer → un appel MCP suivant renvoie `401`.
5. Le chemin jeton personnel (Claude Desktop, en-tête Bearer) fonctionne toujours.

Consigner le résultat de chaque point.

- [ ] **Step 4: État du dépôt**

Run: `git status` (arbre propre) puis `git log --oneline main..HEAD`
Expected: la série de commits OAuth au-dessus de `main`, arbre propre.

---

## Self-Review (rempli à l'écriture du plan)

- **Couverture de la spec :** architecture porte unique (Task 5) ✓ ; modèle de portée par table + consentement (Tasks 2/4/6) ✓ ; flux DCR/authorize/token (Tasks 1/3 + config plugin) ✓ ; modèle de données 3 tables plugin + `mcp_oauth_scope` (Task 2) ✓ ; consentement UI (Task 6) ✓ ; révocation UI (Task 7) ✓ ; routes `.well-known` (Task 3) ✓ ; config + coupe-circuit (Tasks 1/5) ✓ ; gestion d'erreurs 401/503 (Task 5) ✓ ; copie claude.ai (Task 8) ✓ ; tests purs+intégration (toutes) ✓. Les 3 risques de la spec sont adressés : révocation par suppression directe (Task 4 Step 5), résolution `.well-known` (Task 3 Step 1 + doc citée), migration tables plugin (Task 2).
- **Placeholders :** aucun TODO/TBD ; chaque étape porte du code réel.
- **Cohérence des types :** `McpActor`/`AuthOutcome`/`McpScope` réutilisés tels quels ; `buildOauthActor`, `scopeFromRow`, `OauthConnectionRow`, `upsertOauthScopeCore`/`getOauthScopeCore`/`touchOauthScopeCore`/`listOauthConnectionsCore`/`revokeOauthConnectionCore`, `approveOauthConsent`/`denyOauthConsent`/`revokeOauthConnection` : signatures identiques entre définition et consommation.

Voir [[video-module-roadmap]] pour le découpage et [[execution-mode-subagent-driven]] pour le mode d'exécution.
