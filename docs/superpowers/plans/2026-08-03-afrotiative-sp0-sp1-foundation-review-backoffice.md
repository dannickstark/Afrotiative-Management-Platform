# Afrotiative SP0+SP1 — Foundation & Daily-Review Back-office — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the foundation and the daily-review back-office (Login → Dashboard → Review Queue → Article Editor + manual create) for Afrotiative Media, on a real Neon database with role-based auth, matching the validated spec.

**Architecture:** Next.js 16 App Router with React Server Components for reads and Server Actions for writes. Drizzle ORM against Neon (pooled connection). Better-Auth (admin plugin) for sessions + RBAC, enforced in server actions. The pipeline that *produces* articles and WordPress publishing are simulated via seed data + stub actions; their DB schema is built now so later segments (SP3/SP5) add only logic.

**Tech Stack:** TypeScript · **Bun** (runtime, package manager, TS executor, test runner) · Next.js 16.3.0 · React 19.2.8 · Tailwind v4.3.3 · shadcn/ui · Drizzle 0.45.2 / drizzle-kit 0.31.10 · `pg` 8.22.0 · Better-Auth 1.6.25 · Tiptap 3.29.2 · TanStack Table 8.21.3 · sonner 2.0.7 · zod 4.4.3 · next-themes 0.4.6 · lucide-react 1.28.0 · `bun:test`.

## Global Constraints

- **Runtime & toolchain: Bun (≥ 1.1).** Bun is the package manager (`bun install` / `bun add` / `bun add -d`), the script runner (`bun run <script>`), the TypeScript executor (`bun file.ts` — **no `tsx`/`ts-node`**), and the test runner (`bun test`, importing from `bun:test` — **no Vitest**). Next.js is launched through Bun with the `--bun` flag baked into the npm scripts so Next runs on the Bun runtime, not Node. **Bun auto-loads `.env.local`** into `process.env` — **no `dotenv`** is needed anywhere (app, scripts, tests, `drizzle.config.ts`). Bun reads `tsconfig.json` `paths`, so the `@/*` alias resolves in tests and scripts with no extra config.
- **Exact versions (pin these):** next@16.3.0, react@19.2.8, react-dom@19.2.8, tailwindcss@4.3.3, better-auth@1.6.25, drizzle-orm@0.45.2, drizzle-kit@0.31.10, pg@8.22.0, @tiptap/react@3.29.2, @tiptap/starter-kit@3.29.2, @tiptap/extension-link@3.29.2, @tanstack/react-table@8.21.3, sonner@2.0.7, zod@4.4.3, next-themes@0.4.6, lucide-react@1.28.0. Dev: drizzle-kit@0.31.10, @faker-js/faker@10.5.0, @types/pg, bun-types (latest). (Test runner and TS execution are built into Bun — no Vitest/tsx/dotenv/jsdom.)
- **Database:** use the **pooled** connection string (`DATABASE_URL`, host contains `-pooler`) in all app code and server actions; use **direct** (`DIRECT_URL`, no `-pooler`) only in `drizzle.config.ts` for migrations. Both already present in `.env.local`.
- **UI language: French.** All visible strings in French. Currency/context: panafricain business & finance.
- **Roles:** `admin`, `editor`, `journalist`. Role-gated actions are **hidden, not disabled** — a journalist never sees "Publier"/"Rejeter"/"Renvoyer à l'IA".
- **No self-signup.** Accounts are created by an admin (seeded for now).
- **Article status enum (exact values):** `draft`, `pending`, `in_review`, `approved`, `published`, `rejected`.
- **Authorization is enforced in server actions** (never rely on middleware alone — CVE-2025-29927). Keep Next.js patched.
- **Accent color:** one warm terracotta/amber, used only for primary actions and attention elements, never as a page background.
- **Every main screen** designs its loading / empty / error states, not only the happy path.
- **Destructive actions** (rejeter, dépublier, désactiver, supprimer) go through a confirmation dialog naming the consequence.
- **TDD where logic lives** (RBAC, server actions, auth, schema). UI screens end with a **manual verification step** driving the real app.

---

## File Structure

```
package.json, tsconfig.json, next.config.ts, postcss.config.mjs, components.json
bunfig.toml, drizzle.config.ts, .env.example
app/
  layout.tsx                      # root: html/body, ThemeProvider, Toaster, fonts
  globals.css                     # Tailwind v4 + design tokens (light/dark, accent, status)
  page.tsx                        # redirect → /dashboard or /login
  (auth)/login/page.tsx           # login form
  (app)/layout.tsx                # protected shell (auth guard + Sidebar + Topbar)
  (app)/dashboard/page.tsx
  (app)/queue/page.tsx
  (app)/article/[id]/page.tsx     # editor (review + read-only if published/locked)
  (app)/article/new/page.tsx      # manual create
  (app)/published/page.tsx        # placeholder (SP5)
  (app)/runs/page.tsx             # placeholder (SP4)
  (app)/calendar/page.tsx         # placeholder (SP5)
  (app)/settings/{feeds,taxonomy,team,integrations}/page.tsx  # placeholders (SP2)
components/
  ui/*                            # shadcn primitives (generated via CLI)
  shell/{sidebar.tsx, topbar.tsx, role-badge.tsx, theme-toggle.tsx, nav-items.ts}
  status-badge.tsx                # shared status → color mapping
  confirm-dialog.tsx              # reusable destructive-action confirm
  dashboard/{summary-cards.tsx, pending-list.tsx, error-list.tsx, empty-state.tsx}
  queue/{queue-table.tsx, columns.tsx, queue-filters.tsx, confidence-badge.tsx, row-actions.tsx}
  article/{editor-shell.tsx, rich-editor.tsx, editor-toolbar.tsx, action-bar.tsx,
           side-panel.tsx, image-panel.tsx, category-select.tsx, tags-input.tsx,
           sources-list.tsx, excerpt-field.tsx, history-panel.tsx, lock-banner.tsx}
db/
  index.ts                        # pooled Drizzle client
  schema.ts                       # ALL tables + enums
  seed.ts                         # realistic French seed data
lib/
  auth.ts                         # Better-Auth server instance + access control
  auth-client.ts                  # Better-Auth React client
  rbac.ts                         # can()/requirePermission() + role labels
  session.ts                      # getSession()/requireUser() helpers
  actions/
    article-actions.ts            # save/lock/reject/regenerate/approve/schedule (server actions)
    queue-actions.ts              # quick approve/reject from the queue
  queries/
    dashboard.ts, queue.ts, article.ts   # typed read helpers (RSC)
  format.ts                       # date/status/label formatting (fr)
tests/
  rbac.test.ts, auth.test.ts, article-actions.test.ts, schema.test.ts
```

---

## Task 1: Project scaffold & Bun tooling

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `postcss.config.mjs`, `app/layout.tsx`, `app/globals.css`, `app/page.tsx`, `bunfig.toml`, `.env.example`, `components.json`
- Test: `tests/smoke.test.ts`

**Interfaces:**
- Produces: a booting Next.js app running on the Bun runtime; `bun run dev/build/typecheck`, `bun test`, `bun run db:*` scripts; path alias `@/*`.

- [ ] **Step 1: Scaffold Next.js in the current directory (Bun)**

Bun must be installed (`bun --version`; if missing: `curl -fsSL https://bun.sh/install | bash`). The repo already contains the two source `.md` docs, `.gitignore`, `.env.local`, and `docs/`. Scaffold into this non-empty dir via a temp folder then move:

```bash
bunx create-next-app@16.3.0 .afrotmp --ts --tailwind --app --src-dir=false --import-alias "@/*" --use-bun --no-eslint --turbopack --yes
# move generated files up, keeping our existing files
rsync -a --ignore-existing .afrotmp/ ./ && cp -f .afrotmp/tsconfig.json .afrotmp/next.config.* .afrotmp/postcss.config.* .afrotmp/package.json ./ && rm -rf .afrotmp
```

- [ ] **Step 2: Pin dependencies and add scripts (Bun)**

Run:
```bash
bun add next@16.3.0 react@19.2.8 react-dom@19.2.8 drizzle-orm@0.45.2 pg@8.22.0 better-auth@1.6.25 \
  @tiptap/react@3.29.2 @tiptap/starter-kit@3.29.2 @tiptap/extension-link@3.29.2 \
  @tanstack/react-table@8.21.3 sonner@2.0.7 zod@4.4.3 next-themes@0.4.6 lucide-react@1.28.0
bun add -d tailwindcss@4.3.3 drizzle-kit@0.31.10 @faker-js/faker@10.5.0 @types/pg bun-types
```

Edit `package.json` scripts (`--bun` forces Next onto the Bun runtime; `bun test` and `bun db/seed.ts` need no extra tooling):
```json
{
  "scripts": {
    "dev": "bun --bun next dev --turbopack",
    "build": "bun --bun next build",
    "start": "bun --bun next start",
    "typecheck": "tsc --noEmit",
    "test": "bun test",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate",
    "db:push": "drizzle-kit push",
    "db:seed": "bun db/seed.ts"
  }
}
```

Also ensure `tsconfig.json` has `"types": ["bun-types"]` in `compilerOptions` (so `bun:test` and Bun globals typecheck).

- [ ] **Step 3: Bun test config**

`bun test` needs no config file — it discovers `*.test.ts`, reads `tsconfig.json` `paths` for the `@/*` alias, and **auto-loads `.env.local`**. Create a minimal `bunfig.toml` only to keep test settings explicit and future-proof:
```toml
[test]
# Bun auto-loads .env.local; tests hit the real Neon DB via DATABASE_URL.
# Run DB-touching tests serially to avoid cross-test row contention.
```
> No `vitest.config.ts`, `vitest.setup.ts`, or `dotenv` — Bun replaces all three.

- [ ] **Step 4: Write a smoke test**

Create `tests/smoke.test.ts`:
```ts
import { expect, test } from "bun:test";

test("environment is wired", () => {
  expect(1 + 1).toBe(2);
});
```

- [ ] **Step 5: Create `.env.example` (documents required vars, no secrets)**

```bash
# Neon Postgres — pooled (app) and direct (migrations)
DATABASE_URL="postgresql://user:pass@HOST-pooler.neon.tech/db?sslmode=require"
DIRECT_URL="postgresql://user:pass@HOST.neon.tech/db?sslmode=require"
# Better-Auth
BETTER_AUTH_SECRET="generate-with: openssl rand -base64 32"
BETTER_AUTH_URL="http://localhost:3000"
```

- [ ] **Step 6: Run test + build + typecheck**

