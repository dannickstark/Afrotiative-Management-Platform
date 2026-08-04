# Afrotiative SP2 — Settings & Administration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the newsroom in-app control of RSS Sources (CRUD + test-feed), Team & roles (add member with one-time temp password, role change, disable), the Categories/Tags mirror (+ sync from WordPress), and Integrations status (+ free test) — replacing the SP1 placeholder Settings pages.

**Architecture:** A `/settings` layout with role-gated sub-nav; four RSC pages each behind a server-enforced `requirePermission`; server actions per screen over existing tables (`feeds`, Better-Auth `user`, `wp_categories`/`wp_tags`, `distributions`) reusing SP3's `parseFeed`, SP5's `WordPressClient`, and `getPipelineConfig`. No new tables, no publishing (human-review gate untouched).

**Tech Stack:** TypeScript · Bun · Next.js 16 (Node runtime) · Drizzle/Neon · Better-Auth admin plugin · shadcn/Base-UI · no new deps.

## Global Constraints

- **Runtime & toolchain: Bun** (`bun add`/`bun run`/`bun test`). Next on **Node** (plain `next …` scripts). `.env.local` auto-loaded (+ `test-setup.ts` preload deletes provider `*_API_KEY` vars — WP/provider tests set their own). Never touch/commit `.env.local`; never `git clean`. Reseed (`bun run db:seed`) after any test that mutates rows.
- **UI language French.** Status badges reuse the app's `--status-*` tokens; destructive actions (delete feed, disable member) go through a `ConfirmDialog` naming the consequence; every screen has vide/chargement/erreur states; dark mode.
- **RBAC — server-enforced on EVERY page AND action (not just hidden nav):**
  - Sources RSS / Categories & Tags → `feed:manage` / `taxonomy:manage` (Éditeur + Admin).
  - Équipe / Intégrations → `team:manage` / `pipeline:configure` (Admin only).
  - A Journaliste is refused all of `/settings/*`; an Éditeur is refused `/settings/team` and `/settings/integrations`.
- **No in-UI secret editing** (keys stay in `.env`; status shows configuré / non configuré, NEVER the key value). Integration "Tester" uses only FREE checks (never a token-spending LLM completion).
- **Team safety:** never delete a user (disable via `banned` only); an admin cannot disable themselves or remove their own last admin role (anti-self-lockout). The generated temp password is shown ONCE to the admin and is never logged/committed.
- **No new tables**; any schema change is additive (none expected). Human-review gate untouched (Settings never publishes).
- **TDD where logic lives** (action guards, feed CRUD + test-feed, addMember temp-password + role/disable + anti-lockout, taxonomy sync upsert, integration status/test). Each screen ends with a manual verification step; full browser e2e is Task 6.

---

## File Structure

```
app/(app)/settings/layout.tsx                 # sub-nav + requireUser
app/(app)/settings/{feeds,taxonomy,team,integrations}/page.tsx   # replace placeholders; each requirePermission
lib/queries/settings.ts                       # getFeeds / getMembers / getTaxonomy / getIntegrationStatus
lib/actions/feed-actions.ts                   # createFeed/updateFeed/toggleFeed/deleteFeed/testFeed
lib/actions/team-actions.ts                   # addMember/setMemberRole/disableMember/enableMember
lib/actions/taxonomy-actions.ts               # syncTaxonomyFromWordPress
lib/actions/integration-actions.ts            # testIntegration
components/settings/{settings-nav.tsx, feeds-table.tsx, feed-sheet.tsx, members-table.tsx,
                     add-member-dialog.tsx, taxonomy-tables.tsx, integration-cards.tsx}
tests/{feed-actions, team-actions, taxonomy-sync, integration-status}.test.ts
```

---

## Task 1: Settings shell + sub-nav + read queries + RBAC page guards

