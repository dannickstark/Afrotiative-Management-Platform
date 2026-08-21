# Inserts enrichis (SP3) — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rendre les inserts pleinement exploitables : édition complète (kind, tc in/out, durée, crédit, droits, url), vérification des liens (ok/mort/interdit), upload d'images/graphiques vers R2.

**Architecture:** Un cœur d'édition partielle (`updateBeatInsertCore` étendu), un vérificateur pur (`verifyUrl` : garde SSRF + GET par plage), un cœur d'upload (validateur `sharp` + `putObject`), et une UI `InsertRow` transformée en formulaire complet avec boutons Vérifier/Téléverser. Aucune migration (toutes les colonnes existent).

**Tech Stack:** Next.js (App Router), Drizzle/Postgres, `sharp` (validation image), R2 (`putObject`), shadcn/ui, `bun test`. Aucune nouvelle dépendance.

**Spec:** `docs/superpowers/specs/2026-08-21-video-inserts-enrichis-design.md`

## Global Constraints

- **Copie UI en français.**
- **AUCUNE migration.** Toutes les colonnes de `beat_inserts` existent déjà (kind, url, r2Key, tcIn, tcOut, displayDurationSec, credit, rightsNote, linkStatus, linkCheckedAt). Aucune nouvelle valeur d'enum.
- **Ordre de verrou** pour toute transaction touchant les inserts : `script_variants` (FOR UPDATE) → `script_beats` → `beat_inserts`. Ne jamais réintroduire le cycle ABBA.
- **Reset de statut resserré :** `linkStatus`/`linkCheckedAt` ne repassent à `non_verifie`/`null` QUE si `url` est fourni ET change. Éditer crédit/droits/tc/kind ne touche pas le statut.
- **Pureté :** `lib/video/timecode.ts`, `lib/video/link-check.ts`, `lib/async-pool.ts` restent PURS (`fetch` injectable, pas de `@/db`). Les cœurs DB vivent dans `lib/video/persist.ts` / `lib/video/insert-upload-core.ts` (sans `"use server"`). Les server actions (`lib/actions/video-actions.ts`) débutent par `guard()` = `requireUser()` + `requirePermission(role,"video","manage")` et convertissent `RefusalError` via `refusable()`.
- **SSRF :** `isSafePublicHttpUrl` appliqué DANS le vérificateur avant tout fetch ; URL privée/non-http → `mort` sans requête. Le bypass de garde n'existe qu'en `NODE_ENV === "test"` AVEC un `fetchImpl` injecté (motif `lib/studio/images.ts`).
- **Vérificateur :** GET avec `Range: "bytes=0-0"`, `AbortSignal.timeout`, `redirect: "follow"`, **corps jamais lu**. Mapping : 2xx→`ok`, 401/403→`interdit`, autre→`mort`, exception→`mort`.
- **Upload :** images/graphiques uniquement, `validateImageAsset` (`sharp`, 5 Mio, png/jpeg/webp/svg). Nouveau préfixe de clé `video/inserts/{yyyy}/{mm}/{uuid}.{ext}`. `getStudioConfig()` null → refus propre.
- **Tests purs** inscrits dans `PURE_FILES` de `scripts/test-fast.ts` (nom nu). Tests DB : voie lente, nettoyage obligatoire, **UUID valides** pour les colonnes `uuid` (projet/variante/beat/insert). Signal vert = `bun run typecheck` + `bun run test:pure`.

---

## File Structure

| Fichier | Rôle | Action |
|---|---|---|
| `lib/video/schema.ts` | Kinds d'insert exportés | Modifier — `INSERT_KINDS`/`InsertKind` |
| `lib/video/timecode.ts` | Timecode → secondes (pur) | Créer |
| `lib/async-pool.ts` | Concurrence bornée (pur) | Créer |
| `lib/video/link-check.ts` | `verifyUrl` (pur, fetch injectable) | Créer |
| `lib/video/insert-upload-core.ts` | Upload R2 d'un média d'insert (DB core) | Créer |
| `lib/video/persist.ts` | Cœurs inserts | Modifier — `updateBeatInsertCore` étendu, `setInsertLinkStatusCore`, read cores, `verifyProjectLinksCore` |
| `lib/validation.ts` | Schéma d'édition | Modifier — `updateInsertSchema` étendu |
| `lib/actions/video-actions.ts` | Server actions | Modifier — `verifyInsertLink`, `verifyProjectLinks`, `uploadInsertMedia` |
| `components/video/beat-list.tsx` | Types vue | Modifier — `InsertView` gagne rightsNote/r2Key/linkCheckedAt |
| `components/video/beat-inspector.tsx` | `InsertRow` | Modifier — formulaire complet + Vérifier + Téléverser |
| `app/(app)/video/[id]/page.tsx` | Page projet | Modifier — mapping insert complet + bouton « Vérifier tous les liens » |
| `scripts/test-fast.ts` | Allowlist tests purs | Modifier |

---

## Task 1: Kinds d'insert exportés + module timecode (pur)

**Files:**
- Modify: `lib/video/schema.ts`
- Create: `lib/video/timecode.ts`
- Test: `tests/video-timecode.test.ts` (pur)
- Modify: `scripts/test-fast.ts`

**Interfaces:**
- Produces: `INSERT_KINDS` (const tuple), `InsertKind` (union) ; `parseTimecode(tc: string|null): number|null`, `insertSpanSeconds(tcIn: string|null, tcOut: string|null): number|null`.

- [ ] **Step 1: Écrire le test qui échoue**

Créer `tests/video-timecode.test.ts` :