Run: `bun test && bun run typecheck && bun run build`
Expected: smoke test PASSES, typecheck clean, build succeeds.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "chore: scaffold Next.js 16 app with Bun toolchain, Tailwind, Drizzle"
```

---

## Task 2: Database client, full schema & migration

**Files:**
- Create: `db/index.ts`, `db/schema.ts`, `drizzle.config.ts`
- Test: `tests/schema.test.ts`

**Interfaces:**
- Produces: `db` (Drizzle client), and typed tables/enums: `user, session, account, verification, feeds, rawItems, articles, articleSources, articleTags, articleRevisions, articleEmbeddings, clusters, wpCategories, wpTags, pipelineRuns, pipelineSteps, distributions`; enums `articleStatus` (`draft|pending|in_review|approved|published|rejected`), `feedFetchStatus` (`ok|error|never`), `pipelineStatus` (`success|partial|failed|running`), `distributionStatus` (`stubbed|pending|sent|failed`).

- [ ] **Step 1: Create the pooled Drizzle client**

`db/index.ts`:
```ts
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool, { schema });
export * from "./schema";
```

- [ ] **Step 2: Write the full schema**

`db/schema.ts`:
```ts
import {
  pgTable, pgEnum, text, boolean, timestamp, integer, jsonb, uuid, vector, index,
} from "drizzle-orm/pg-core";

// ---- enums ----
export const articleStatus = pgEnum("article_status", [
  "draft", "pending", "in_review", "approved", "published", "rejected",
]);
export const feedFetchStatus = pgEnum("feed_fetch_status", ["ok", "error", "never"]);
export const pipelineStatus = pgEnum("pipeline_status", ["success", "partial", "failed", "running"]);
export const distributionStatus = pgEnum("distribution_status", ["stubbed", "pending", "sent", "failed"]);
export const userRole = pgEnum("user_role", ["admin", "editor", "journalist"]);