**Files:** Create `app/(app)/settings/layout.tsx`, `components/settings/settings-nav.tsx`, `lib/queries/settings.ts`; Modify the four `app/(app)/settings/*/page.tsx` (replace placeholders with gated pages rendering their data via to-be-built tables in Tasks 2–5); Test `tests/settings-rbac.test.ts`

**Interfaces:**
- Produces: `getFeeds()`, `getMembers()`, `getTaxonomy()`, `getIntegrationStatus()` from `lib/queries/settings.ts`; `<SettingsNav role />` (role-filtered sub-nav); each settings page calls `requireUser()` + `requirePermission(...)`.

- [ ] **Step 1: RBAC page-guard test first**

`tests/settings-rbac.test.ts`:
```ts
import { describe, it, expect } from "bun:test";
import { can } from "@/lib/rbac";
describe("settings RBAC", () => {
  it("editor manages feeds+taxonomy but not team/integrations", () => {
    expect(can("editor","feed","manage")).toBe(true);
    expect(can("editor","taxonomy","manage")).toBe(true);
    expect(can("editor","team","manage")).toBe(false);
    expect(can("editor","pipeline","configure")).toBe(false);
  });
  it("admin manages all; journalist none", () => {
    expect(can("admin","team","manage")).toBe(true);
    expect(can("admin","pipeline","configure")).toBe(true);
    expect(can("journalist","feed","manage")).toBe(false);
    expect(can("journalist","taxonomy","manage")).toBe(false);
  });
});
```

- [ ] **Step 2: Run → PASS** (rbac exists). `bun test tests/settings-rbac.test.ts`.

- [ ] **Step 3: Read queries**

`lib/queries/settings.ts`:
```ts
import { db, feeds, user, wpCategories, wpTags, distributions, pipelineRuns } from "@/db";
import { and, desc, eq } from "drizzle-orm";
import { getWpConfig } from "@/lib/wp/config";
import { getPipelineConfig } from "@/lib/config/pipeline-config";

export async function getFeeds() {
  return db.select().from(feeds).orderBy(feeds.name);
}
export async function getMembers() {
  return db.select({ id: user.id, name: user.name, email: user.email, role: user.role, banned: user.banned, lastLoginAt: user.lastLoginAt })
    .from(user).orderBy(user.createdAt);
}
export async function getTaxonomy() {
  const [categories, tags] = await Promise.all([
    db.select().from(wpCategories).orderBy(wpCategories.name),
    db.select().from(wpTags).orderBy(wpTags.name),
  ]);
  return { categories, tags };
}
export async function getIntegrationStatus() {
  const cfg = getPipelineConfig();
  const [lastPub] = await db.select({ at: distributions.at }).from(distributions).where(eq(distributions.status, "sent")).orderBy(desc(distributions.at)).limit(1);
  const [lastRun] = await db.select({ at: pipelineRuns.startedAt, status: pipelineRuns.status }).from(pipelineRuns).orderBy(desc(pipelineRuns.startedAt)).limit(1);
  return {
    wordpress: { configured: !!getWpConfig(), lastSuccessAt: lastPub?.at ?? null },
    omniroute: { configured: !!cfg.omniroute },
    openrouter: { configured: !!cfg.openrouter },
    jina: { configured: !!cfg.jina },
    firecrawl: { configured: !!cfg.firecrawl },
    lastRun: lastRun ?? null,
  };
}
```

- [ ] **Step 4: Settings sub-nav (client)**

`components/settings/settings-nav.tsx` — role-filtered horizontal/vertical nav: `Sources RSS` (`/settings/feeds`), `Catégories & Tags` (`/settings/taxonomy`) for editor+admin; `Équipe` (`/settings/team`), `Intégrations` (`/settings/integrations`) for admin only. Active state via `usePathname`. Full code following the shell/sidebar pattern.

- [ ] **Step 5: Layout + gated pages**