```ts
import { expect, test } from "bun:test";
import { parseTimecode, insertSpanSeconds } from "@/lib/video/timecode";

test("parseTimecode : HH:MM:SS et millisecondes", () => {
  expect(parseTimecode("00:00:05")).toBe(5);
  expect(parseTimecode("01:02:03")).toBe(3723);
  expect(parseTimecode("00:00:01.500")).toBe(1.5);
  expect(parseTimecode("00:00:01.5")).toBe(1.5);
});

test("parseTimecode : hors format → null", () => {
  expect(parseTimecode("1:2:3")).toBeNull();
  expect(parseTimecode("abc")).toBeNull();
  expect(parseTimecode(null)).toBeNull();
  expect(parseTimecode("")).toBeNull();
});

test("insertSpanSeconds : out−in si valide, sinon null", () => {
  expect(insertSpanSeconds("00:00:01", "00:00:05")).toBe(4);
  expect(insertSpanSeconds("00:00:05", "00:00:01")).toBeNull(); // out ≤ in
  expect(insertSpanSeconds("00:00:05", "00:00:05")).toBeNull();
  expect(insertSpanSeconds("00:00:01", null)).toBeNull();
  expect(insertSpanSeconds("bad", "00:00:05")).toBeNull();
});
```

- [ ] **Step 2: Lancer et vérifier l'échec**

Run: `bun test tests/video-timecode.test.ts`
Expected: FAIL — module introuvable.

- [ ] **Step 3: Ajouter les kinds exportés**

Dans `lib/video/schema.ts`, sous `TC_RE` (ligne 17) :

```ts
export const INSERT_KINDS = ["image", "video", "extrait", "graphique", "fichier"] as const;
export type InsertKind = (typeof INSERT_KINDS)[number];
```

(Ne pas refactorer `insertPayloadSchema` — son `z.enum([...])` inline reste équivalent ; on évite tout risque sur l'import.)

- [ ] **Step 4: Écrire le module timecode**

Créer `lib/video/timecode.ts` :

```ts
import { TC_RE } from "@/lib/video/schema";

/** `HH:MM:SS(.mmm)` → secondes (ms incluses). `null` si non conforme à TC_RE. */
export function parseTimecode(tc: string | null): number | null {
  if (!tc || !TC_RE.test(tc)) return null;
  const [hms, ms] = tc.split(".");
  const [h, m, s] = hms.split(":").map(Number);
  const millis = ms ? Number(ms.padEnd(3, "0")) : 0;
  return h * 3600 + m * 60 + s + millis / 1000;
}

/** Durée en secondes si les deux timecodes sont valides et `out > in`, sinon `null`. */
export function insertSpanSeconds(tcIn: string | null, tcOut: string | null): number | null {
  const a = parseTimecode(tcIn);
  const b = parseTimecode(tcOut);
  if (a === null || b === null) return null;
  const span = b - a;
  return span > 0 ? span : null;
}
```

- [ ] **Step 5: Lancer, inscrire le pur, typecheck, commit**

Run: `bun test tests/video-timecode.test.ts` → PASS.
Ajouter `"video-timecode.test.ts"` au `PURE_FILES`.
Run: `bun run typecheck && bun run test:pure`

```bash
git add lib/video/schema.ts lib/video/timecode.ts tests/video-timecode.test.ts scripts/test-fast.ts
git commit -m "feat(video): kinds d'insert exportés et module timecode"
```

---

## Task 2: Édition complète de l'insert (schéma + cœur)

**Files:**
- Modify: `lib/validation.ts` (`updateInsertSchema`)
- Modify: `lib/video/persist.ts` (`updateBeatInsertCore`)
- Test: `tests/insert-edit-core.test.ts` (DB)

**Interfaces:**
- Consumes: `INSERT_KINDS`/`InsertKind`, `TC_RE`, `insertSpanSeconds` (Task 1).
- Produces: `updateBeatInsertCore(input: { insertId: string; url?: string|null; kind?: InsertKind; tcIn?: string|null; tcOut?: string|null; displayDurationSec?: number|null; credit?: string|null; rightsNote?: string|null }): Promise<void>` — patch partiel. `UpdateInsertInput` élargi.

- [ ] **Step 1: Étendre le schéma**

Dans `lib/validation.ts`, ajouter les imports en tête : `import { TC_RE, INSERT_KINDS } from "@/lib/video/schema";` et `import { insertSpanSeconds } from "@/lib/video/timecode";`. Remplacer `updateInsertSchema` (lignes 392-401) par :

```ts
export const updateInsertSchema = z.object({
  insertId: z.string().uuid(),
  url: z.string().url("URL invalide.").refine((u) => /^https?:\/\//i.test(u), "URL invalide (http/https uniquement).")
    .max(2048).nullable().optional(),
  kind: z.enum(INSERT_KINDS).optional(),
  tcIn: z.string().regex(TC_RE, "Timecode invalide (HH:MM:SS).").nullable().optional(),
  tcOut: z.string().regex(TC_RE, "Timecode invalide (HH:MM:SS).").nullable().optional(),
  displayDurationSec: z.number().int().min(1).max(600).nullable().optional(),
  credit: z.string().max(200).nullable().optional(),
  rightsNote: z.string().max(500).nullable().optional(),
}).refine(
  (v) => !(v.tcIn && v.tcOut) || insertSpanSeconds(v.tcIn, v.tcOut) !== null,
  { message: "Le point de sortie doit suivre le point d'entrée.", path: ["tcOut"] },
);
export type UpdateInsertInput = z.infer<typeof updateInsertSchema>;
```

Sémantique de patch partiel : `.optional()` = champ absent (no-op) ; `.nullable()` = mise à null explicite (vider) ; une valeur = écriture.

- [ ] **Step 2: Écrire le test DB qui échoue**

Créer `tests/insert-edit-core.test.ts` (UUID valides ; nettoyage `afterAll`) :

```ts
import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, videoProjects, scriptVariants, scriptBeats, beatInserts } from "@/db";
import { updateBeatInsertCore } from "@/lib/video/persist";

const P = "00000000-0000-0000-0000-0000000003a1";
let insertId = "";

afterAll(async () => { await db.delete(videoProjects).where(eq(videoProjects.id, P)); });

test("patch partiel : crédit/tc éditables sans reset du statut ; url change → reset", async () => {
  await db.insert(videoProjects).values({ id: P, title: "T", subject: null }).onConflictDoNothing();
  const [v] = await db.insert(scriptVariants).values({ projectId: P, platform: "youtube_long", position: 0 }).returning();
  const [b] = await db.insert(scriptBeats).values({ variantId: v.id, externalId: "b1", position: 0, kind: "insert", spokenText: "" }).returning();
  const [ins] = await db.insert(beatInserts).values({ beatId: b.id, kind: "image", url: "http://x/a.jpg", position: 0, linkStatus: "ok", linkCheckedAt: new Date() }).returning();
  insertId = ins.id;

  // Éditer crédit + tc : le statut vérifié DOIT survivre.
  await updateBeatInsertCore({ insertId, credit: "AFP", tcIn: "00:00:01", tcOut: "00:00:05" });
  let [row] = await db.select().from(beatInserts).where(eq(beatInserts.id, insertId));
  expect(row.credit).toBe("AFP");
  expect(row.tcIn).toBe("00:00:01");
  expect(row.linkStatus).toBe("ok"); // pas de reset

  // Changer l'url : reset à non_verifie.
  await updateBeatInsertCore({ insertId, url: "http://x/b.jpg" });
  [row] = await db.select().from(beatInserts).where(eq(beatInserts.id, insertId));
  expect(row.url).toBe("http://x/b.jpg");
  expect(row.linkStatus).toBe("non_verifie");
  expect(row.linkCheckedAt).toBeNull();

  // Champ absent = inchangé (crédit non touché en ne le passant pas).
  await updateBeatInsertCore({ insertId, rightsNote: "CC-BY" });
  [row] = await db.select().from(beatInserts).where(eq(beatInserts.id, insertId));
  expect(row.credit).toBe("AFP");
  expect(row.rightsNote).toBe("CC-BY");
});
```

- [ ] **Step 3: Lancer et vérifier l'échec**

Run: `bun test tests/insert-edit-core.test.ts`
Expected: FAIL — `updateBeatInsertCore` n'accepte pas encore ces champs (typecheck/erreur d'exécution).