// ---- Better-Auth tables ----
export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  role: userRole("role").notNull().default("journalist"),
  banned: boolean("banned").notNull().default(false),
  banReason: text("ban_reason"),
  banExpires: timestamp("ban_expires"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  lastLoginAt: timestamp("last_login_at"),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  impersonatedBy: text("impersonated_by"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  password: text("password"),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ---- taxonomy mirror ----
export const wpCategories = pgTable("wp_categories", {
  id: uuid("id").primaryKey().defaultRandom(),
  wpId: integer("wp_id"),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  articleCount: integer("article_count").notNull().default(0),
});

export const wpTags = pgTable("wp_tags", {
  id: uuid("id").primaryKey().defaultRandom(),
  wpId: integer("wp_id"),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  articleCount: integer("article_count").notNull().default(0),
});

// ---- feeds & raw items ----
export const feeds = pgTable("feeds", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  feedUrl: text("feed_url").notNull(),
  siteUrl: text("site_url"),
  active: boolean("active").notNull().default(true),
  lastFetchAt: timestamp("last_fetch_at"),
  lastFetchStatus: feedFetchStatus("last_fetch_status").notNull().default("never"),
  itemsCaptured7d: integer("items_captured_7d").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const rawItems = pgTable("raw_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  feedId: uuid("feed_id").notNull().references(() => feeds.id, { onDelete: "cascade" }),
  guid: text("guid").notNull(),
  url: text("url").notNull(),
  contentHash: text("content_hash").notNull(),
  rawTitle: text("raw_title"),
  rawBody: text("raw_body"),
  fetchedAt: timestamp("fetched_at").notNull().defaultNow(),
}, (t) => [index("raw_items_hash_idx").on(t.contentHash)]);

// ---- clusters ----
export const clusters = pgTable("clusters", {
  id: uuid("id").primaryKey().defaultRandom(),
  label: text("label"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ---- articles ----
export const articles = pgTable("articles", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  bodyHtml: text("body_html").notNull().default(""),
  excerpt: text("excerpt"),
  status: articleStatus("status").notNull().default("pending"),
  categoryId: uuid("category_id").references(() => wpCategories.id),
  featuredImageUrl: text("featured_image_url"),
  imageCredit: text("image_credit"),
  imageSourceUrl: text("image_source_url"),
  aiAuthor: boolean("ai_author").notNull().default(true),
  createdBy: text("created_by").references(() => user.id),
  clusterId: uuid("cluster_id").references(() => clusters.id),
  confidenceFlags: jsonb("confidence_flags").$type<{
    categoryUncertain?: boolean; imageMissing?: boolean; clusterUncertain?: boolean;
  }>().notNull().default({}),
  lockedBy: text("locked_by").references(() => user.id),
  lockedAt: timestamp("locked_at"),
  rejectReason: text("reject_reason"),
  generatedAt: timestamp("generated_at"),
  scheduledAt: timestamp("scheduled_at"),
  publishedAt: timestamp("published_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [index("articles_status_idx").on(t.status)]);

export const articleSources = pgTable("article_sources", {
  id: uuid("id").primaryKey().defaultRandom(),
  articleId: uuid("article_id").notNull().references(() => articles.id, { onDelete: "cascade" }),
  mediaName: text("media_name").notNull(),
  url: text("url").notNull(),
});

export const articleTags = pgTable("article_tags", {
  id: uuid("id").primaryKey().defaultRandom(),
  articleId: uuid("article_id").notNull().references(() => articles.id, { onDelete: "cascade" }),
  tagName: text("tag_name").notNull(),
  isNew: boolean("is_new").notNull().default(false),
});

export const articleRevisions = pgTable("article_revisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  articleId: uuid("article_id").notNull().references(() => articles.id, { onDelete: "cascade" }),
  actorId: text("actor_id").references(() => user.id),
  action: text("action").notNull(), // e.g. "généré", "modifié", "approuvé", "rejeté"
  detail: text("detail"),
  at: timestamp("at").notNull().defaultNow(),
});

export const articleEmbeddings = pgTable("article_embeddings", {
  articleId: uuid("article_id").primaryKey().references(() => articles.id, { onDelete: "cascade" }),
  embedding: vector("embedding", { dimensions: 1024 }),
}, (t) => [index("article_embeddings_hnsw").using("hnsw", t.embedding.op("vector_cosine_ops"))]);

// ---- pipeline observability ----
export const pipelineRuns = pgTable("pipeline_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  triggeredBy: text("triggered_by").notNull().default("scheduled"), // scheduled | manual
  status: pipelineStatus("status").notNull().default("running"),
  feedsRead: integer("feeds_read").notNull().default(0),
  newItems: integer("new_items").notNull().default(0),
  published: integer("published").notNull().default(0),
  startedAt: timestamp("started_at").notNull().defaultNow(),
  finishedAt: timestamp("finished_at"),
});

export const pipelineSteps = pgTable("pipeline_steps", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id").notNull().references(() => pipelineRuns.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  status: pipelineStatus("status").notNull(),
  durationMs: integer("duration_ms"),
  errorMessage: text("error_message"),   // human-readable
  errorTechnical: text("error_technical"), // stack/detail behind "voir détails"
});

// ---- distributions (pluggable publish targets) ----
export const distributions = pgTable("distributions", {
  id: uuid("id").primaryKey().defaultRandom(),
  articleId: uuid("article_id").notNull().references(() => articles.id, { onDelete: "cascade" }),
  channel: text("channel").notNull().default("wordpress"),
  status: distributionStatus("status").notNull().default("stubbed"),
  externalId: text("external_id"),
  at: timestamp("at").notNull().defaultNow(),
});
```

- [ ] **Step 3: Create drizzle config (uses DIRECT url for migrations)**

`drizzle.config.ts` (run via `bunx drizzle-kit …`, so Bun has already loaded `.env.local` into `process.env` — no dotenv):
```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./db/schema.ts",
  out: "./db/migrations",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DIRECT_URL! },
});
```
> The drizzle-kit scripts (`db:generate`/`db:push`/`db:migrate`) must be invoked through Bun (`bun run db:push`) so `.env.local` is present. If you ever call `drizzle-kit` via another runner, prefix `DIRECT_URL=... `.

- [ ] **Step 4: Enable pgvector, generate & push migration**

Run (Bun auto-loads `.env.local`, so no dotenv needed):
```bash
# enable the extension on Neon (SQL name is "vector") via a one-off bun script
bun -e "import {Client} from 'pg';const c=new Client({connectionString:process.env.DIRECT_URL});await c.connect();await c.query('CREATE EXTENSION IF NOT EXISTS vector;');await c.end();console.log('vector enabled')"
bun run db:generate
bun run db:push
```
Expected: migration files generated in `db/migrations`, push reports tables created.

> Note: if drizzle-kit generates the `vector` column before the extension is guaranteed, keep the explicit `CREATE EXTENSION` step **before** `db:push`.

- [ ] **Step 5: Write schema integration test**

`tests/schema.test.ts`:
```ts
import { describe, it, expect, afterAll } from "bun:test";
import { db, feeds } from "@/db";
import { eq } from "drizzle-orm";

describe("schema", () => {
  const marker = "TEST_FEED_ZZZ";
  afterAll(async () => { await db.delete(feeds).where(eq(feeds.name, marker)); });

  it("inserts and reads a feed round-trip", async () => {
    const [row] = await db.insert(feeds)
      .values({ name: marker, feedUrl: "https://example.com/rss" })
      .returning();
    expect(row.id).toBeTruthy();
    expect(row.active).toBe(true);
    expect(row.lastFetchStatus).toBe("never");
  });
});
```

- [ ] **Step 6: Run the test**

Run: `bun test tests/schema.test.ts`
Expected: PASS (connects to Neon via pooled URL, round-trips a row).

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(db): full platform schema, pooled Drizzle client, pgvector, migration"
```

---

## Task 3: Better-Auth server, client & access control

**Files:**
- Create: `lib/auth.ts`, `lib/auth-client.ts`, `lib/session.ts`, `lib/create-user.ts`, `app/api/auth/[...all]/route.ts`
- Test: `tests/auth.test.ts`

**Interfaces:**
- Produces:
  - `auth` (Better-Auth server instance) with admin plugin + access control statements `{ article, feed, taxonomy, team, pipeline }` and roles `admin/editor/journalist`.
  - `authClient` with `signIn`, `signOut`, `useSession`.
  - `getSession(): Promise<Session | null>` and `requireUser(): Promise<UserWithRole>` (redirects to `/login` if absent).
  - Exported `Role = "admin" | "editor" | "journalist"`.

- [ ] **Step 1: Access-control statements & roles**

Create `lib/permissions.ts`:
```ts
import { createAccessControl } from "better-auth/plugins/access";

export const statement = {
  article: ["create", "edit", "approve", "publish", "reject", "regenerate"],
  feed: ["read", "manage"],
  taxonomy: ["read", "manage"],
  team: ["read", "manage"],
  pipeline: ["read", "configure"],
} as const;

export const ac = createAccessControl(statement);

export const journalist = ac.newRole({
  article: ["create", "edit"],
  feed: ["read"], taxonomy: ["read"],
});
export const editor = ac.newRole({
  article: ["create", "edit", "approve", "publish", "reject", "regenerate"],
  feed: ["read", "manage"], taxonomy: ["read", "manage"], pipeline: ["read"],
});
export const admin = ac.newRole({
  article: ["create", "edit", "approve", "publish", "reject", "regenerate"],
  feed: ["read", "manage"], taxonomy: ["read", "manage"],
  team: ["read", "manage"], pipeline: ["read", "configure"],
});
```

- [ ] **Step 2: Better-Auth server instance**

Create `lib/auth.ts`:
```ts
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin as adminPlugin } from "better-auth/plugins";
import { db } from "@/db";
import * as schema from "@/db/schema";
import { ac, admin, editor, journalist } from "./permissions";

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg", schema }),
  emailAndPassword: { enabled: true, disableSignUp: true },
  plugins: [
    adminPlugin({
      ac,
      roles: { admin, editor, journalist },
      defaultRole: "journalist",
      adminRoles: ["admin"],
    }),
  ],
  session: { expiresIn: 60 * 60 * 24 * 7 },
});

export type Role = "admin" | "editor" | "journalist";
```

- [ ] **Step 3: Route handler + React client**

Create `app/api/auth/[...all]/route.ts`:
```ts
import { auth } from "@/lib/auth";
import { toNextJsHandler } from "better-auth/next-js";
export const { GET, POST } = toNextJsHandler(auth);
```

Create `lib/auth-client.ts`:
```ts
"use client";
import { createAuthClient } from "better-auth/react";
import { adminClient } from "better-auth/client/plugins";
import { ac, admin, editor, journalist } from "./permissions";

export const authClient = createAuthClient({
  plugins: [adminClient({ ac, roles: { admin, editor, journalist } })],
});
export const { signIn, signOut, useSession } = authClient;
```

- [ ] **Step 4: Session helpers**

Create `lib/session.ts`:
```ts
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth, type Role } from "./auth";

export async function getSession() {
  return auth.api.getSession({ headers: await headers() });
}

export type SessionUser = { id: string; name: string; email: string; role: Role; banned: boolean };

export async function requireUser(): Promise<SessionUser> {
  const s = await getSession();
  if (!s?.user) redirect("/login");
  return s.user as unknown as SessionUser;
}
```

Create `lib/create-user.ts` — session-free credential-user creation (avoids the admin-plugin bootstrap deadlock: `auth.api.createUser` needs an existing admin session, impossible for the first user). Hashes via Better-Auth's own context and inserts `user` + `account` rows directly:
```ts
import { randomUUID } from "node:crypto";
import { auth, type Role } from "./auth";
import { db, user, account } from "@/db";

export async function createCredentialUser(input: { email: string; name: string; role: Role; password: string }) {
  const ctx = await auth.$context;
  const hash = await ctx.password.hash(input.password);
  const id = randomUUID();
  await db.insert(user).values({ id, email: input.email, name: input.name, role: input.role, emailVerified: true });
  await db.insert(account).values({ id: randomUUID(), userId: id, accountId: id, providerId: "credential", password: hash });
  return id;
}
```

- [ ] **Step 5: Auth integration test (valid / wrong password / disabled)**

`tests/auth.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { auth } from "@/lib/auth";
import { createCredentialUser } from "@/lib/create-user";
import { db, user } from "@/db";
import { eq } from "drizzle-orm";

const email = "auth_test@afrotiative.test";
const password = "Test1234!secure";

describe("auth", () => {
  beforeAll(async () => {
    await db.delete(user).where(eq(user.email, email));
    await createCredentialUser({ email, password, name: "Auth Test", role: "editor" });
  });
  afterAll(async () => { await db.delete(user).where(eq(user.email, email)); });

  it("signs in with correct credentials", async () => {
    const res = await auth.api.signInEmail({ body: { email, password } });
    expect(res.user.email).toBe(email);
  });

  it("rejects a wrong password", async () => {
    await expect(auth.api.signInEmail({ body: { email, password: "wrong-pass-000" } }))
      .rejects.toThrow();
  });
});
```

- [ ] **Step 6: Run the test**

Run: `bun test tests/auth.test.ts`
Expected: PASS (correct sign-in works, wrong password throws).

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(auth): Better-Auth with admin plugin, RBAC statements, session helpers"
```

---

## Task 4: Seed data

**Files:**
- Create: `db/seed.ts`
- Test: manual (run the script; assert row counts)

**Interfaces:**
- Consumes: `createCredentialUser` (from `lib/create-user.ts`), all schema tables.
- Produces: 3 users (admin/editor/journalist), 6 feeds (mixed health), ~8 categories, ~15 tags, ~25 articles across every status incl. low-confidence, sources/tags/revisions, 3 pipeline runs incl. one failed.

- [ ] **Step 1: Write the seed script**

`db/seed.ts` (idempotent: clears app tables first, recreates users; run via `bun run db:seed`, so `.env.local` is auto-loaded — no dotenv):
```ts
import { db } from "@/db";
import {
  feeds, articles, articleSources, articleTags, articleRevisions,
  wpCategories, wpTags, clusters, pipelineRuns, pipelineSteps, distributions, user,
} from "@/db/schema";
import { createCredentialUser } from "@/lib/create-user";
import { inArray } from "drizzle-orm";

const CATS = ["Économie", "Finance", "Marchés", "Startups & Tech", "Énergie",
  "Politique économique", "Entreprises", "International"];
const TAGS = ["BRVM", "FCFA", "BCEAO", "pétrole", "fintech", "inflation", "BAD",
  "zone franc", "mobile money", "or", "cacao", "Nigeria", "Cameroun", "UEMOA", "dette"];

async function main() {
  // wipe app tables (keep migrations)
  await db.delete(distributions); await db.delete(pipelineSteps); await db.delete(pipelineRuns);
  await db.delete(articleRevisions); await db.delete(articleTags); await db.delete(articleSources);
  await db.delete(articles); await db.delete(clusters); await db.delete(feeds);
  await db.delete(wpTags); await db.delete(wpCategories);

  const seedUsers = [
    { email: "admin@afrotiative.com", name: "Awa Diallo", role: "admin" as const },
    { email: "editor@afrotiative.com", name: "Koffi Mensah", role: "editor" as const },
    { email: "journaliste@afrotiative.com", name: "Zara Okonkwo", role: "journalist" as const },
  ];
  for (const u of seedUsers) {
    await db.delete(user).where(inArray(user.email, [u.email]));
    await createCredentialUser({ ...u, password: "Afrotiative2026!" });
  }
  const [admin] = await db.select().from(user).where(inArray(user.email, ["admin@afrotiative.com"]));

  const cats = await db.insert(wpCategories).values(
    CATS.map((name, i) => ({ name, slug: name.toLowerCase().replace(/[^a-z]+/g, "-"), wpId: i + 1 }))
  ).returning();
  await db.insert(wpTags).values(
    TAGS.map((name, i) => ({ name, slug: name.toLowerCase().replace(/[^a-z]+/g, "-"), wpId: i + 1 }))
  );

  await db.insert(feeds).values([
    { name: "Financial Afrik", feedUrl: "https://www.financialafrik.com/feed/", siteUrl: "https://www.financialafrik.com", lastFetchStatus: "ok", itemsCaptured7d: 34, lastFetchAt: new Date(Date.now() - 36e5) },
    { name: "Jeune Afrique — Éco", feedUrl: "https://www.jeuneafrique.com/economie/feed/", siteUrl: "https://www.jeuneafrique.com", lastFetchStatus: "ok", itemsCaptured7d: 51, lastFetchAt: new Date(Date.now() - 72e5) },
    { name: "Agence Ecofin", feedUrl: "https://www.agenceecofin.com/rss", siteUrl: "https://www.agenceecofin.com", lastFetchStatus: "ok", itemsCaptured7d: 78, lastFetchAt: new Date(Date.now() - 18e5) },
    { name: "Sika Finance", feedUrl: "https://www.sikafinance.com/rss", siteUrl: "https://www.sikafinance.com", lastFetchStatus: "error", itemsCaptured7d: 0, lastFetchAt: new Date(Date.now() - 864e5) },
    { name: "La Tribune Afrique", feedUrl: "https://afrique.latribune.fr/feed", siteUrl: "https://afrique.latribune.fr", lastFetchStatus: "ok", itemsCaptured7d: 22, lastFetchAt: new Date(Date.now() - 54e5) },
    { name: "Bloomberg Africa", feedUrl: "https://www.bloomberg.com/africa/rss", siteUrl: "https://www.bloomberg.com", lastFetchStatus: "never", itemsCaptured7d: 0 },
  ]);

  // helper to build one article
  const statuses = ["pending","pending","pending","in_review","approved","published","rejected","draft"] as const;
  const rows = Array.from({ length: 25 }).map((_, i) => {
    const status = statuses[i % statuses.length];
    const cat = cats[i % cats.length];
    const lowConf = i % 5 === 0;
    return {
      title: SAMPLE_TITLES[i % SAMPLE_TITLES.length],
      bodyHtml: `<p>${SAMPLE_BODY}</p><h2>Contexte</h2><p>${SAMPLE_BODY}</p>`,
      excerpt: SAMPLE_TITLES[i % SAMPLE_TITLES.length].slice(0, 120),
      status,
      categoryId: lowConf ? null : cat.id,
      featuredImageUrl: lowConf ? null : `https://picsum.photos/seed/afro${i}/800/450`,
      imageCredit: lowConf ? null : "Financial Afrik",
      imageSourceUrl: lowConf ? null : "https://www.financialafrik.com",
      aiAuthor: status !== "draft",
      createdBy: admin.id,
      confidenceFlags: lowConf ? { categoryUncertain: true, imageMissing: true } : {},
      generatedAt: new Date(Date.now() - (i + 1) * 36e5),
      publishedAt: status === "published" ? new Date(Date.now() - i * 36e5) : null,
    };
  });
  const inserted = await db.insert(articles).values(rows).returning();

  for (const a of inserted) {
    await db.insert(articleSources).values([
      { articleId: a.id, mediaName: "Financial Afrik", url: "https://www.financialafrik.com/article" },
      { articleId: a.id, mediaName: "Agence Ecofin", url: "https://www.agenceecofin.com/article" },
    ]);
    await db.insert(articleTags).values([
      { articleId: a.id, tagName: "BRVM", isNew: false },
      { articleId: a.id, tagName: "prévisions 2026", isNew: true },
    ]);
    await db.insert(articleRevisions).values({ articleId: a.id, actorId: admin.id, action: "généré par IA" });
  }

  const [run1] = await db.insert(pipelineRuns).values(
    { triggeredBy: "scheduled", status: "failed", feedsRead: 6, newItems: 12, published: 0, finishedAt: new Date(Date.now() - 6e5) }
  ).returning();
  await db.insert(pipelineSteps).values([
    { runId: run1.id, name: "Lecture des flux", status: "success", durationMs: 1840 },
    { runId: run1.id, name: "Extraction du contenu", status: "failed", durationMs: 5200,
      errorMessage: "L'extraction du contenu a échoué pour Sika Finance (le site n'a pas répondu à temps).",
      errorTechnical: "FetchError: ETIMEDOUT https://www.sikafinance.com after 30000ms" },
  ]);
  await db.insert(pipelineRuns).values([
    { triggeredBy: "scheduled", status: "success", feedsRead: 6, newItems: 8, published: 3, finishedAt: new Date(Date.now() - 9e6) },
    { triggeredBy: "manual", status: "partial", feedsRead: 6, newItems: 5, published: 2, finishedAt: new Date(Date.now() - 18e6) },
  ]);

  console.log(`Seed OK: ${inserted.length} articles, ${seedUsers.length} users.`);
  process.exit(0);
}

const SAMPLE_TITLES = [
  "La BRVM franchit un nouveau record porté par le secteur bancaire",
  "Zone franc : la BCEAO maintient son taux directeur face à l'inflation",
  "Mobile money : le Cameroun dépasse les 20 millions de comptes actifs",
  "Pétrole : le Nigeria révise à la hausse ses prévisions de production",
  "Fintech ouest-africaine : une levée de fonds record pour une startup ivoirienne",
  "Cacao : les cours mondiaux repartent à la hausse avant la récolte",
  "La BAD approuve un prêt de 300 M$ pour l'énergie solaire au Sahel",
  "UEMOA : la dette publique régionale sous surveillance du FMI",
];
const SAMPLE_BODY = "Selon plusieurs sources concordantes, l'évolution récente confirme une tendance de fond sur les marchés régionaux, avec des implications pour les investisseurs et les décideurs publics.";

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run the seed**

Run: `bun run db:seed`
Expected: prints `Seed OK: 25 articles, 3 users.`

- [ ] **Step 3: Verify counts**

Run:
```bash
bun -e "import {db,articles,user,feeds} from './db';console.log('articles',(await db.select().from(articles)).length);console.log('users',(await db.select().from(user)).length);console.log('feeds',(await db.select().from(feeds)).length);process.exit(0)"
```
Expected: articles 25, users 3, feeds 6.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(db): realistic French newsroom seed data"
```

---

## Task 5: Design tokens & theme

**Files:**
- Modify: `app/globals.css`, `app/layout.tsx`
- Create: `components/theme-provider.tsx`, `components/status-badge.tsx`, `lib/format.ts`
- Test: `tests/status-badge.test.tsx` (mapping is pure)

**Interfaces:**
- Produces: CSS variables for light/dark + `--accent` (terracotta) + status colors; `<StatusBadge status="pending" />`; `statusLabel(status)`, `formatDate(d)` in `lib/format.ts`.

- [ ] **Step 1: shadcn init + base primitives**

Run:
```bash
bunx shadcn@latest init -d
bunx shadcn@latest add button card badge table dialog sheet select input textarea \
  dropdown-menu avatar tabs sonner tooltip label separator skeleton command popover
```

- [ ] **Step 2: Design tokens in `app/globals.css`**

Append after shadcn's `@theme`/`:root` block (keep shadcn's variables; add accent + status):
```css
:root {
  --accent-brand: oklch(0.62 0.15 47);          /* terracotta/amber — actions only */
  --accent-brand-foreground: oklch(0.98 0 0);
  --status-draft: oklch(0.55 0.02 260);
  --status-pending: oklch(0.75 0.15 75);        /* amber */
  --status-in-review: oklch(0.55 0.16 265);     /* indigo */
  --status-approved: oklch(0.62 0.16 150);      /* green */
  --status-published: oklch(0.62 0.16 150);
  --status-rejected: oklch(0.58 0.20 25);       /* red */
  --status-error: oklch(0.55 0.22 20);
}
.dark {
  --accent-brand: oklch(0.68 0.15 47);
}
```

- [ ] **Step 3: Theme provider + root layout with fonts**

`components/theme-provider.tsx`:
```tsx
"use client";
import { ThemeProvider as NextThemesProvider } from "next-themes";
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return <NextThemesProvider attribute="class" defaultTheme="system" enableSystem>{children}</NextThemesProvider>;
}
```

`app/layout.tsx`:
```tsx
import type { Metadata } from "next";
import { Inter, Lora } from "next/font/google";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-sans" });
const lora = Lora({ subsets: ["latin"], variable: "--font-editorial" });

