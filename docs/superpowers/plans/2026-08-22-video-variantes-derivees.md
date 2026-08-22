# Variantes dérivées & cadrages (SP6) — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dériver une variante d'un script par copie profonde indépendante (beats + inserts + liens Q/R remappés), gérer les variantes (dériver / supprimer une dérivée), et afficher un guide de zone sûre selon le ratio.

**Architecture:** Un cœur `deriveVariantCore` (copie profonde en une transaction, nouveaux ids, `answersBeatId` remappé) et `deleteVariantCore` (origine protégée), des actions gardées, un `variant-manager` dans l'onglet Écriture, et un `aspect-ratio-guide` visuel. Aucune migration.

**Tech Stack:** Next.js, Drizzle/Postgres, shadcn/ui, `bun test`. Aucune dépendance nouvelle.

**Spec:** `docs/superpowers/specs/2026-08-22-video-variantes-derivees-design.md`

## Global Constraints

- **Copie UI en français.**
- **AUCUNE migration.** `scriptVariants.derivedFromId` (uuid nu), `aspectRatio`, `scriptBeats.framing` existent déjà. Aucun enum ajouté.
- **Dériver = copie profonde indépendante** : nouveaux ids partout. Copié : beats (`externalId`, position, kind, spokenText, directionNote, screenText, transitionIn/Out, estimatedDurationSec, durationOverrideSec, `framing`, `speakerId`, `sources`) + `beat_inserts` (kind, url, r2Key, tc, displayDurationSec, credit, rightsNote, linkStatus, linkCheckedAt, position). **`answersBeatId` REMAPPÉ** via une map old→new. **EXCLU** : `selectedTakeId`, `montageCheckedAt`, `importedSnapshot`, `locallyEditedAt`, `beat_takes`, journal.
- **Unicité `(projectId, position)`** sur `script_variants` → la dérivée prend `max(position)+1` (motif `prepareImportCore`).
- **Suppression = dérivées uniquement** : `derivedFromId` nul (origine) → refus. Cascade DB pour les enfants. `derivedFromId` pendouillant après suppression : toléré (uuid logique, pas de FK).
- **Ordre de verrou** `script_variants` d'abord (FOR UPDATE) dans les deux cœurs.
- **Cores** sans `"use server"` (`lib/video/variants-persist.ts`), importent `@/db`, réutilisent `RefusalError`. **Actions** = `export async function` (leçon SP4), `guard()` = `video:manage`, `refusable`, `revalidateVideo`.
- **Rafraîchissement** : `revalidateVideo()` suffit (doctrine `speakers-manager`) SAUF la dérivation (navigue vers la nouvelle variante) et la suppression de la variante active (navigue vers l'origine) — via `router.push`.
- **Tests purs** dans `PURE_FILES`. Tests DB : voie lente, UUID valides, nettoyage.

---

## File Structure

| Fichier | Rôle | Action |
|---|---|---|
| `lib/validation.ts` | Schémas | Modifier — `deriveVariantSchema`, `variantIdSchema` |
| `lib/video/variants-persist.ts` | Cœurs dérive/suppression | Créer |
| `lib/actions/video-actions.ts` | Actions | Modifier — `deriveVariant`, `deleteVariant` |
| `components/video/variant-manager.tsx` | Gestion des variantes (client) | Créer |
| `components/video/aspect-ratio-guide.tsx` | Guide de zone sûre (pur) | Créer |
| `components/video/tournage-view.tsx` | Prop `aspectRatio` + guide | Modifier |
| `app/(app)/video/[id]/page.tsx` | Monter VariantManager + guide + prop tournage | Modifier |
| `scripts/test-fast.ts` | Allowlist tests purs | Modifier |

---

## Task 1: Schémas + cœurs dérive / suppression

**Files:**
- Modify: `lib/validation.ts`
- Create: `lib/video/variants-persist.ts`
- Test: `tests/variants-core.test.ts` (DB)

**Interfaces:**
- Produces: `deriveVariantCore({ sourceVariantId, platform, aspectRatio, targetDurationSec }): Promise<{ variantId: string }>` ; `deleteVariantCore({ variantId }): Promise<void>` ; schémas `deriveVariantSchema`/`variantIdSchema`.

- [ ] **Step 1: Ajouter les schémas**

Dans `lib/validation.ts` :

```ts
export const deriveVariantSchema = z.object({
  sourceVariantId: z.string().uuid(),
  platform: z.enum(["youtube_long", "youtube_short", "tiktok", "reel", "interview"]),
  aspectRatio: z.enum(["16:9", "9:16", "1:1"]),
  targetDurationSec: z.number().int().min(5).max(14400).nullable(),
});

export const variantIdSchema = z.object({ variantId: z.string().uuid("Identifiant invalide") });
```

- [ ] **Step 2: Écrire le test DB qui échoue**

Créer `tests/variants-core.test.ts` (UUID valides, `afterAll` nettoyage) :

```ts
import { afterAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db, videoProjects, scriptVariants, scriptBeats, beatInserts, interviewSpeakers } from "@/db";
import { deriveVariantCore, deleteVariantCore } from "@/lib/video/variants-persist";

const P = "00000000-0000-0000-0000-0000000006a1";
afterAll(async () => { await db.delete(videoProjects).where(eq(videoProjects.id, P)); });

test("dérive une copie profonde (beats+inserts, answersBeatId remappé, speaker préservé)", async () => {
  await db.insert(videoProjects).values({ id: P, title: "T", subject: null }).onConflictDoNothing();
  const [src] = await db.insert(scriptVariants).values({ projectId: P, platform: "youtube_long", position: 0, aspectRatio: "16:9" }).returning();
  const [sp] = await db.insert(interviewSpeakers).values({ projectId: P, name: "Awa" }).returning();
  const [q] = await db.insert(scriptBeats).values({ variantId: src.id, externalId: "q1", position: 0, kind: "question", spokenText: "Q" }).returning();
  const [r] = await db.insert(scriptBeats).values({ variantId: src.id, externalId: "r1", position: 1, kind: "reponse", spokenText: "R", answersBeatId: q.id, speakerId: sp.id }).returning();
  await db.insert(beatInserts).values({ beatId: r.id, kind: "image", url: "http://x/a.jpg", position: 0 });

  const { variantId } = await deriveVariantCore({ sourceVariantId: src.id, platform: "reel", aspectRatio: "9:16", targetDurationSec: 60 });

  const [nv] = await db.select().from(scriptVariants).where(eq(scriptVariants.id, variantId));
  expect(nv.derivedFromId).toBe(src.id);
  expect(nv.position).toBe(1);
  expect(nv.aspectRatio).toBe("9:16");

  const nBeats = await db.select().from(scriptBeats).where(eq(scriptBeats.variantId, variantId));
  expect(nBeats.length).toBe(2);
  const nq = nBeats.find((b) => b.externalId === "q1")!;
  const nr = nBeats.find((b) => b.externalId === "r1")!;
  expect(nq.id).not.toBe(q.id);                 // nouveaux ids
  expect(nr.answersBeatId).toBe(nq.id);         // remappé vers le beat COPIÉ, pas la source
  expect(nr.speakerId).toBe(sp.id);             // speaker (projet) préservé
  const nIns = await db.select().from(beatInserts).where(eq(beatInserts.beatId, nr.id));
  expect(nIns.length).toBe(1);
  expect(nIns[0].url).toBe("http://x/a.jpg");
  // La source est inchangée.
  expect((await db.select().from(scriptBeats).where(eq(scriptBeats.variantId, src.id))).length).toBe(2);
});

test("supprime une dérivée ; refuse l'origine", async () => {
  const [src] = await db.select().from(scriptVariants).where(and(eq(scriptVariants.projectId, P), eq(scriptVariants.position, 0)));
  await expect(deleteVariantCore({ variantId: src.id })).rejects.toThrow(); // origine protégée
  const [derived] = await db.select().from(scriptVariants).where(and(eq(scriptVariants.projectId, P), eq(scriptVariants.position, 1)));
  await deleteVariantCore({ variantId: derived.id });
  expect((await db.select().from(scriptVariants).where(eq(scriptVariants.id, derived.id))).length).toBe(0);
});
```

- [ ] **Step 3: Lancer et vérifier l'échec**

Run: `bun test tests/variants-core.test.ts --timeout 20000` → FAIL (module absent).

- [ ] **Step 4: Écrire le cœur**

Créer `lib/video/variants-persist.ts` :

```ts
import { asc, eq, inArray } from "drizzle-orm";
import { db, scriptVariants, scriptBeats, beatInserts } from "@/db";
import { RefusalError } from "@/lib/video/persist";

export async function deriveVariantCore(
  input: { sourceVariantId: string; platform: string; aspectRatio: string; targetDurationSec: number | null },
): Promise<{ variantId: string }> {
  return db.transaction(async (tx) => {
    const [source] = await tx.select({ id: scriptVariants.id, projectId: scriptVariants.projectId })
      .from(scriptVariants).where(eq(scriptVariants.id, input.sourceVariantId)).for("update");
    if (!source) throw new RefusalError("Variante source introuvable.");

    const variants = await tx.select({ position: scriptVariants.position }).from(scriptVariants)
      .where(eq(scriptVariants.projectId, source.projectId));
    const position = variants.reduce((max, v) => Math.max(max, v.position), -1) + 1;

    const [nv] = await tx.insert(scriptVariants).values({
      projectId: source.projectId,
      platform: input.platform as (typeof scriptVariants.$inferInsert)["platform"],
      aspectRatio: input.aspectRatio,
      targetDurationSec: input.targetDurationSec,
      position,
      derivedFromId: input.sourceVariantId,
    }).returning({ id: scriptVariants.id });

    const srcBeats = await tx.select().from(scriptBeats)
      .where(eq(scriptBeats.variantId, input.sourceVariantId)).orderBy(asc(scriptBeats.position));

    const idMap = new Map<string, string>();
    for (const b of srcBeats) {
      const [row] = await tx.insert(scriptBeats).values({
        variantId: nv.id, externalId: b.externalId, position: b.position, kind: b.kind,
        spokenText: b.spokenText, directionNote: b.directionNote, screenText: b.screenText,
        transitionIn: b.transitionIn, transitionOut: b.transitionOut,
        estimatedDurationSec: b.estimatedDurationSec, durationOverrideSec: b.durationOverrideSec,
        framing: b.framing, speakerId: b.speakerId, sources: b.sources,
        // EXCLUS : answersBeatId (remappé plus bas), selectedTakeId, montageCheckedAt, importedSnapshot, locallyEditedAt.
      }).returning({ id: scriptBeats.id });
      idMap.set(b.id, row.id);
    }

    // Remap des liens Q/R vers les beats copiés.
    for (const b of srcBeats) {
      if (!b.answersBeatId) continue;
      const target = idMap.get(b.answersBeatId);
      const newId = idMap.get(b.id);
      if (target && newId) {
        await tx.update(scriptBeats).set({ answersBeatId: target }).where(eq(scriptBeats.id, newId));
      }
    }

    // Copie des inserts.
    const srcIds = srcBeats.map((b) => b.id);
    if (srcIds.length > 0) {
      const inserts = await tx.select().from(beatInserts)
        .where(inArray(beatInserts.beatId, srcIds)).orderBy(asc(beatInserts.position));
      for (const ins of inserts) {
        const newBeatId = idMap.get(ins.beatId);
        if (!newBeatId) continue;
        await tx.insert(beatInserts).values({
          beatId: newBeatId, kind: ins.kind, url: ins.url, r2Key: ins.r2Key,
          tcIn: ins.tcIn, tcOut: ins.tcOut, displayDurationSec: ins.displayDurationSec,
          credit: ins.credit, rightsNote: ins.rightsNote, linkStatus: ins.linkStatus,
          linkCheckedAt: ins.linkCheckedAt, position: ins.position,
        });
      }
    }

    return { variantId: nv.id };
  });
}

export async function deleteVariantCore(input: { variantId: string }): Promise<void> {
  await db.transaction(async (tx) => {
    const [v] = await tx.select({ id: scriptVariants.id, derivedFromId: scriptVariants.derivedFromId })
      .from(scriptVariants).where(eq(scriptVariants.id, input.variantId)).for("update");
    if (!v) throw new RefusalError("Variante introuvable.");
    if (v.derivedFromId === null) throw new RefusalError("La variante d'origine ne peut pas être supprimée.");
    await tx.delete(scriptVariants).where(eq(scriptVariants.id, input.variantId));
  });
}
```

- [ ] **Step 5: Lancer et vérifier + typecheck**

Run: `bun test tests/variants-core.test.ts --timeout 20000 && bun run typecheck`
Expected: PASS + exit 0. NON inscrit au `PURE_FILES` (DB).

- [ ] **Step 6: Commit**

```bash
git add lib/validation.ts lib/video/variants-persist.ts tests/variants-core.test.ts
git commit -m "feat(video): cœurs de dérivation et suppression de variante"
```

---

## Task 2: Actions + gestionnaire de variantes

**Files:**
- Modify: `lib/actions/video-actions.ts`
- Create: `components/video/variant-manager.tsx` (`"use client"`)
- Modify: `app/(app)/video/[id]/page.tsx` (remplacer le bloc de badges)
- Test: `tests/variant-manager.test.ts` (pur)
- Modify: `scripts/test-fast.ts`

**Interfaces:**
- Consumes: `deriveVariantCore`/`deleteVariantCore` (Task 1), schémas (Task 1), `PLATFORM_LABEL`.
- Produces: actions `deriveVariant`/`deleteVariant` ; composant `VariantManager`.

- [ ] **Step 1: Écrire les actions**

Dans `lib/actions/video-actions.ts`, ajouter aux imports `deriveVariantSchema, variantIdSchema` (`@/lib/validation`) et `deriveVariantCore, deleteVariantCore` (`@/lib/video/variants-persist`). Puis (motif `createSpeaker`/`deleteSpeaker`, **`export async function`**) :

```ts
export async function deriveVariant(input: unknown): Promise<{ ok: true; variantId: string } | { ok: false; message: string }> {
  await guard();
  const parsed = deriveVariantSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Entrée invalide." };
  const res = await refusable(() => deriveVariantCore(parsed.data));
  if (!res.ok) return res;
  revalidateVideo();
  return { ok: true, variantId: res.value.variantId };
}

export async function deleteVariant(input: unknown): Promise<{ ok: true } | { ok: false; message: string }> {
  await guard();
  const parsed = variantIdSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Entrée invalide." };
  const res = await refusable(() => deleteVariantCore({ variantId: parsed.data.variantId }));
  if (!res.ok) return res;
  revalidateVideo();
  return { ok: true };
}
```

- [ ] **Step 2: Écrire le test du composant (échoue)**

Créer `tests/variant-manager.test.ts` (motif `renderToStaticMarkup` + `createElement` + mock `next/navigation` comme `tests/variant-manager`/`insert-row` — le composant utilise `useRouter`). Rendre `VariantManager` avec deux variantes (une origine `derivedFromId: null`, une dérivée) → attendre : les libellés de plateforme, un marqueur « dérivée » sur la dérivée, le bouton « Dériver une variante », et un bouton « Supprimer » présent UNIQUEMENT pour la dérivée (pas pour l'origine). Inscrire `"variant-manager.test.ts"` au `PURE_FILES`.

- [ ] **Step 3: Écrire le composant**

Créer `components/video/variant-manager.tsx` (`"use client"`), motif de `components/video/speakers-manager.tsx` (Card + Dialog + ConfirmDialog + useTransition + toast), MAIS avec navigation (`useRouter().push`) pour la dérivation et la suppression de la variante active. Props :

```ts
type VariantRow = { id: string; platform: string; aspectRatio: string; derivedFromId: string | null; position: number };
export function VariantManager({ projectId, variants, activeVariantId }: {
  projectId: string; variants: VariantRow[]; activeVariantId: string | null;
}) { … }
```

Éléments requis (contraints par le test) :
- Les variantes en badges : `PLATFORM_LABEL[v.platform] ?? v.platform` + ` · ${v.aspectRatio}`, badge « default » si `v.id === activeVariantId` sinon « outline », lien `href={`/video/${projectId}?tab=ecriture&variant=${v.id}`}`. Marqueur « dérivée » (petit texte/badge secondaire) si `v.derivedFromId !== null`.
- Bouton **« Dériver une variante »** → un `Dialog` (select plateforme parmi `PLATFORMS`+`PLATFORM_LABEL`, select ratio `["16:9","9:16","1:1"]`, input durée cible optionnel). Sur validation : `startSaving(async () => { const res = await deriveVariant({ sourceVariantId: activeVariantId, platform, aspectRatio, targetDurationSec }); if (!res.ok) { toast.error(res.message); return; } toast.success("Variante dérivée."); router.push(`/video/${projectId}?tab=ecriture&variant=${res.variantId}`); })`. (Refuser si `activeVariantId` est nul.)
- Sur chaque variante **dérivée** (`derivedFromId !== null`) : un `ConfirmDialog` destructif « Supprimer » → `deleteVariant({ variantId: v.id })` ; sur succès `toast.success` ET si `v.id === activeVariantId` `router.push(`/video/${projectId}?tab=ecriture`)` (retombe sur l'origine), sinon rien (revalidate gère). Pas de bouton Supprimer sur l'origine.

Utiliser les mêmes imports que `speakers-manager.tsx` (`Dialog*`, `Button`, `Badge`, `ConfirmDialog`, `toast`, `useTransition`, `useState`) + `useRouter` de `next/navigation`, `PLATFORM_LABEL` de `@/lib/video/labels`, `PLATFORMS` de `@/lib/video/schema`.

- [ ] **Step 4: Monter dans la page**

Dans `app/(app)/video/[id]/page.tsx`, remplacer le bloc `{project.variants.length > 1 && (…badges…)}` (dans `<TabsContent value="ecriture">`) par :

```tsx
<VariantManager
  projectId={project.id}
  variants={project.variants.map((v) => ({ id: v.id, platform: v.platform, aspectRatio: v.aspectRatio, derivedFromId: v.derivedFromId, position: v.position }))}
  activeVariantId={activeVariant?.id ?? null}
/>
```

Importer `VariantManager` ; retirer l'import `Link`/`Badge` s'ils ne servent plus ailleurs (les garder sinon). Le VariantManager s'affiche même avec une seule variante (pour exposer « Dériver »).

- [ ] **Step 5: Lancer, inscrire le pur, typecheck**

Ajouter `"variant-manager.test.ts"` au `PURE_FILES`.
Run: `bun test tests/variant-manager.test.ts && bun run test:pure && bun run typecheck`
Expected: PASS + exit 0.

- [ ] **Step 6: Commit**

```bash
git add lib/actions/video-actions.ts components/video/variant-manager.tsx "app/(app)/video/[id]/page.tsx" tests/variant-manager.test.ts scripts/test-fast.ts
git commit -m "feat(video): actions et gestionnaire de variantes dérivées"
```

---

## Task 3: Guide de zone sûre (cadrage)

**Files:**
- Create: `components/video/aspect-ratio-guide.tsx`
- Modify: `components/video/tournage-view.tsx` (prop `aspectRatio` + guide), `app/(app)/video/[id]/page.tsx` (guide Écriture + prop tournage)
- Test: `tests/aspect-ratio-guide.test.ts` (pur)
- Modify: `scripts/test-fast.ts`

**Interfaces:**
- Produces: `AspectRatioGuide({ ratio }: { ratio: string })`.

- [ ] **Step 1: Écrire le test (échoue)**

Créer `tests/aspect-ratio-guide.test.ts` (`renderToStaticMarkup` + `createElement`) : rendre `AspectRatioGuide` avec `ratio="9:16"` → attendre que le libellé « 9:16 » apparaisse et un `<svg>` ; avec `ratio="16:9"` → « 16:9 ». Vérifier qu'un ratio inconnu ne casse pas (rend le libellé brut). Inscrire au `PURE_FILES`.

- [ ] **Step 2: Écrire le composant**

Créer `components/video/aspect-ratio-guide.tsx` (server-safe, pas de `"use client"`) : un petit schéma SVG du cadre selon `ratio` (rectangle paysage pour `16:9`, portrait pour `9:16`, carré pour `1:1`) avec une **zone sûre** esquissée (un rectangle interne en pointillés), le libellé du ratio, et une note courte adaptée (ex. `9:16` → « Gardez l'action dans la zone centrale verticale. »). Dimensions modestes (ex. hauteur ~80px). Un `ratio` inconnu affiche le libellé brut sans casser.

- [ ] **Step 3: Câbler dans la page (Écriture) et le tournage**

- `app/(app)/video/[id]/page.tsx` :
  - Importer `AspectRatioGuide`.
  - Dans l'onglet Écriture, rendre `{activeVariant && <AspectRatioGuide ratio={activeVariant.aspectRatio} />}` près du `VariantManager`.
  - Passer le ratio au tournage : `<TournageView projectId={project.id} status={tournage.status} beats={tournage.beats} aspectRatio={activeVariant.aspectRatio} />` (activeVariant est non nul si `tournage` l'est).
- `components/video/tournage-view.tsx` :
  - `TournageView` gagne une prop `aspectRatio: string`.
  - Importer `AspectRatioGuide` et le rendre dans l'en-tête du **prompteur** (`PrompteurMode` reçoit `aspectRatio` en prop depuis `TournageView`) — un petit guide au-dessus/à côté du texte. (Le passer à `PrompteurMode`.)

- [ ] **Step 4: Lancer, inscrire le pur, typecheck**

Ajouter `"aspect-ratio-guide.test.ts"` au `PURE_FILES`.
Run: `bun test tests/aspect-ratio-guide.test.ts && bun run test:pure && bun run typecheck`
Expected: PASS + exit 0. (Les tests existants de `tournage-view` doivent toujours passer — la nouvelle prop `aspectRatio` doit avoir un défaut sûr OU les tests être mis à jour ; vérifier `tests/tournage-view.test.ts` et adapter si besoin.)

- [ ] **Step 5: Commit**

```bash
git add components/video/aspect-ratio-guide.tsx components/video/tournage-view.tsx "app/(app)/video/[id]/page.tsx" tests/aspect-ratio-guide.test.ts scripts/test-fast.ts
git commit -m "feat(video): guide de zone sûre selon le ratio (cadrage)"
```

---

## Task 4: Vérification finale

**Files:** aucun.

- [ ] **Step 1: Suite pure + typecheck + build**

Run: `bun run typecheck && bun run test:pure && bun run build`
Expected: exit 0 partout ; le build résout la page projet.

- [ ] **Step 2: Confirmer l'absence de migration**

Run: `bun run db:generate`
Expected: « nothing to migrate ». Sinon s'arrêter et rapporter.

- [ ] **Step 3: Tests DB ciblés**

Run: `bun test tests/variants-core.test.ts --timeout 25000`
Expected: PASS.

- [ ] **Step 4: Preuve manuelle**

1. Onglet Écriture : « Dériver une variante » → choisir Reel / 9:16 → la nouvelle variante apparaît en badge et devient active (URL `?variant=`) ; ses beats + inserts sont copiés ; éditer un beat de la dérivée n'affecte pas l'original.
2. Sur un projet interview : les liens Q/R et les locuteurs sont préservés dans la dérivée (le conducteur affiche le locuteur, la réponse pointe la bonne question de la dérivée).
3. Supprimer la variante dérivée → retour sur l'origine ; l'origine n'a pas de bouton Supprimer (protégée).
4. Le guide de zone sûre reflète le ratio (16:9 paysage, 9:16 portrait) dans Écriture et le prompteur.
5. Les prises (tournage) de l'original ne sont PAS copiées dans la dérivée.

- [ ] **Step 4: État du dépôt**

Run: `git status` (propre) ; `git log --oneline main..HEAD`.

---

## Self-Review (à l'écriture)

- **Couverture spec :** copie profonde beats+inserts, nouveaux ids, `answersBeatId` remappé, `speakerId` préservé, exclusion tournage/montage (T1) ✓ ; position suivante + unicité (T1) ✓ ; suppression dérivée seule, origine protégée (T1) ✓ ; actions gardées `async function` (T2) ✓ ; gestionnaire de variantes + dériver + supprimer (T2) ✓ ; guide de zone sûre Écriture + prompteur (T3) ✓ ; aucune migration ✓ ; lecteurs existants inchangés (scopés `activeVariant`) ✓.
- **Placeholders :** aucun ; code réel pour cœurs/schémas ; l'UI reprend les motifs nommés (`speakers-manager`, `ConfirmDialog`) avec tests contraignants.
- **Cohérence des types :** `deriveVariantCore`/`deleteVariantCore` (T1) consommés par les actions (T2) ; `VariantRow` (T2) construit depuis `project.variants` (déjà `derivedFromId`/`aspectRatio`) ; `AspectRatioGuide({ratio})` (T3) consommé par Écriture + tournage ; `TournageView` gagne `aspectRatio` (T3, défaut sûr ou tests adaptés).

Voir [[video-module-roadmap]] et [[execution-mode-subagent-driven]]. **Dernier des 8 sous-projets du module Vidéo.**
