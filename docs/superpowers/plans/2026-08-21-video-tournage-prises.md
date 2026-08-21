# Tournage & journal de prises (SP4) — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Vue de tournage responsive (prompteur + journal de prises par beat, prise retenue) et transitions de statut du projet (prêt à tourner → tourné → en montage).

**Architecture:** Une colonne `selectedTakeId` (référence logique) sur `script_beats`, des cœurs de prises (`lib/video/takes-core.ts`, ordre de verrou étendu à `beat_takes`), un cœur de transition de statut (le premier chemin d'écriture du statut), et un onglet Tournage client (grandes cibles tactiles, mode Journal + mode Prompteur). Une migration additive.

**Tech Stack:** Next.js (App Router), Drizzle/Postgres, shadcn/ui + Tailwind v4, `bun test`. Aucune nouvelle dépendance.

**Spec:** `docs/superpowers/specs/2026-08-21-video-tournage-prises-design.md`

## Global Constraints

- **Copie UI en français.**
- **Une seule migration** : `selected_take_id` (uuid nullable, **sans FK**) sur `script_beats`. `beat_takes` et l'enum `take_status` existent déjà (SP1) — la migration ne doit PAS les recréer, seulement ajouter la colonne. Aucune valeur d'enum ajoutée.
- **`selectedTakeId` = référence logique** (comme `answersBeatId`/`derivedFromId` : uuid sans `.references()`). Cohérence garantie par les cœurs (select vérifie l'appartenance ; delete efface).
- **Ordre de verrou** étendu : `script_variants` (FOR UPDATE) → `script_beats` → **`beat_takes` en dernier**. Découverte de la variante par selects nus (`beatId → variantId`), puis `FOR UPDATE` sur la variante. Ne pas rouvrir le cycle ABBA.
- **Pureté :** `lib/video/tournage-rules.ts` reste PUR (`nextTakeNumber`, `estTransitionAutorisee` — pas de `@/db`). Les cœurs DB (`takes-core.ts`, `setProjectStatusCore` dans `persist.ts`) sont sans `"use server"`, réutilisent `RefusalError`.
- **Server actions** (`lib/actions/video-actions.ts`) débutent par `guard()` = `requireUser()` + `requirePermission(role,"video","manage")`, convertissent `RefusalError` via `refusable()`, `revalidateVideo()` sur succès, renvoient `{ ok:true; … } | { ok:false; message }`.
- **Transitions autorisées** (les seules) : `en_ecriture → pret_a_tourner`, `pret_a_tourner → tourne`, `tourne → en_montage`.
- **Pas d'intégration conducteur** (SP2 inchangé) ; `selectedTakeId` stocké mais non lu par la vue montage.
- **Tests purs** dans `PURE_FILES` (`scripts/test-fast.ts`). Tests DB : voie lente, UUID valides, nettoyage.

---

## File Structure

| Fichier | Rôle | Action |
|---|---|---|
| `lib/video/schema.ts` | Statuts de prise exportés | Modifier — `TAKE_STATUSES`/`TakeStatus` |
| `lib/video/labels.ts` | Libellés | Modifier — `TAKE_STATUS_LABEL` |
| `lib/video/tournage-rules.ts` | Règles pures | Créer — `nextTakeNumber`, `estTransitionAutorisee` |
| `db/schema.ts` | Colonne `selected_take_id` | Modifier |
| `db/migrations/00XX_*.sql` | Migration | Créer (générée) |
| `lib/video/takes-core.ts` | Cœurs de prises + lecture tournage | Créer |
| `lib/video/persist.ts` | Cœur de transition de statut | Modifier — `setProjectStatusCore` |
| `lib/actions/video-actions.ts` | Server actions | Modifier — statut + prises |
| `components/video/tournage-view.tsx` | Onglet Tournage (client) | Créer |
| `app/(app)/video/[id]/page.tsx` | Page projet | Modifier — 5ᵉ onglet + `readTournageCore` |
| `scripts/test-fast.ts` | Allowlist tests purs | Modifier |

---

## Task 1: Statuts de prise + libellés + règles pures

**Files:**
- Modify: `lib/video/schema.ts`, `lib/video/labels.ts`
- Create: `lib/video/tournage-rules.ts`
- Test: `tests/tournage-rules.test.ts` (pur)
- Modify: `scripts/test-fast.ts`

**Interfaces:**
- Produces: `TAKE_STATUSES`/`TakeStatus` ; `TAKE_STATUS_LABEL` ; `nextTakeNumber(existing: number[]): number`, `estTransitionAutorisee(from: string, to: string): boolean`.

- [ ] **Step 1: Écrire le test qui échoue**

Créer `tests/tournage-rules.test.ts` :

```ts
import { expect, test } from "bun:test";
import { nextTakeNumber, estTransitionAutorisee } from "@/lib/video/tournage-rules";

test("nextTakeNumber : vide → 1, sinon max+1 (gaps OK)", () => {
  expect(nextTakeNumber([])).toBe(1);
  expect(nextTakeNumber([1, 2, 3])).toBe(4);
  expect(nextTakeNumber([1, 3])).toBe(4); // max+1, pas comblement de trou
  expect(nextTakeNumber([5])).toBe(6);
});

test("estTransitionAutorisee : seules les trois transitions de tournage", () => {
  expect(estTransitionAutorisee("en_ecriture", "pret_a_tourner")).toBe(true);
  expect(estTransitionAutorisee("pret_a_tourner", "tourne")).toBe(true);
  expect(estTransitionAutorisee("tourne", "en_montage")).toBe(true);
  expect(estTransitionAutorisee("tourne", "publie")).toBe(false);
  expect(estTransitionAutorisee("brouillon", "tourne")).toBe(false);
  expect(estTransitionAutorisee("en_montage", "tourne")).toBe(false); // pas de retour arrière
});
```

- [ ] **Step 2: Lancer et vérifier l'échec**

Run: `bun test tests/tournage-rules.test.ts` → FAIL (module absent).

- [ ] **Step 3: Écrire le module pur**

Créer `lib/video/tournage-rules.ts` :

```ts
/** Numéro de prise suivant pour un beat : max+1, ou 1 si aucune prise. Ne comble pas les trous. */
export function nextTakeNumber(existing: number[]): number {
  return existing.length === 0 ? 1 : Math.max(...existing) + 1;
}

// Les seules transitions de statut wirées par SP4 (phase tournage). Tout le reste est refusé.
const TRANSITIONS: Record<string, string[]> = {
  en_ecriture: ["pret_a_tourner"],
  pret_a_tourner: ["tourne"],
  tourne: ["en_montage"],
};

export function estTransitionAutorisee(from: string, to: string): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}
```

- [ ] **Step 4: Ajouter statuts + libellés**

`lib/video/schema.ts`, sous `INSERT_KINDS` (ligne ~19) :

```ts
export const TAKE_STATUSES = ["bonne", "mauvaise", "a_revoir"] as const;
export type TakeStatus = (typeof TAKE_STATUSES)[number];
```

`lib/video/labels.ts`, sous `LINK_STATUS_LABEL` :

```ts
export const TAKE_STATUS_LABEL: Record<string, string> = {
  bonne: "Bonne", mauvaise: "Mauvaise", a_revoir: "À revoir",
};
```

- [ ] **Step 5: Lancer, inscrire le pur, typecheck, commit**

Run: `bun test tests/tournage-rules.test.ts` → PASS.
Ajouter `"tournage-rules.test.ts"` au `PURE_FILES`.
Run: `bun run typecheck && bun run test:pure`

```bash
git add lib/video/schema.ts lib/video/labels.ts lib/video/tournage-rules.ts tests/tournage-rules.test.ts scripts/test-fast.ts
git commit -m "feat(video): statuts de prise, libellés et règles de tournage pures"
```

---

## Task 2: Colonne `selected_take_id` + migration

**Files:**
- Modify: `db/schema.ts` (`scriptBeats`)
- Create: `db/migrations/00XX_*.sql` (généré)
- Test: `tests/tournage-schema.test.ts` (DB léger — vérifie l'export de colonne)

**Interfaces:**
- Produces: `scriptBeats.selectedTakeId` (uuid nullable, ré-exporté par `@/db`).

- [ ] **Step 1: Ajouter la colonne**

Dans `db/schema.ts`, table `scriptBeats`, après `montageCheckedAt` :

```ts
  // Prise retenue pour ce beat (SP4). Référence LOGIQUE vers beat_takes.id, SANS FK : une FK
  // beat→prise alors que beat_takes.beatId→script_beats cascade formerait un cycle. Cohérence
  // assurée par les cœurs (selectTakeCore vérifie l'appartenance ; deleteTakeCore efface).
  selectedTakeId: uuid("selected_take_id"),
```

- [ ] **Step 2: Générer la migration**

Run: `bun run db:generate`
Expected: crée `00XX_*.sql` contenant UNIQUEMENT `ALTER TABLE "script_beats" ADD COLUMN "selected_take_id" uuid;`. **Vérifier** qu'il ne recrée PAS `beat_takes` ni le type `take_status` (déjà migrés en SP1) ni aucune autre table. Si drizzle propose de recréer `beat_takes`, s'arrêter et rapporter (le journal de migration est peut-être désaligné) — ne pas appliquer.

- [ ] **Step 3: Appliquer**

Run: `bun run db:migrate`
Expected: applique l'ADD COLUMN sans erreur.

- [ ] **Step 4: Test DB léger**

Créer `tests/tournage-schema.test.ts` :

```ts
import { expect, test } from "bun:test";
import { scriptBeats, beatTakes } from "@/db";

test("selectedTakeId exposé sur script_beats ; beat_takes présent", () => {
  expect(scriptBeats.selectedTakeId).toBeDefined();
  expect(beatTakes.number).toBeDefined();
  expect(beatTakes.status).toBeDefined();
});
```

- [ ] **Step 5: Vérifier + commit**

Run: `bun test tests/tournage-schema.test.ts && bun run typecheck`
(NE PAS inscrire au `PURE_FILES` — importe `@/db`.)

```bash
git add db/schema.ts db/migrations tests/tournage-schema.test.ts
git commit -m "feat(video): colonne selected_take_id (prise retenue) sur script_beats"
```

---

## Task 3: Cœurs de prises + lecture tournage

**Files:**
- Create: `lib/video/takes-core.ts`
- Test: `tests/takes-core.test.ts` (DB)

**Interfaces:**
- Consumes: `nextTakeNumber` (Task 1), `RefusalError` (`@/lib/video/persist`), `TakeStatus` (Task 1), `BEAT_KIND_LABEL` (`@/lib/video/labels`), `scriptBeats.selectedTakeId` (Task 2).
- Produces: `addTakeCore`, `updateTakeCore`, `deleteTakeCore`, `selectTakeCore`, `readTournageCore`, types `TournageBeat`/`TakeRow`.

- [ ] **Step 1: Écrire le test DB qui échoue**

Créer `tests/takes-core.test.ts` (UUID valides, `afterAll` nettoyage) couvrant : add (numérotation 1 puis 2), update (status+note), select (retient ; refuse une prise d'un autre beat), delete (efface selectedTakeId si retenue), readTournage (beats+prises ordonnés). Modèle :

```ts
import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, videoProjects, scriptVariants, scriptBeats, beatTakes } from "@/db";
import { addTakeCore, updateTakeCore, deleteTakeCore, selectTakeCore, readTournageCore } from "@/lib/video/takes-core";

const P = "00000000-0000-0000-0000-0000000004a1";
let variantId = "", beatId = "", otherBeatId = "";

afterAll(async () => { await db.delete(videoProjects).where(eq(videoProjects.id, P)); });

test("add → numérotation, select, delete efface la retenue, readTournage", async () => {
  await db.insert(videoProjects).values({ id: P, title: "T", subject: null }).onConflictDoNothing();
  const [v] = await db.insert(scriptVariants).values({ projectId: P, platform: "youtube_long", position: 0 }).returning();
  variantId = v.id;
  const [b] = await db.insert(scriptBeats).values({ variantId, externalId: "b1", position: 0, kind: "narration", spokenText: "Bonjour" }).returning();
  const [b2] = await db.insert(scriptBeats).values({ variantId, externalId: "b2", position: 1, kind: "reponse", spokenText: "Oui" }).returning();
  beatId = b.id; otherBeatId = b2.id;

  const t1 = await addTakeCore({ beatId, status: "mauvaise" });
  const t2 = await addTakeCore({ beatId });
  expect([t1.number, t2.number]).toEqual([1, 2]);

  await updateTakeCore({ takeId: t2.id, status: "bonne", note: "la bonne" });
  await selectTakeCore({ beatId, takeId: t2.id });
  let [beatRow] = await db.select().from(scriptBeats).where(eq(scriptBeats.id, beatId));
  expect(beatRow.selectedTakeId).toBe(t2.id);

  // Refuse une prise d'un autre beat.
  await expect(selectTakeCore({ beatId: otherBeatId, takeId: t2.id })).rejects.toThrow();

  // Supprimer la prise retenue efface selectedTakeId.
  await deleteTakeCore({ takeId: t2.id });
  [beatRow] = await db.select().from(scriptBeats).where(eq(scriptBeats.id, beatId));
  expect(beatRow.selectedTakeId).toBeNull();

  const read = await readTournageCore(variantId);
  expect(read?.beats.map((x) => x.position)).toEqual([0, 1]);
  expect(read?.beats[0].takes.map((x) => x.number)).toEqual([1]); // t1 reste
});
```

- [ ] **Step 2: Lancer et vérifier l'échec**

Run: `bun test tests/takes-core.test.ts --timeout 20000` → FAIL (module absent).

- [ ] **Step 3: Écrire le cœur**

Créer `lib/video/takes-core.ts` :

```ts
import { asc, eq, and, inArray } from "drizzle-orm";
import { db, scriptVariants, scriptBeats, beatTakes, videoProjects } from "@/db";
import { RefusalError } from "@/lib/video/persist";
import { nextTakeNumber } from "@/lib/video/tournage-rules";
import { BEAT_KIND_LABEL } from "@/lib/video/labels";
import type { TakeStatus } from "@/lib/video/schema";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Ordre de verrou : découvrir la variante (select nu), la verrouiller FOR UPDATE, PUIS écrire beat_takes.
async function lockVariantOfBeat(tx: Tx, beatId: string): Promise<string> {
  const [beat] = await tx.select({ variantId: scriptBeats.variantId }).from(scriptBeats).where(eq(scriptBeats.id, beatId));
  if (!beat) throw new RefusalError("Beat introuvable.");
  await tx.select({ id: scriptVariants.id }).from(scriptVariants).where(eq(scriptVariants.id, beat.variantId)).for("update");
  return beat.variantId;
}

export async function addTakeCore(input: { beatId: string; status?: TakeStatus }): Promise<{ id: string; number: number }> {
  return db.transaction(async (tx) => {
    await lockVariantOfBeat(tx, input.beatId);
    const existing = await tx.select({ number: beatTakes.number }).from(beatTakes).where(eq(beatTakes.beatId, input.beatId));
    const number = nextTakeNumber(existing.map((r) => r.number));
    const [row] = await tx.insert(beatTakes).values({
      beatId: input.beatId, number, status: input.status ?? "a_revoir", startedAt: new Date(),
    }).returning({ id: beatTakes.id });
    return { id: row.id, number };
  });
}

export async function updateTakeCore(input: { takeId: string; status?: TakeStatus; note?: string | null }): Promise<void> {
  await db.transaction(async (tx) => {
    const [take] = await tx.select({ beatId: beatTakes.beatId }).from(beatTakes).where(eq(beatTakes.id, input.takeId));
    if (!take) throw new RefusalError("Prise introuvable.");
    await lockVariantOfBeat(tx, take.beatId);
    const patch: Partial<typeof beatTakes.$inferInsert> = {};
    if (input.status !== undefined) patch.status = input.status;
    if (input.note !== undefined) patch.note = input.note;
    if (Object.keys(patch).length === 0) return;
    await tx.update(beatTakes).set(patch).where(eq(beatTakes.id, input.takeId));
  });
}

export async function deleteTakeCore(input: { takeId: string }): Promise<void> {
  await db.transaction(async (tx) => {
    const [take] = await tx.select({ beatId: beatTakes.beatId }).from(beatTakes).where(eq(beatTakes.id, input.takeId));
    if (!take) throw new RefusalError("Prise introuvable.");
    await lockVariantOfBeat(tx, take.beatId);
    // Si c'était la prise retenue, l'effacer (référence logique sans FK).
    await tx.update(scriptBeats).set({ selectedTakeId: null })
      .where(and(eq(scriptBeats.id, take.beatId), eq(scriptBeats.selectedTakeId, input.takeId)));
    await tx.delete(beatTakes).where(eq(beatTakes.id, input.takeId));
  });
}

export async function selectTakeCore(input: { beatId: string; takeId: string | null }): Promise<void> {
  await db.transaction(async (tx) => {
    await lockVariantOfBeat(tx, input.beatId);
    if (input.takeId !== null) {
      const [take] = await tx.select({ beatId: beatTakes.beatId }).from(beatTakes).where(eq(beatTakes.id, input.takeId));
      if (!take || take.beatId !== input.beatId) throw new RefusalError("Prise absente de ce beat.");
    }
    await tx.update(scriptBeats).set({ selectedTakeId: input.takeId }).where(eq(scriptBeats.id, input.beatId));
  });
}

export type TakeRow = { id: string; number: number; status: string; note: string | null; startedAt: Date | null };
export type TournageBeat = {
  id: string; position: number; kind: string; kindLabel: string;
  spokenText: string; directionNote: string | null; selectedTakeId: string | null; takes: TakeRow[];
};

export async function readTournageCore(
  variantId: string,
): Promise<{ variantId: string; projectId: string; status: string; beats: TournageBeat[] } | null> {
  const [variant] = await db.select().from(scriptVariants).where(eq(scriptVariants.id, variantId));
  if (!variant) return null;
  const [project] = await db.select({ id: videoProjects.id, status: videoProjects.status })
    .from(videoProjects).where(eq(videoProjects.id, variant.projectId));
  if (!project) return null;

  const beats = await db.select().from(scriptBeats).where(eq(scriptBeats.variantId, variantId)).orderBy(asc(scriptBeats.position));
  const beatIds = beats.map((b) => b.id);
  const takes = beatIds.length
    ? await db.select().from(beatTakes).where(inArray(beatTakes.beatId, beatIds)).orderBy(asc(beatTakes.number))
    : [];
  const byBeat = new Map<string, TakeRow[]>();
  for (const t of takes) {
    const l = byBeat.get(t.beatId) ?? [];
    l.push({ id: t.id, number: t.number, status: t.status, note: t.note, startedAt: t.startedAt });
    byBeat.set(t.beatId, l);
  }

  return {
    variantId, projectId: project.id, status: project.status,
    beats: beats.map((b) => ({
      id: b.id, position: b.position, kind: b.kind, kindLabel: BEAT_KIND_LABEL[b.kind] ?? b.kind,
      spokenText: b.spokenText, directionNote: b.directionNote, selectedTakeId: b.selectedTakeId,
      takes: byBeat.get(b.id) ?? [],
    })),
  };
}
```

- [ ] **Step 4: Lancer et vérifier + typecheck**

Run: `bun test tests/takes-core.test.ts --timeout 20000 && bun run typecheck`
Expected: PASS + exit 0. NON inscrit au `PURE_FILES`.

- [ ] **Step 5: Commit**

```bash
git add lib/video/takes-core.ts tests/takes-core.test.ts
git commit -m "feat(video): cœurs de journal de prises et lecture tournage"
```

---

## Task 4: Transition de statut + server actions

**Files:**
- Modify: `lib/video/persist.ts` (`setProjectStatusCore`)
- Modify: `lib/actions/video-actions.ts` (statut + prises)
- Test: `tests/project-status-core.test.ts` (DB)

**Interfaces:**
- Consumes: `estTransitionAutorisee` (Task 1), take cores (Task 3), `guard`/`refusable`/`revalidateVideo`, `TAKE_STATUSES` (Task 1).
- Produces: `setProjectStatusCore({ projectId, to }): Promise<void>` ; actions `markReadyToShoot`, `startShooting`, `finishShooting`, `addTake`, `updateTake`, `deleteTake`, `selectTake`.

- [ ] **Step 1: Écrire le cœur de statut**

Dans `lib/video/persist.ts`, ajouter `import { estTransitionAutorisee } from "@/lib/video/tournage-rules";` puis :

```ts
export async function setProjectStatusCore(input: { projectId: string; to: string }): Promise<void> {
  await db.transaction(async (tx) => {
    const [proj] = await tx.select({ status: videoProjects.status }).from(videoProjects)
      .where(eq(videoProjects.id, input.projectId)).for("update");
    if (!proj) throw new RefusalError("Projet introuvable.");
    if (!estTransitionAutorisee(proj.status, input.to)) throw new RefusalError("Transition de statut non autorisée.");
    await tx.update(videoProjects)
      .set({ status: input.to as (typeof videoProjects.$inferInsert)["status"], updatedAt: new Date() })
      .where(eq(videoProjects.id, input.projectId));
  });
}
```

- [ ] **Step 2: Écrire le test DB du cœur (échoue)**

Créer `tests/project-status-core.test.ts` : insère un projet en `en_ecriture` ; `setProjectStatusCore` vers `pret_a_tourner` OK → `tourne` OK → `en_montage` OK ; une transition illégale (`en_montage → tourne`) rejette ; projet inconnu rejette. UUID valides, nettoyage. (Le statut par défaut à l'insert est `brouillon` — poser explicitement `status: "en_ecriture"` à l'insert de test, ou transitionner depuis `brouillon`… mais `brouillon` n'a aucune transition autorisée ; donc insérer avec `status: "en_ecriture"`.)

- [ ] **Step 3: Lancer et vérifier l'échec**

Run: `bun test tests/project-status-core.test.ts --timeout 20000` → FAIL.

- [ ] **Step 4: Écrire les server actions**

Dans `lib/actions/video-actions.ts`, ajouter aux imports : `setProjectStatusCore` (depuis `@/lib/video/persist`), `addTakeCore, updateTakeCore, deleteTakeCore, selectTakeCore` (depuis `@/lib/video/takes-core`), `TAKE_STATUSES, type TakeStatus` (depuis `@/lib/video/schema`). Puis :

```ts
async function transition(projectId: string, to: string): Promise<{ ok: true } | { ok: false; message: string }> {
  await guard();
  const res = await refusable(() => setProjectStatusCore({ projectId, to }));
  if (!res.ok) return res;
  revalidateVideo();
  return { ok: true };
}
export const markReadyToShoot = (projectId: string) => transition(projectId, "pret_a_tourner");
export const startShooting = (projectId: string) => transition(projectId, "tourne");
export const finishShooting = (projectId: string) => transition(projectId, "en_montage");

function parseStatus(v: unknown): TakeStatus | null {
  return typeof v === "string" && (TAKE_STATUSES as readonly string[]).includes(v) ? (v as TakeStatus) : null;
}

export async function addTake(
  input: { beatId: string; status?: string },
): Promise<{ ok: true; id: string; number: number } | { ok: false; message: string }> {
  await guard();
  if (typeof input?.beatId !== "string") return { ok: false, message: "Requête invalide." };
  const status = input.status === undefined ? undefined : (parseStatus(input.status) ?? undefined);
  const res = await refusable(() => addTakeCore({ beatId: input.beatId, status }));
  if (!res.ok) return res;
  revalidateVideo();
  return { ok: true, id: res.value.id, number: res.value.number };
}

export async function updateTake(
  input: { takeId: string; status?: string; note?: string | null },
): Promise<{ ok: true } | { ok: false; message: string }> {
  await guard();
  if (typeof input?.takeId !== "string") return { ok: false, message: "Requête invalide." };
  const status = input.status === undefined ? undefined : parseStatus(input.status);
  if (input.status !== undefined && status === null) return { ok: false, message: "Statut de prise invalide." };
  const res = await refusable(() => updateTakeCore({ takeId: input.takeId, status: status ?? undefined, note: input.note }));
  if (!res.ok) return res;
  revalidateVideo();
  return { ok: true };
}

export async function deleteTake(takeId: string): Promise<{ ok: true } | { ok: false; message: string }> {
  await guard();
  const res = await refusable(() => deleteTakeCore({ takeId }));
  if (!res.ok) return res;
  revalidateVideo();
  return { ok: true };
}

export async function selectTake(
  input: { beatId: string; takeId: string | null },
): Promise<{ ok: true } | { ok: false; message: string }> {
  await guard();
  if (typeof input?.beatId !== "string") return { ok: false, message: "Requête invalide." };
  const res = await refusable(() => selectTakeCore({ beatId: input.beatId, takeId: input.takeId }));
  if (!res.ok) return res;
  revalidateVideo();
  return { ok: true };
}
```

- [ ] **Step 5: Lancer, typecheck, test:pure**

Run: `bun test tests/project-status-core.test.ts --timeout 20000 && bun run typecheck && bun run test:pure`
Expected: PASS + exit 0. (Les actions de prises sont de fines enveloppes des cœurs déjà testés en Task 3.)

- [ ] **Step 6: Commit**

```bash
git add lib/video/persist.ts lib/actions/video-actions.ts tests/project-status-core.test.ts
git commit -m "feat(video): transitions de statut de tournage et actions de prises"
```

---

## Task 5: Onglet Tournage (prompteur + journal)

**Files:**
- Create: `components/video/tournage-view.tsx` (`"use client"`)
- Modify: `app/(app)/video/[id]/page.tsx` (5ᵉ onglet + `readTournageCore`)
- Test: `tests/tournage-view.test.ts` (pur, `renderToStaticMarkup`)
- Modify: `scripts/test-fast.ts`

**Interfaces:**
- Consumes: `addTake`/`updateTake`/`deleteTake`/`selectTake`/`markReadyToShoot`/`startShooting`/`finishShooting` (Task 4) ; `readTournageCore` + `TournageBeat` (Task 3) ; `TAKE_STATUS_LABEL` (Task 1).
- Produces: `TournageView({ projectId, status, beats }: { projectId: string; status: string; beats: TournageBeat[] })`.

- [ ] **Step 1: Écrire le test qui échoue**

Créer `tests/tournage-view.test.ts` (motif `renderToStaticMarkup` + `createElement`) : rendre `TournageView` avec un beat portant une prise `bonne` retenue → attendre le texte parlé, le libellé « Bonne », les trois boutons de log (« Bonne »/« Mauvaise »/« À revoir »), et le bouton de statut adapté (statut `pret_a_tourner` → « Démarrer le tournage »). Un cas vide (aucun beat) → « Aucun beat ». Enregistrer `"tournage-view.test.ts"` au `PURE_FILES`. Comme le composant est `"use client"` avec `useRouter`, ajouter un mock `next/navigation` en tête suivi d'un import dynamique (motif utilisé par `tests/insert-row.test.ts`).

- [ ] **Step 2: Lancer et vérifier l'échec**

Run: `bun test tests/tournage-view.test.ts` → FAIL (composant absent).

- [ ] **Step 3: Écrire le composant**

Créer `components/video/tournage-view.tsx` (`"use client"`). Suivre le motif de `components/video/verify-all-links.tsx` (useTransition + toast + useRouter().refresh, gestion `{ ok:false }` via `res.message`). Structure :

- En-tête de statut : afficher le statut courant ; un bouton de transition selon `status` — `pret_a_tourner` → « Démarrer le tournage » (`startShooting`), `en_ecriture` → « Marquer prêt à tourner » (`markReadyToShoot`), `tourne` → « Tournage terminé » (`finishShooting`). Aucun bouton pour les autres statuts.
- Une bascule « Mode prompteur » (état local booléen).
- **Mode Journal** (défaut) : pour chaque beat, une carte — libellé de kind, texte parlé (`text-base`), note de réalisation (petit), la liste des prises (numéro, badge `TAKE_STATUS_LABEL`, ★ si `beat.selectedTakeId === take.id`, note), et **trois gros boutons** `size="lg"` Bonne/Mauvaise/À revoir appelant `addTake({ beatId, status })`. Par prise : bouton ★ (`selectTake({ beatId, takeId })`, ou re-cliquer pour désélectionner → `takeId: null`), un champ note + Enregistrer (`updateTake`), et Supprimer (`deleteTake`, `ConfirmDialog` destructif). Toutes les actions : `startTransition` + `toast` + `router.refresh()`.
- **Mode Prompteur** : un beat à la fois (index local), texte parlé en `text-2xl`/`text-3xl` lisible, boutons Précédent/Suivant, et les trois boutons de log rapides pour le beat courant. Pas d'auto-défilement.
- État vide (`beats.length === 0`) : « Aucun beat à tourner. ».

Grandes cibles tactiles : boutons `size="lg"`, espacement généreux, responsive (`flex-wrap`, pleine largeur sur mobile).

- [ ] **Step 4: Câbler le 5ᵉ onglet**

Dans `app/(app)/video/[id]/page.tsx` :
1. Import `readTournageCore` (`@/lib/video/takes-core`) et `TournageView` (`@/components/video/tournage-view`).
2. Charger : `const tournage = activeVariant ? await readTournageCore(activeVariant.id) : null;` (près du chargement du conducteur).
3. Étendre le `defaultValue` du `<Tabs>` : `sp.tab === "tournage" ? "tournage" : sp.tab === "montage" ? "montage" : …` (avant le fallback `"brief"`).
4. `<TabsList>` : ajouter `<TabsTrigger value="tournage">Tournage</TabsTrigger>` (après Montage).
5. Ajouter le contenu :

```tsx
<TabsContent value="tournage">
  {tournage ? (
    <TournageView projectId={project.id} status={tournage.status} beats={tournage.beats} />
  ) : (
    <p className="text-sm text-muted-foreground">Aucune variante.</p>
  )}
</TabsContent>
```

- [ ] **Step 5: Lancer, inscrire le pur, typecheck**

Run: `bun test tests/tournage-view.test.ts && bun run test:pure && bun run typecheck`
Expected: PASS + exit 0.

- [ ] **Step 6: Commit**

```bash
git add components/video/tournage-view.tsx "app/(app)/video/[id]/page.tsx" tests/tournage-view.test.ts scripts/test-fast.ts
git commit -m "feat(video): onglet Tournage (prompteur et journal de prises)"
```

---

## Task 6: Vérification finale

**Files:** aucun.

- [ ] **Step 1: Suite pure + typecheck + build**

Run: `bun run typecheck && bun run test:pure && bun run build`
Expected: exit 0 partout. Le build résout le nouvel onglet Tournage.

- [ ] **Step 2: Tests DB ciblés**

Run: `bun test tests/takes-core.test.ts tests/project-status-core.test.ts tests/tournage-schema.test.ts --timeout 25000`
Expected: PASS. Ne pas lancer `bun test` complet (voie lente, infra-flaky).

- [ ] **Step 3: Preuve manuelle**

Onglet Tournage d'un projet :
1. Depuis `en_ecriture` : « Marquer prêt à tourner » → statut `pret_a_tourner` ; « Démarrer le tournage » → `tourne` ; « Tournage terminé » → `en_montage`. Une transition illégale n'est jamais proposée par l'UI.
2. Loguer des prises d'un tap (Bonne/Mauvaise/À revoir) → numérotation 1,2,3… ; éditer une note ; désigner la prise retenue (★) ; supprimer une prise (la retenue effacée si c'était elle).
3. Mode Prompteur : grand texte, navigation précédent/suivant, log rapide.
4. Responsive : cibles tactiles confortables sur mobile/tablette.
5. Désigner une prise d'un autre beat via une requête forgée → refus (`selectTakeCore`).

- [ ] **Step 4: État du dépôt**

Run: `git status` (propre) ; `git log --oneline main..HEAD`.

---

## Self-Review (à l'écriture)

- **Couverture spec :** `selectedTakeId` référence logique + migration (T2) ✓ ; cœurs add/update/delete/select + lecture (T3) ✓ ; transitions de statut + garde pure (T1/T4) ✓ ; actions gardées (T4) ✓ ; onglet Tournage prompteur+journal, grandes cibles (T5) ✓ ; libellés + statuts exportés (T1) ✓ ; pas d'intégration conducteur (aucune modif SP2) ✓ ; ordre de verrou étendu à `beat_takes` (T3) ✓.
- **Placeholders :** aucun ; code réel pour purs/cœurs/schéma/actions ; l'UI reprend le motif nommé `verify-all-links.tsx` avec un test contraignant.
- **Cohérence des types :** `TakeStatus` défini T1, consommé T3 (cœurs) et T4 (actions) ; `TournageBeat` défini T3, consommé T5 (UI) ; `estTransitionAutorisee`/`nextTakeNumber` définis T1, consommés T3/T4 ; `selectedTakeId` ajouté T2, lu/écrit T3. Une seule migration (T2), `beat_takes` non recréée.

Voir [[video-module-roadmap]] et [[execution-mode-subagent-driven]].
