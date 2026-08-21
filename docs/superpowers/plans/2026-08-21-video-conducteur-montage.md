# Conducteur de montage & accès monteur (SP2) — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Donner au monteur un conducteur de montage exploitable — projeté des beats SP1, visible dans l'app (rôle `Monteur`) et via un lien signé externe, exportable (PDF imprimable, CSV/JSON, manifeste médias), avec annotations légères en retour.

**Architecture:** Une projection pure (`buildConducteur`) alimente une vue in-app (4ᵉ onglet), une page publique par lien signé haché, et des exports paramétrés (session OU jeton). Les annotations (beat coché, lien mort) sont journalisées et strictement limitées au projet du jeton côté public.

**Tech Stack:** Next.js (App Router), Drizzle + Postgres/Neon, shadcn/ui + Tailwind v4, `bun test`. Pas de nouvelle dépendance (PDF = HTML imprimable).

**Spec:** `docs/superpowers/specs/2026-08-20-video-conducteur-montage-design.md`

## Global Constraints

- **Copie UI en français.** Toutes les chaînes visibles.
- **Durées STOCKÉES, jamais recalculées.** La projection utilise `durationOverrideSec ?? estimatedDurationSec` (la colonne stockée), PAS `variantSeconds`/`beatSeconds` (qui ré-estiment depuis `spokenText`). `isBreathRisk(spokenText)` reste utilisable (pur, sur le texte).
- **Pureté :** `lib/video/rundown.ts`, `lib/video/labels.ts`, `lib/montage/token.ts` restent PURS (pas de `@/db`, pas de réseau, pas de DOM). Les cœurs DB vivent dans `lib/montage/persist.ts` / `lib/montage/access.ts` (sans `"use server"`), sur le modèle de `lib/video/persist.ts` (seule exception `@/db`).
- **Server actions** débutent par `requireUser()` + `requirePermission(role, "video", <action>)`. Écritures partage = `manage` ; annotations = `annotate`. Le cœur DB throw `RefusalError` pour un refus métier ; l'action le convertit en `{ ok:false, message }` via le motif `refusable()`.
- **Route publique HORS `(app)`** : le groupe `app/(app)/` impose `requireUser()` dans son layout. La page monteur vit dans un NOUVEAU groupe `app/(public)/` sans ce gardien. Toutes ses lectures/écritures sont paramétrées par le partage résolu (jamais `requireUser`).
- **Jeton de partage haché uniquement** (préfixe + SHA-256), jamais en clair. Namespace `afro_montage_` (distinct de `afro_vid_`). Comparaison constante `safeEqual`.
- **Migrations :** éditer `db/schema.ts` puis `bun run db:generate` (numéro auto, prochain = `0029`), puis `bun run db:migrate`. Une valeur d'enum s'ajoute par `ALTER TYPE "public"."<enum>" ADD VALUE '<val>';`. **JAMAIS** de migration qui à la fois ajoute une valeur d'enum ET la référence (55P04, migrate = une seule transaction). Nos valeurs d'enum (`user_role.monteur`, `script_journal_source.monteur`) ne sont référencées qu'au RUNTIME, jamais en migration — donc sûres.
- **Ordre de verrouillage SP1** pour toute transaction touchant les beats/inserts : `script_variants` puis `script_beats` puis `beat_inserts`.
- **Tests purs** inscrits dans le `Set` `PURE_FILES` de `scripts/test-fast.ts` (nom nu, sans `tests/`). Signal vert = `bun run typecheck` + `bun run test:pure`. Tests DB : voie lente par défaut, nettoyage obligatoire (DB partagée).

---

## File Structure

| Fichier | Rôle | Action |
|---|---|---|
| `lib/video/labels.ts` | Libellés | Modifier — `BEAT_KIND_LABEL`, `INSERT_KIND_LABEL`, `LINK_STATUS_LABEL` |
| `lib/video/rundown.ts` | Projection pure | Créer — `buildConducteur` + types |
| `lib/montage/persist.ts` | Cœurs DB montage (sans `"use server"`) | Créer — `readConducteurCore`, annotation cores |
| `lib/montage/token.ts` | Jeton de partage (pur) | Créer |
| `lib/montage/access.ts` | Résolution de partage (DB core) | Créer — `resolveShare`, `createShareCore`, `revokeShareCore`, `listSharesCore` |
| `lib/actions/montage-actions.ts` | Server actions (`"use server"`) | Créer |
| `db/schema.ts` | Schéma | Modifier — colonne, table, 2 valeurs d'enum |
| `db/migrations/00XX_*.sql` | Migrations | Créer (générées) |
| `lib/permissions.ts` / `lib/rbac.ts` / `lib/auth.ts` | Rôle Monteur + action `annotate` | Modifier |
| `components/video/conducteur-view.tsx` | Vue conducteur (lecture + annotations) | Créer |
| `components/video/montage-share-panel.tsx` | Panneau « Accès monteur » | Créer |
| `app/(app)/video/[id]/page.tsx` | Page projet | Modifier — 4ᵉ onglet Montage |
| `app/(public)/layout.tsx` | Layout public sans auth | Créer |
| `app/(public)/montage/[token]/page.tsx` | Page monteur publique | Créer |
| `app/(public)/montage/[token]/print/page.tsx` | Vue imprimable (PDF) | Créer |
| `app/api/montage/export/route.ts` | Export CSV/JSON + manifeste | Créer |
| `scripts/test-fast.ts` | Allowlist tests purs | Modifier |

---

## Task 1: Libellés de kind d'insert et de statut de lien

**Files:**
- Modify: `lib/video/labels.ts`
- Test: `tests/video-labels.test.ts` (pur)
- Modify: `scripts/test-fast.ts`

**Interfaces:**
- Produces: `BEAT_KIND_LABEL`, `INSERT_KIND_LABEL`, `LINK_STATUS_LABEL` (`Record<string,string>`).

- [ ] **Step 1: Écrire le test qui échoue**

Créer `tests/video-labels.test.ts` :

```ts
import { expect, test } from "bun:test";
import { BEAT_KIND_LABEL, INSERT_KIND_LABEL, LINK_STATUS_LABEL } from "@/lib/video/labels";

test("libellés d'insert couvrent l'enum insert_kind", () => {
  for (const k of ["image", "video", "extrait", "graphique", "fichier"]) {
    expect(INSERT_KIND_LABEL[k]).toBeTruthy();
  }
});

test("libellés de statut de lien, orientés monteur", () => {
  expect(LINK_STATUS_LABEL.non_verifie).toBe("À vérifier");
  expect(LINK_STATUS_LABEL.mort).toBe("Mort");
  expect(LINK_STATUS_LABEL.ok).toBe("OK");
  expect(LINK_STATUS_LABEL.interdit).toBe("Interdit");
});

test("libellés de beat couvrent l'enum beat_kind", () => {
  for (const k of ["narration", "question", "reponse", "insert", "broll", "transition", "texte_ecran", "son", "note"]) {
    expect(BEAT_KIND_LABEL[k]).toBeTruthy();
  }
});
```

- [ ] **Step 2: Lancer et vérifier l'échec**

Run: `bun test tests/video-labels.test.ts`
Expected: FAIL — exports absents.

- [ ] **Step 3: Ajouter les libellés**

Dans `lib/video/labels.ts`, sous `PLATFORM_LABEL` :

```ts
export const BEAT_KIND_LABEL: Record<string, string> = {
  narration: "Narration", question: "Question", reponse: "Réponse", insert: "Insert",
  broll: "B-roll", transition: "Transition", texte_ecran: "Texte écran", son: "Son", note: "Note",
};

export const INSERT_KIND_LABEL: Record<string, string> = {
  image: "Image", video: "Vidéo", extrait: "Extrait", graphique: "Graphique", fichier: "Fichier",
};

export const LINK_STATUS_LABEL: Record<string, string> = {
  non_verifie: "À vérifier", ok: "OK", mort: "Mort", interdit: "Interdit",
};
```

- [ ] **Step 4: Lancer et vérifier le succès**

Run: `bun test tests/video-labels.test.ts`
Expected: PASS.

- [ ] **Step 5: Inscrire le test pur, typecheck, commit**

Ajouter `"video-labels.test.ts"` au `PURE_FILES` de `scripts/test-fast.ts`.

Run: `bun run typecheck && bun run test:pure`

```bash
git add lib/video/labels.ts tests/video-labels.test.ts scripts/test-fast.ts
git commit -m "feat(video): libellés de kind d'insert et de statut de lien"
```

---

## Task 2: Projection pure `buildConducteur`

**Files:**
- Create: `lib/video/rundown.ts`
- Test: `tests/video-rundown.test.ts` (pur)
- Modify: `scripts/test-fast.ts`