- [ ] **Step 4: Étendre le cœur (patch partiel, ordre de verrou conservé)**

Dans `lib/video/persist.ts`, ajouter `InsertKind` à l'import depuis `@/lib/video/schema` (ligne 12). Remplacer la signature et le corps de `updateBeatInsertCore` (le walk + verrou restent identiques ; seule la construction du `set` change) :

```ts
export async function updateBeatInsertCore(input: {
  insertId: string;
  url?: string | null;
  kind?: InsertKind;
  tcIn?: string | null;
  tcOut?: string | null;
  displayDurationSec?: number | null;
  credit?: string | null;
  rightsNote?: string | null;
}): Promise<void> {
  await db.transaction(async (tx) => {
    const [locatedInsert] = await tx.select({ beatId: beatInserts.beatId }).from(beatInserts)
      .where(eq(beatInserts.id, input.insertId));
    if (!locatedInsert) throw new RefusalError("Insert introuvable.");

    const [locatedBeat] = await tx.select({ variantId: scriptBeats.variantId }).from(scriptBeats)
      .where(eq(scriptBeats.id, locatedInsert.beatId));
    if (!locatedBeat) throw new RefusalError("Beat introuvable pour cet insert.");

    const [variant] = await tx.select({ id: scriptVariants.id }).from(scriptVariants)
      .where(eq(scriptVariants.id, locatedBeat.variantId)).for("update");
    if (!variant) throw new RefusalError("Variante introuvable pour cet insert.");

    const [current] = await tx.select().from(beatInserts).where(eq(beatInserts.id, input.insertId));
    if (!current) throw new RefusalError("Insert introuvable.");

    const urlProvided = input.url !== undefined;
    const urlChanged = urlProvided && input.url !== current.url;

    await tx.update(scriptBeats).set({ locallyEditedAt: new Date(), updatedAt: new Date() })
      .where(eq(scriptBeats.id, locatedInsert.beatId));

    // Patch partiel : n'écrire QUE les champs fournis (absent = no-op ; null = vider).
    const patch: Partial<typeof beatInserts.$inferInsert> = { updatedAt: new Date() };
    if (urlProvided) patch.url = input.url ?? null;
    if (input.kind !== undefined) patch.kind = input.kind;
    if (input.tcIn !== undefined) patch.tcIn = input.tcIn;
    if (input.tcOut !== undefined) patch.tcOut = input.tcOut;
    if (input.displayDurationSec !== undefined) patch.displayDurationSec = input.displayDurationSec;
    if (input.credit !== undefined) patch.credit = input.credit;
    if (input.rightsNote !== undefined) patch.rightsNote = input.rightsNote;
    // Seul un changement d'URL invalide la vérification (r2Key jamais touché ici).
    if (urlChanged) { patch.linkStatus = "non_verifie"; patch.linkCheckedAt = null; }

    await tx.update(beatInserts).set(patch).where(eq(beatInserts.id, input.insertId));
    await tx.update(scriptVariants).set({ updatedAt: new Date() }).where(eq(scriptVariants.id, locatedBeat.variantId));
  });
}
```

L'action `updateInsert` (`lib/actions/video-actions.ts:96`) reste inchangée : elle passe déjà `parsed.data` (désormais élargi) au cœur.

- [ ] **Step 5: Lancer et vérifier le succès + typecheck**