`app/(app)/settings/layout.tsx`: `const user = await requireUser();` render `<SettingsNav role={user.role} />` + `{children}`.
Each page adds its guard at the top and renders its data (the table components arrive in Tasks 2–5; for now render the heading + fetched data in a minimal list so the page compiles):
```tsx
// app/(app)/settings/feeds/page.tsx
import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";
import { getFeeds } from "@/lib/queries/settings";
export default async function Page() {
  const user = await requireUser(); requirePermission(user.role, "feed", "manage");
  const feeds = await getFeeds();
  return <div className="space-y-4"><h1 className="text-xl font-semibold">Sources RSS</h1>{/* FeedsTable in Task 2 */}<pre className="text-xs text-muted-foreground">{feeds.length} source(s)</pre></div>;
}
```
Do the same for `taxonomy` (`taxonomy:manage`), `team` (`team:manage`), `integrations` (`pipeline:configure`) — each guarded + fetching its data. `requirePermission` throws for a disallowed role (Journaliste on any; Éditeur on team/integrations).

- [ ] **Step 6: typecheck + build + commit** — `bun run typecheck && bun run build`. `git add -A && git commit -m "feat(settings): shell, role-gated sub-nav + pages, read queries"`

---

## Task 2: Sources RSS (CRUD + test-feed)

**Files:** Create `lib/actions/feed-actions.ts`, `components/settings/{feeds-table.tsx,feed-sheet.tsx}`; Modify `app/(app)/settings/feeds/page.tsx`; Test `tests/feed-actions.test.ts`

**Interfaces:**
- Produces server actions (all `requirePermission(role,"feed","manage")`): `createFeed(input)`, `updateFeed(id, input)`, `toggleFeed(id, active)`, `deleteFeed(id)`, `testFeed(url): {ok, count?, message?}`.

- [ ] **Step 1: Guard + test-feed test first**

`tests/feed-actions.test.ts`:
```ts
import { describe, it, expect } from "bun:test";
import { can } from "@/lib/rbac";
import { validateFeedInput } from "@/lib/actions/feed-actions";
describe("feed actions", () => {
  it("only editor/admin manage feeds", () => {
    expect(can("editor","feed","manage")).toBe(true);
    expect(can("journalist","feed","manage")).toBe(false);
  });
  it("validates feed input (url required)", () => {
    expect(validateFeedInput({ name: "X", feedUrl: "not-a-url", active: true }).ok).toBe(false);
    expect(validateFeedInput({ name: "X", feedUrl: "https://x.com/feed", active: true }).ok).toBe(true);
  });
});
```
(A DB round-trip integration test for create/toggle/delete is added in Step 4; `testFeed` against a real feed is exercised in Task 6.)

- [ ] **Step 2: Implement `lib/actions/feed-actions.ts`**

```ts
"use server";
import { db, feeds } from "@/db";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";
import { z } from "zod";

const feedSchema = z.object({
  name: z.string().min(2, "Nom trop court"),
  feedUrl: z.string().url("URL du flux invalide"),
  siteUrl: z.string().url("URL du site invalide").optional().or(z.literal("")),
  active: z.boolean(),
});
export function validateFeedInput(input: unknown) {
  const r = feedSchema.safeParse(input);
  return r.success ? { ok: true as const, data: r.data } : { ok: false as const, message: r.error.issues[0]?.message ?? "Entrée invalide" };
}
async function guard() { const u = await requireUser(); requirePermission(u.role, "feed", "manage"); return u; }

export async function createFeed(input: z.infer<typeof feedSchema>) {
  await guard(); const { data } = { data: feedSchema.parse(input) };
  await db.insert(feeds).values({ name: data.name, feedUrl: data.feedUrl, siteUrl: data.siteUrl || null, active: data.active });
  revalidatePath("/settings/feeds");
}
export async function updateFeed(id: string, input: z.infer<typeof feedSchema>) {
  await guard(); const data = feedSchema.parse(input);
  await db.update(feeds).set({ name: data.name, feedUrl: data.feedUrl, siteUrl: data.siteUrl || null, active: data.active }).where(eq(feeds.id, id));
  revalidatePath("/settings/feeds");
}
export async function toggleFeed(id: string, active: boolean) {
  await guard(); await db.update(feeds).set({ active }).where(eq(feeds.id, id)); revalidatePath("/settings/feeds");
}
export async function deleteFeed(id: string) {
  await guard(); await db.delete(feeds).where(eq(feeds.id, id)); revalidatePath("/settings/feeds");
}
export async function testFeed(url: string) {
  await guard();
  try { const { parseFeed } = await import("@/lib/rss/parse-feed"); const items = await parseFeed(url);
    return { ok: true as const, count: items.length, message: `${items.length} article(s) trouvé(s).` };
  } catch (e) { return { ok: false as const, message: `Flux illisible : ${(e as Error).message}` }; }
}
```
> `parseFeed` transitively imports nothing jsdom-heavy (rss-parser), so a static import would be fine too; dynamic keeps parity.

