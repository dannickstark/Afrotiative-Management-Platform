# Mode interview (SP5) — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gérer les intervenants d'une interview, assigner un locuteur par beat, lier chaque réponse à sa question, et bloquer la mise en montage tant qu'un intervenant n'a pas consenti — le tout en application.

**Architecture:** Un cœur CRUD `speakers-persist.ts` (par projet), une extension de `updateBeatCore` (speakerId + answersBeatId validés), une garde de consentement dans `setProjectStatusCore`, un onglet Intervenants et deux selects dans l'inspecteur de beat. Aucune migration (toutes les colonnes existent).

**Tech Stack:** Next.js (App Router), Drizzle/Postgres, shadcn/ui, `bun test`. Aucune dépendance nouvelle.

**Spec:** `docs/superpowers/specs/2026-08-21-video-mode-interview-design.md`

## Global Constraints

- **Copie UI en français.**
- **AUCUNE migration.** `interview_speakers` (name, role, consentGiven, consentNote), `scriptBeats.speakerId` (FK), `scriptBeats.answersBeatId` (uuid logique) existent déjà (migration 0020). Aucun enum ajouté.
- **FK `speakerId` = `ON DELETE no action`** : supprimer un intervenant référencé par un beat lèverait une violation 23503. `deleteSpeakerCore` DOIT dénouer (`scriptBeats.speakerId = null`) avant de supprimer.
- **`answersBeatId` = référence logique** (pas de FK). Cohérence assurée par le cœur à l'écriture ; la lecture doit tolérer une cible absente.
- **Mapping Q/R strict** : `answersBeatId` seulement sur un beat `reponse`, cible un beat `question` de la MÊME variante, jamais soi-même — sinon `RefusalError`.
- **Consentement** : `setProjectStatusCore` refuse `→ en_montage` si le projet a ≥1 `interview_speakers` avec `consentGiven = false`. Autres transitions inchangées.
- **Ordre de verrou** : écriture de beat = `script_variants` (FOR UPDATE) → `script_beats`. `deleteSpeakerCore` verrouille les variantes du projet (par id) avant de dénouer les beats.
- **Cores** sans `"use server"`, importent `@/db`, réutilisent `RefusalError` (de `@/lib/video/persist`). Les **actions** (`guard()` = `video:manage`, `refusable()`, `revalidateVideo()`).
- **Lectures** dans `lib/queries/video.ts` (jamais d'écriture) ; **écritures** dans les cores.
- **Tests purs** dans `PURE_FILES` (`scripts/test-fast.ts`). Tests DB : voie lente, UUID valides, nettoyage.

---

## File Structure

| Fichier | Rôle | Action |
|---|---|---|
| `lib/validation.ts` | Schémas | Modifier — `createSpeakerSchema`/`updateSpeakerSchema`, extension `updateBeatSchema` |
| `lib/video/speakers-persist.ts` | Cœurs CRUD intervenants | Créer |
| `lib/queries/video.ts` | Lecture intervenants | Modifier — `listSpeakers` + `SpeakerRow` |
| `lib/video/persist.ts` | Beat + statut | Modifier — `updateBeatCore` (speaker/Q-R), `setProjectStatusCore` (consentement), import `interviewSpeakers` |
| `lib/actions/video-actions.ts` | Actions | Modifier — `createSpeaker`/`updateSpeaker`/`deleteSpeaker` |
| `components/video/speakers-manager.tsx` | Onglet Intervenants (client) | Créer |
| `components/video/beat-list.tsx` | Type vue | Modifier — `BeatView` + speakerId/answersBeatId, prop `speakers` |
| `components/video/beat-inspector.tsx` | Inspecteur | Modifier — selects locuteur + « Répond à » |
| `app/(app)/video/[id]/page.tsx` | Page projet | Modifier — 6ᵉ onglet + `listSpeakers` + mapping + threading |
| `scripts/test-fast.ts` | Allowlist tests purs | Modifier |

---

## Task 1: Schémas + cœurs CRUD intervenants + lecture

**Files:**
- Modify: `lib/validation.ts`
- Create: `lib/video/speakers-persist.ts`
- Modify: `lib/queries/video.ts`
- Test: `tests/speakers-core.test.ts` (DB)

**Interfaces:**
- Consumes: `RefusalError` (`@/lib/video/persist`), `interviewSpeakers`/`scriptVariants`/`scriptBeats` (`@/db`).
- Produces: `createSpeakerCore({ projectId, name, role }): Promise<string>` ; `updateSpeakerCore({ speakerId, name?, role?, consentGiven?, consentNote? }): Promise<void>` ; `deleteSpeakerCore({ speakerId }): Promise<void>` ; `listSpeakers(projectId): Promise<SpeakerRow[]>` + `SpeakerRow` ; schémas Zod `createSpeakerSchema`/`updateSpeakerSchema`.

- [ ] **Step 1: Ajouter les schémas**

Dans `lib/validation.ts`, ajouter (après les schémas de catégorie) :

```ts
export const createSpeakerSchema = z.object({
  projectId: z.string().uuid(),
  name: z.string().min(1, "Nom requis").max(120),
  role: z.string().max(120).nullable().optional(),
});

export const updateSpeakerSchema = z.object({
  speakerId: z.string().uuid(),
  name: z.string().min(1, "Nom requis").max(120).optional(),
  role: z.string().max(120).nullable().optional(),
  consentGiven: z.boolean().optional(),
  consentNote: z.string().max(1000).nullable().optional(),
});

export const speakerIdSchema = z.object({ speakerId: z.string().uuid("Identifiant invalide") });
```

- [ ] **Step 2: Écrire le test DB qui échoue**

Créer `tests/speakers-core.test.ts` (UUID valides, `afterAll` nettoyage) :

```ts
import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, videoProjects, scriptVariants, scriptBeats, interviewSpeakers } from "@/db";
import { createSpeakerCore, updateSpeakerCore, deleteSpeakerCore } from "@/lib/video/speakers-persist";
import { listSpeakers } from "@/lib/queries/video";

const P = "00000000-0000-0000-0000-0000000005a1";

afterAll(async () => { await db.delete(videoProjects).where(eq(videoProjects.id, P)); });

test("CRUD intervenant + suppression dénoue les beats", async () => {
  await db.insert(videoProjects).values({ id: P, title: "T", subject: null }).onConflictDoNothing();
  const [v] = await db.insert(scriptVariants).values({ projectId: P, platform: "interview", position: 0 }).returning();
  const [b] = await db.insert(scriptBeats).values({ variantId: v.id, externalId: "b1", position: 0, kind: "reponse", spokenText: "" }).returning();

  const id = await createSpeakerCore({ projectId: P, name: "Awa", role: "Experte" });
  let list = await listSpeakers(P);
  expect(list.find((s) => s.id === id)?.consentGiven).toBe(false);

  await updateSpeakerCore({ speakerId: id, consentGiven: true, consentNote: "Signé le 20/08" });
  list = await listSpeakers(P);
  expect(list.find((s) => s.id === id)?.consentGiven).toBe(true);

  // Assigner puis supprimer : le beat doit être dénoué (speakerId → null), pas d'erreur FK.
  await db.update(scriptBeats).set({ speakerId: id }).where(eq(scriptBeats.id, b.id));
  await deleteSpeakerCore({ speakerId: id });
  const [beatRow] = await db.select().from(scriptBeats).where(eq(scriptBeats.id, b.id));
  expect(beatRow.speakerId).toBeNull();
  expect((await listSpeakers(P)).length).toBe(0);
});
```

- [ ] **Step 3: Lancer et vérifier l'échec**

Run: `bun test tests/speakers-core.test.ts --timeout 20000` → FAIL (modules absents).

- [ ] **Step 4: Écrire le cœur**

Créer `lib/video/speakers-persist.ts` :

```ts
import { asc, eq } from "drizzle-orm";
import { db, interviewSpeakers, scriptVariants, scriptBeats } from "@/db";
import { RefusalError } from "@/lib/video/persist";

export async function createSpeakerCore(
  input: { projectId: string; name: string; role: string | null },
): Promise<string> {
  const [row] = await db.insert(interviewSpeakers).values({
    projectId: input.projectId, name: input.name.trim(), role: input.role?.trim() || null,
  }).returning({ id: interviewSpeakers.id });
  return row.id;
}

export async function updateSpeakerCore(
  input: { speakerId: string; name?: string; role?: string | null; consentGiven?: boolean; consentNote?: string | null },
): Promise<void> {
  const patch: Partial<typeof interviewSpeakers.$inferInsert> = { updatedAt: new Date() };
  if (input.name !== undefined) patch.name = input.name.trim();
  if (input.role !== undefined) patch.role = input.role?.trim() || null;
  if (input.consentGiven !== undefined) patch.consentGiven = input.consentGiven;
  if (input.consentNote !== undefined) patch.consentNote = input.consentNote;
  const updated = await db.update(interviewSpeakers).set(patch)
    .where(eq(interviewSpeakers.id, input.speakerId)).returning({ id: interviewSpeakers.id });
  if (updated.length === 0) throw new RefusalError("Intervenant introuvable.");
}

export async function deleteSpeakerCore(input: { speakerId: string }): Promise<void> {
  await db.transaction(async (tx) => {
    const [sp] = await tx.select({ projectId: interviewSpeakers.projectId }).from(interviewSpeakers)
      .where(eq(interviewSpeakers.id, input.speakerId));
    if (!sp) throw new RefusalError("Intervenant introuvable.");
    // Verrouiller les variantes du projet (par id) avant de dénouer les beats — respecte l'ordre de verrou.
    await tx.select({ id: scriptVariants.id }).from(scriptVariants)
      .where(eq(scriptVariants.projectId, sp.projectId)).orderBy(asc(scriptVariants.id)).for("update");
    // FK speakerId = ON DELETE no action : dénouer d'abord, sinon violation 23503.
    await tx.update(scriptBeats).set({ speakerId: null }).where(eq(scriptBeats.speakerId, input.speakerId));
    await tx.delete(interviewSpeakers).where(eq(interviewSpeakers.id, input.speakerId));
  });
}
```

- [ ] **Step 5: Ajouter la lecture**

Dans `lib/queries/video.ts`, ajouter (vérifier que `interviewSpeakers`, `asc`, `eq` sont importés ; sinon les ajouter aux imports existants) :

```ts
export type SpeakerRow = {
  id: string; name: string; role: string | null;
  consentGiven: boolean; consentNote: string | null; createdAt: Date;
};

export async function listSpeakers(projectId: string): Promise<SpeakerRow[]> {
  return db.select({
    id: interviewSpeakers.id, name: interviewSpeakers.name, role: interviewSpeakers.role,
    consentGiven: interviewSpeakers.consentGiven, consentNote: interviewSpeakers.consentNote,
    createdAt: interviewSpeakers.createdAt,
  }).from(interviewSpeakers).where(eq(interviewSpeakers.projectId, projectId))
    .orderBy(asc(interviewSpeakers.createdAt));
}
```

- [ ] **Step 6: Lancer et vérifier + typecheck**

Run: `bun test tests/speakers-core.test.ts --timeout 20000 && bun run typecheck`
Expected: PASS + exit 0. NON inscrit au `PURE_FILES` (DB).

- [ ] **Step 7: Commit**

```bash
git add lib/validation.ts lib/video/speakers-persist.ts lib/queries/video.ts tests/speakers-core.test.ts
git commit -m "feat(video): cœurs CRUD des intervenants et lecture"
```

---

## Task 2: Assignation locuteur + mapping Q/R dans `updateBeatCore`

**Files:**
- Modify: `lib/validation.ts` (`updateBeatSchema`)
- Modify: `lib/video/persist.ts` (`updateBeatCore` + import `interviewSpeakers`)
- Test: `tests/beat-speaker-answers-core.test.ts` (DB)

**Interfaces:**
- Produces: `updateBeatCore` accepte `speakerId?: string | null` et `answersBeatId?: string | null` (patch partiel + validations).

- [ ] **Step 1: Étendre le schéma**

Dans `lib/validation.ts`, `updateBeatSchema`, ajouter deux champs :

```ts
  speakerId: z.string().uuid().nullable().optional(),
  answersBeatId: z.string().uuid().nullable().optional(),
```

- [ ] **Step 2: Écrire le test DB qui échoue**

Créer `tests/beat-speaker-answers-core.test.ts` : projet + variante + un beat `question` (Q) et un beat `reponse` (R) + un intervenant du projet + un beat d'un AUTRE projet/variante. Vérifier :
- assigner `speakerId` (intervenant du projet) sur R → OK ; un intervenant d'un autre projet → refus.
- `answersBeatId` sur R vers Q (même variante) → OK ; sur Q (source non-`reponse`) → refus ; vers un beat non-`question` → refus ; vers Q d'une autre variante → refus ; vers soi-même → refus.
UUID valides, nettoyage, `--timeout 20000`.

- [ ] **Step 3: Lancer et vérifier l'échec**

Run: `bun test tests/beat-speaker-answers-core.test.ts --timeout 20000` → FAIL.

- [ ] **Step 4: Étendre le cœur**

Dans `lib/video/persist.ts` :
1. Ajouter `interviewSpeakers` à l'import `@/db` (ligne ~1-3).
2. Étendre le type d'entrée de `updateBeatCore` avec `speakerId?: string | null;` et `answersBeatId?: string | null;`.
3. Après la re-lecture de `current` (le beat) et AVANT le `tx.update(scriptBeats)`, ajouter les validations :

```ts
    // Assignation d'un locuteur : l'intervenant doit appartenir au projet du beat.
    if (input.speakerId !== undefined && input.speakerId !== null) {
      const [proj] = await tx.select({ projectId: scriptVariants.projectId }).from(scriptVariants)
        .where(eq(scriptVariants.id, current.variantId));
      const [sp] = await tx.select({ projectId: interviewSpeakers.projectId }).from(interviewSpeakers)
        .where(eq(interviewSpeakers.id, input.speakerId));
      if (!sp || !proj || sp.projectId !== proj.projectId) throw new RefusalError("Intervenant absent de ce projet.");
    }
    // Mapping Q/R strict : réponse → question de la même variante, jamais soi-même.
    if (input.answersBeatId !== undefined && input.answersBeatId !== null) {
      if (current.kind !== "reponse") throw new RefusalError("Seul un beat « réponse » peut répondre à une question.");
      if (input.answersBeatId === input.beatId) throw new RefusalError("Un beat ne peut pas se répondre à lui-même.");
      const [target] = await tx.select({ kind: scriptBeats.kind, variantId: scriptBeats.variantId }).from(scriptBeats)
        .where(eq(scriptBeats.id, input.answersBeatId));
      if (!target || target.kind !== "question" || target.variantId !== current.variantId) {
        throw new RefusalError("La cible doit être une question de la même variante.");
      }
    }
```

4. Dans le `tx.update(scriptBeats).set({...})`, ajouter :

```ts
      speakerId: input.speakerId !== undefined ? input.speakerId : current.speakerId,
      answersBeatId: input.answersBeatId !== undefined ? input.answersBeatId : current.answersBeatId,
```

(Le reste — spokenText/durées/etc. — inchangé ; le retour de la fonction reste identique.)

- [ ] **Step 5: Lancer, typecheck**

Run: `bun test tests/beat-speaker-answers-core.test.ts --timeout 20000 && bun run typecheck`
Expected: PASS + exit 0.

- [ ] **Step 6: Commit**

```bash
git add lib/validation.ts lib/video/persist.ts tests/beat-speaker-answers-core.test.ts
git commit -m "feat(video): assignation d'un locuteur et mapping réponse→question"
```

---

## Task 3: Garde de consentement sur `→ en_montage`

**Files:**
- Modify: `lib/video/persist.ts` (`setProjectStatusCore`)
- Test: `tests/consent-gate-core.test.ts` (DB)

**Interfaces:**
- Modifie: `setProjectStatusCore` refuse `→ en_montage` si un intervenant du projet a `consentGiven = false`.

- [ ] **Step 1: Écrire le test DB qui échoue**

Créer `tests/consent-gate-core.test.ts` : projet en `tourne` + un intervenant `consentGiven=false` → `setProjectStatusCore({ projectId, to: "en_montage" })` **rejette** ; après `consentGiven=true` → **passe** ; un projet en `tourne` sans intervenant → passe. (Insérer le projet avec `status: "tourne"`.) UUID valides, nettoyage, `--timeout 20000`.

- [ ] **Step 2: Lancer et vérifier l'échec**

Run: `bun test tests/consent-gate-core.test.ts --timeout 20000` → FAIL (pas encore de garde).

- [ ] **Step 3: Ajouter la garde**

Dans `lib/video/persist.ts`, `setProjectStatusCore`, après la vérification `estTransitionAutorisee` et AVANT le `tx.update(videoProjects)`, ajouter (utiliser `and` — déjà importé de `drizzle-orm` ; `interviewSpeakers` importé en Task 2) :

```ts
    if (input.to === "en_montage") {
      const [pending] = await tx.select({ id: interviewSpeakers.id }).from(interviewSpeakers)
        .where(and(eq(interviewSpeakers.projectId, input.projectId), eq(interviewSpeakers.consentGiven, false)))
        .limit(1);
      if (pending) throw new RefusalError("Consentement manquant : un intervenant n'a pas donné son consentement.");
    }
```

- [ ] **Step 4: Lancer, typecheck**

Run: `bun test tests/consent-gate-core.test.ts --timeout 20000 && bun run typecheck`
Expected: PASS + exit 0.

- [ ] **Step 5: Commit**

```bash
git add lib/video/persist.ts tests/consent-gate-core.test.ts
git commit -m "feat(video): verrou de consentement avant la mise en montage"
```

---

## Task 4: Actions intervenants + onglet Intervenants

**Files:**
- Modify: `lib/actions/video-actions.ts`
- Create: `components/video/speakers-manager.tsx` (`"use client"`)
- Modify: `app/(app)/video/[id]/page.tsx` (6ᵉ onglet + `listSpeakers`)
- Test: `tests/speakers-manager.test.ts` (pur)
- Modify: `scripts/test-fast.ts`

**Interfaces:**
- Consumes: `createSpeakerCore`/`updateSpeakerCore`/`deleteSpeakerCore` (Task 1), schémas (Task 1), `SpeakerRow`/`listSpeakers` (Task 1).
- Produces: actions `createSpeaker`/`updateSpeaker`/`deleteSpeaker` ; composant `SpeakersManager`.

- [ ] **Step 1: Écrire les actions**

Dans `lib/actions/video-actions.ts`, ajouter aux imports : `createSpeakerSchema, updateSpeakerSchema, speakerIdSchema` (`@/lib/validation`) et `createSpeakerCore, updateSpeakerCore, deleteSpeakerCore` (`@/lib/video/speakers-persist`). Puis (motif de `setProjectCategory`) :

```ts
export async function createSpeaker(input: unknown): Promise<{ ok: true; id: string } | { ok: false; message: string }> {
  await guard();
  const parsed = createSpeakerSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Entrée invalide." };
  const res = await refusable(() => createSpeakerCore({ projectId: parsed.data.projectId, name: parsed.data.name, role: parsed.data.role ?? null }));
  if (!res.ok) return res;
  revalidateVideo();
  return { ok: true, id: res.value };
}

export async function updateSpeaker(input: unknown): Promise<{ ok: true } | { ok: false; message: string }> {
  await guard();
  const parsed = updateSpeakerSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Entrée invalide." };
  const res = await refusable(() => updateSpeakerCore(parsed.data));
  if (!res.ok) return res;
  revalidateVideo();
  return { ok: true };
}

export async function deleteSpeaker(input: unknown): Promise<{ ok: true } | { ok: false; message: string }> {
  await guard();
  const parsed = speakerIdSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Entrée invalide." };
  const res = await refusable(() => deleteSpeakerCore({ speakerId: parsed.data.speakerId }));
  if (!res.ok) return res;
  revalidateVideo();
  return { ok: true };
}
```

- [ ] **Step 2: Écrire le test du composant (échoue)**

Créer `tests/speakers-manager.test.ts` (motif `renderToStaticMarkup` + `createElement`, mock `next/navigation` si `useRouter` est utilisé) : rendre `SpeakersManager` avec deux intervenants (un consenti, un non) → attendre les noms, un badge de consentement, et le bandeau d'avertissement « sans consentement » ; cas vide → « Aucun intervenant ». Inscrire `"speakers-manager.test.ts"` au `PURE_FILES`.

- [ ] **Step 3: Écrire le composant**

Créer `components/video/speakers-manager.tsx` (`"use client"`), motif de `components/video/category-manager.tsx` (liste + Dialog add/edit + ConfirmDialog delete + `useTransition` + `toast`, **revalidate-only, pas de router.refresh**). Props `{ projectId: string; speakers: SpeakerRow[] }`. Éléments requis (contraints par le test) :
- Un bandeau d'avertissement si `speakers.some((s) => !s.consentGiven)` : « {n} intervenant(s) sans consentement — la mise en montage sera bloquée. ».
- La liste : nom, rôle, badge « Consentement OK » / « Sans consentement », note.
- Bouton « Nouvel intervenant » → dialog (nom + rôle) → `createSpeaker({ projectId, name, role })`.
- Par ligne : éditer (nom/rôle/consentement/note via `updateSpeaker`), un interrupteur/bouton de consentement (`updateSpeaker({ speakerId, consentGiven })`), supprimer (`deleteSpeaker({ speakerId })`, `ConfirmDialog` destructif).
- État vide → « Aucun intervenant ».

- [ ] **Step 4: Câbler l'onglet + charger les intervenants**

Dans `app/(app)/video/[id]/page.tsx` :
1. Import `listSpeakers` (`@/lib/queries/video`) + `SpeakersManager`.
2. Charger `const speakers = await listSpeakers(project.id);` (l'ajouter au `Promise.all` existant si présent, sinon un `await` près des autres lectures).
3. Étendre le `defaultValue` du `<Tabs>` : `sp.tab === "intervenants" ? "intervenants" : …` (avant le fallback `"brief"`).
4. `<TabsList>` : ajouter `<TabsTrigger value="intervenants">Intervenants</TabsTrigger>` (après Tournage).
5. Ajouter le contenu : `<TabsContent value="intervenants"><SpeakersManager projectId={project.id} speakers={speakers} /></TabsContent>`.

- [ ] **Step 5: Lancer, inscrire le pur, typecheck**

Run: `bun test tests/speakers-manager.test.ts && bun run test:pure && bun run typecheck`
Expected: PASS + exit 0.

- [ ] **Step 6: Commit**

```bash
git add lib/actions/video-actions.ts components/video/speakers-manager.tsx "app/(app)/video/[id]/page.tsx" tests/speakers-manager.test.ts scripts/test-fast.ts
git commit -m "feat(video): actions intervenants et onglet Intervenants"
```

---

## Task 5: Selects locuteur + « Répond à » dans l'inspecteur

**Files:**
- Modify: `components/video/beat-list.tsx` (`BeatView` + prop `speakers`)
- Modify: `components/video/beat-inspector.tsx` (deux selects)
- Modify: `app/(app)/video/[id]/page.tsx` (mapping + threading)
- Test: `tests/beat-inspector-interview.test.ts` (pur)
- Modify: `scripts/test-fast.ts`

**Interfaces:**
- Consumes: `updateBeat` (élargi Task 2), `SpeakerRow` (Task 1).

- [ ] **Step 1: Élargir `BeatView` + prop speakers**

Dans `components/video/beat-list.tsx` :
- `BeatView` gagne `speakerId: string | null;` et `answersBeatId: string | null;`.
- `BeatList` accepte une prop `speakers: { id: string; name: string }[]` et la passe à `BeatInspector`.

- [ ] **Step 2: Écrire le test qui échoue**

Créer `tests/beat-inspector-interview.test.ts` (motif render + mock `next/navigation`) : rendre `BeatInspector` avec un beat `kind = "reponse"`, une liste `speakers`, et des beats `question` frères → attendre le select « Locuteur » (avec les noms d'intervenants) et le select « Répond à » (avec les questions). Rendre avec un beat `kind = "narration"` → le select « Répond à » n'apparaît PAS (réservé aux réponses). Inscrire au `PURE_FILES`.

- [ ] **Step 3: Ajouter les selects à l'inspecteur**

Dans `components/video/beat-inspector.tsx` :
1. `BeatInspector` accepte deux nouvelles props : `speakers: { id: string; name: string }[]` et `questionBeats: { id: string; position: number; spokenText: string }[]` (les beats `question` de la variante).
2. `FormState` + `toForm` gagnent `speakerId: string | null` et `answersBeatId: string | null`.
3. Dans le conteneur de champs, ajouter deux blocs (native `<select>`, motif d'`InsertRow`) :
   - **Locuteur** : options = `speakers` + « Aucun » (valeur ""). `onChange` met `speakerId` (""→null).
   - **Répond à** : rendu SEULEMENT si `beat.kind === "reponse"`. Options = `questionBeats` (label « #{position+1} — extrait ») + « Aucune ». Met `answersBeatId`.
4. `handleSave` inclut `speakerId` et `answersBeatId` dans l'appel `updateBeat({ beatId, …, speakerId, answersBeatId })` et dans le `onSaved` patch.

- [ ] **Step 4: Câbler le mapping + threading dans la page**

Dans `app/(app)/video/[id]/page.tsx` :
- Le mapping `beats: BeatView[]` gagne `speakerId: b.speakerId,` et `answersBeatId: b.answersBeatId,` (le row brut les porte déjà — `getVideoProject` renvoie toutes les colonnes).
- Passer `speakers={speakers.map((s) => ({ id: s.id, name: s.name }))}` à `<BeatList>`. `BeatList` calcule les `questionBeats` de la variante (`beats.filter((b) => b.kind === "question")`) et les passe à `BeatInspector`.

- [ ] **Step 5: Lancer, inscrire le pur, typecheck**

Run: `bun test tests/beat-inspector-interview.test.ts && bun run test:pure && bun run typecheck`
Expected: PASS + exit 0. (Le test existant de l'inspecteur/`beat-list` doit toujours passer — ajouts additifs, props avec défauts sûrs.)

- [ ] **Step 6: Commit**

```bash
git add components/video/beat-list.tsx components/video/beat-inspector.tsx "app/(app)/video/[id]/page.tsx" tests/beat-inspector-interview.test.ts scripts/test-fast.ts
git commit -m "feat(video): locuteur et « répond à » dans l'inspecteur de beat"
```

---

## Task 6: Vérification finale

**Files:** aucun.

- [ ] **Step 1: Suite pure + typecheck + build**

Run: `bun run typecheck && bun run test:pure && bun run build`
Expected: exit 0 partout. Le build résout le 6ᵉ onglet Intervenants. **Confirmer `bun run db:generate` ne génère RIEN** (aucune migration attendue) — si une migration est proposée, s'arrêter et rapporter (le schéma aurait divergé).

- [ ] **Step 2: Tests DB ciblés**

Run: `bun test tests/speakers-core.test.ts tests/beat-speaker-answers-core.test.ts tests/consent-gate-core.test.ts --timeout 25000`
Expected: PASS. Ne pas lancer `bun test` complet (voie lente, infra-flaky).

- [ ] **Step 3: Preuve manuelle**

1. Onglet Intervenants : créer un intervenant, basculer le consentement, éditer la note, supprimer (un beat qui le référençait est dénoué, pas d'erreur).
2. Écriture → inspecteur d'un beat : assigner un locuteur ; sur un beat `reponse`, lier une `question` de la variante ; le conducteur (Montage) affiche le nom du locuteur.
3. Tournage : avec un intervenant non consenti, « Tournage terminé » → refus « Consentement manquant » ; après consentement → passe en montage.
4. Tenter (requête forgée) d'assigner un intervenant d'un autre projet ou de lier une réponse à une question d'une autre variante → refus.

- [ ] **Step 4: État du dépôt**

Run: `git status` (propre) ; `git log --oneline main..HEAD`.

---

## Self-Review (à l'écriture)

- **Couverture spec :** intervenants CRUD + lecture (T1) ✓ ; suppression null-then-delete verrouillée (T1) ✓ ; assignation locuteur + Q/R strict (T2) ✓ ; verrou de consentement `→ en_montage` (T3) ✓ ; actions gardées (T4) ✓ ; onglet Intervenants + bandeau (T4) ✓ ; selects inspecteur (T5) ✓ ; aucune migration ✓ ; conducteur SP2 inchangé ✓ ; `answersBeatId` référence logique tolérée en lecture (noté) ✓.
- **Placeholders :** aucun ; code réel pour cœurs/schémas/validations ; l'UI reprend les motifs nommés (`category-manager`, `InsertRow` selects) avec tests contraignants.
- **Cohérence des types :** `SpeakerRow` défini T1, consommé T4/T5 ; schémas T1 consommés T4 ; `updateBeatCore` élargi T2, appelé par `updateBeat` (inchangé) et l'inspecteur T5 ; `BeatView` élargi T5, cohérent avec le mapping page. `interviewSpeakers` importé dans persist.ts en T2, réutilisé T3.

Voir [[video-module-roadmap]] et [[execution-mode-subagent-driven]].