export const metadata: Metadata = {
  title: "Afrotiative Media — Console éditoriale",
  description: "Plateforme interne de gestion de contenu",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr" suppressHydrationWarning className={`${inter.variable} ${lora.variable}`}>
      <body className="font-sans antialiased">
        <ThemeProvider>{children}</ThemeProvider>
        <Toaster richColors position="top-right" />
      </body>
    </html>
  );
}
```

- [ ] **Step 4: Status badge + formatters**

`lib/format.ts`:
```ts
export type ArticleStatus = "draft" | "pending" | "in_review" | "approved" | "published" | "rejected";

export const STATUS_LABEL: Record<ArticleStatus, string> = {
  draft: "Brouillon", pending: "En attente", in_review: "En relecture",
  approved: "Approuvé", published: "Publié", rejected: "Rejeté",
};

export function statusLabel(s: ArticleStatus) { return STATUS_LABEL[s]; }

export function formatDate(d: Date | string | null): string {
  if (!d) return "—";
  return new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(d));
}
export function relativeDate(d: Date | string | null): string {
  if (!d) return "—";
  const diff = (Date.now() - new Date(d).getTime()) / 1000;
  const h = Math.round(diff / 3600);
  if (h < 1) return "à l'instant";
  if (h < 24) return `il y a ${h} h`;
  return `il y a ${Math.round(h / 24)} j`;
}
```

`components/status-badge.tsx`:
```tsx
import { Badge } from "@/components/ui/badge";
import { statusLabel, type ArticleStatus } from "@/lib/format";

const STYLE: Record<ArticleStatus, string> = {
  draft: "bg-[var(--status-draft)]/15 text-[var(--status-draft)] border-[var(--status-draft)]/30",
  pending: "bg-[var(--status-pending)]/15 text-[var(--status-pending)] border-[var(--status-pending)]/30",
  in_review: "bg-[var(--status-in-review)]/15 text-[var(--status-in-review)] border-[var(--status-in-review)]/30",
  approved: "bg-[var(--status-approved)]/15 text-[var(--status-approved)] border-[var(--status-approved)]/30",
  published: "bg-[var(--status-published)]/15 text-[var(--status-published)] border-[var(--status-published)]/30",
  rejected: "bg-[var(--status-rejected)]/15 text-[var(--status-rejected)] border-[var(--status-rejected)]/30",
};

export function StatusBadge({ status }: { status: ArticleStatus }) {
  return <Badge variant="outline" className={STYLE[status]}>{statusLabel(status)}</Badge>;
}
```

- [ ] **Step 5: Test the pure status mapping (no DOM)**

Test the label/style mapping as pure data — no React rendering, so `bun test` needs no DOM setup. `tests/status.test.ts`:
```ts
import { describe, it, expect } from "bun:test";
import { STATUS_LABEL, statusLabel, type ArticleStatus } from "@/lib/format";

const ALL: ArticleStatus[] = ["draft", "pending", "in_review", "approved", "published", "rejected"];

describe("status mapping", () => {
  it("has a French label for every status value", () => {
    for (const s of ALL) expect(STATUS_LABEL[s].length).toBeGreaterThan(0);
    expect(statusLabel("pending")).toBe("En attente");
    expect(statusLabel("rejected")).toBe("Rejeté");
  });
});
```
> Component rendering is validated in the end-to-end verification pass (Task 15), not with a DOM test runner — Bun stays dependency-free here.

- [ ] **Step 6: Run test + typecheck**

Run: `bun test tests/status.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(ui): design tokens, theme provider, status badge, fr formatters"
```

---

## Task 6: RBAC helpers & role-visibility

**Files:**
- Create: `lib/rbac.ts`, `components/role-gate.tsx`
- Test: `tests/rbac.test.ts`

**Interfaces:**
- Produces:
  - `can(role: Role, resource, action): boolean`
  - `requirePermission(user, resource, action): void` (throws `PermissionError` if denied)
  - `ROLE_LABEL: Record<Role, string>`
  - `<RoleGate allow={["admin","editor"]}>…</RoleGate>` (client, hides children for other roles)

- [ ] **Step 1: Write RBAC tests first**

`tests/rbac.test.ts`:
```ts
import { describe, it, expect } from "bun:test";
import { can } from "@/lib/rbac";