Run: `bun test tests/insert-edit-core.test.ts && bun run typecheck`
Expected: PASS + exit 0. NE PAS inscrire ce test au `PURE_FILES` (DB).

- [ ] **Step 6: Commit**

```bash
git add lib/validation.ts lib/video/persist.ts tests/insert-edit-core.test.ts
git commit -m "feat(video): édition complète des métadonnées et timecodes d'un insert"
```

---

## Task 3: Vérification des liens (pur + cœurs + actions)

**Files:**
- Create: `lib/video/link-check.ts` (pur), `lib/async-pool.ts` (pur)
- Modify: `lib/video/persist.ts` (`setInsertLinkStatusCore`, `getInsertUrlCore`, `listProjectInsertsForVerifyCore`, `verifyProjectLinksCore`)
- Modify: `lib/actions/video-actions.ts` (`verifyInsertLink`, `verifyProjectLinks`)
- Test: `tests/link-check.test.ts` (pur), `tests/async-pool.test.ts` (pur), `tests/insert-verify-core.test.ts` (DB)
- Modify: `scripts/test-fast.ts`

**Interfaces:**
- Produces:
  - `verifyUrl(url: string|null, opts?: { fetchImpl?: typeof fetch; timeoutMs?: number }): Promise<{ status: "ok"|"mort"|"interdit"; httpStatus?: number }>`
  - `mapWithConcurrency<T,R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]>`
  - `setInsertLinkStatusCore({ insertId, status }): Promise<void>` ; `getInsertUrlCore(insertId): Promise<{ url: string|null }|null>` ; `listProjectInsertsForVerifyCore(projectId): Promise<{ id: string; url: string|null }[]>` ; `verifyProjectLinksCore({ projectId, fetchImpl? }): Promise<{ ok: number; mort: number; interdit: number }>`.
  - Actions `verifyInsertLink(insertId)`, `verifyProjectLinks(projectId)`.

- [ ] **Step 1: Tests purs qui échouent**

Créer `tests/link-check.test.ts` :

```ts
import { expect, test } from "bun:test";
import { verifyUrl } from "@/lib/video/link-check";

const fetchStatus = (status: number): typeof fetch =>
  (async () => new Response(null, { status })) as unknown as typeof fetch;

test("2xx → ok", async () => {
  expect((await verifyUrl("https://x.test/a", { fetchImpl: fetchStatus(206) })).status).toBe("ok");
  expect((await verifyUrl("https://x.test/a", { fetchImpl: fetchStatus(200) })).status).toBe("ok");
});
test("401/403 → interdit", async () => {
  expect((await verifyUrl("https://x.test/a", { fetchImpl: fetchStatus(403) })).status).toBe("interdit");
  expect((await verifyUrl("https://x.test/a", { fetchImpl: fetchStatus(401) })).status).toBe("interdit");
});
test("autre 4xx/5xx → mort", async () => {
  expect((await verifyUrl("https://x.test/a", { fetchImpl: fetchStatus(404) })).status).toBe("mort");
  expect((await verifyUrl("https://x.test/a", { fetchImpl: fetchStatus(500) })).status).toBe("mort");
});
test("exception → mort", async () => {
  const boom = (async () => { throw new Error("net"); }) as unknown as typeof fetch;
  expect((await verifyUrl("https://x.test/a", { fetchImpl: boom })).status).toBe("mort");
});
test("url privée/non-http → mort SANS fetch", async () => {
  let called = false;
  const spy = (async () => { called = true; return new Response(null, { status: 200 }); }) as unknown as typeof fetch;
  expect((await verifyUrl("http://127.0.0.1/x", { fetchImpl: spy })).status).toBe("mort");
  expect((await verifyUrl(null, { fetchImpl: spy })).status).toBe("mort");
  expect(called).toBe(false);
});
```

Note : le bypass de garde exige `NODE_ENV === "test"` (bun test le pose) + `fetchImpl` — donc la garde SSRF est bien exercée ici (url privée → mort sans fetch) car `isSafePublicHttpUrl` est vérifié AVANT le bypass de fetch.

Créer `tests/async-pool.test.ts` :

```ts
import { expect, test } from "bun:test";
import { mapWithConcurrency } from "@/lib/async-pool";

test("traite tous les éléments, jamais plus de `limit` en vol", async () => {
  let inFlight = 0, maxSeen = 0;
  const items = Array.from({ length: 10 }, (_, i) => i);
  const out = await mapWithConcurrency(items, 3, async (n) => {
    inFlight++; maxSeen = Math.max(maxSeen, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--; return n * 2;
  });
  expect(out).toEqual(items.map((n) => n * 2));
  expect(maxSeen).toBeLessThanOrEqual(3);
});

test("liste vide → []", async () => {
  expect(await mapWithConcurrency([], 3, async () => 1)).toEqual([]);
});
```

- [ ] **Step 2: Lancer et vérifier l'échec**

Run: `bun test tests/link-check.test.ts tests/async-pool.test.ts`
Expected: FAIL — modules introuvables.

- [ ] **Step 3: Écrire `lib/async-pool.ts`**

```ts
/** Applique `fn` à chaque élément, au plus `limit` en parallèle, en préservant l'ordre. */
export async function mapWithConcurrency<T, R>(
  items: T[], limit: number, fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker);
  await Promise.all(workers);
  return results;
}
```

- [ ] **Step 4: Écrire `lib/video/link-check.ts`**