**Interfaces:**
- Consumes: `BEAT_KIND_LABEL`/`INSERT_KIND_LABEL`/`LINK_STATUS_LABEL` (Task 1), `isBreathRisk` (`lib/video/duration.ts`).
- Produces (later tasks depend on these exact types):
  - `RundownBeatInput`, `RundownInsertInput`, `ConducteurBeat`, `ConducteurInsert`, `Conducteur`.
  - `buildConducteur(beats: RundownBeatInput[], resolveMedia: (url: string|null, r2Key: string|null) => string|null): Conducteur`.

Durée = `durationOverrideSec ?? estimatedDurationSec` (STOCKÉE). Totaux sommés depuis ces valeurs stockées, jamais ré-estimés. `resolveMedia` est injecté pour garder le module pur (la résolution R2 vit dans le cœur DB).

- [ ] **Step 1: Écrire le test qui échoue**

Créer `tests/video-rundown.test.ts` :

```ts
import { expect, test } from "bun:test";
import { buildConducteur, type RundownBeatInput } from "@/lib/video/rundown";

const resolve = (url: string | null, r2Key: string | null) =>
  r2Key ? `https://cdn.test/${r2Key}` : url;

function beat(over: Partial<RundownBeatInput> = {}): RundownBeatInput {
  return {
    position: 1, kind: "narration", spokenText: "Bonjour",
    directionNote: null, screenText: null, transitionIn: null, transitionOut: null,
    estimatedDurationSec: 5, durationOverrideSec: null, speakerName: null,
    montageCheckedAt: null, inserts: [], ...over,
  };
}

test("durée = override si présent, sinon estimation stockée (pas de recalcul)", () => {
  const c = buildConducteur([beat({ estimatedDurationSec: 5, durationOverrideSec: 12 })], resolve);
  expect(c.beats[0].durationSec).toBe(12);
  const c2 = buildConducteur([beat({ estimatedDurationSec: 7, durationOverrideSec: null })], resolve);
  expect(c2.beats[0].durationSec).toBe(7);
});

test("totaux : nb beats, durée totale, nb inserts, nb liens morts", () => {
  const c = buildConducteur([
    beat({ estimatedDurationSec: 3, inserts: [
      { id: "i1", kind: "image", url: "http://x", r2Key: null, tcIn: null, tcOut: null, displayDurationSec: null, credit: null, rightsNote: null, linkStatus: "ok" },
      { id: "i2", kind: "video", url: null, r2Key: "k2", tcIn: "00:00:01", tcOut: "00:00:05", displayDurationSec: 4, credit: "AFP", rightsNote: null, linkStatus: "mort" },
    ] }),
    beat({ position: 2, estimatedDurationSec: 4, inserts: [] }),
  ], resolve);
  expect(c.totals).toEqual({ beatCount: 2, totalDurationSec: 7, insertCount: 2, deadLinkCount: 1 });
  expect(c.beats[0].inserts[1].mediaUrl).toBe("https://cdn.test/k2");
  expect(c.beats[0].inserts[1].linkLabel).toBe("Mort");
  expect(c.beats[0].inserts[0].kindLabel).toBe("Image");
});

test("interdit compte aussi comme lien mort ; breathRisk et checked exposés", () => {
  const long = "mot ".repeat(40);
  const c = buildConducteur([beat({ spokenText: long, montageCheckedAt: new Date(), inserts: [
    { id: "i", kind: "extrait", url: "http://x", r2Key: null, tcIn: null, tcOut: null, displayDurationSec: null, credit: null, rightsNote: null, linkStatus: "interdit" },
  ] })], resolve);
  expect(c.totals.deadLinkCount).toBe(1);
  expect(c.beats[0].breathRisk).toBe(true);
  expect(c.beats[0].checked).toBe(true);
});
```

- [ ] **Step 2: Lancer et vérifier l'échec**

Run: `bun test tests/video-rundown.test.ts`
Expected: FAIL — module introuvable.

- [ ] **Step 3: Écrire la projection**

Créer `lib/video/rundown.ts` :

```ts
import { BEAT_KIND_LABEL, INSERT_KIND_LABEL, LINK_STATUS_LABEL } from "@/lib/video/labels";
import { isBreathRisk } from "@/lib/video/duration";

export type RundownInsertInput = {
  id: string; kind: string; url: string | null; r2Key: string | null;
  tcIn: string | null; tcOut: string | null; displayDurationSec: number | null;
  credit: string | null; rightsNote: string | null; linkStatus: string;
};

export type RundownBeatInput = {
  position: number; kind: string; spokenText: string;
  directionNote: string | null; screenText: string | null;
  transitionIn: string | null; transitionOut: string | null;
  estimatedDurationSec: number; durationOverrideSec: number | null;
  speakerName: string | null; montageCheckedAt: Date | null;
  inserts: RundownInsertInput[];
};

export type ConducteurInsert = {
  id: string; kind: string; kindLabel: string; mediaUrl: string | null;
  tcIn: string | null; tcOut: string | null; displayDurationSec: number | null;
  credit: string | null; rightsNote: string | null; linkStatus: string; linkLabel: string;
};

export type ConducteurBeat = {
  position: number; kind: string; kindLabel: string; spokenText: string;
  directionNote: string | null; screenText: string | null;
  transitionIn: string | null; transitionOut: string | null;
  durationSec: number; breathRisk: boolean; speakerName: string | null;
  checked: boolean; inserts: ConducteurInsert[];
};

export type Conducteur = {
  beats: ConducteurBeat[];
  totals: { beatCount: number; totalDurationSec: number; insertCount: number; deadLinkCount: number };
};

const DEAD = new Set(["mort", "interdit"]);

export function buildConducteur(
  beats: RundownBeatInput[],
  resolveMedia: (url: string | null, r2Key: string | null) => string | null,
): Conducteur {
  const outBeats: ConducteurBeat[] = beats.map((b) => ({
    position: b.position,
    kind: b.kind,
    kindLabel: BEAT_KIND_LABEL[b.kind] ?? b.kind,
    spokenText: b.spokenText,
    directionNote: b.directionNote,
    screenText: b.screenText,
    transitionIn: b.transitionIn,
    transitionOut: b.transitionOut,
    durationSec: b.durationOverrideSec ?? b.estimatedDurationSec,
    breathRisk: isBreathRisk(b.spokenText),
    speakerName: b.speakerName,
    checked: b.montageCheckedAt !== null,
    inserts: b.inserts.map((ins) => ({
      id: ins.id,
      kind: ins.kind,
      kindLabel: INSERT_KIND_LABEL[ins.kind] ?? ins.kind,
      mediaUrl: resolveMedia(ins.url, ins.r2Key),
      tcIn: ins.tcIn,
      tcOut: ins.tcOut,
      displayDurationSec: ins.displayDurationSec,
      credit: ins.credit,
      rightsNote: ins.rightsNote,
      linkStatus: ins.linkStatus,
      linkLabel: LINK_STATUS_LABEL[ins.linkStatus] ?? ins.linkStatus,
    })),
  }));

  return {
    beats: outBeats,
    totals: {
      beatCount: outBeats.length,
      totalDurationSec: outBeats.reduce((s, b) => s + b.durationSec, 0),
      insertCount: outBeats.reduce((n, b) => n + b.inserts.length, 0),
      deadLinkCount: outBeats.reduce((n, b) => n + b.inserts.filter((i) => DEAD.has(i.linkStatus)).length, 0),
    },
  };
}
```

- [ ] **Step 4: Lancer et vérifier le succès**

Run: `bun test tests/video-rundown.test.ts`
Expected: PASS.

- [ ] **Step 5: Inscrire le test pur, typecheck, commit**

Ajouter `"video-rundown.test.ts"` au `PURE_FILES`.

Run: `bun run typecheck && bun run test:pure`

```bash
git add lib/video/rundown.ts tests/video-rundown.test.ts scripts/test-fast.ts
git commit -m "feat(video): projection pure du conducteur de montage"
```

---

## Task 3: Colonne `montage_checked_at` + cœur DB `readConducteurCore`

**Files:**
- Modify: `db/schema.ts` (ajouter `montageCheckedAt` à `scriptBeats`)
- Create: `db/migrations/00XX_*.sql` (généré)
- Create: `lib/montage/persist.ts`
- Test: `tests/montage-read-core.test.ts` (DB)

**Interfaces:**
- Consumes: `buildConducteur` (Task 2), `getStudioConfig`/`publicUrlFor` (`@/lib/storage/r2`, `@/lib/studio/config`), tables `scriptBeats`/`beatInserts`/`scriptVariants`/`videoProjects`.
- Produces: `readConducteurCore(variantId: string): Promise<{ projectId: string; variantId: string; conducteur: Conducteur } | null>`.

- [ ] **Step 1: Ajouter la colonne au schéma**

Dans `db/schema.ts`, table `scriptBeats`, ajouter après `locallyEditedAt` :

```ts
  montageCheckedAt: timestamp("montage_checked_at"),