- [ ] **Step 3: UI (feeds-table + feed-sheet) + wire page**

`components/settings/feeds-table.tsx` (client) — shadcn `Table`: nom, URL, health badge (`ok`→green/`--status-approved`, `error`→red/`--status-error`, `never`→slate/`--status-draft` from `lastFetchStatus`), articles 7 j (`itemsCaptured7d`), an active **Switch** (→ `toggleFeed`), row actions (Modifier → opens `FeedSheet`; Vérifier → `testFeed(feedUrl)` toast; Supprimer → `ConfirmDialog` → `deleteFeed`). Empty state "Aucune source configurée."
`components/settings/feed-sheet.tsx` (client) — a shadcn `Sheet` add/edit form (nom, feedUrl, siteUrl, actif switch) with a "Vérifier ce flux" button (`testFeed`) and Enregistrer (`createFeed`/`updateFeed`); zod-validated, French errors. (Base UI: use `render` not `asChild`.)
Wire `app/(app)/settings/feeds/page.tsx` to render `<FeedsTable feeds={await getFeeds()} />` + an "Ajouter une source" button opening `FeedSheet`.

- [ ] **Step 4: Self-cleaning integration test (create→toggle→delete)**

Extend `tests/feed-actions.test.ts` with a DB test calling the drizzle paths the actions use (or a helper) — insert a temp feed, toggle active, delete — asserting DB state, self-cleaning. (Actions themselves need a session; test the DB effect via the same queries, per the codebase pattern.) Reseed if seed rows touched (they aren't — temp rows only).

- [ ] **Step 5: Run tests + typecheck + build** — `bun test tests/feed-actions.test.ts && bun run typecheck && bun run build`.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(settings): RSS Sources admin — CRUD, health, test-feed"`

---

## Task 3: Équipe & rôles

**Files:** Create `lib/actions/team-actions.ts`, `components/settings/{members-table.tsx,add-member-dialog.tsx}`; Modify `app/(app)/settings/team/page.tsx`; Test `tests/team-actions.test.ts`

**Interfaces:**
- Produces (all `requirePermission(role,"team","manage")` = Admin): `addMember({email,name,role}): {ok, tempPassword?, message?}`, `setMemberRole(userId, role)`, `disableMember(userId)`, `enableMember(userId)`. Anti-self-lockout enforced.

- [ ] **Step 1: Guard + anti-lockout test first**

`tests/team-actions.test.ts`:
```ts
import { describe, it, expect } from "bun:test";
import { can } from "@/lib/rbac";
import { generateTempPassword } from "@/lib/actions/team-actions";
describe("team actions", () => {
  it("only admin manages the team", () => {
    expect(can("admin","team","manage")).toBe(true);
    expect(can("editor","team","manage")).toBe(false);
    expect(can("journalist","team","manage")).toBe(false);
  });
  it("temp password is reasonably strong", () => {
    const p = generateTempPassword();
    expect(p.length).toBeGreaterThanOrEqual(12);
    expect(generateTempPassword()).not.toBe(p); // random
  });
});
```

- [ ] **Step 2: Implement `lib/actions/team-actions.ts`**

```ts
"use server";
import { db, user } from "@/db";
import { and, eq, ne } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";
import { createCredentialUser } from "@/lib/create-user";
import { z } from "zod";
import { randomBytes } from "node:crypto";

export function generateTempPassword(): string {
  return randomBytes(12).toString("base64url").slice(0, 16) + "A9!"; // ensure length + variety
}
async function guard() { const u = await requireUser(); requirePermission(u.role, "team", "manage"); return u; }

const addSchema = z.object({ email: z.string().email("Email invalide"), name: z.string().min(2, "Nom trop court"), role: z.enum(["admin","editor","journalist"]) });
export async function addMember(input: z.infer<typeof addSchema>) {
  await guard(); const data = addSchema.parse(input);
  const existing = await db.select({ id: user.id }).from(user).where(eq(user.email, data.email)).limit(1);
  if (existing.length) return { ok: false as const, message: "Un membre avec cet email existe déjà." };
  const tempPassword = generateTempPassword();
  await createCredentialUser({ email: data.email, name: data.name, role: data.role, password: tempPassword });
  revalidatePath("/settings/team");
  return { ok: true as const, tempPassword };
}

const roleSchema = z.enum(["admin","editor","journalist"]);
export async function setMemberRole(userId: string, role: z.infer<typeof roleSchema>) {
  const me = await guard(); roleSchema.parse(role);
  if (userId === me.id && role !== "admin") {
    const otherAdmins = await db.select({ id: user.id }).from(user).where(and(eq(user.role, "admin"), ne(user.id, me.id)));
    if (otherAdmins.length === 0) return { ok: false as const, message: "Vous êtes le dernier administrateur — désignez un autre admin d'abord." };
  }
  await db.update(user).set({ role }).where(eq(user.id, userId));
  revalidatePath("/settings/team"); return { ok: true as const };
}
export async function disableMember(userId: string) {
  const me = await guard();
  if (userId === me.id) return { ok: false as const, message: "Vous ne pouvez pas désactiver votre propre compte." };
  await db.update(user).set({ banned: true }).where(eq(user.id, userId));
  // Revoke existing sessions so a disabled member is logged out immediately (ban only blocks new logins).
  const { session } = await import("@/db");
  await db.delete(session).where(eq(session.userId, userId));
  revalidatePath("/settings/team"); return { ok: true as const };
}
export async function enableMember(userId: string) {
  await guard(); await db.update(user).set({ banned: false }).where(eq(user.id, userId));
  revalidatePath("/settings/team"); return { ok: true as const };
}
```
> Setting `user.role`/`user.banned` directly is what the Better-Auth admin plugin reads (roles/ban checks). Verify against installed better-auth that `role`/`banned` columns are the source of truth (they are, per SP0 schema + SP3 usage).

- [ ] **Step 3: UI (members-table + add-member-dialog) + wire page**

`components/settings/members-table.tsx` (client) — table: nom, email, role badge (`ROLE_LABEL`), statut (Actif/Désactivé badge), dernière connexion (`formatDate`). Row actions: rôle `Select` (→ `setMemberRole`, toast; if returned `{ok:false}` toast the message), Désactiver/Réactiver (`ConfirmDialog` → `disableMember`/`enableMember`).
`components/settings/add-member-dialog.tsx` (client) — a `Dialog`: email + name + role Select → `addMember`. On `{ok, tempPassword}`, show the temp password ONCE in a copyable field with a clear "communiquez ce mot de passe au membre — il ne sera plus affiché" note. French; zod errors inline.
Wire `app/(app)/settings/team/page.tsx` → `<MembersTable members={await getMembers()} />` + "Ajouter un membre".

- [ ] **Step 4: Self-cleaning integration test (addMember → login works → cleanup)**

Extend `tests/team-actions.test.ts`: call `createCredentialUser` with a `generateTempPassword()` (the addMember path), then `auth.api.signInEmail` with that password succeeds; then delete the temp user (cascade). Assert role set correctly. Self-clean in afterAll.

- [ ] **Step 5: Run tests + typecheck + build** — `bun test tests/team-actions.test.ts && bun run typecheck && bun run build`.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(settings): Team & roles — add member (temp password), role change, disable (anti-lockout)"`

---

## Task 4: Catégories & Tags (mirror + WP sync)

**Files:** Create `lib/actions/taxonomy-actions.ts`, `components/settings/taxonomy-tables.tsx`; Modify `app/(app)/settings/taxonomy/page.tsx`; Test `tests/taxonomy-sync.test.ts`

**Interfaces:**
- Produces `syncTaxonomyFromWordPress(): {ok, categories?, tags?, message?}` (`requirePermission(role,"taxonomy","manage")`).

- [ ] **Step 1: Upsert logic test first (pure helper)**

`tests/taxonomy-sync.test.ts`:
```ts
import { describe, it, expect } from "bun:test";
import { diffTaxonomy } from "@/lib/actions/taxonomy-actions";
describe("diffTaxonomy", () => {
  it("splits WP terms into inserts (new names) and updates (existing names)", () => {
    const existing = [{ name: "Économie", wpId: null as number|null }];
    const wp = [{ id: 5, name: "Économie" }, { id: 8, name: "Finance" }];
    const d = diffTaxonomy(existing, wp);
    expect(d.updates).toEqual([{ name: "Économie", wpId: 5 }]);
    expect(d.inserts).toEqual([{ name: "Finance", wpId: 8 }]);
  });
});
```

- [ ] **Step 2: Implement `lib/actions/taxonomy-actions.ts`**

`diffTaxonomy(existing, wpTerms)` (PURE) → `{ inserts: {name,wpId}[], updates: {name,wpId}[] }` (case-insensitive name match). Then:
```ts
export async function syncTaxonomyFromWordPress() {
  const u = await requireUser(); requirePermission(u.role, "taxonomy", "manage");
  const { getWpConfig } = await import("@/lib/wp/config");
  const cfg = getWpConfig(); if (!cfg) return { ok: false as const, message: "WordPress non configuré." };
  const { WordPressClient } = await import("@/lib/wp/client");
  const { db, wpCategories, wpTags } = await import("@/db"); const { eq } = await import("drizzle-orm");
  const wp = new WordPressClient(cfg);
  const [wpCats, wpTagsList] = await Promise.all([wp.getCategories(), wp.getTags()]);
  // upsert categories + tags by name (insert new, update wpId on existing); count = WP term count
  // (implement with diffTaxonomy over the current db rows; set wpId + articleCount from the WP `count` field)
  // ... full implementation ...
  revalidatePath("/settings/taxonomy");
  return { ok: true as const, categories: wpCats.length, tags: wpTagsList.length };
}
```
Provide the full upsert: read current `wpCategories`/`wpTags`, `diffTaxonomy`, `db.insert` the inserts, `db.update` `wpId`+`articleCount` for the updates. `WordPressClient.getCategories()/getTags()` return `{id, name, count}` (extend the client's return type if needed to include `count` — additive to the existing method).

- [ ] **Step 3: UI + wire page**

`components/settings/taxonomy-tables.tsx` (client) — two tables (Catégories / Tags): nom, WP id (or "—" if unsynced), nombre d'articles. A "Synchroniser depuis WordPress" button → `syncTaxonomyFromWordPress` in a transition, toast the recap or the "non configuré" message. Empty state.
Wire `app/(app)/settings/taxonomy/page.tsx` → `<TaxonomyTables data={await getTaxonomy()} />`.

- [ ] **Step 4: Integration test (sync upsert via fake WP)**

Extend `tests/taxonomy-sync.test.ts`: point WP env at a `Bun.serve` fake returning a couple of categories/tags with `count`; call the sync path (or its core upsert helper) against a temp taxonomy state; assert new terms inserted + existing get their `wpId`. Self-clean + reseed (the seed's wp_* rows are the baseline — restore them).

- [ ] **Step 5: Run tests + typecheck + build** — `bun test tests/taxonomy-sync.test.ts && bun run typecheck && bun run build`. Reseed.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(settings): Categories/Tags mirror + sync from WordPress"`

---

## Task 5: Intégrations (status + free test)

**Files:** Create `lib/actions/integration-actions.ts`, `components/settings/integration-cards.tsx`; Modify `app/(app)/settings/integrations/page.tsx`; Test `tests/integration-status.test.ts`

**Interfaces:**
- Consumes `getIntegrationStatus()` (Task 1). Produces `testIntegration(name): {ok, detail}` (`requirePermission(role,"pipeline","configure")` = Admin; FREE checks only).

- [ ] **Step 1: Guard + status-shape test first**

`tests/integration-status.test.ts`:
```ts
import { describe, it, expect } from "bun:test";
import { can } from "@/lib/rbac";
describe("integration test guard", () => {
  it("only admin can test integrations", () => {
    expect(can("admin","pipeline","configure")).toBe(true);
    expect(can("editor","pipeline","configure")).toBe(false);
  });
});
```
(A DB test for `getIntegrationStatus` shape against the seeded config is added in Step 3.)

- [ ] **Step 2: Implement `lib/actions/integration-actions.ts`**

```ts
"use server";
import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";

export async function testIntegration(name: string) {
  const u = await requireUser(); requirePermission(u.role, "pipeline", "configure");
  const { getWpConfig } = await import("@/lib/wp/config");
  const { getPipelineConfig } = await import("@/lib/config/pipeline-config");
  const cfg = getPipelineConfig();
  try {
    if (name === "wordpress") {
      const wc = getWpConfig(); if (!wc) return { ok: false as const, detail: "Non configuré." };
      const { WordPressClient } = await import("@/lib/wp/client");
      return { ok: await new WordPressClient(wc).testConnection(), detail: "Connexion WordPress vérifiée." };
    }
    if (name === "omniroute" || name === "openrouter") {
      const p = name === "omniroute" ? cfg.omniroute : cfg.openrouter;
      if (!p) return { ok: false as const, detail: "Non configuré." };
      const res = await fetch(`${p.baseUrl}/models`, { headers: { Authorization: `Bearer ${p.apiKey}` }, signal: AbortSignal.timeout(15000) });
      return { ok: res.ok, detail: res.ok ? "Clé valide (/models)." : `HTTP ${res.status}` }; // FREE — no completion
    }
    if (name === "jina") return { ok: !!cfg.jina, detail: cfg.jina ? "Clé Jina présente." : "Non configuré." };
    if (name === "firecrawl") return { ok: !!cfg.firecrawl, detail: cfg.firecrawl ? "Clé Firecrawl présente." : "Non configuré." };
    return { ok: false as const, detail: "Intégration inconnue." };
  } catch (e) { return { ok: false as const, detail: `Échec : ${(e as Error).message}` }; }
}
```
> LLM test uses the FREE `/models` endpoint (never a token-spending completion). Jina/Firecrawl report configured (a lightweight reachability HEAD may be added, but must stay free).

- [ ] **Step 3: UI + wire page + status test**

`components/settings/integration-cards.tsx` (client) — a `Card` per integration (WordPress, OmniRoute, OpenRouter, Jina, Firecrawl): name, a "Configuré"/"Non configuré" badge (green/slate), the last-success line when present, and a "Tester" button → `testIntegration(name)` in a transition, toast `{ok?success:error, detail}`. Reserved (disabled) card slots for WhatsApp/réseaux sociaux ("Bientôt — SP6"). French.
Wire `app/(app)/settings/integrations/page.tsx` → `<IntegrationCards status={await getIntegrationStatus()} />`.
Add to `tests/integration-status.test.ts` a check that `getIntegrationStatus()` returns the expected shape (wordpress/omniroute/openrouter/jina/firecrawl + configured booleans) against the current env.

- [ ] **Step 4: Run tests + typecheck + build** — `bun test tests/integration-status.test.ts && bun run typecheck && bun run build`.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(settings): Integrations status + free test (no in-UI secret editing)"`

---

## Task 6: End-to-end verification

**Files:** none (verification).

- [ ] **Step 1: Green baseline** — `bun run typecheck && bun test && bun run build` all pass.

- [ ] **Step 2: Drive the app (run/verify skill)**, signed in as `admin@afrotiative.com`:
  1. **Sources RSS:** add a source (valid feed URL) → appears; "Vérifier ce flux" on a real seeded feed → toast "N articles trouvés"; test a broken URL → clear error toast; toggle active off/on; edit; delete (confirm). Health badges render.
  2. **Équipe:** add a member (email + role) → the one-time temp password is shown + copyable; the member appears Actif; change their role; disable (confirm) → Désactivé; re-enable. Try to disable yourself → refused with the anti-lockout message.
  3. **Catégories & Tags:** "Synchroniser depuis WordPress" → real WP categories/tags appear with real WP ids (or "non configuré" if creds absent — they're present, so real sync).
  4. **Intégrations:** cards show Configuré for wordpress/omniroute/openrouter/jina/firecrawl; "Tester" WordPress → success; "Tester" OmniRoute/OpenRouter → success via /models (no tokens spent).
- [ ] **Step 3: RBAC checks** — sign in as `editor@afrotiative.com`: sees Sources RSS + Catégories/Tags, NOT Équipe/Intégrations (nav hidden AND direct `/settings/team` refused). Sign in as `journaliste@afrotiative.com`: no Réglages nav; `/settings/feeds` refused.
- [ ] **Step 4: Cleanup** — delete any members/feeds created during verification (or `bun run db:seed` to restore the baseline); confirm 25 articles / 3 users / 6 feeds. Note: a WP taxonomy sync updates the local `wp_*` mirror (fine; reseed restores the demo placeholders). Remove throwaway artifacts.
- [ ] **Step 5: Final commit / tag** — `git add -A && git commit -m "chore: SP2 verified — Settings admin end-to-end" || echo "nothing to commit"; git tag sp2-complete`

---

## Self-Review Notes (coverage map)

- **Spec §3 shell/RBAC** → Task 1. **§4 Sources RSS** → Task 2. **§5 Équipe (temp password, anti-lockout)** → Task 3. **§6 Catégories/Tags + WP sync** → Task 4. **§7 Intégrations (status + free test)** → Task 5. **§8 no new tables** → all (existing tables). **§9 transverse (confirmations, states, French)** → Tasks 2–5 UI. **§10 tests/verification** → each task + Task 6.
- **RBAC server-enforced per page AND action:** page guards (Task 1) + action `requirePermission` (Tasks 2–5); Journaliste refused everywhere, Éditeur refused on team/integrations — asserted in Task 1's test + Task 6's browser check.
- **Safety:** temp password shown once/never logged (Task 3); no in-UI secret editing / free integration tests only (Task 5); disable-not-delete + anti-self-lockout (Task 3); human-review gate untouched (Settings never publishes).
- **Reuse:** `feeds`/`user`/`wp_*`/`distributions` tables, `parseFeed` (SP3), `WordPressClient` (SP5), `getPipelineConfig`, Better-Auth, `RoleGate`/`ConfirmDialog`/status tokens.
```