```ts
import { isSafePublicHttpUrl } from "@/lib/url-guard";

export type VerifyResult = { status: "ok" | "mort" | "interdit"; httpStatus?: number };

export async function verifyUrl(
  url: string | null,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<VerifyResult> {
  if (!url || !url.trim()) return { status: "mort" };
  // Garde SSRF appliquée AVANT tout fetch ; jamais contournée hors NODE_ENV=test + fetchImpl.
  if (!isSafePublicHttpUrl(url)) return { status: "mort" };
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    // GET par plage : ne télécharge pas le fichier ; le corps n'est jamais lu.
    const res = await doFetch(url, {
      method: "GET",
      headers: { Range: "bytes=0-0" },
      redirect: "follow",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
    const s = res.status;
    if (s >= 200 && s < 300) return { status: "ok", httpStatus: s };
    if (s === 401 || s === 403) return { status: "interdit", httpStatus: s };
    return { status: "mort", httpStatus: s };
  } catch {
    return { status: "mort" };
  }
}
```

Note : contrairement à `prepareImage`, la garde SSRF s'applique ICI **toujours** (pas de bypass) — le test injecte `fetchImpl` mais utilise une url privée pour vérifier que la garde court-circuite avant le fetch, et une url publique `https://x.test/...` (non privée) pour les cas de mapping. `x.test` n'est pas dans les motifs privés → la garde passe, le `fetchImpl` injecté répond.

- [ ] **Step 5: Lancer les tests purs**

Run: `bun test tests/link-check.test.ts tests/async-pool.test.ts` → PASS.

- [ ] **Step 6: Écrire les cœurs DB**

Dans `lib/video/persist.ts`, ajouter `import { verifyUrl } from "@/lib/video/link-check";` et `import { mapWithConcurrency } from "@/lib/async-pool";`, puis :

```ts
export async function getInsertUrlCore(insertId: string): Promise<{ url: string | null } | null> {
  const [row] = await db.select({ url: beatInserts.url }).from(beatInserts).where(eq(beatInserts.id, insertId));
  return row ?? null;
}

export async function setInsertLinkStatusCore(
  input: { insertId: string; status: "ok" | "mort" | "interdit" },
): Promise<void> {
  await db.transaction(async (tx) => {
    const [loc] = await tx.select({ beatId: beatInserts.beatId }).from(beatInserts).where(eq(beatInserts.id, input.insertId));
    if (!loc) throw new RefusalError("Insert introuvable.");
    const [beat] = await tx.select({ variantId: scriptBeats.variantId }).from(scriptBeats).where(eq(scriptBeats.id, loc.beatId));
    if (!beat) throw new RefusalError("Beat introuvable pour cet insert.");
    // Verrou de variante pour l'ordre habituel ; PAS de bump locallyEditedAt (rafraîchissement de statut).
    await tx.select({ id: scriptVariants.id }).from(scriptVariants).where(eq(scriptVariants.id, beat.variantId)).for("update");
    await tx.update(beatInserts).set({ linkStatus: input.status, linkCheckedAt: new Date(), updatedAt: new Date() })
      .where(eq(beatInserts.id, input.insertId));
  });
}

export async function listProjectInsertsForVerifyCore(projectId: string): Promise<{ id: string; url: string | null }[]> {
  return db.select({ id: beatInserts.id, url: beatInserts.url })
    .from(beatInserts)
    .innerJoin(scriptBeats, eq(scriptBeats.id, beatInserts.beatId))
    .innerJoin(scriptVariants, eq(scriptVariants.id, scriptBeats.variantId))
    .where(eq(scriptVariants.projectId, projectId));
}

export async function verifyProjectLinksCore(
  input: { projectId: string; fetchImpl?: typeof fetch },
): Promise<{ ok: number; mort: number; interdit: number }> {
  const inserts = await listProjectInsertsForVerifyCore(input.projectId);
  const statuses = await mapWithConcurrency(inserts, 5, async (ins) => {
    const { status } = await verifyUrl(ins.url, { fetchImpl: input.fetchImpl });
    await setInsertLinkStatusCore({ insertId: ins.id, status });
    return status;
  });
  const counts = { ok: 0, mort: 0, interdit: 0 };
  for (const s of statuses) counts[s]++;
  return counts;
}
```

- [ ] **Step 7: Écrire les server actions**

Dans `lib/actions/video-actions.ts`, ajouter aux imports `verifyUrl` n'est pas nécessaire (le cœur l'utilise) ; importer `getInsertUrlCore, setInsertLinkStatusCore, verifyProjectLinksCore` depuis `@/lib/video/persist` et `verifyUrl` depuis `@/lib/video/link-check` (pour l'action unitaire). Ajouter :

```ts
export async function verifyInsertLink(
  insertId: string,
): Promise<{ ok: true; status: "ok" | "mort" | "interdit" } | { ok: false; message: string }> {
  await guard();
  const insert = await getInsertUrlCore(insertId);
  if (!insert) return { ok: false, message: "Insert introuvable." };
  const { status } = await verifyUrl(insert.url);
  const res = await refusable(() => setInsertLinkStatusCore({ insertId, status }));
  if (!res.ok) return res;
  revalidateVideo();
  return { ok: true, status };
}

export async function verifyProjectLinks(
  projectId: string,
): Promise<{ ok: true; counts: { ok: number; mort: number; interdit: number } } | { ok: false; message: string }> {
  await guard();
  const counts = await verifyProjectLinksCore({ projectId });
  revalidateVideo();
  return { ok: true, counts };
}
```

- [ ] **Step 8: Test DB des cœurs**

Créer `tests/insert-verify-core.test.ts` : insère projet/variante/beat + 2 inserts (une url publique factice, une privée) ; `verifyProjectLinksCore({ projectId, fetchImpl })` avec un `fetchImpl` renvoyant 200 pour l'une → attend `linkStatus` mis à jour et des totaux cohérents (l'url privée → `mort` sans fetch, la publique → `ok`). Teste aussi `setInsertLinkStatusCore` seul. UUID valides, nettoyage. NON inscrit au `PURE_FILES`.