```

- [ ] **Step 2: Générer et appliquer la migration**

Run: `bun run db:generate`
Expected: crée `00XX_*.sql` contenant `ALTER TABLE "script_beats" ADD COLUMN "montage_checked_at" timestamp;`. Vérifier qu'il ne contient QUE cet ADD COLUMN (aucune valeur d'enum). Puis :
Run: `bun run db:migrate`

- [ ] **Step 3: Écrire le test DB qui échoue**

Créer `tests/montage-read-core.test.ts`. Il insère projet→variante→beats→inserts, appelle `readConducteurCore`, vérifie l'ordre, les durées stockées, les totaux, la résolution média. Nettoyer en `afterAll`. Modèle :

```ts
import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, videoProjects, scriptVariants, scriptBeats, beatInserts } from "@/db";
import { readConducteurCore } from "@/lib/montage/persist";

const P = "test-montage-proj-1";
let variantId = "";

afterAll(async () => {
  await db.delete(videoProjects).where(eq(videoProjects.id, P));
});

test("readConducteurCore projette beats ordonnés, durées stockées et totaux", async () => {
  await db.insert(videoProjects).values({ id: P, title: "Test", subject: null }).onConflictDoNothing();
  const [v] = await db.insert(scriptVariants).values({ projectId: P, platform: "youtube_long", position: 0 }).returning();
  variantId = v.id;
  const [b1] = await db.insert(scriptBeats).values({ variantId, externalId: "b1", position: 0, kind: "narration", spokenText: "Bonjour", estimatedDurationSec: 5, durationOverrideSec: 12 }).returning();
  await db.insert(scriptBeats).values({ variantId, externalId: "b2", position: 1, kind: "broll", spokenText: "", estimatedDurationSec: 4 });
  await db.insert(beatInserts).values({ beatId: b1.id, kind: "image", url: "http://x/a.jpg", position: 0, linkStatus: "mort" });

  const res = await readConducteurCore(variantId);
  expect(res).not.toBeNull();
  expect(res!.projectId).toBe(P);
  expect(res!.conducteur.beats.map((b) => b.position)).toEqual([0, 1]);
  expect(res!.conducteur.beats[0].durationSec).toBe(12); // override stocké
  expect(res!.conducteur.totals).toMatchObject({ beatCount: 2, totalDurationSec: 16, insertCount: 1, deadLinkCount: 1 });
});

test("variante inconnue → null", async () => {
  expect(await readConducteurCore("00000000-0000-0000-0000-000000000000")).toBeNull();
});
```

- [ ] **Step 4: Lancer et vérifier l'échec**

Run: `bun test tests/montage-read-core.test.ts`
Expected: FAIL — module introuvable.

- [ ] **Step 5: Écrire le cœur DB**

Créer `lib/montage/persist.ts` :

```ts
// Cœur DB montage. Comme lib/video/persist.ts : PAS de "use server", accès @/db regroupé,
// gardé par les server actions ailleurs. Module pur interdit d'importer ceci.
import { and, asc, eq, inArray } from "drizzle-orm";
import { db, scriptVariants, videoProjects, scriptBeats, beatInserts, interviewSpeakers } from "@/db";
import { buildConducteur, type Conducteur, type RundownBeatInput } from "@/lib/video/rundown";
import { getStudioConfig } from "@/lib/studio/config";
import { publicUrlFor } from "@/lib/storage/r2";

function mediaResolver(): (url: string | null, r2Key: string | null) => string | null {
  const cfg = getStudioConfig();
  return (url, r2Key) => (cfg && r2Key ? publicUrlFor(cfg, r2Key) : url);
}

export async function readConducteurCore(
  variantId: string,
): Promise<{ projectId: string; variantId: string; conducteur: Conducteur } | null> {
  const [variant] = await db.select().from(scriptVariants).where(eq(scriptVariants.id, variantId));
  if (!variant) return null;
  const [project] = await db.select().from(videoProjects).where(eq(videoProjects.id, variant.projectId));
  if (!project) return null;

  const beats = await db.select().from(scriptBeats)
    .where(eq(scriptBeats.variantId, variantId))
    .orderBy(asc(scriptBeats.position));

  const speakerIds = beats.map((b) => b.speakerId).filter((x): x is string => !!x);
  const speakers = speakerIds.length
    ? await db.select().from(interviewSpeakers).where(inArray(interviewSpeakers.id, speakerIds))
    : [];
  const speakerName = new Map(speakers.map((s) => [s.id, s.name]));

  const beatIds = beats.map((b) => b.id);
  const inserts = beatIds.length
    ? await db.select().from(beatInserts).where(inArray(beatInserts.beatId, beatIds)).orderBy(asc(beatInserts.position))
    : [];
  const insertsByBeat = new Map<string, typeof inserts>();
  for (const ins of inserts) {
    const list = insertsByBeat.get(ins.beatId) ?? [];
    list.push(ins);
    insertsByBeat.set(ins.beatId, list);
  }

  const input: RundownBeatInput[] = beats.map((b) => ({
    position: b.position, kind: b.kind, spokenText: b.spokenText,
    directionNote: b.directionNote, screenText: b.screenText,
    transitionIn: b.transitionIn, transitionOut: b.transitionOut,
    estimatedDurationSec: b.estimatedDurationSec, durationOverrideSec: b.durationOverrideSec,
    speakerName: b.speakerId ? (speakerName.get(b.speakerId) ?? null) : null,
    montageCheckedAt: b.montageCheckedAt,
    inserts: (insertsByBeat.get(b.id) ?? []).map((ins) => ({
      id: ins.id, kind: ins.kind, url: ins.url, r2Key: ins.r2Key,
      tcIn: ins.tcIn, tcOut: ins.tcOut, displayDurationSec: ins.displayDurationSec,
      credit: ins.credit, rightsNote: ins.rightsNote, linkStatus: ins.linkStatus,
    })),
  }));

  return { projectId: project.id, variantId, conducteur: buildConducteur(input, mediaResolver()) };
}
```

- [ ] **Step 6: Lancer et vérifier le succès + typecheck**

Run: `bun test tests/montage-read-core.test.ts && bun run typecheck`
Expected: PASS + exit 0. NE PAS inscrire ce test au `PURE_FILES` (DB).

- [ ] **Step 7: Commit**

```bash
git add db/schema.ts db/migrations lib/montage/persist.ts tests/montage-read-core.test.ts
git commit -m "feat(montage): colonne montage_checked_at et cœur de lecture du conducteur"
```

---

## Task 4: Onglet Montage dans l'app + `conducteur-view`

**Files:**
- Create: `components/video/conducteur-view.tsx` (server-safe, lecture seule pour l'instant)
- Modify: `app/(app)/video/[id]/page.tsx` (4ᵉ onglet + chargement du conducteur)
- Test: `tests/conducteur-view.test.ts` (pur, `renderToStaticMarkup`)
- Modify: `scripts/test-fast.ts`

**Interfaces:**
- Consumes: `Conducteur` (Task 2), `readConducteurCore` (Task 3).
- Produces: `ConducteurView({ conducteur }: { conducteur: Conducteur })`.

- [ ] **Step 1: Écrire le test qui échoue**

Créer `tests/conducteur-view.test.ts` (motif `renderToStaticMarkup` + `React.createElement`, comme `tests/mcp-settings-ui.test.ts`) :

```ts
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { ConducteurView } from "@/components/video/conducteur-view";
import type { Conducteur } from "@/lib/video/rundown";

const conducteur: Conducteur = {
  beats: [{
    position: 0, kind: "narration", kindLabel: "Narration", spokenText: "Bonjour",
    directionNote: "Plan large", screenText: null, transitionIn: null, transitionOut: null,
    durationSec: 12, breathRisk: false, speakerName: null, checked: false,
    inserts: [{ id: "i1", kind: "image", kindLabel: "Image", mediaUrl: "http://x/a.jpg",
      tcIn: "00:00:01", tcOut: "00:00:05", displayDurationSec: 4, credit: "AFP", rightsNote: null,
      linkStatus: "mort", linkLabel: "Mort" }],
  }],
  totals: { beatCount: 1, totalDurationSec: 12, insertCount: 1, deadLinkCount: 1 },
};

test("affiche totaux, beat, insert et badge de lien", () => {
  const html = renderToStaticMarkup(createElement(ConducteurView, { conducteur }));
  expect(html).toContain("Narration");
  expect(html).toContain("Plan large");
  expect(html).toContain("Mort");
  expect(html).toContain("AFP");
});