describe("can()", () => {
  it("journalist can create/edit but not publish/reject", () => {
    expect(can("journalist", "article", "create")).toBe(true);
    expect(can("journalist", "article", "edit")).toBe(true);
    expect(can("journalist", "article", "publish")).toBe(false);
    expect(can("journalist", "article", "reject")).toBe(false);
  });
  it("editor can publish and manage feeds but not team", () => {
    expect(can("editor", "article", "publish")).toBe(true);
    expect(can("editor", "feed", "manage")).toBe(true);
    expect(can("editor", "team", "manage")).toBe(false);
  });
  it("admin can manage team and configure pipeline", () => {
    expect(can("admin", "team", "manage")).toBe(true);
    expect(can("admin", "pipeline", "configure")).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/rbac.test.ts`
Expected: FAIL ("Cannot find module '@/lib/rbac'").

- [ ] **Step 3: Implement `lib/rbac.ts`**

```ts
import type { Role } from "@/lib/auth";

type Matrix = Record<Role, Record<string, string[]>>;

const MATRIX: Matrix = {
  journalist: { article: ["create", "edit"], feed: ["read"], taxonomy: ["read"] },
  editor: {
    article: ["create", "edit", "approve", "publish", "reject", "regenerate"],
    feed: ["read", "manage"], taxonomy: ["read", "manage"], pipeline: ["read"],
  },
  admin: {
    article: ["create", "edit", "approve", "publish", "reject", "regenerate"],
    feed: ["read", "manage"], taxonomy: ["read", "manage"],
    team: ["read", "manage"], pipeline: ["read", "configure"],
  },
};

export const ROLE_LABEL: Record<Role, string> = {
  admin: "Admin", editor: "Éditeur", journalist: "Journaliste",
};

export function can(role: Role, resource: string, action: string): boolean {
  return MATRIX[role]?.[resource]?.includes(action) ?? false;
}

export class PermissionError extends Error {
  constructor(resource: string, action: string) {
    super(`Action non autorisée : ${action} sur ${resource}`);
    this.name = "PermissionError";
  }
}

export function requirePermission(role: Role, resource: string, action: string): void {
  if (!can(role, resource, action)) throw new PermissionError(resource, action);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/rbac.test.ts`
Expected: PASS (all 3).

- [ ] **Step 5: Role gate component**

`components/role-gate.tsx`:
```tsx
"use client";
import { useSession } from "@/lib/auth-client";
import type { Role } from "@/lib/auth";

export function RoleGate({ allow, children }: { allow: Role[]; children: React.ReactNode }) {
  const { data } = useSession();
  const role = data?.user?.role as Role | undefined;
  if (!role || !allow.includes(role)) return null;
  return <>{children}</>;
}
```

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(rbac): can()/requirePermission matrix, RoleGate, role labels"
```

---

## Task 7: App shell (protected layout, sidebar, topbar)

**Files:**
- Create: `app/(app)/layout.tsx`, `components/shell/sidebar.tsx`, `components/shell/topbar.tsx`, `components/shell/nav-items.ts`, `components/shell/theme-toggle.tsx`, `app/page.tsx`, and placeholder pages for `published/runs/calendar/settings/*`.
- Test: manual verification.

**Interfaces:**
- Consumes: `requireUser`, `getSession`, `ROLE_LABEL`, `can`.
- Produces: authenticated shell wrapping all `(app)` routes; `NAV_ITEMS` list; pending-count badge on "File de revue".

- [ ] **Step 1: Root redirect**

`app/page.tsx`:
```tsx
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
export default async function Home() {
  const s = await getSession();
  redirect(s?.user ? "/dashboard" : "/login");
}
```

- [ ] **Step 2: Nav items (role-aware)**

`components/shell/nav-items.ts`:
```ts
import { LayoutDashboard, Inbox, Calendar, Newspaper, Activity, Settings } from "lucide-react";
import type { Role } from "@/lib/auth";

export type NavItem = { href: string; label: string; icon: typeof Inbox; roles?: Role[]; badgeKey?: "pending" };
export const NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", label: "Tableau de bord", icon: LayoutDashboard },
  { href: "/queue", label: "File de revue", icon: Inbox, badgeKey: "pending" },
  { href: "/calendar", label: "Calendrier", icon: Calendar },
  { href: "/published", label: "Articles publiés", icon: Newspaper },
  { href: "/runs", label: "Exécutions", icon: Activity },
  { href: "/settings/feeds", label: "Réglages", icon: Settings, roles: ["admin", "editor"] },
];
```

- [ ] **Step 3: Sidebar (client, active state + pending badge)**

`components/shell/sidebar.tsx`:
```tsx
"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV_ITEMS } from "./nav-items";
import { Badge } from "@/components/ui/badge";
import type { Role } from "@/lib/auth";
import { cn } from "@/lib/utils";

export function Sidebar({ role, pendingCount }: { role: Role; pendingCount: number }) {
  const pathname = usePathname();
  return (
    <aside className="w-60 shrink-0 border-r bg-muted/30 flex flex-col">
      <div className="h-14 flex items-center px-4 font-semibold tracking-tight">
        <span className="text-[var(--accent-brand)]">Afrotiative</span>
      </div>
      <nav className="flex-1 px-2 space-y-1">
        {NAV_ITEMS.filter((i) => !i.roles || i.roles.includes(role)).map((item) => {
          const active = pathname.startsWith(item.href);
          const Icon = item.icon;
          return (
            <Link key={item.href} href={item.href}
              className={cn("flex items-center gap-3 rounded-md px-3 py-2 text-sm",
                active ? "bg-background font-medium shadow-sm" : "text-muted-foreground hover:bg-background/60")}>
              <Icon className="size-4" /> <span className="flex-1">{item.label}</span>
              {item.badgeKey === "pending" && pendingCount > 0 && (
                <Badge className="bg-[var(--accent-brand)] text-[var(--accent-brand-foreground)]">{pendingCount}</Badge>
              )}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
```

- [ ] **Step 4: Topbar + role badge + theme toggle**

`components/shell/theme-toggle.tsx`:
```tsx
"use client";
import { useTheme } from "next-themes";
import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  return (
    <Button variant="ghost" size="icon" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} aria-label="Basculer le thème">
      <Sun className="size-4 dark:hidden" /><Moon className="size-4 hidden dark:block" />
    </Button>
  );
}
```

`components/shell/topbar.tsx`:
```tsx
import { Badge } from "@/components/ui/badge";
import { ThemeToggle } from "./theme-toggle";
import { ROLE_LABEL } from "@/lib/rbac";
import type { SessionUser } from "@/lib/session";

export function Topbar({ user }: { user: SessionUser }) {
  return (
    <header className="h-14 border-b flex items-center justify-end gap-3 px-4">
      <Badge variant="secondary">{ROLE_LABEL[user.role]}</Badge>
      <span className="text-sm text-muted-foreground">{user.name}</span>
      <ThemeToggle />
    </header>
  );
}
```

- [ ] **Step 5: Protected layout (auth guard + pending count)**

`app/(app)/layout.tsx`:
```tsx
import { requireUser } from "@/lib/session";
import { db, articles } from "@/db";
import { eq } from "drizzle-orm";
import { Sidebar } from "@/components/shell/sidebar";
import { Topbar } from "@/components/shell/topbar";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const pending = await db.$count(articles, eq(articles.status, "pending"));
  return (
    <div className="flex h-screen">
      <Sidebar role={user.role} pendingCount={pending} />
      <div className="flex-1 flex flex-col min-w-0">
        <Topbar user={user} />
        <main className="flex-1 overflow-auto p-6">{children}</main>
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Placeholder pages for not-yet-built routes**

Create each of `app/(app)/{published,runs,calendar,settings/feeds,settings/taxonomy,settings/team,settings/integrations}/page.tsx` with a labelled "bientôt" placeholder, e.g. `app/(app)/runs/page.tsx`:
```tsx
export default function Page() {
  return <div className="text-muted-foreground">Exécutions du pipeline — disponible dans une prochaine version (SP4).</div>;
}
```
(Repeat with the matching French label + SP tag for each placeholder route.)

- [ ] **Step 7: Verify shell renders (manual)**

Run: `bun run dev`, then use the run/verify skill (browser) — but auth guard will redirect to `/login` (built next). For now confirm `bun run build` + `bun run typecheck` pass.
Run: `bun run typecheck && bun run build`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat(shell): protected layout, sidebar with pending badge, topbar, theme toggle"
```

---

## Task 8: Login page

**Files:**
- Create: `app/(auth)/login/page.tsx`, `components/login-form.tsx`
- Test: manual verification (drive the app).

**Interfaces:**
- Consumes: `authClient.signIn.email`.
- Produces: working email/password login; distinct message for disabled account vs wrong password; redirect to `/dashboard` on success.

- [ ] **Step 1: Login form (client)**

`components/login-form.tsx`:
```tsx
"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { signIn } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null); setLoading(true);
    const { error } = await signIn.email({ email, password });
    setLoading(false);
    if (error) {
      // Better-Auth surfaces banned accounts with a specific code/status
      if (error.code === "BANNED_USER" || /ban/i.test(error.message ?? "")) {
        setError("Ce compte a été désactivé. Contactez un administrateur.");
      } else {
        setError("Email ou mot de passe incorrect.");
      }
      return;
    }
    router.push("/dashboard");
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader><CardTitle>Console éditoriale Afrotiative</CardTitle></CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Mot de passe</Label>
            <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          {error && <p className="text-sm text-[var(--status-rejected)]" role="alert">{error}</p>}
          <Button type="submit" disabled={loading}
            className="w-full bg-[var(--accent-brand)] text-[var(--accent-brand-foreground)]">
            {loading ? "Connexion…" : "Se connecter"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 2: Login page**

`app/(auth)/login/page.tsx`:
```tsx
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { LoginForm } from "@/components/login-form";

export default async function LoginPage() {
  const s = await getSession();
  if (s?.user) redirect("/dashboard");
  return <div className="min-h-screen grid place-items-center bg-muted/30 p-6"><LoginForm /></div>;
}
```

- [ ] **Step 3: Verify login flow (manual, real app)**

Run: `bun run dev`. Using the run/verify skill (browser):
1. Visit `/login`, sign in as `editor@afrotiative.com` / `Afrotiative2026!` → lands on `/dashboard` (empty shell for now).
2. Wrong password → "Email ou mot de passe incorrect."
3. Temporarily ban the seed journalist (set `user.banned=true` via a one-off `bun -e "import {db,user} from './db';import {eq} from 'drizzle-orm';await db.update(user).set({banned:true}).where(eq(user.email,'journaliste@afrotiative.com'));process.exit(0)"`) → sign-in shows "Ce compte a été désactivé."
Expected: all three behave as described.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(auth): login page with disabled-account vs wrong-password messaging"
```

---

## Task 9: Dashboard

**Files:**
- Create: `lib/queries/dashboard.ts`, `app/(app)/dashboard/page.tsx`, `components/dashboard/{summary-cards.tsx,pending-list.tsx,error-list.tsx,empty-state.tsx}`
- Test: `tests/dashboard-queries.test.ts`

**Interfaces:**
- Consumes: `db`, schema tables.
- Produces: `getDashboardData(): Promise<{ pendingCount, failedRuns24h, publishedToday, publishedWeek, lastRun, latestPending[], latestErrors[] }>`.

- [ ] **Step 1: Dashboard query helper**

`lib/queries/dashboard.ts`:
```ts
import { db, articles, pipelineRuns, pipelineSteps } from "@/db";
import { and, desc, eq, gte, sql } from "drizzle-orm";

export async function getDashboardData() {
  const dayAgo = new Date(Date.now() - 864e5);
  const startOfWeek = new Date(Date.now() - 7 * 864e5);

  const pendingCount = await db.$count(articles, eq(articles.status, "pending"));
  const failedRuns24h = await db.$count(pipelineRuns, and(eq(pipelineRuns.status, "failed"), gte(pipelineRuns.startedAt, dayAgo)));
  const publishedWeek = await db.$count(articles, and(eq(articles.status, "published"), gte(articles.publishedAt, startOfWeek)));
  const publishedToday = await db.$count(articles, and(eq(articles.status, "published"), gte(articles.publishedAt, new Date(new Date().setHours(0,0,0,0)))));

  const [lastRun] = await db.select().from(pipelineRuns).orderBy(desc(pipelineRuns.startedAt)).limit(1);

  const latestPending = await db.select({
    id: articles.id, title: articles.title, status: articles.status, generatedAt: articles.generatedAt,
    confidenceFlags: articles.confidenceFlags,
  }).from(articles).where(eq(articles.status, "pending")).orderBy(articles.generatedAt).limit(5);

  const latestErrors = await db.select({
    id: pipelineSteps.id, name: pipelineSteps.name, message: pipelineSteps.errorMessage,
  }).from(pipelineSteps).where(eq(pipelineSteps.status, "failed")).limit(5);

  return { pendingCount, failedRuns24h, publishedToday, publishedWeek, lastRun, latestPending, latestErrors };
}
```

- [ ] **Step 2: Test the query against seed data**

`tests/dashboard-queries.test.ts`:
```ts
import { describe, it, expect } from "bun:test";
import { getDashboardData } from "@/lib/queries/dashboard";

describe("getDashboardData", () => {
  it("returns counts and lists from seeded data", async () => {
    const d = await getDashboardData();
    expect(d.pendingCount).toBeGreaterThan(0);
    expect(d.latestPending.length).toBeGreaterThan(0);
    expect(d.latestErrors.length).toBeGreaterThan(0); // seed has one failed step
  });
});
```

- [ ] **Step 3: Run the test**

Run: `bun test tests/dashboard-queries.test.ts`
Expected: PASS (requires seed run first).

- [ ] **Step 4: Summary cards + lists + empty state**

`components/dashboard/summary-cards.tsx`:
```tsx
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDate } from "@/lib/format";

export function SummaryCards({ d }: { d: Awaited<ReturnType<typeof import("@/lib/queries/dashboard").getDashboardData>> }) {
  const cards = [
    { label: "En attente de revue", value: d.pendingCount, accent: d.pendingCount > 0 },
    { label: "Exécutions en échec (24 h)", value: d.failedRuns24h, alert: d.failedRuns24h > 0 },
    { label: "Publiés cette semaine", value: d.publishedWeek, sub: `dont ${d.publishedToday} aujourd'hui` },
    { label: "Dernière exécution", value: d.lastRun ? formatDate(d.lastRun.startedAt) : "—", sub: d.lastRun?.status },
  ];
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {cards.map((c) => (
        <Card key={c.label}>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">{c.label}</CardTitle></CardHeader>
          <CardContent>
            <div className={`text-2xl font-semibold ${c.alert ? "text-[var(--status-error)]" : c.accent ? "text-[var(--accent-brand)]" : ""}`}>{c.value}</div>
            {c.sub && <p className="text-xs text-muted-foreground mt-1">{c.sub}</p>}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
```

`components/dashboard/empty-state.tsx`:
```tsx
import { Inbox } from "lucide-react";
export function EmptyState({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="grid place-items-center rounded-lg border border-dashed py-16 text-center">
      <Inbox className="size-8 text-muted-foreground mb-3" />
      <p className="font-medium">{title}</p>
      <p className="text-sm text-muted-foreground">{hint}</p>
    </div>
  );
}
```

`components/dashboard/pending-list.tsx` and `error-list.tsx`: render `d.latestPending` (link each to `/article/[id]`, show `<StatusBadge>` + low-confidence dot) and `d.latestErrors` (name + human message) respectively; when empty, render `<EmptyState>`.
```tsx
// components/dashboard/pending-list.tsx
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/status-badge";
import { EmptyState } from "./empty-state";
import { relativeDate } from "@/lib/format";

export function PendingList({ items }: { items: { id: string; title: string; status: any; generatedAt: Date | null; confidenceFlags: any }[] }) {
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Derniers articles en attente</CardTitle></CardHeader>
      <CardContent>
        {items.length === 0 ? <EmptyState title="Rien à relire" hint="Le pipeline n'a rien produit de nouveau." /> : (
          <ul className="divide-y">
            {items.map((a) => {
              const low = a.confidenceFlags?.categoryUncertain || a.confidenceFlags?.imageMissing;
              return (
                <li key={a.id} className="py-2">
                  <Link href={`/article/${a.id}`} className="flex items-center gap-2 hover:underline">
                    {low && <span title="Faible confiance IA" className="size-2 rounded-full bg-[var(--status-pending)]" />}
                    <span className="flex-1 truncate">{a.title}</span>
                    <span className="text-xs text-muted-foreground">{relativeDate(a.generatedAt)}</span>
                    <StatusBadge status={a.status} />
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
```
(`error-list.tsx` mirrors this shape over `items: {id,name,message}` with an `AlertTriangle` icon and the `EmptyState` "Aucune erreur — le pipeline tourne normalement.")

- [ ] **Step 5: Dashboard page (RSC)**

`app/(app)/dashboard/page.tsx`:
```tsx
import { getDashboardData } from "@/lib/queries/dashboard";
import { SummaryCards } from "@/components/dashboard/summary-cards";
import { PendingList } from "@/components/dashboard/pending-list";
import { ErrorList } from "@/components/dashboard/error-list";

export default async function DashboardPage() {
  const d = await getDashboardData();
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Tableau de bord</h1>
      <SummaryCards d={d} />
      <div className="grid gap-6 lg:grid-cols-2">
        <PendingList items={d.latestPending} />
        <ErrorList items={d.latestErrors} />
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Verify (manual)**

Run: `bun run dev`, sign in, confirm dashboard shows non-zero cards, 5 pending items link to editor, one pipeline error listed.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(dashboard): summary cards, pending list, error list with empty states"
```

---

## Task 10: Review Queue

**Files:**
- Create: `lib/queries/queue.ts`, `lib/actions/queue-actions.ts`, `app/(app)/queue/page.tsx`, `components/queue/{queue-table.tsx,columns.tsx,queue-filters.tsx,confidence-badge.tsx,row-actions.tsx}`
- Test: `tests/queue-actions.test.ts`

**Interfaces:**
- Consumes: `db`, `requireUser`, `requirePermission`.
- Produces:
  - `getQueue(): Promise<QueueRow[]>` where `QueueRow = { id, title, categoryName, sourceCount, imageUrl, generatedAt, status, low }`.
  - server actions `quickApprove(id)`, `quickReject(id, reason)` (editor/admin only; `revalidatePath("/queue")`).

- [ ] **Step 1: Queue query**

`lib/queries/queue.ts`:
```ts
import { db, articles, articleSources, wpCategories } from "@/db";
import { desc, eq, sql } from "drizzle-orm";

export type QueueRow = {
  id: string; title: string; categoryName: string | null; sourceCount: number;
  imageUrl: string | null; generatedAt: Date | null; status: string; low: boolean;
};

export async function getQueue(): Promise<QueueRow[]> {
  const rows = await db.select({
    id: articles.id, title: articles.title, categoryName: wpCategories.name,
    imageUrl: articles.featuredImageUrl, generatedAt: articles.generatedAt,
    status: articles.status, confidenceFlags: articles.confidenceFlags,
    sourceCount: sql<number>`(select count(*) from ${articleSources} s where s.article_id = ${articles.id})`,
  }).from(articles).leftJoin(wpCategories, eq(articles.categoryId, wpCategories.id))
    .orderBy(articles.generatedAt); // oldest first

  return rows.map((r) => ({
    ...r, sourceCount: Number(r.sourceCount),
    low: Boolean(r.confidenceFlags?.categoryUncertain || r.confidenceFlags?.imageMissing || r.confidenceFlags?.clusterUncertain),
  }));
}
```

- [ ] **Step 2: Queue actions (write test first)**

`tests/queue-actions.test.ts`:
```ts
import { describe, it, expect, vi } from "bun:test";
import { can } from "@/lib/rbac";

// Unit-level guard: the action must refuse a journalist.
describe("queue action guards", () => {
  it("journalist cannot approve", () => { expect(can("journalist", "article", "approve")).toBe(false); });
  it("editor can approve", () => { expect(can("editor", "article", "approve")).toBe(true); });
});
```
(The action's DB effect is covered by the manual verification step; this test locks the guard rule.)

- [ ] **Step 3: Implement queue actions**

`lib/actions/queue-actions.ts`:
```ts
"use server";
import { db, articles, articleRevisions, distributions } from "@/db";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";
import { z } from "zod";

export async function quickApprove(id: string) {
  const user = await requireUser();
  requirePermission(user.role, "article", "approve");
  await db.update(articles).set({ status: "published", publishedAt: new Date(), updatedAt: new Date() }).where(eq(articles.id, id));
  await db.insert(distributions).values({ articleId: id, channel: "wordpress", status: "stubbed" });
  await db.insert(articleRevisions).values({ articleId: id, actorId: user.id, action: "approuvé (publication simulée)" });
  revalidatePath("/queue"); revalidatePath("/dashboard");
}

const rejectSchema = z.object({ id: z.string().uuid(), reason: z.string().min(3, "Motif requis") });
export async function quickReject(input: { id: string; reason: string }) {
  const user = await requireUser();
  requirePermission(user.role, "article", "reject");
  const { id, reason } = rejectSchema.parse(input);
  await db.update(articles).set({ status: "rejected", rejectReason: reason, updatedAt: new Date() }).where(eq(articles.id, id));
  await db.insert(articleRevisions).values({ articleId: id, actorId: user.id, action: "rejeté", detail: reason });
  revalidatePath("/queue"); revalidatePath("/dashboard");
}
```

- [ ] **Step 4: Table columns + confidence badge + row actions**

`components/queue/confidence-badge.tsx`:
```tsx
import { AlertTriangle } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
export function ConfidenceBadge() {
  return (
    <Tooltip>
      <TooltipTrigger asChild><span className="inline-flex text-[var(--status-pending)]"><AlertTriangle className="size-4" /></span></TooltipTrigger>
      <TooltipContent>Faible confiance IA — à vérifier en priorité (catégorie, image ou regroupement incertain).</TooltipContent>
    </Tooltip>
  );
}
```

`components/queue/columns.tsx` — TanStack `ColumnDef<QueueRow>[]`: title (with `ConfidenceBadge` when `low`), categoryName (fallback "—"), sourceCount, image thumbnail (`next/image` or placeholder), `relativeDate(generatedAt)`, `<StatusBadge>`, and a `row-actions` cell. Provide the full array:
```tsx
"use client";
import type { ColumnDef } from "@tanstack/react-table";
import type { QueueRow } from "@/lib/queries/queue";
import { StatusBadge } from "@/components/status-badge";
import { ConfidenceBadge } from "./confidence-badge";
import { RowActions } from "./row-actions";
import { relativeDate } from "@/lib/format";

export const columns: ColumnDef<QueueRow>[] = [
  { accessorKey: "title", header: "Titre", cell: ({ row }) => (
      <div className="flex items-center gap-2 max-w-[380px]">
        {row.original.low && <ConfidenceBadge />}
        <span className="truncate font-medium">{row.original.title}</span>
      </div>) },
  { accessorKey: "categoryName", header: "Catégorie", cell: ({ getValue }) => (getValue() as string) ?? "—" },
  { accessorKey: "sourceCount", header: "Sources" },
  { accessorKey: "generatedAt", header: "Généré", cell: ({ getValue }) => relativeDate(getValue() as Date) },
  { accessorKey: "status", header: "Statut", cell: ({ getValue }) => <StatusBadge status={getValue() as any} /> },
  { id: "actions", cell: ({ row }) => <RowActions row={row.original} /> },
];
```

`components/queue/row-actions.tsx` — hover/menu actions gated by RoleGate: "Ouvrir" (link), "Approuver rapidement" (calls `quickApprove` inside a `startTransition`, toast on success), "Rejeter" (opens `ConfirmDialog` requiring a reason, calls `quickReject`). Show only "Ouvrir" to journalists via `RoleGate`.

- [ ] **Step 5: Filters + table shell**

`components/queue/queue-filters.tsx` — text search + `Select` for status/category/source, controlling TanStack `columnFilters`/`globalFilter`.
`components/queue/queue-table.tsx` — `useReactTable` with `getCoreRowModel`, `getFilteredRowModel`, `getPaginationRowModel`, `getSortedRowModel`; renders shadcn `Table`; empty state row "Aucun article ne correspond à ces filtres."

- [ ] **Step 6: Queue page**

`app/(app)/queue/page.tsx`:
```tsx
import { getQueue } from "@/lib/queries/queue";
import { QueueTable } from "@/components/queue/queue-table";

export default async function QueuePage() {
  const rows = await getQueue();
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">File de revue</h1>
      <QueueTable data={rows} />
    </div>
  );
}
```

- [ ] **Step 7: Run tests + verify (manual)**

Run: `bun test tests/queue-actions.test.ts && bun run typecheck`
Then `bun run dev`: as editor, filter/sort/search work, low-confidence rows show the badge, "Approuver rapidement" flips status + toasts; as journalist, only "Ouvrir" is visible.

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat(queue): review queue table, filters, confidence badge, quick approve/reject"
```

---

## Task 11: Article Editor — data layer, locking & server actions

**Files:**
- Create: `lib/queries/article.ts`, `lib/actions/article-actions.ts`, `lib/validation.ts`, `lib/lock.ts`
- Test: `tests/article-actions.test.ts`

**Interfaces:**
- Consumes: `db`, `requireUser`, `requirePermission`, schema.
- Produces:
  - `lib/lock.ts` (plain module, NOT `"use server"`): `LOCK_TTL_MS = 5*60_000`, `isLockActive(lockedAt): boolean`.
  - `getArticle(id): Promise<ArticleDetail | null>` (article + sources + tags + revisions + category + lock holder name + categories list).
  - `acquireLock(id)`, `refreshLock(id)`, `releaseLock(id)`.
  - `saveDraft(input)`, `rejectArticle({id,reason})`, `regenerate(id)` (stub), `approveAndPublish(id)` (stub), `schedule({id, at})`.
  - Zod `saveDraftSchema`.

- [ ] **Step 1a: Lock constants (plain module — must NOT be `"use server"`)**

`lib/lock.ts`:
```ts
export const LOCK_TTL_MS = 5 * 60_000;
export function isLockActive(lockedAt: Date | null): boolean {
  return !!lockedAt && Date.now() - new Date(lockedAt).getTime() < LOCK_TTL_MS;
}
```

- [ ] **Step 1: Validation schemas**

`lib/validation.ts`:
```ts
import { z } from "zod";
export const saveDraftSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(3, "Titre trop court"),
  bodyHtml: z.string(),
  excerpt: z.string().optional(),
  categoryId: z.string().uuid().nullable(),
  tags: z.array(z.object({ tagName: z.string(), isNew: z.boolean() })),
  featuredImageUrl: z.string().url().nullable(),
  imageCredit: z.string().nullable(),
  imageSourceUrl: z.string().url().nullable(),
});
export type SaveDraftInput = z.infer<typeof saveDraftSchema>;
```

- [ ] **Step 2: Article query**

`lib/queries/article.ts`:
```ts
import { db, articles, articleSources, articleTags, articleRevisions, wpCategories, user } from "@/db";
import { eq, asc, desc } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

export async function getArticle(id: string) {
  const locker = alias(user, "locker");
  const [a] = await db.select({
    article: articles, categoryName: wpCategories.name, lockerName: locker.name,
  }).from(articles)
    .leftJoin(wpCategories, eq(articles.categoryId, wpCategories.id))
    .leftJoin(locker, eq(articles.lockedBy, locker.id))
    .where(eq(articles.id, id));
  if (!a) return null;
  const sources = await db.select().from(articleSources).where(eq(articleSources.articleId, id));
  const tags = await db.select().from(articleTags).where(eq(articleTags.articleId, id));
  const revisions = await db.select().from(articleRevisions).where(eq(articleRevisions.articleId, id)).orderBy(desc(articleRevisions.at));
  const categories = await db.select().from(wpCategories).orderBy(asc(wpCategories.name));
  return { ...a.article, categoryName: a.categoryName, lockerName: a.lockerName, sources, tags, revisions, categories };
}
export type ArticleDetail = NonNullable<Awaited<ReturnType<typeof getArticle>>>;
```

- [ ] **Step 3: Server actions (with tests first for the guards + lock)**

`tests/article-actions.test.ts`:
```ts
import { describe, it, expect } from "bun:test";
import { can } from "@/lib/rbac";
import { LOCK_TTL_MS, isLockActive } from "@/lib/lock";

describe("article action rules", () => {
  it("only editor/admin may approve/reject/regenerate", () => {
    for (const a of ["approve","reject","regenerate"] as const) {
      expect(can("journalist","article",a)).toBe(false);
      expect(can("editor","article",a)).toBe(true);
    }
  });
  it("lock older than TTL is inactive", () => {
    expect(isLockActive(new Date(Date.now() - LOCK_TTL_MS - 1000))).toBe(false);
    expect(isLockActive(new Date())).toBe(true);
  });
});
```

- [ ] **Step 4: Run tests to confirm they fail**

Run: `bun test tests/article-actions.test.ts`
Expected: FAIL (module/exports missing).

- [ ] **Step 5: Implement actions**

`lib/actions/article-actions.ts`:
```ts
"use server";
import { db, articles, articleTags, articleRevisions, distributions } from "@/db";
import { and, eq, ne, isNull, or, lt } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";
import { saveDraftSchema, type SaveDraftInput } from "@/lib/validation";
import { isLockActive } from "@/lib/lock";
import { z } from "zod";

export async function acquireLock(id: string) {
  const user = await requireUser();
  const [a] = await db.select({ lockedBy: articles.lockedBy, lockedAt: articles.lockedAt }).from(articles).where(eq(articles.id, id));
  const held = a && a.lockedBy && a.lockedBy !== user.id && isLockActive(a.lockedAt);
  if (held && user.role !== "admin") return { ok: false as const, heldBy: a!.lockedBy! };
  await db.update(articles).set({ lockedBy: user.id, lockedAt: new Date() }).where(eq(articles.id, id));
  return { ok: true as const };
}
export async function refreshLock(id: string) {
  const user = await requireUser();
  await db.update(articles).set({ lockedAt: new Date() }).where(and(eq(articles.id, id), eq(articles.lockedBy, user.id)));
}
export async function releaseLock(id: string) {
  const user = await requireUser();
  await db.update(articles).set({ lockedBy: null, lockedAt: null }).where(and(eq(articles.id, id), eq(articles.lockedBy, user.id)));
}

export async function saveDraft(input: SaveDraftInput) {
  const user = await requireUser();
  requirePermission(user.role, "article", "edit");
  const data = saveDraftSchema.parse(input);
  await db.update(articles).set({
    title: data.title, bodyHtml: data.bodyHtml, excerpt: data.excerpt,
    categoryId: data.categoryId, featuredImageUrl: data.featuredImageUrl,
    imageCredit: data.imageCredit, imageSourceUrl: data.imageSourceUrl, updatedAt: new Date(),
  }).where(eq(articles.id, data.id));
  await db.delete(articleTags).where(eq(articleTags.articleId, data.id));
  if (data.tags.length) await db.insert(articleTags).values(data.tags.map((t) => ({ articleId: data.id, tagName: t.tagName, isNew: t.isNew })));
  await db.insert(articleRevisions).values({ articleId: data.id, actorId: user.id, action: "modifié" });
  revalidatePath(`/article/${data.id}`);
}

const rejectSchema = z.object({ id: z.string().uuid(), reason: z.string().min(3, "Motif requis") });
export async function rejectArticle(input: { id: string; reason: string }) {
  const user = await requireUser();
  requirePermission(user.role, "article", "reject");
  const { id, reason } = rejectSchema.parse(input);
  await db.update(articles).set({ status: "rejected", rejectReason: reason, updatedAt: new Date() }).where(eq(articles.id, id));
  await db.insert(articleRevisions).values({ articleId: id, actorId: user.id, action: "rejeté", detail: reason });
  revalidatePath(`/article/${id}`); revalidatePath("/queue");
}

export async function regenerate(id: string) {
  const user = await requireUser();
  requirePermission(user.role, "article", "regenerate");
  // STUB (SP3): mark for regeneration; no AI call yet.
  await db.update(articles).set({ status: "pending", updatedAt: new Date() }).where(eq(articles.id, id));
  await db.insert(articleRevisions).values({ articleId: id, actorId: user.id, action: "renvoyé à l'IA (simulé)" });
  revalidatePath(`/article/${id}`);
  return { stub: true, message: "Régénération simulée — le pipeline IA sera branché en SP3." };
}

export async function approveAndPublish(id: string) {
  const user = await requireUser();
  requirePermission(user.role, "article", "publish");
  const [a] = await db.select().from(articles).where(eq(articles.id, id));
  if (!a) throw new Error("Article introuvable.");
  if (!a.categoryId) throw new Error("Choisissez une catégorie avant de publier.");
  if (a.featuredImageUrl && !a.imageCredit) throw new Error("Le crédit de l'image est obligatoire.");
  await db.update(articles).set({ status: "published", publishedAt: new Date(), updatedAt: new Date(), lockedBy: null, lockedAt: null }).where(eq(articles.id, id));
  await db.insert(distributions).values({ articleId: id, channel: "wordpress", status: "stubbed" });
  await db.insert(articleRevisions).values({ articleId: id, actorId: user.id, action: "approuvé & publié (simulé)" });
  revalidatePath(`/article/${id}`); revalidatePath("/queue"); revalidatePath("/dashboard");
  return { stub: true, message: "Publication simulée — WordPress sera branché en SP5." };
}

const scheduleSchema = z.object({ id: z.string().uuid(), at: z.coerce.date() });
export async function schedule(input: { id: string; at: Date }) {
  const user = await requireUser();
  requirePermission(user.role, "article", "publish");
  const { id, at } = scheduleSchema.parse(input);
  await db.update(articles).set({ status: "approved", scheduledAt: at, updatedAt: new Date() }).where(eq(articles.id, id));
  await db.insert(articleRevisions).values({ articleId: id, actorId: user.id, action: "planifié" });
  revalidatePath(`/article/${id}`);
}
```

- [ ] **Step 6: Run tests to confirm they pass**

Run: `bun test tests/article-actions.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(article): query, soft-lock, save/reject/regenerate/publish/schedule actions (publish stubbed)"
```

---

## Task 12: Article Editor — UI shell, Tiptap editor & action bar

**Files:**
- Create: `app/(app)/article/[id]/page.tsx`, `components/article/{editor-shell.tsx,rich-editor.tsx,editor-toolbar.tsx,action-bar.tsx,lock-banner.tsx}`, `components/confirm-dialog.tsx`
- Test: manual verification.

**Interfaces:**
- Consumes: `getArticle`, all `article-actions`, `RoleGate`, `can`.
- Produces: two-column editor page; constrained Tiptap; persistent action bar; lock handling with heartbeat.

- [ ] **Step 1: Reusable confirm dialog**

`components/confirm-dialog.tsx`:
```tsx
"use client";
import { useState } from "react";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export function ConfirmDialog({ trigger, title, description, confirmLabel, destructive, withReason, onConfirm }:
  { trigger: React.ReactNode; title: string; description: string; confirmLabel: string;
    destructive?: boolean; withReason?: boolean; onConfirm: (reason?: string) => void | Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">{description}</p>
        {withReason && <Textarea placeholder="Motif (obligatoire)…" value={reason} onChange={(e) => setReason(e.target.value)} />}
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>Annuler</Button>
          <Button variant={destructive ? "destructive" : "default"}
            disabled={withReason && reason.trim().length < 3}
            onClick={async () => { await onConfirm(withReason ? reason : undefined); setOpen(false); }}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Constrained Tiptap editor + toolbar**

`components/article/rich-editor.tsx`:
```tsx
"use client";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import { EditorToolbar } from "./editor-toolbar";

export function RichEditor({ value, onChange, editable }: { value: string; onChange: (html: string) => void; editable: boolean }) {
  const editor = useEditor({
    editable, immediatelyRender: false,
    extensions: [
      StarterKit.configure({ heading: { levels: [2, 3] }, blockquote: false, codeBlock: false, code: false, horizontalRule: false }),
      Link.configure({ openOnClick: false }),
    ],
    content: value,
    onUpdate: ({ editor }) => onChange(editor.getHTML()),
    editorProps: { attributes: { class: "font-editorial prose prose-neutral dark:prose-invert max-w-none min-h-[420px] focus:outline-none" } },
  });
  if (!editor) return null;
  return (
    <div className="rounded-md border">
      {editable && <EditorToolbar editor={editor} />}
      <EditorContent editor={editor} className="p-4" />
    </div>
  );
}
```

`components/article/editor-toolbar.tsx` — buttons for **bold, H2, H3, link, bullet list, ordered list only** (each toggles via `editor.chain().focus()....run()`, active state highlighted). No other marks.

- [ ] **Step 3: Lock banner**

`components/article/lock-banner.tsx`:
```tsx
export function LockBanner({ holder }: { holder: string }) {
  return (
    <div className="rounded-md border border-[var(--status-pending)]/40 bg-[var(--status-pending)]/10 px-4 py-2 text-sm">
      Cet article est en cours d'édition par <strong>{holder}</strong>. Il est en lecture seule pour éviter d'écraser son travail.
    </div>
  );
}
```

- [ ] **Step 4: Action bar (role-gated, stub toasts)**

`components/article/action-bar.tsx` — persistent bar. Buttons: **Enregistrer** (all editors of the doc), and inside `RoleGate allow={["admin","editor"]}`: **Rejeter** (ConfirmDialog withReason → `rejectArticle`), **Renvoyer à l'IA** (`regenerate`, toast shows returned stub message), **Approuver & publier** (calls `approveAndPublish`; on thrown validation error, toast the message; on success toast the stub message + `router.push("/queue")`), **Planifier** (popover with datetime → `schedule`). Each wraps calls in `startTransition` + `sonner` toasts. The "Améliorer avec IA" affordance lives in the editor column, disabled with tooltip "Bientôt (SP3)".

- [ ] **Step 5: Editor shell (two columns + lock + heartbeat) & page**

`components/article/editor-shell.tsx` (client) — holds local form state (title, bodyHtml, excerpt, categoryId, tags, image fields), renders left `RichEditor` + right `SidePanel` (Task 13) + top/bottom `ActionBar`. On mount calls `acquireLock`; if `!ok`, render read-only + `LockBanner`. Sets an interval calling `refreshLock` every 60s; on unmount calls `releaseLock`. If `status === "published"`, render read-only with a "Dépublier/Republier" affordance placeholder.

`app/(app)/article/[id]/page.tsx`:
```tsx
import { notFound } from "next/navigation";
import { getArticle } from "@/lib/queries/article";
import { requireUser } from "@/lib/session";
import { isLockActive } from "@/lib/lock";
import { EditorShell } from "@/components/article/editor-shell";

export default async function ArticlePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const article = await getArticle(id);
  if (!article) notFound();
  const lockedByOther = !!article.lockedBy && article.lockedBy !== user.id && isLockActive(article.lockedAt) && user.role !== "admin";
  return <EditorShell article={article} role={user.role} lockedByOther={lockedByOther} />;
}
```

- [ ] **Step 6: Verify (manual, real app)**

Run: `bun run dev`. As editor: open a low-confidence article, edit title/body (toolbar only exposes the 6 controls), Enregistrer toasts success; Approuver & publier on an article with no category → error toast "Choisissez une catégorie…"; after setting a category → success stub toast, returns to queue. As journalist: no Rejeter/Publier/Renvoyer buttons. Open the same article in a second browser as another user → lock banner appears.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(article): two-column editor, constrained Tiptap, action bar, soft-lock heartbeat"
```

---

## Task 13: Article Editor — side panel

**Files:**
- Create: `components/article/{side-panel.tsx,image-panel.tsx,category-select.tsx,tags-input.tsx,sources-list.tsx,excerpt-field.tsx,history-panel.tsx}`
- Test: manual verification.

**Interfaces:**
- Consumes: `ArticleDetail`, form state setters from `EditorShell`.
- Produces: the fixed right panel composing all sub-panels.

- [ ] **Step 1: Image panel (preview + mandatory credit + change/upload)**

`components/article/image-panel.tsx` — shows `featuredImageUrl` preview (or an "image absente" placeholder when null, styled with the pending accent to flag low-confidence), the **credit** (media name + source link shown in clear), a "Changer l'image" button (URL input for now; upload wired later), and an error state when the image fails to load (`onError` → placeholder + "Échec du chargement de l'image").

- [ ] **Step 2: Category select (constrained to existing)**

`components/article/category-select.tsx` — shadcn `Select` populated from `article.categories`; value = `categoryId`; when null, show "Aucune catégorie (à choisir)" in the pending color.

- [ ] **Step 3: Tags input (existing vs new distinction)**

`components/article/tags-input.tsx` — chips from `article.tags`; existing tags (`isNew=false`) rendered neutral, new tags (`isNew=true`) rendered with the accent + a "nouveau" hint; add via `Command`/input matched against the mirrored `wpTags` list (match → existing, else → new).

- [ ] **Step 4: Sources, excerpt, history**

`components/article/sources-list.tsx` — list of `{mediaName, url}` exactly as it will appear in the article footer (external links).
`components/article/excerpt-field.tsx` — editable `Textarea` bound to excerpt.
`components/article/history-panel.tsx` — `article.revisions` timeline (actor + action + `formatDate(at)`); shows "Généré par IA" / "Modifié par X".

- [ ] **Step 5: Compose side panel**

`components/article/side-panel.tsx` — vertical stack (or shadcn `Tabs` if long) of: ImagePanel · CategorySelect · TagsInput · SourcesList · ExcerptField · HistoryPanel. Fixed within the right column; scrolls independently.

- [ ] **Step 6: Verify (manual)**

Run: `bun run dev`. Confirm: image credit always visible; new vs existing tags visually distinct; category constrained to the list; sources link out; history shows the generation + any edits you just made.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(article): side panel — image/credit, category, tags(new/existing), sources, excerpt, history"
```

---

## Task 14: Manual article creation (journalist)

**Files:**
- Create: `app/(app)/article/new/page.tsx`, `lib/actions/create-actions.ts`
- Modify: `components/shell/nav-items.ts` or dashboard to add a "Nouvel article" entry point.
- Test: `tests/create-actions.test.ts` (guard) + manual.

**Interfaces:**
- Consumes: `requireUser`, `requirePermission`, `EditorShell`.
- Produces: `createManualArticle(): Promise<{ id }>` (creates a `draft` owned by the user), reusing the editor; submit sets status `pending`.

- [ ] **Step 1: Guard test**

`tests/create-actions.test.ts`:
```ts
import { describe, it, expect } from "bun:test";
import { can } from "@/lib/rbac";
describe("manual create", () => {
  it("journalist can create articles", () => { expect(can("journalist", "article", "create")).toBe(true); });
});
```

- [ ] **Step 2: Create action + submit-for-review**

`lib/actions/create-actions.ts`:
```ts
"use server";
import { db, articles, articleRevisions } from "@/db";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";

export async function createManualArticle() {
  const user = await requireUser();
  requirePermission(user.role, "article", "create");
  const [a] = await db.insert(articles).values({
    title: "Nouvel article", bodyHtml: "", status: "draft", aiAuthor: false, createdBy: user.id,
  }).returning();
  await db.insert(articleRevisions).values({ articleId: a.id, actorId: user.id, action: "créé manuellement" });
  redirect(`/article/${a.id}`);
}

export async function submitForReview(id: string) {
  const user = await requireUser();
  requirePermission(user.role, "article", "create");
  await db.update(articles).set({ status: "pending", updatedAt: new Date() }).where(eq(articles.id, id));
  await db.insert(articleRevisions).values({ articleId: id, actorId: user.id, action: "soumis en revue" });
  redirect("/queue");
}
```

- [ ] **Step 3: New-article entry + page**

`app/(app)/article/new/page.tsx` — a server component with a form whose action is `createManualArticle` (button "Créer un article"), or directly invoke on load via a small client trigger. Add a "Nouvel article" button on the Dashboard and Queue headers (visible to all roles, since all can create). In `EditorShell`, when `article.aiAuthor === false && status === "draft"`, the action bar shows **"Soumettre en revue"** (calls `submitForReview`) instead of publish controls — and journalists never see publish controls regardless (already enforced by `RoleGate`).

- [ ] **Step 4: Run test + verify (manual)**

Run: `bun test tests/create-actions.test.ts`
Then `bun run dev` as journalist: "Nouvel article" → editor with no publish buttons → fill title/body, choose category/tags → "Soumettre en revue" → lands in queue as `pending`; confirm the journalist cannot see any publish/approve/reject control anywhere.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(article): manual creation + submit-for-review for journalists"
```

---

## Task 15: End-to-end verification pass

**Files:** none (verification only).

- [ ] **Step 1: Full typecheck + build + tests**

Run: `bun run typecheck && bun test && bun run build`
Expected: all clean/green.

- [ ] **Step 2: Drive Parcours A end-to-end (run/verify skill, real app)**

Sign in as `editor@afrotiative.com`:
1. Dashboard shows non-zero cards + one pipeline error.
2. Click into the queue (badge count matches pending).
3. Open the oldest pending article → correct a sentence → set category/tags → **Approuver & publier** → success stub toast → back to queue, article gone from pending, dashboard "publiés" incremented.
4. Reject another with a reason → status `rejected`.
Expected: every step works; no console errors.

- [ ] **Step 3: Role & state checks**

- Sign in as `journaliste@afrotiative.com`: no publish/approve/reject anywhere; can create + submit.
- Trigger the disabled-account path on a temp user → correct message.
- Open one article in two sessions → lock banner in the second; admin can override.
- Toggle dark mode → tokens/badges legible in both themes.
- Empty states: filter the queue to no matches → empty row; (optionally) point at an empty DB branch → dashboard "aucune activité".

- [ ] **Step 4: Final commit / tag**

```bash
git add -A && git commit -m "chore: SP0+SP1 verified — foundation & daily-review back-office complete" || echo "nothing to commit"
git tag sp1-complete
```

---

## Self-Review Notes (coverage map)

- **Spec §3 stack** → Task 1. **§4 schema (all tables)** → Task 2. **§5 auth/RBAC** → Tasks 3, 6, 8. **§6 shell/design system/dark mode/status tokens/toasts** → Tasks 5, 7. **§7.1 login (disabled vs wrong pw)** → Task 8. **§7.2 dashboard (cards/lists/empty)** → Task 9. **§7.3 queue (table/filters/low-confidence/row actions)** → Task 10. **§7.4 editor (two-col/Tiptap/side panel/action bar/lock/states)** → Tasks 11–13. **§7.5 manual create** → Task 14. **§8 data layer/soft-lock/publish-stub** → Tasks 11–12. **§9 seed** → Task 4. **§10 error handling** → Tasks 8, 10, 11 (toasts/validation) + Task 12 (image error, lock). **§11 verification** → Task 15.
- **Stubs (spec §2):** publish (Tasks 10, 11), regenerate (Task 11), "Améliorer avec IA" disabled (Task 12) — all explicitly simulated, DB schema present for SP3/SP5.
- **Deferred screens** (Runs/Calendar/Published/Taxonomy/Team/Integrations) → placeholder routes in Task 7; full builds are SP2/SP4/SP5.