- [ ] **Step 9: Inscrire les purs, typecheck, commit**

Ajouter `"link-check.test.ts"` et `"async-pool.test.ts"` au `PURE_FILES`.
Run: `bun test tests/insert-verify-core.test.ts && bun run test:pure && bun run typecheck`

```bash
git add lib/video/link-check.ts lib/async-pool.ts lib/video/persist.ts lib/actions/video-actions.ts tests/link-check.test.ts tests/async-pool.test.ts tests/insert-verify-core.test.ts scripts/test-fast.ts
git commit -m "feat(video): vérification des liens d'insert (ok/mort/interdit)"
```

---

## Task 4: Upload R2 d'un média d'insert (images/graphiques)

**Files:**
- Create: `lib/video/insert-upload-core.ts`
- Modify: `lib/actions/video-actions.ts` (`uploadInsertMedia`)
- Test: `tests/insert-upload-core.test.ts` (DB, `putObject` injecté)

**Interfaces:**
- Consumes: `validateImageAsset` (`@/lib/studio/asset-validate`), `putObject`/`R2Deps` (`@/lib/storage/r2`), `getStudioConfig` (`@/lib/studio/config`), `RefusalError`.
- Produces: `insertMediaKey(ext, now): string`, `uploadInsertMediaCore({ insertId, file, deps? }): Promise<{ url: string; r2Key: string }>`, action `uploadInsertMedia(formData): Promise<{ ok: true; url: string }|{ ok: false; message: string }>`.

- [ ] **Step 1: Écrire le cœur**

Créer `lib/video/insert-upload-core.ts` :

```ts
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, beatInserts, scriptBeats, scriptVariants } from "@/db";
import { getStudioConfig } from "@/lib/studio/config";
import { putObject, type R2Deps } from "@/lib/storage/r2";
import { validateImageAsset } from "@/lib/studio/asset-validate";
import { RefusalError } from "@/lib/video/persist";

export function insertMediaKey(ext: string, now: Date): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `video/inserts/${year}/${month}/${randomUUID()}.${ext}`;
}

export async function uploadInsertMediaCore(
  input: { insertId: string; file: File; deps?: R2Deps },
): Promise<{ url: string; r2Key: string }> {
  const cfg = getStudioConfig();
  if (!cfg) throw new RefusalError("Stockage R2 non configuré.");

  const bytes = new Uint8Array(await input.file.arrayBuffer());
  const v = await validateImageAsset(bytes);
  if (!v.ok) throw new RefusalError(v.message);

  const key = insertMediaKey(v.ext, new Date());
  // putObject AVANT la transaction (comme uploadAssetCore) : en cas d'échec DB, l'objet R2 est
  // orphelin — acceptable (nettoyage hors périmètre), on ne référence rien tant que la ligne n'est pas écrite.
  const url = await putObject(cfg, key, bytes, v.mime, input.deps);

  await db.transaction(async (tx) => {
    const [loc] = await tx.select({ beatId: beatInserts.beatId }).from(beatInserts).where(eq(beatInserts.id, input.insertId));
    if (!loc) throw new RefusalError("Insert introuvable.");
    const [beat] = await tx.select({ variantId: scriptBeats.variantId }).from(scriptBeats).where(eq(scriptBeats.id, loc.beatId));
    if (!beat) throw new RefusalError("Beat introuvable pour cet insert.");
    await tx.select({ id: scriptVariants.id }).from(scriptVariants).where(eq(scriptVariants.id, beat.variantId)).for("update");
    await tx.update(scriptBeats).set({ locallyEditedAt: new Date(), updatedAt: new Date() }).where(eq(scriptBeats.id, loc.beatId));
    // Asset hébergé par nous → lien réputé `ok`.
    await tx.update(beatInserts).set({ r2Key: key, url, linkStatus: "ok", linkCheckedAt: new Date(), updatedAt: new Date() })
      .where(eq(beatInserts.id, input.insertId));
    await tx.update(scriptVariants).set({ updatedAt: new Date() }).where(eq(scriptVariants.id, beat.variantId));
  });

  return { url, r2Key: key };
}
```