test("état vide", () => {
  const empty: Conducteur = { beats: [], totals: { beatCount: 0, totalDurationSec: 0, insertCount: 0, deadLinkCount: 0 } };
  const html = renderToStaticMarkup(createElement(ConducteurView, { conducteur: empty }));
  expect(html).toContain("Aucun beat");
});
```

- [ ] **Step 2: Lancer et vérifier l'échec**

Run: `bun test tests/conducteur-view.test.ts`
Expected: FAIL — composant introuvable.

- [ ] **Step 3: Écrire le composant**

Créer `components/video/conducteur-view.tsx`. Server-safe (pas de `"use client"` — lecture seule ; les annotations seront ajoutées en Task 9). Utiliser un formatage de durée `mm:ss`. Structure :

```tsx
import type { Conducteur } from "@/lib/video/rundown";
import { Badge } from "@/components/ui/badge";

function fmt(sec: number): string {
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function ConducteurView({ conducteur }: { conducteur: Conducteur }) {
  const { beats, totals } = conducteur;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-4 rounded-lg border bg-muted/30 px-4 py-3 text-sm">
        <span>{totals.beatCount} beats</span>
        <span>Durée {fmt(totals.totalDurationSec)}</span>
        <span>{totals.insertCount} inserts</span>
        {totals.deadLinkCount > 0 && (
          <span className="text-destructive">{totals.deadLinkCount} lien(s) mort(s)</span>
        )}
      </div>

      {beats.length === 0 ? (
        <p className="text-sm text-muted-foreground">Aucun beat à monter pour l'instant.</p>
      ) : (
        <ol className="space-y-3">
          {beats.map((b) => (
            <li key={b.position} className="rounded-lg border px-4 py-3">
              <div className="flex items-center gap-2 text-sm">
                <span className="font-mono text-muted-foreground">#{b.position + 1}</span>
                <Badge variant="secondary">{b.kindLabel}</Badge>
                <span className="text-muted-foreground">{fmt(b.durationSec)}</span>
                {b.breathRisk && <Badge variant="outline">souffle</Badge>}
                {b.speakerName && <span className="text-muted-foreground">· {b.speakerName}</span>}
              </div>
              {b.spokenText && <p className="mt-2 text-sm">{b.spokenText}</p>}
              {b.directionNote && <p className="mt-1 text-xs text-muted-foreground">Réal. : {b.directionNote}</p>}
              {b.screenText && <p className="mt-1 text-xs text-muted-foreground">Écran : {b.screenText}</p>}
              {(b.transitionIn || b.transitionOut) && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Transition : {b.transitionIn ?? "—"} → {b.transitionOut ?? "—"}
                </p>
              )}
              {b.inserts.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {b.inserts.map((ins) => (
                    <li key={ins.id} className="flex flex-wrap items-center gap-2 text-xs">
                      <Badge variant="secondary">{ins.kindLabel}</Badge>
                      {(ins.tcIn || ins.tcOut) && <span className="font-mono">{ins.tcIn ?? "—"}–{ins.tcOut ?? "—"}</span>}
                      {ins.mediaUrl && <a href={ins.mediaUrl} className="underline" target="_blank" rel="noreferrer">média</a>}
                      {ins.credit && <span className="text-muted-foreground">© {ins.credit}</span>}
                      {ins.rightsNote && <span className="text-muted-foreground">droits : {ins.rightsNote}</span>}
                      <Badge variant={ins.linkStatus === "mort" || ins.linkStatus === "interdit" ? "destructive" : "outline"}>
                        {ins.linkLabel}
                      </Badge>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Câbler le 4ᵉ onglet dans la page projet**

Dans `app/(app)/video/[id]/page.tsx` :
1. Import : `import { ConducteurView } from "@/components/video/conducteur-view";` et `import { readConducteurCore } from "@/lib/montage/persist";`.
2. Après avoir résolu `activeVariant` (ligne ~62), charger le conducteur : `const conducteur = activeVariant ? (await readConducteurCore(activeVariant.id))?.conducteur ?? null : null;`. (Utiliser l'`id` de la variante active — vérifier son nom exact dans le fichier.)
3. Étendre le `defaultValue` du `<Tabs>` : `sp.tab === "montage" ? "montage" : sp.tab === "importer" ? "importer" : sp.tab === "ecriture" ? "ecriture" : "brief"`.
4. Ajouter dans `<TabsList>` : `<TabsTrigger value="montage">Montage</TabsTrigger>`.
5. Ajouter le contenu : `<TabsContent value="montage">{conducteur ? <ConducteurView conducteur={conducteur} /> : <p className="text-sm text-muted-foreground">Aucune variante.</p>}</TabsContent>`.

- [ ] **Step 5: Lancer les tests, inscrire le pur, typecheck**

Ajouter `"conducteur-view.test.ts"` au `PURE_FILES`.
Run: `bun test tests/conducteur-view.test.ts && bun run test:pure && bun run typecheck`
Expected: PASS + exit 0.

- [ ] **Step 6: Commit**

```bash
git add components/video/conducteur-view.tsx "app/(app)/video/[id]/page.tsx" tests/conducteur-view.test.ts scripts/test-fast.ts
git commit -m "feat(montage): onglet Montage et vue conducteur dans l'app"
```

---

## Task 5: Rôle Monteur + action `annotate`

**Files:**
- Modify: `db/schema.ts` (enum `userRole` + `monteur`)
- Create: `db/migrations/00XX_*.sql` (ALTER TYPE ADD VALUE)
- Modify: `lib/permissions.ts`, `lib/rbac.ts`, `lib/auth.ts`
- Test: `tests/rbac-monteur.test.ts` (pur)
- Modify: `scripts/test-fast.ts`

**Interfaces:**
- Produces: rôle `monteur` (video: read+annotate) ; action `video:annotate` ajoutée à editor/admin/monteur ; `Role` inclut `"monteur"`.

- [ ] **Step 1: Écrire le test qui échoue**

Créer `tests/rbac-monteur.test.ts` :

```ts
import { expect, test } from "bun:test";
import { can } from "@/lib/rbac";

test("monteur peut lire et annoter la vidéo, rien d'autre", () => {
  expect(can("monteur", "video", "read")).toBe(true);
  expect(can("monteur", "video", "annotate")).toBe(true);
  expect(can("monteur", "video", "manage")).toBe(false);
  expect(can("monteur", "article", "read")).toBe(false);
});

test("éditeur et admin peuvent annoter ; journaliste non", () => {
  expect(can("editor", "video", "annotate")).toBe(true);
  expect(can("admin", "video", "annotate")).toBe(true);
  expect(can("journalist", "video", "annotate")).toBe(false);
});
```

- [ ] **Step 2: Lancer et vérifier l'échec**

Run: `bun test tests/rbac-monteur.test.ts`
Expected: FAIL — `can("monteur", …)` faux / action inconnue.

- [ ] **Step 3: Ajouter la valeur d'enum et générer la migration**

Dans `db/schema.ts` ligne 43 : `export const userRole = pgEnum("user_role", ["admin", "editor", "journalist", "monteur"]);`
Run: `bun run db:generate`
Expected: crée `00XX_*.sql` contenant UNIQUEMENT `ALTER TYPE "public"."user_role" ADD VALUE 'monteur';`. Vérifier qu'aucune autre instruction ne référence `'monteur'`. Puis `bun run db:migrate`.

- [ ] **Step 4: Étendre permissions, rbac, Role**

`lib/auth.ts` : `export type Role = "admin" | "editor" | "journalist" | "monteur";`

`lib/permissions.ts` :
- Dans `statement`, la ressource `video` gagne `"annotate"` : `video: ["read", "manage", "configure", "annotate"]`.
- Nouveau rôle : `export const monteur = ac.newRole({ video: ["read", "annotate"] });` (suivre la forme exacte des rôles existants).
- Ajouter `annotate` aux rôles `editor` et `admin` (pas `journalist`).
- Vérifier où `ac`/les rôles sont branchés dans `lib/auth.ts` (`adminPlugin({ roles: {...} })`) et y ajouter `monteur`.

`lib/rbac.ts` : dans `MATRIX`, ajouter `monteur: { video: ["read", "annotate"] }` ; ajouter `"annotate"` à `video` pour `editor` et `admin` ; ajouter `ROLE_LABEL.monteur = "Monteur"`.

- [ ] **Step 5: Lancer les tests, inscrire le pur, typecheck**

Ajouter `"rbac-monteur.test.ts"` au `PURE_FILES`.
Run: `bun test tests/rbac-monteur.test.ts && bun run test:pure && bun run typecheck`
Expected: PASS + exit 0.

- [ ] **Step 6: Commit**

```bash
git add db/schema.ts db/migrations lib/permissions.ts lib/rbac.ts lib/auth.ts tests/rbac-monteur.test.ts scripts/test-fast.ts
git commit -m "feat(montage): rôle Monteur et action video:annotate"
```

---

## Task 6: Table `montage_shares` + jeton de partage + résolution

**Files:**
- Modify: `db/schema.ts` (table `montageShares`)
- Create: `db/migrations/00XX_*.sql`
- Create: `lib/montage/token.ts` (pur)
- Create: `lib/montage/access.ts` (cœur DB)
- Test: `tests/montage-token.test.ts` (pur), `tests/montage-access-core.test.ts` (DB)
- Modify: `scripts/test-fast.ts`

**Interfaces:**
- Produces:
  - `token.ts` : `SHARE_NAMESPACE = "afro_montage_"`, `generateShareToken()`, `hashShareToken`, `sharePrefixOf`, `shareTokenMatches`.
  - `access.ts` : `resolveShare(rawToken): Promise<{ ok: true; projectId: string; shareId: string } | { ok: false }>`, `createShareCore({ projectId, userId, expiresAt }): Promise<{ id: string; token: string }>`, `revokeShareCore({ shareId, userId, seesAll }): Promise<{ ok: boolean; message?: string }>`, `listSharesCore(projectId): Promise<ShareRow[]>`, type `ShareRow`.

- [ ] **Step 1: Ajouter la table au schéma**

Dans `db/schema.ts`, après `apiTokens` :

```ts
export const montageShares = pgTable("montage_shares", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => videoProjects.id, { onDelete: "cascade" }),
  tokenPrefix: text("token_prefix").notNull(),
  tokenHash: text("token_hash").notNull(),
  createdBy: text("created_by").references(() => user.id),
  expiresAt: timestamp("expires_at"),
  revokedAt: timestamp("revoked_at"),
  lastAccessedAt: timestamp("last_accessed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("montage_shares_prefix_uq").on(t.tokenPrefix),
  index("montage_shares_project_idx").on(t.projectId),
]);
```

Run: `bun run db:generate` (crée `00XX_*.sql` CREATE TABLE + FK + index) puis `bun run db:migrate`.

- [ ] **Step 2: Écrire le test pur du jeton (échoue)**

Créer `tests/montage-token.test.ts` :

```ts
import { expect, test } from "bun:test";
import { generateShareToken, hashShareToken, sharePrefixOf, shareTokenMatches, SHARE_NAMESPACE } from "@/lib/montage/token";

test("génère un jeton namespacé avec préfixe et hash", () => {
  const { token, prefix, tokenHash } = generateShareToken();
  expect(token.startsWith(SHARE_NAMESPACE)).toBe(true);
  expect(prefix).toBe(token.slice(0, prefix.length));
  expect(tokenHash).toBe(hashShareToken(token));
});

test("prefixOf rejette un jeton étranger", () => {
  expect(sharePrefixOf("afro_vid_xxxxxx")).toBeNull();
  expect(sharePrefixOf(SHARE_NAMESPACE)).toBeNull(); // trop court
});

test("match constant", () => {
  const { token, tokenHash } = generateShareToken();
  expect(shareTokenMatches(token, tokenHash)).toBe(true);
  expect(shareTokenMatches(token + "x", tokenHash)).toBe(false);
});
```

- [ ] **Step 3: Écrire `token.ts` (miroir de `lib/mcp/token.ts`)**

Créer `lib/montage/token.ts` :

```ts
import { createHash, randomBytes } from "node:crypto";
import { safeEqual } from "@/lib/timing-safe";

export const SHARE_NAMESPACE = "afro_montage_";
export const SHARE_PREFIX_LENGTH = SHARE_NAMESPACE.length + 6;

export function hashShareToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function generateShareToken(): { token: string; prefix: string; tokenHash: string } {
  const token = SHARE_NAMESPACE + randomBytes(32).toString("base64url");
  return { token, prefix: token.slice(0, SHARE_PREFIX_LENGTH), tokenHash: hashShareToken(token) };
}

export function sharePrefixOf(token: string): string | null {
  if (!token.startsWith(SHARE_NAMESPACE)) return null;
  if (token.length <= SHARE_PREFIX_LENGTH) return null;
  return token.slice(0, SHARE_PREFIX_LENGTH);
}

export function shareTokenMatches(token: string, storedHash: string): boolean {
  if (!storedHash) return false;
  return safeEqual(hashShareToken(token), storedHash);
}
```

Run: `bun test tests/montage-token.test.ts` → PASS.

- [ ] **Step 4: Écrire `access.ts` (cœur DB)**

Créer `lib/montage/access.ts` :

```ts
import { and, desc, eq } from "drizzle-orm";
import { db, montageShares, user } from "@/db";
import { generateShareToken, sharePrefixOf, shareTokenMatches } from "@/lib/montage/token";

export type ShareRow = {
  id: string; projectId: string; createdByName: string | null;
  expiresAt: Date | null; revokedAt: Date | null; lastAccessedAt: Date | null; createdAt: Date;
};

export async function resolveShare(
  rawToken: string,
): Promise<{ ok: true; projectId: string; shareId: string } | { ok: false }> {
  const prefix = sharePrefixOf(rawToken);
  if (!prefix) return { ok: false };
  const [row] = await db.select().from(montageShares).where(eq(montageShares.tokenPrefix, prefix)).limit(1);
  if (!row) return { ok: false };
  if (row.revokedAt) return { ok: false };
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return { ok: false };
  if (!shareTokenMatches(rawToken, row.tokenHash)) return { ok: false };
  await db.update(montageShares).set({ lastAccessedAt: new Date() }).where(eq(montageShares.id, row.id));
  return { ok: true, projectId: row.projectId, shareId: row.id };
}

export async function createShareCore(
  { projectId, userId, expiresAt }: { projectId: string; userId: string; expiresAt: Date | null },
): Promise<{ id: string; token: string }> {
  const { token, prefix, tokenHash } = generateShareToken();
  const [row] = await db.insert(montageShares)
    .values({ projectId, tokenPrefix: prefix, tokenHash, createdBy: userId, expiresAt })
    .returning({ id: montageShares.id });
  return { id: row.id, token };
}

export async function revokeShareCore(
  { shareId, userId, seesAll }: { shareId: string; userId: string; seesAll: boolean },
): Promise<{ ok: boolean; message?: string }> {
  const [row] = await db.select().from(montageShares).where(eq(montageShares.id, shareId)).limit(1);
  if (!row) return { ok: false, message: "Lien introuvable." };
  if (!seesAll && row.createdBy !== userId) return { ok: false, message: "Vous ne pouvez révoquer que vos propres liens." };
  await db.update(montageShares).set({ revokedAt: new Date() }).where(eq(montageShares.id, shareId));
  return { ok: true };
}

export async function listSharesCore(projectId: string): Promise<ShareRow[]> {
  return db.select({
    id: montageShares.id, projectId: montageShares.projectId, createdByName: user.name,
    expiresAt: montageShares.expiresAt, revokedAt: montageShares.revokedAt,
    lastAccessedAt: montageShares.lastAccessedAt, createdAt: montageShares.createdAt,
  }).from(montageShares)
    .leftJoin(user, eq(user.id, montageShares.createdBy))
    .where(eq(montageShares.projectId, projectId))
    .orderBy(desc(montageShares.createdAt));
}
```

Note : `resolveShare` utilise `Date.now()` — c'est un cœur DB (pas un module pur), l'usage est autorisé (contrairement aux modules purs testés dans la voie rapide).

- [ ] **Step 5: Écrire le test DB de `access.ts`**

Créer `tests/montage-access-core.test.ts` : insère un projet, `createShareCore` → `resolveShare(token)` ok → `revokeShareCore` → `resolveShare` renvoie `{ ok:false }` ; teste aussi l'expiration (créer avec `expiresAt` passé → `resolveShare` false). Nettoyer en `afterAll` (supprimer le projet cascade les partages). Utiliser des ids `test-montage-share-*`.

- [ ] **Step 6: Lancer, inscrire le pur, typecheck, commit**

Ajouter `"montage-token.test.ts"` au `PURE_FILES` (PAS `montage-access-core.test.ts`).
Run: `bun test tests/montage-token.test.ts tests/montage-access-core.test.ts && bun run test:pure && bun run typecheck`

```bash
git add db/schema.ts db/migrations lib/montage/token.ts lib/montage/access.ts tests/montage-token.test.ts tests/montage-access-core.test.ts scripts/test-fast.ts
git commit -m "feat(montage): table de partage, jeton signé et résolution"
```

---

## Task 7: Server actions de partage + panneau « Accès monteur »

**Files:**
- Create: `lib/actions/montage-actions.ts` (`"use server"`)
- Create: `components/video/montage-share-panel.tsx` (`"use client"`)
- Modify: `app/(app)/video/[id]/page.tsx` (monter le panneau dans l'onglet Montage, charger `listSharesCore`, calculer l'URL de base)
- Test: `tests/montage-share-panel.test.ts` (pur)
- Modify: `scripts/test-fast.ts`

**Interfaces:**
- Consumes: `createShareCore`/`revokeShareCore`/`listSharesCore` (Task 6), `requireUser`, `requirePermission`, `can`.
- Produces: `createShareLink(input: { projectId: string; expiresAt: string | null }): Promise<{ ok: true; url: string } | { ok: false; message: string }>`, `revokeShareLink(shareId: string): Promise<{ ok: boolean; message?: string }>`.

- [ ] **Step 1: Écrire les server actions**

Créer `lib/actions/montage-actions.ts`. Garde `video:manage` pour créer/révoquer un lien. L'URL renvoyée = base publique + `/montage/<token>`. Base = `process.env.BETTER_AUTH_URL ?? ""`.

```ts
"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/session";
import { requirePermission, can } from "@/lib/rbac";
import { createShareCore, revokeShareCore } from "@/lib/montage/access";

const createSchema = z.object({
  projectId: z.string().uuid(),
  expiresAt: z.string().datetime().nullable(),
});

export async function createShareLink(
  input: { projectId: string; expiresAt: string | null },
): Promise<{ ok: true; url: string } | { ok: false; message: string }> {
  const u = await requireUser();
  requirePermission(u.role, "video", "manage");
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Entrée invalide." };
  const { token } = await createShareCore({
    projectId: parsed.data.projectId,
    userId: u.id,
    expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null,
  });
  revalidatePath("/video/[id]", "page");
  const base = process.env.BETTER_AUTH_URL ?? "";
  return { ok: true, url: `${base}/montage/${token}` };
}

export async function revokeShareLink(shareId: string): Promise<{ ok: boolean; message?: string }> {
  const u = await requireUser();
  requirePermission(u.role, "video", "manage");
  const seesAll = can(u.role, "video", "configure");
  const res = await revokeShareCore({ shareId, userId: u.id, seesAll });
  if (res.ok) revalidatePath("/video/[id]", "page");
  return res;
}
```

- [ ] **Step 2: Écrire le panneau (miroir de `token-list.tsx`)**

Créer `components/video/montage-share-panel.tsx` (`"use client"`). Reprendre le motif de `components/settings/mcp/token-list.tsx` : bouton « Créer un lien » (option d'expiration via `<input type="date">` facultatif) → affiche l'URL complète **une seule fois** dans un encart d'avertissement (« Copiez ce lien — il ne sera plus affiché »), liste les liens (`ShareRow[]`) avec statut (actif / expiré / révoqué), dernier accès, et bouton Révoquer via `ConfirmDialog` destructif. Utiliser `useTransition`, `toast` (sonner), `router.refresh()`. Props : `{ projectId: string; shares: ShareRow[]; canManage: boolean }`.

Le test (Step 4) vérifie le rendu de la liste et l'état vide — écrire le composant pour satisfaire : afficher « Aucun lien monteur » si vide, le statut et « Révoquer » sinon.

- [ ] **Step 3: Écrire le test du panneau (pur)**

Créer `tests/montage-share-panel.test.ts` (motif `renderToStaticMarkup` + `createElement`) : rendre `MontageSharePanel` avec un `ShareRow` actif → attend le bouton « Révoquer » et un libellé de statut ; rendre vide → attend « Aucun lien monteur ».

- [ ] **Step 4: Monter le panneau dans l'onglet Montage**

Dans `app/(app)/video/[id]/page.tsx` : importer `listSharesCore`, `MontageSharePanel`, `can` ; charger `const shares = await listSharesCore(projectId)` (le `projectId` du projet courant) ; dans `<TabsContent value="montage">`, rendre le panneau au-dessus du conducteur, réservé à `video:manage` : `{can(user.role, "video", "manage") && <MontageSharePanel projectId={project.id} shares={shares} canManage />}`.

- [ ] **Step 5: Lancer, inscrire le pur, typecheck, commit**

Ajouter `"montage-share-panel.test.ts"` au `PURE_FILES`.
Run: `bun test tests/montage-share-panel.test.ts && bun run test:pure && bun run typecheck`

```bash
git add lib/actions/montage-actions.ts components/video/montage-share-panel.tsx "app/(app)/video/[id]/page.tsx" tests/montage-share-panel.test.ts scripts/test-fast.ts
git commit -m "feat(montage): création/révocation de liens monteur et panneau"
```

---

## Task 8: Route publique du monteur

**Files:**
- Create: `app/(public)/layout.tsx`
- Create: `app/(public)/montage/[token]/page.tsx`
- Test: `tests/montage-public-route.test.ts` (DB — vérifie le rejet d'un jeton invalide/révoqué)

**Interfaces:**
- Consumes: `resolveShare` (Task 6), `getVideoProject`-like lecture de la variante, `readConducteurCore` (Task 3), `ConducteurView` (Task 4).

- [ ] **Step 1: Créer le layout public (sans auth)**

Créer `app/(public)/layout.tsx` — layout minimal SANS `requireUser`, sans chrome d'app :

```tsx
export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-3xl px-4 py-8">{children}</div>;
}
```

- [ ] **Step 2: Créer la page monteur**

Créer `app/(public)/montage/[token]/page.tsx` (Server Component, PAS de `requireUser`). Résout le jeton, charge la variante en tête du projet, rend le conducteur.

```tsx
import { asc, eq } from "drizzle-orm";
import { db, scriptVariants, videoProjects } from "@/db";
import { resolveShare } from "@/lib/montage/access";
import { readConducteurCore } from "@/lib/montage/persist";
import { ConducteurView } from "@/components/video/conducteur-view";

export default async function MontagePublicPage(
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const share = await resolveShare(token);
  if (!share.ok) {
    return <p className="text-sm text-muted-foreground">Lien invalide ou expiré.</p>;
  }
  const [project] = await db.select().from(videoProjects).where(eq(videoProjects.id, share.projectId));
  const [variant] = await db.select().from(scriptVariants)
    .where(eq(scriptVariants.projectId, share.projectId)).orderBy(asc(scriptVariants.position)).limit(1);
  if (!project || !variant) {
    return <p className="text-sm text-muted-foreground">Projet indisponible.</p>;
  }
  const read = await readConducteurCore(variant.id);
  return (
    <div className="space-y-4">
      <h1 className="font-serif text-2xl">{project.title}</h1>
      {read ? <ConducteurView conducteur={read.conducteur} /> : <p>Aucun conducteur.</p>}
    </div>
  );
}
```

- [ ] **Step 3: Écrire le test d'intégration (DB)**

Créer `tests/montage-public-route.test.ts` : importe le `default` de la page, appelle avec un `params` résolvant un jeton révoqué/inexistant → attend le rendu « Lien invalide ou expiré » (via `renderToStaticMarkup` du JSX retourné, ou en vérifiant la string). Pour un jeton valide : insérer projet+variante+partage, rendre, attendre le titre du projet. Nettoyer en `afterAll`. (Ce test touche la DB → voie lente.)

- [ ] **Step 4: Vérifier + commit**

Run: `bun test tests/montage-public-route.test.ts && bun run typecheck && bun run build`
Expected: PASS + build résout `/montage/[token]` HORS `(app)` (pas de redirection login). Confirmer dans la sortie de build que la route `/montage/[token]` existe.

```bash
git add "app/(public)" tests/montage-public-route.test.ts
git commit -m "feat(montage): page publique du monteur par lien signé"
```

---

## Task 9: Annotations (beat coché, lien mort) journalisées

**Files:**
- Modify: `db/schema.ts` (enum `scriptJournalSource` + `monteur`)
- Create: `db/migrations/00XX_*.sql` (ALTER TYPE ADD VALUE)
- Modify: `lib/montage/persist.ts` (cœurs d'annotation)
- Modify: `lib/actions/montage-actions.ts` (actions app + jeton)
- Create: `components/video/conducteur-annotations.tsx` (`"use client"`, contrôles)
- Modify: `components/video/conducteur-view.tsx` (accepter des contrôles optionnels), `app/(public)/montage/[token]/page.tsx` (passer le jeton), `app/(app)/video/[id]/page.tsx` (activer les contrôles si `video:annotate`)
- Test: `tests/montage-annotate-core.test.ts` (DB)

**Interfaces:**
- Produces (dans `lib/montage/persist.ts`):
  - `toggleBeatCheckedCore({ beatId, projectId }): Promise<{ checked: boolean }>` — bascule `montageCheckedAt`, vérifie que le beat appartient à `projectId`, journalise.
  - `flagInsertDeadCore({ insertId, projectId }): Promise<void>` — passe `linkStatus='mort'`, vérifie l'appartenance, journalise.
  - Les deux throw `RefusalError` si le beat/insert n'appartient pas à `projectId`.
- Produces (dans `montage-actions.ts`): `toggleBeatChecked(input)`, `flagInsertDead(input)` — deux voies d'autorisation : session `video:annotate` OU jeton de partage (résolu, projet imposé).

- [ ] **Step 1: Ajouter la valeur d'enum + migration**

`db/schema.ts` ligne 653 : `export const scriptJournalSource = pgEnum("script_journal_source", ["copier_coller", "mcp", "manuel", "monteur"]);`
Run: `bun run db:generate` → `00XX_*.sql` avec UNIQUEMENT `ALTER TYPE "public"."script_journal_source" ADD VALUE 'monteur';` (aucune référence à la valeur). Puis `bun run db:migrate`.

- [ ] **Step 2: Écrire le test DB des cœurs (échoue)**

Créer `tests/montage-annotate-core.test.ts` : insère projet→variante→beat→insert ; `toggleBeatCheckedCore` bascule (null→date→null) et écrit une ligne `script_journal` `source='monteur'` ; `flagInsertDeadCore` passe l'insert à `mort` + journal ; un beat/insert d'un AUTRE projet → `RefusalError`. Nettoyer en `afterAll`.

- [ ] **Step 3: Écrire les cœurs d'annotation**

Dans `lib/montage/persist.ts`, ajouter (respecter l'ordre de verrou `script_variants < script_beats < beat_inserts` ; ici on touche un seul beat/insert par appel) :

```ts
import { RefusalError } from "@/lib/video/persist"; // réutiliser le signal de refus métier
// (si l'import croisé pose souci, définir un RefusalError local identique — vérifier d'abord.)
import { scriptJournal } from "@/db";

async function beatBelongsToProject(beatId: string, projectId: string): Promise<{ id: string; variantId: string } | null> {
  const [row] = await db.select({ id: scriptBeats.id, variantId: scriptBeats.variantId, projectId: scriptVariants.projectId })
    .from(scriptBeats)
    .innerJoin(scriptVariants, eq(scriptVariants.id, scriptBeats.variantId))
    .where(and(eq(scriptBeats.id, beatId), eq(scriptVariants.projectId, projectId)))
    .limit(1);
  return row ? { id: row.id, variantId: row.variantId } : null;
}

export async function toggleBeatCheckedCore(
  { beatId, projectId, actorUserId }: { beatId: string; projectId: string; actorUserId: string | null },
): Promise<{ checked: boolean }> {
  const beat = await beatBelongsToProject(beatId, projectId);
  if (!beat) throw new RefusalError("Beat introuvable pour ce projet.");
  const [cur] = await db.select({ at: scriptBeats.montageCheckedAt }).from(scriptBeats).where(eq(scriptBeats.id, beatId));
  const next = cur?.at ? null : new Date();
  await db.update(scriptBeats).set({ montageCheckedAt: next }).where(eq(scriptBeats.id, beatId));
  await db.insert(scriptJournal).values({
    projectId, variantId: beat.variantId, source: "monteur", toolName: "toggle_beat_checked",
    actorUserId, outcome: "applique", diff: { beatId, checked: next !== null },
  });
  return { checked: next !== null };
}

export async function flagInsertDeadCore(
  { insertId, projectId, actorUserId }: { insertId: string; projectId: string; actorUserId: string | null },
): Promise<void> {
  const [row] = await db.select({ id: beatInserts.id, variantId: scriptBeats.variantId, projectId: scriptVariants.projectId })
    .from(beatInserts)
    .innerJoin(scriptBeats, eq(scriptBeats.id, beatInserts.beatId))
    .innerJoin(scriptVariants, eq(scriptVariants.id, scriptBeats.variantId))
    .where(and(eq(beatInserts.id, insertId), eq(scriptVariants.projectId, projectId)))
    .limit(1);
  if (!row) throw new RefusalError("Insert introuvable pour ce projet.");
  await db.update(beatInserts).set({ linkStatus: "mort", linkCheckedAt: new Date() }).where(eq(beatInserts.id, insertId));
  await db.insert(scriptJournal).values({
    projectId, variantId: row.variantId, source: "monteur", toolName: "flag_insert_dead",
    actorUserId, outcome: "applique", diff: { insertId, linkStatus: "mort" },
  });
}
```

Note : vérifier que `RefusalError` est bien exporté par `lib/video/persist.ts` (il l'est, ligne 34) ; l'importer évite une divergence. `scriptJournal.outcome` exige une valeur de `scriptJournalOutcome` — `"applique"` convient.

- [ ] **Step 4: Écrire les server actions (deux voies d'auth)**

Dans `lib/actions/montage-actions.ts`, ajouter. La voie app exige `video:annotate` ; la voie jeton résout le partage et IMPOSE son `projectId`.

```ts
import { resolveShare } from "@/lib/montage/access";
import { toggleBeatCheckedCore, flagInsertDeadCore } from "@/lib/montage/persist";

async function annotateAuth(
  input: { shareToken?: string; projectId?: string },
): Promise<{ projectId: string; actorUserId: string | null } | { error: string }> {
  if (input.shareToken) {
    const share = await resolveShare(input.shareToken);
    if (!share.ok) return { error: "Lien invalide ou expiré." };
    return { projectId: share.projectId, actorUserId: null };
  }
  const u = await requireUser();
  requirePermission(u.role, "video", "annotate");
  if (!input.projectId) return { error: "Projet manquant." };
  return { projectId: input.projectId, actorUserId: u.id };
}

export async function toggleBeatChecked(
  input: { beatId: string; projectId?: string; shareToken?: string },
): Promise<{ ok: true; checked: boolean } | { ok: false; message: string }> {
  const auth = await annotateAuth(input);
  if ("error" in auth) return { ok: false, message: auth.error };
  try {
    const res = await toggleBeatCheckedCore({ beatId: input.beatId, projectId: auth.projectId, actorUserId: auth.actorUserId });
    return { ok: true, checked: res.checked };
  } catch (e) {
    if (e instanceof (await import("@/lib/video/persist")).RefusalError) return { ok: false, message: (e as Error).message };
    throw e;
  }
}

export async function flagInsertDead(
  input: { insertId: string; projectId?: string; shareToken?: string },
): Promise<{ ok: boolean; message?: string }> {
  const auth = await annotateAuth(input);
  if ("error" in auth) return { ok: false, message: auth.error };
  try {
    await flagInsertDeadCore({ insertId: input.insertId, projectId: auth.projectId, actorUserId: auth.actorUserId });
    return { ok: true };
  } catch (e) {
    if (e instanceof (await import("@/lib/video/persist")).RefusalError) return { ok: false, message: (e as Error).message };
    throw e;
  }
}
```

(Si le `await import` dynamique du `RefusalError` gêne, importer `RefusalError` en tête statiquement — les deux marchent.)

- [ ] **Step 5: Contrôles d'annotation dans la vue**

Créer `components/video/conducteur-annotations.tsx` (`"use client"`) : un bouton « Monté » (bascule) par beat et un bouton « Signaler lien mort » par insert, appelant `toggleBeatChecked`/`flagInsertDead` avec `useTransition` + `toast` + `router.refresh()`. Props : `{ beatId?: string; insertId?: string; projectId?: string; shareToken?: string; checked?: boolean }`.

Modifier `ConducteurView` pour accepter une prop optionnelle `annotate?: { projectId?: string; shareToken?: string }` ; quand présente, rendre les contrôles à côté de chaque beat/insert. Sans la prop, la vue reste en lecture seule (les tests existants passent toujours).

Câbler :
- `app/(app)/video/[id]/page.tsx` : passer `annotate={{ projectId: project.id }}` au `ConducteurView` de l'onglet Montage **si** `can(user.role, "video", "annotate")`.
- `app/(public)/montage/[token]/page.tsx` : passer `annotate={{ shareToken: token }}`.

- [ ] **Step 6: Vérifier + commit**

Run: `bun test tests/montage-annotate-core.test.ts && bun run test:pure && bun run typecheck`
Expected: PASS + exit 0. (Les tests purs de `conducteur-view` doivent toujours passer — la prop `annotate` est optionnelle.)

```bash
git add db/schema.ts db/migrations lib/montage/persist.ts lib/actions/montage-actions.ts components/video "app/(app)/video/[id]/page.tsx" "app/(public)/montage/[token]/page.tsx" tests/montage-annotate-core.test.ts
git commit -m "feat(montage): annotations monteur (beat monté, lien mort) journalisées"
```

---

## Task 10: Exports — imprimable, CSV/JSON, manifeste

**Files:**
- Create: `app/(public)/montage/[token]/print/page.tsx` (vue imprimable)
- Create: `lib/montage/export.ts` (sérialisation pure CSV/JSON/manifeste)
- Create: `app/api/montage/export/route.ts` (handler paramétré session OU jeton)
- Modify: `components/video/conducteur-view.tsx` (liens d'export) — optionnel via prop
- Test: `tests/montage-export.test.ts` (pur)
- Modify: `scripts/test-fast.ts`

**Interfaces:**
- Produces (`lib/montage/export.ts`, pur) :
  - `toShotListCsv(conducteur: Conducteur): string`
  - `toShotListJson(conducteur: Conducteur): unknown`
  - `toMediaManifest(conducteur: Conducteur): { media: {...}[] }`

- [ ] **Step 1: Écrire le test pur des sérialiseurs (échoue)**

Créer `tests/montage-export.test.ts` : construit un `Conducteur` (comme le test de Task 4), vérifie que `toShotListCsv` produit un en-tête `beat_position,beat_kind,duration_sec,insert_kind,tc_in,tc_out,media_url,credit,rights,link_status` + une ligne par insert (et une ligne beat sans insert) ; que les valeurs contenant une virgule/guillemet sont échappées ; que `toMediaManifest` ne liste que les inserts avec `mediaUrl`.

- [ ] **Step 2: Écrire les sérialiseurs (pur)**

Créer `lib/montage/export.ts` avec `toShotListCsv`/`toShotListJson`/`toMediaManifest`. CSV : échappement RFC 4180 (entourer de guillemets si virgule/guillemet/retour ligne ; doubler les guillemets). Une ligne par insert ; un beat sans insert → une ligne avec colonnes insert vides.

- [ ] **Step 3: Écrire le handler d'export (session OU jeton)**

Créer `app/api/montage/export/route.ts` — `GET` avec query `?variantId=…&format=csv|json|manifest` (interne, `requireUser` + `video:read`) OU `?token=…&format=…` (public, `resolveShare` → variante en tête du projet). Génère via `readConducteurCore` + les sérialiseurs. `Content-Disposition: attachment; filename="conducteur.<ext>"`. Le token ne donne accès qu'à SON projet.

```ts
import { asc, eq } from "drizzle-orm";
import { db, scriptVariants } from "@/db";
import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";
import { resolveShare } from "@/lib/montage/access";
import { readConducteurCore } from "@/lib/montage/persist";
import { toShotListCsv, toShotListJson, toMediaManifest } from "@/lib/montage/export";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const format = url.searchParams.get("format") ?? "csv";
  const token = url.searchParams.get("token");

  let variantId = url.searchParams.get("variantId");
  if (token) {
    const share = await resolveShare(token);
    if (!share.ok) return new Response("Lien invalide", { status: 404 });
    const [v] = await db.select().from(scriptVariants).where(eq(scriptVariants.projectId, share.projectId)).orderBy(asc(scriptVariants.position)).limit(1);
    variantId = v?.id ?? null;
  } else {
    const u = await requireUser();
    requirePermission(u.role, "video", "read");
  }
  if (!variantId) return new Response("Variante introuvable", { status: 404 });

  const read = await readConducteurCore(variantId);
  if (!read) return new Response("Conducteur introuvable", { status: 404 });

  if (format === "json") {
    return Response.json(toShotListJson(read.conducteur), {
      headers: { "Content-Disposition": 'attachment; filename="conducteur.json"' },
    });
  }
  if (format === "manifest") {
    return Response.json(toMediaManifest(read.conducteur), {
      headers: { "Content-Disposition": 'attachment; filename="medias.json"' },
    });
  }
  return new Response(toShotListCsv(read.conducteur), {
    headers: { "content-type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="conducteur.csv"' },
  });
}
```

- [ ] **Step 4: Vue imprimable (PDF)**

Créer `app/(public)/montage/[token]/print/page.tsx` : comme la page monteur mais avec une feuille de style `@media print` masquant tout sauf le conducteur, et un `<style>` global d'impression (ou une classe `print:*`). L'utilisateur imprime → « Enregistrer en PDF ». Rendre `ConducteurView` en lecture seule. Ajouter aussi, dans l'onglet Montage in-app, un lien « Version imprimable » et des liens d'export CSV/JSON/manifeste (pointant sur `/api/montage/export?variantId=…&format=…` en interne, et `?token=…` sur la page publique).

- [ ] **Step 5: Vérifier, inscrire le pur, commit**

Ajouter `"montage-export.test.ts"` au `PURE_FILES`.
Run: `bun test tests/montage-export.test.ts && bun run test:pure && bun run typecheck && bun run build`
Expected: PASS + build inclut `/api/montage/export` et `/montage/[token]/print`.

```bash
git add lib/montage/export.ts app/api/montage "app/(public)/montage/[token]/print" components/video "app/(app)/video/[id]/page.tsx" tests/montage-export.test.ts scripts/test-fast.ts
git commit -m "feat(montage): exports conducteur (imprimable, CSV/JSON, manifeste)"
```

---

## Task 11: Vérification finale

**Files:** aucun (vérification).

- [ ] **Step 1: Suite pure + typecheck + build**

Run: `bun run typecheck && bun run test:pure && bun run build`
Expected: exit 0 partout. Le build résout : onglet Montage, `/montage/[token]`, `/montage/[token]/print`, `/api/montage/export`.

- [ ] **Step 2: Tests DB ciblés**

Run: `bun test tests/montage-read-core.test.ts tests/montage-access-core.test.ts tests/montage-annotate-core.test.ts tests/montage-public-route.test.ts`
Expected: PASS (nettoyage inclus). Ne pas lancer `bun test` complet (voie lente, infra-flaky).

- [ ] **Step 3: Preuve manuelle**

Ce que les tests ne couvrent pas — vérifier dans le navigateur :
1. Onglet Montage d'un projet : totaux, beats, inserts, badges de lien.
2. Créer un lien monteur (URL affichée une fois) → l'ouvrir en navigation privée (non connecté) → le conducteur s'affiche, PAS de redirection login.
3. Sur la page publique : cocher un beat, signaler un lien mort → l'app reflète le changement ; une entrée `script_journal` `source='monteur'` existe.
4. Révoquer le lien → la page publique affiche « Lien invalide ou expiré ».
5. Un lien d'un projet A ne peut ni lire ni annoter un beat du projet B (tenter un `beatId` étranger via l'action → refus).
6. Exports : imprimable (→ PDF navigateur), CSV, JSON, manifeste — chacun ne contient que le projet du jeton.
7. Un utilisateur de rôle `monteur` connecté voit l'onglet Montage et peut annoter, mais pas gérer les liens (`video:manage` requis).

- [ ] **Step 4: État du dépôt**

Run: `git status` (propre) puis `git log --oneline main..HEAD`.

---

## Self-Review (à l'écriture)

- **Couverture spec :** projection pure (T2) ✓ ; cœur + durées stockées + résolution R2 (T3) ✓ ; vue in-app (T4) ✓ ; rôle Monteur + annotate (T5) ✓ ; lien signé haché + résolution révocation/expiration (T6) ✓ ; gestion des liens (T7) ✓ ; route publique hors `(app)` (T8) ✓ ; annotations journalisées + portée jeton stricte (T9) ✓ ; 3 exports session-ou-jeton (T10) ✓ ; libellés monteur du linkStatus (T1) ✓. Les 4 migrations enum-sûres (colonne T3, `user_role` T5, table T6, `script_journal_source` T9) sont isolées de toute référence à la valeur ajoutée.
- **Placeholders :** aucun ; code réel à chaque étape de logique/cœur ; les composants UI reprennent un motif existant nommé (`token-list.tsx`) avec le rendu clé fourni et un test qui contraint le résultat.
- **Cohérence des types :** `Conducteur`/`ConducteurBeat`/`RundownBeatInput` définis en T2 et consommés tels quels en T3/T4/T10 ; `resolveShare`→`{projectId,shareId}` consommé en T8/T9/T10 ; `RefusalError` réutilisé de `lib/video/persist.ts` en T9 ; `ShareRow` défini en T6, consommé en T7. Convention de durée `durationOverrideSec ?? estimatedDurationSec` identique partout, jamais recalculée.

Voir [[video-module-roadmap]] et [[execution-mode-subagent-driven]].