Note : vérifier que `R2Deps` est bien exporté par `@/lib/storage/r2` (le paramètre `deps` de `putObject` l'utilise). S'il n'est pas exporté, exporter le type là-bas (petit ajout) ou typer `deps?` en `{ sendRequest?: ...; sleep?: ... }` en le copiant.

- [ ] **Step 2: Écrire l'action**

Dans `lib/actions/video-actions.ts`, ajouter `import { uploadInsertMediaCore } from "@/lib/video/insert-upload-core";` puis :

```ts
export async function uploadInsertMedia(
  formData: FormData,
): Promise<{ ok: true; url: string } | { ok: false; message: string }> {
  await guard();
  const insertId = formData.get("insertId");
  const file = formData.get("file");
  if (typeof insertId !== "string" || !(file instanceof File)) return { ok: false, message: "Requête invalide." };
  const res = await refusable(() => uploadInsertMediaCore({ insertId, file }));
  if (!res.ok) return res;
  revalidateVideo();
  return { ok: true, url: res.value.url };
}
```

- [ ] **Step 3: Test DB (putObject injecté, PNG réel)**

Créer `tests/insert-upload-core.test.ts` : insère projet/variante/beat/insert ; appelle `uploadInsertMediaCore` avec un `File` construit d'un PNG 1×1 réel (décodable par `sharp`) et `deps: { sendRequest: async () => new Response(null, { status: 200 }) }` (stub réseau R2) ; attend `r2Key` préfixé `video/inserts/`, `url` non nulle, `linkStatus="ok"`. Un PNG 1×1 en base64 :

```ts
const PNG_1x1 = Uint8Array.from(atob(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
), (c) => c.charCodeAt(0));
const file = new File([PNG_1x1], "a.png", { type: "image/png" });
```

Nettoyage `afterAll`, UUID valides. Si `getStudioConfig()` renvoie `null` faute d'env R2, le test doit poser les variables d'env R2 minimales AVANT l'appel (ou passer par un cfg injecté — mais `uploadInsertMediaCore` lit `getStudioConfig()` en dur). **Décision d'implémentation** : si l'environnement de test n'a pas les variables R2, définir `process.env.R2_*` factices en tête de test (account/key/secret/bucket/publicBaseUrl bidons) — `putObject` est stubbé via `deps.sendRequest`, donc les valeurs ne servent qu'à passer `getStudioConfig()`. NON inscrit au `PURE_FILES`.

- [ ] **Step 4: Vérifier + commit**

Run: `bun test tests/insert-upload-core.test.ts && bun run typecheck && bun run test:pure`

```bash
git add lib/video/insert-upload-core.ts lib/actions/video-actions.ts tests/insert-upload-core.test.ts
git commit -m "feat(video): upload R2 des médias d'insert (images/graphiques)"
```

---

## Task 5: UI — formulaire d'insert complet + champs surfacés

**Files:**
- Modify: `components/video/beat-list.tsx` (`InsertView` + `rightsNote`/`r2Key`/`linkCheckedAt`)
- Modify: `app/(app)/video/[id]/page.tsx` (mapping insert complet)
- Modify: `components/video/beat-inspector.tsx` (`InsertRow` → formulaire complet)
- Test: `tests/insert-row.test.ts` (pur, `renderToStaticMarkup`)
- Modify: `scripts/test-fast.ts`

**Interfaces:**
- Consumes: `updateInsert` (action, élargie Task 2), `insertSpanSeconds` (Task 1), `INSERT_KINDS` (Task 1).

- [ ] **Step 1: Élargir `InsertView` et le mapping**

Dans `components/video/beat-list.tsx`, ajouter à `InsertView` : `rightsNote: string | null; r2Key: string | null; linkCheckedAt: Date | string | null;`.

Dans `app/(app)/video/[id]/page.tsx` (mapping lignes 92-101), ajouter `rightsNote: ins.rightsNote, r2Key: ins.r2Key, linkCheckedAt: ins.linkCheckedAt,`. Vérifier que la source `getVideoProject` (`lib/queries/video.ts`) renvoie bien ces colonnes ; si son `select` est projeté (ne renvoie pas ces champs), les y ajouter.

- [ ] **Step 2: Écrire le test qui échoue**

Créer `tests/insert-row.test.ts` (motif `renderToStaticMarkup` + `createElement`) : rendre `InsertRow` avec un insert (kind image, tc, crédit, droits) et attendre les inputs/valeurs — libellés « Crédit », « Droits », « Entrée », « Sortie », la valeur du crédit, et l'affichage de la portée calculée (`insertSpanSeconds`). Comme `InsertRow` n'est pas exporté aujourd'hui, l'exporter (ou tester via `BeatInspector`). **Décision** : exporter `InsertRow` depuis `beat-inspector.tsx` pour le rendre testable.

- [ ] **Step 3: Réécrire `InsertRow` en formulaire complet**

Dans `components/video/beat-inspector.tsx`, remplacer `InsertRow` (lignes 52-115) par un formulaire : état local pour `kind, url, tcIn, tcOut, displayDurationSec, credit, rightsNote` (initialisés depuis l'insert, resynchronisés via `useEffect` sur `insert.id`) ; un select `kind` (options `INSERT_KINDS` + libellés `INSERT_KIND_LABEL` de `@/lib/video/labels`) ; des `Input` pour tc in/out (placeholder `HH:MM:SS`), durée, crédit, droits, url ; l'affichage de `insertSpanSeconds(tcIn, tcOut)` quand défini ; un seul bouton Enregistrer appelant `updateInsert({ insertId, url, kind, tcIn, tcOut, displayDurationSec, credit, rightsNote })` (convertir "" → null pour les champs texte, la durée en nombre ou null). Conserver le badge `LINK_STATUS_LABEL` et le toast. `onSaved` propage le patch au parent. Export nommé `export function InsertRow(...)`.

Garder la sémantique : n'envoyer `url` que si un champ est réellement édité n'est PAS nécessaire (le patch partiel côté serveur ne reset le statut que si l'url change réellement — envoyer tous les champs est sûr). Afficher `linkCheckedAt` si présent (« Vérifié le … »).

- [ ] **Step 4: Lancer, inscrire le pur, typecheck**

Ajouter `"insert-row.test.ts"` au `PURE_FILES`.
Run: `bun test tests/insert-row.test.ts && bun run test:pure && bun run typecheck`

- [ ] **Step 5: Commit**

```bash
git add components/video/beat-list.tsx "app/(app)/video/[id]/page.tsx" components/video/beat-inspector.tsx tests/insert-row.test.ts scripts/test-fast.ts
git commit -m "feat(video): formulaire d'édition complet de l'insert"
```

---

## Task 6: UI — vérifier le lien, vérifier tout, téléverser

**Files:**
- Modify: `components/video/beat-inspector.tsx` (`InsertRow` : bouton Vérifier + auto-après-save + upload + vignette)
- Create: `components/video/verify-all-links.tsx` (`"use client"`, bouton projet)
- Modify: `app/(app)/video/[id]/page.tsx` (monter le bouton dans l'onglet Écriture)
- Test: `tests/verify-all-links.test.ts` (pur)
- Modify: `scripts/test-fast.ts`

**Interfaces:**
- Consumes: `verifyInsertLink`, `verifyProjectLinks`, `uploadInsertMedia` (Tasks 3–4).

- [ ] **Step 1: Bouton « Vérifier le lien » + auto-après-save dans `InsertRow`**

Dans `InsertRow`, ajouter un bouton « Vérifier le lien » (visible si une url est présente) appelant `verifyInsertLink(insert.id)` dans une transition ; sur succès, `toast` + `onSaved({ id, linkStatus: res.status })`. Dans `handleSave`, après un `updateInsert` réussi où l'url a changé et n'est pas nulle, **enchaîner automatiquement** `verifyInsertLink(insert.id)` et propager le statut (vérification automatique découplée).

- [ ] **Step 2: Upload pour image/graphique dans `InsertRow`**

Quand `insert.kind ∈ {"image","graphique"}`, afficher un `<input type="file" accept="image/*">` + bouton « Téléverser » construisant un `FormData` (`insertId`, `file`) et appelant `uploadInsertMedia(formData)` ; sur succès, `toast` + `onSaved({ id, url: res.url, linkStatus: "ok" })` et rafraîchir. Afficher une vignette du média résolu (`r2Key` → non résolu côté client ; utiliser `insert.url` qui pointe désormais sur l'URL publique après upload) — `<img src={insert.url} … className="max-h-24" />` si `url`.

- [ ] **Step 3: Composant « Vérifier tous les liens »**

Créer `components/video/verify-all-links.tsx` (`"use client"`) : un bouton appelant `verifyProjectLinks(projectId)` dans une transition ; sur succès, `toast.success(`${counts.ok} ok · ${counts.mort} morts · ${counts.interdit} interdits`)` + `router.refresh()`. Props `{ projectId: string }`. Le test (Step 5) attend le libellé du bouton (« Vérifier tous les liens »).

- [ ] **Step 4: Monter le bouton dans l'onglet Écriture**

Dans `app/(app)/video/[id]/page.tsx`, importer `VerifyAllLinks` et le rendre en tête du `<TabsContent value="ecriture">` (au-dessus de `<BeatList>`), avec `projectId={project.id}`.

- [ ] **Step 5: Test pur du bouton projet**

Créer `tests/verify-all-links.test.ts` : rendre `VerifyAllLinks` avec un `projectId` → attendre « Vérifier tous les liens ». Inscrire au `PURE_FILES`.

- [ ] **Step 6: Vérifier + commit**

Run: `bun test tests/verify-all-links.test.ts tests/insert-row.test.ts && bun run test:pure && bun run typecheck`
(Le test `insert-row` doit toujours passer — les ajouts sont additifs.)

```bash
git add components/video/beat-inspector.tsx components/video/verify-all-links.tsx "app/(app)/video/[id]/page.tsx" tests/verify-all-links.test.ts scripts/test-fast.ts
git commit -m "feat(video): vérifier un lien, vérifier tout le projet, téléverser un média"
```

---

## Task 7: Vérification finale

**Files:** aucun.

- [ ] **Step 1: Suite pure + typecheck + build**

Run: `bun run typecheck && bun run test:pure && bun run build`
Expected: exit 0 partout. Le build compile la page projet, l'action d'export inchangée, etc.

- [ ] **Step 2: Tests DB ciblés**

Run: `bun test tests/insert-edit-core.test.ts tests/insert-verify-core.test.ts tests/insert-upload-core.test.ts`
Expected: PASS. Ne pas lancer `bun test` complet (voie lente, infra-flaky).

- [ ] **Step 3: Preuve manuelle**

Vérifier dans le navigateur (onglet Écriture d'un projet, inspecteur de beat) :
1. Éditer tc in/out + crédit + droits d'un insert → enregistré ; un statut `ok` préalable survit ; changer l'url → repasse à `non_verifie` puis se re-vérifie automatiquement.
2. « Vérifier le lien » sur une url vivante → `ok` ; sur une url morte (404) → `mort` ; sur une url 403 → `interdit` ; sur une url privée (127.0.0.1) → `mort` sans requête sortante.
3. « Vérifier tous les liens » → toast avec les totaux ; les badges du conducteur (onglet Montage) reflètent les nouveaux statuts.
4. Téléverser un PNG sur un insert `image` → vignette affichée, `linkStatus` = `ok`, l'URL pointe sur R2 ; un fichier > 5 Mio ou non-image → refus propre.
5. `tcOut ≤ tcIn` → message de validation, pas d'enregistrement.

- [ ] **Step 4: État du dépôt**

Run: `git status` (propre) ; `git log --oneline main..HEAD`.

---

## Self-Review (à l'écriture)

- **Couverture spec :** édition complète (T2, schéma+cœur patch partiel) ✓ ; timecode (T1) ✓ ; vérificateur ok/mort/interdit + GET par plage + SSRF (T3) ✓ ; auto-après-save + par-insert + par-projet (T3 cœurs, T6 UI) ✓ ; upload images/graphiques + préfixe `video/inserts/` + linkStatus=ok (T4) ✓ ; champs surfacés rightsNote/r2Key/linkCheckedAt (T5) ✓ ; aucune migration ✓. Reset de statut resserré (url-change only) couvert par le test T2.
- **Placeholders :** aucun ; code réel pour purs/cœurs/schéma ; UI décrite en réécrivant un composant existant nommé (`InsertRow`) avec test contraignant.
- **Cohérence des types :** `verifyUrl`→`{status}` consommé par `setInsertLinkStatusCore`/`verifyProjectLinksCore`/actions ; `InsertKind` défini T1, consommé T2 (schéma+cœur) et T5 (UI) ; `mapWithConcurrency` défini T3, consommé par `verifyProjectLinksCore` ; `R2Deps` réutilisé de `@/lib/storage/r2` en T4 ; `InsertView` élargi T5, cohérent avec le mapping page.

Voir [[video-module-roadmap]] et [[execution-mode-subagent-driven]].
