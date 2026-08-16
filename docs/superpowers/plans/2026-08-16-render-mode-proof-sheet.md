# Refonte du mode « Rendu réel » — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remplacer le mode « Rendu réel » (grande case + bande de 7 vignettes de 112px) par une planche de contrôle des 8 formats, dont chaque tuile ouvre une vue d'inspection zoomable et exportable — en corrigeant au passage le « fit » cassé, le double chrome, les deux modèles de fraîcheur, l'incohérence article, l'absence de mémoïsation et l'absence de responsive.

**Architecture:** `render-mode.tsx` devient un routeur mince entre deux nouveaux composants (`render/proof-sheet.tsx`, `render/format-focus.tsx`) au-dessus d'une barre d'outils partagée. Le cœur réseau de `preview-pane.tsx` est extrait en un hook sans UI (`hooks/use-preview.ts`) adossé à un cache LRU pur en portée module (`lib/studio/preview-cache.ts`), ce qui donne un seul chemin de rendu, un seul modèle de fraîcheur et une mémo qui survit au démontage du mode.

**Tech Stack:** Next.js (App Router) · React 19 · TypeScript · Tailwind v4 · base-ui (`components/ui/*`) · `bun test` + `react-dom/server` (rendu statique) · Server Action `previewTemplate` → satori/resvg/sharp.

**Spec:** `docs/superpowers/specs/2026-08-16-render-mode-redesign-design.md`

## Global Constraints

- **Toute copie visible par l'utilisateur est en français.** Ce dépôt n'a pas d'i18n : les libellés sont écrits en dur, en français, dans le JSX. Suivre le ton des fichiers voisins.
- **DESIGN.md est normatif** : accent terracotta réservé aux actions primaires (*The Actions-Only Rule*) ; séparation par filet `ring-1 ring-foreground/10` et bascule tonale, **jamais d'ombre au repos** (*The Hairline-Not-Shadow Rule*) ; neutres chauds uniquement ; `Lora` réservé aux titres éditoriaux — **tout le chrome d'UI reste en Inter** ; boutons compacts 32px par défaut.
- **`--canvas-backdrop`** est la surface d'atelier du studio ; la planche s'y pose.
- **Aucune nouvelle dépendance npm.** En particulier : pas de `jszip`, pas de librairie de zoom/pan.
- **`previewTemplate` (`lib/actions/studio-preview-actions.ts`) reste le seul appel réseau de l'aperçu.** Aucun chemin ne doit écrire `renders` ni un objet R2. Cette garantie est testée structurellement — voir Tâche 3.
- **Tout nouveau fichier de test doit être ajouté à `PURE_FILES` dans `scripts/test-fast.ts`** (l'allowlist de la voie parallèle), sinon il retombe silencieusement dans la voie DB, lente et sérielle.
- **Commande d'itération : `bun run test:pure`.** La suite complète (`bun test`) touche une base Neon partagée et est lente ; aucune tâche de ce plan n'en a besoin sauf mention explicite.
- **Convention d'amorces de test** : les états post-réseau se testent via des props `initial*` fournies **uniquement** par les tests, jamais par la composition réelle. `react-dom/server` n'exécute aucun effet — sans ces amorces, un test ne peut pas atteindre ces états. Étendre cette convention, ne pas la remplacer.
- **Ne jamais affaiblir un test existant pour faire passer une refonte.** Si l'extraction casse la garantie structurelle de `tests/studio-preview.test.ts`, c'est l'extraction qui est fautive.

## Écarts assumés par rapport à la spec

Trois points où l'implémentation diverge du document approuvé, chacun vers une solution plus simple **et** plus correcte. Ils sont listés ici pour que la spec et le plan ne divergent pas en silence.

1. **§3 — le `ResizeObserver` disparaît.** La spec prévoyait de calculer l'échelle « fit » en JS. Inutile : le défaut n°2 venait de la boîte `aspectRatio` **plus** l'enveloppe `width:100%;height:100%`. Une fois ces deux règles supprimées, un simple `object-contain` dans un conteneur `flex-1 min-h-0` ajuste correctement, sans mesure. Le mode « fit » est donc du CSS pur ; seul le zoom explicite pose des pixels.
2. **§3 — le zoom continu devient une échelle discrète.** `ZOOM_STEPS = [0.1, 0.25, 0.5, 0.75, 1]`. Un zoom continu partant de « fit » exigerait de connaître l'échelle de fit en JS, ce que l'écart n°1 vient de rendre inutile. Une échelle discrète est prévisible, testable **purement**, et suffit à l'usage déclaré (inspecter la typo).
3. **§5 — la pastille d'agrégation ouvre le premier format signalé au lieu de faire défiler jusqu'à sa tuile.** Supprime tout le câblage de `ref` entre la barre d'outils et la grille, et sert mieux l'intention : on veut regarder le problème, pas seulement sa vignette.

## Structure des fichiers

| Fichier | Responsabilité | Tâche |
|---|---|---|
| `lib/studio/preview-cache.ts` | **créé** — clé de cache + LRU bornée en octets. Pur, sans DOM. | 1 |
| `lib/studio/studio-mode.ts` | **modifié** — `focusedFormat`, `formatNavAction`, `zoomStep` ; contrat de `selectedId` réécrit. | 2 |
| `lib/studio/relayout.ts` | **modifié** — accueille `sceneForFormat` (déplacée depuis `render-mode.tsx`, qui deviendrait sinon une dépendance circulaire de ses propres enfants). | 2 |
| `hooks/use-preview.ts` | **créé** — cœur sans UI de l'aperçu : différé, garde anti-périmé, cache, `enabled`. | 3 |
| `components/studio/preview-pane.tsx` | **modifié** — réécrit autour du hook ; sortie et `data-testid` inchangés ; `onResult` supprimé (devenu mort). | 3 |
| `components/studio/render/proof-sheet.tsx` | **créé** — la grille des 8 tuiles. | 4 |
| `components/studio/render/format-focus.tsx` | **créé** — un format, zoomable, exportable. | 5 |
| `components/studio/render-mode.tsx` | **réécrit** — routeur planche ⇄ focus + barre d'outils (article, actualiser, agrégat d'alertes). | 6 |
| `components/studio/render/export.ts` | **créé** — nom de fichier et orchestration des téléchargements séquentiels. | 7 |
| `components/studio/editor-shell.tsx` | **modifié** — `too-small` ne garde plus que Montage ; `ModeSwitch` reste monté. | 8 |
| `components/studio/mode-switch.tsx` | **modifié** — côté Montage désactivable. | 8 |

---

### Task 1: Cache d'aperçu (pur)

**Files:**
- Create: `lib/studio/preview-cache.ts`
- Create: `tests/studio-preview-cache.test.ts`
- Modify: `scripts/test-fast.ts` (ajouter le fichier de test à `PURE_FILES`)

**Interfaces:**
- Consumes: `Scene` (`lib/studio/scene.ts`), `FormatKey` (`lib/studio/formats.ts`).
- Produces:
  - `previewCacheKey(templateId: string, scene: Scene, format: FormatKey | undefined, articleId: string | null | undefined): string`
  - `type CachedPreview = { dataUri: string; degraded: boolean; overflowingLayerIds: string[]; lowResLayerIds: string[] }`
  - `interface PreviewCache { get(k): CachedPreview | undefined; set(k, v): void; delete(k): void; clear(): void; bytes(): number; keys(): string[] }`
  - `createPreviewCache(maxBytes: number): PreviewCache`
  - `PREVIEW_CACHE_MAX_BYTES: number` (48 Mo)
  - `previewCache: PreviewCache` (l'instance partagée, portée module)

- [ ] **Step 1: Écrire le test qui échoue**

Créer `tests/studio-preview-cache.test.ts` :

```ts
import { describe, it, expect } from "bun:test";
import {
  previewCacheKey, createPreviewCache, PREVIEW_CACHE_MAX_BYTES, previewCache,
  type CachedPreview,
} from "@/lib/studio/preview-cache";
import { parseScene, type Scene } from "@/lib/studio/scene";

// tests/studio-preview-cache.test.ts — le mémo client de l'aperçu (refonte Rendu réel, §4 de la
// spec). PUR : aucun DOM, aucune base, aucun réseau — ce fichier appartient à la voie parallèle
// (scripts/test-fast.ts:PURE_FILES).

function fixtureScene(titleX = 40): Scene {
  return parseScene({
    schemaVersion: 1,
    canvas: { width: 1080, height: 1350, background: "#101010" },
    layers: [
      {
        id: "title", name: "Titre", visible: true, locked: false,
        frame: { x: titleX, y: 40, w: 1000, h: 100 },
        type: "text", content: "Titre de test",
        font: { family: "Noto Sans", size: 48, weight: 700 },
        color: "#FFFFFF", align: "left", vAlign: "top", lineHeight: 1.2,
      },
    ],
  });
}

const TPL = "11111111-1111-1111-1111-111111111111";

function entry(dataUriLength: number): CachedPreview {
  return {
    dataUri: "d".repeat(dataUriLength),
    degraded: false, overflowingLayerIds: [], lowResLayerIds: [],
  };
}

describe("previewCacheKey", () => {
  it("deux scènes au contenu identique donnent la MÊME clé, même si ce sont deux objets distincts", () => {
    const a = previewCacheKey(TPL, fixtureScene(), "ig_portrait", null);
    const b = previewCacheKey(TPL, fixtureScene(), "ig_portrait", null);
    expect(a).toBe(b);
  });

  it("un calque déplacé d'un seul pixel donne une clé DIFFÉRENTE", () => {
    const a = previewCacheKey(TPL, fixtureScene(40), "ig_portrait", null);
    const b = previewCacheKey(TPL, fixtureScene(41), "ig_portrait", null);
    expect(a).not.toBe(b);
  });

  it("le format, l'article et le gabarit font tous partie de la clé", () => {
    const base = previewCacheKey(TPL, fixtureScene(), "ig_portrait", null);
    expect(previewCacheKey(TPL, fixtureScene(), "story", null)).not.toBe(base);
    expect(previewCacheKey(TPL, fixtureScene(), "ig_portrait", "art-1")).not.toBe(base);
    expect(previewCacheKey("22222222-2222-2222-2222-222222222222", fixtureScene(), "ig_portrait", null)).not.toBe(base);
  });

  it("`format` absent et `articleId` absent/null sont traités de façon stable", () => {
    expect(previewCacheKey(TPL, fixtureScene(), undefined, null))
      .toBe(previewCacheKey(TPL, fixtureScene(), undefined, undefined));
    expect(previewCacheKey(TPL, fixtureScene(), undefined, null))
      .not.toBe(previewCacheKey(TPL, fixtureScene(), "ig_portrait", null));
  });
});

describe("createPreviewCache — éviction bornée en OCTETS", () => {
  it("relit ce qu'il a écrit", () => {
    const c = createPreviewCache(10_000);
    c.set("a", entry(100));
    expect(c.get("a")?.dataUri).toHaveLength(100);
  });

  it("évince le plus ancien jusqu'à repasser sous le budget", () => {
    // bytes ≈ length * 0.75 → une entrée de 1000 caractères pèse 750 octets.
    const c = createPreviewCache(2_000); // tient 2 entrées de 750, pas 3.
    c.set("a", entry(1000));
    c.set("b", entry(1000));
    c.set("c", entry(1000));
    expect(c.get("a")).toBeUndefined();
    expect(c.get("b")).toBeDefined();
    expect(c.get("c")).toBeDefined();
    expect(c.bytes()).toBeLessThanOrEqual(2_000);
  });

  it("un `get` rafraîchit la récence : c'est bien une LRU, pas une FIFO", () => {
    const c = createPreviewCache(2_000);
    c.set("a", entry(1000));
    c.set("b", entry(1000));
    c.get("a");            // "a" redevient la plus récente
    c.set("c", entry(1000)); // doit donc évincer "b", pas "a"
    expect(c.get("a")).toBeDefined();
    expect(c.get("b")).toBeUndefined();
  });

  it("une entrée plus grosse à elle seule que le budget n'est PAS mise en cache (et n'en vide pas le contenu)", () => {
    const c = createPreviewCache(2_000);
    c.set("a", entry(1000));
    c.set("enorme", entry(100_000));
    expect(c.get("enorme")).toBeUndefined();
    expect(c.get("a")).toBeDefined();
  });

  it("réécrire une clé existante remplace son poids au lieu de le cumuler", () => {
    const c = createPreviewCache(10_000);
    c.set("a", entry(1000));
    const after1 = c.bytes();
    c.set("a", entry(1000));
    expect(c.bytes()).toBe(after1);
    expect(c.keys()).toEqual(["a"]);
  });

  it("`delete` et `clear` libèrent les octets", () => {
    const c = createPreviewCache(10_000);
    c.set("a", entry(1000));
    c.delete("a");
    expect(c.bytes()).toBe(0);
    c.set("b", entry(1000));
    c.clear();
    expect(c.bytes()).toBe(0);
    expect(c.keys()).toEqual([]);
  });
});

describe("l'instance partagée", () => {
  it("existe et porte le budget documenté", () => {
    expect(PREVIEW_CACHE_MAX_BYTES).toBe(48 * 1024 * 1024);
    expect(typeof previewCache.get).toBe("function");
  });
});
```

- [ ] **Step 2: Lancer le test pour le voir échouer**

```bash
bun test tests/studio-preview-cache.test.ts
```

Attendu : ÉCHEC — `Cannot find module '@/lib/studio/preview-cache'`.

- [ ] **Step 3: Écrire l'implémentation**

Créer `lib/studio/preview-cache.ts` :

```ts
// lib/studio/preview-cache.ts — le mémo CLIENT de l'aperçu (refonte « Rendu réel », spec §4).
//
// Pourquoi ce fichier existe : previewTemplate() n'est jamais gratuit — chaque appel est un VRAI
// rendu satori/resvg/sharp, et AUCUN cache serveur ne l'absorbe (previewTemplateCore appelle
// renderScene directement, jamais renderForArticle ; voir la garantie structurelle de
// tests/studio-preview.test.ts). Avant ce cache, entrer en Rendu réel coûtait jusqu'à huit rendus,
// refaits À CHAQUE aller-retour de mode.
//
// PORTÉE MODULE, délibérément : c'est ce qui fait survivre la mémo au DÉMONTAGE de RenderMode
// (quand `mode` repasse à "montage", editor-shell.tsx démonte tout l'arbre). Un `useRef` ou un
// contexte React mourraient avec lui et ne résoudraient donc pas le problème visé.
//
// PUR : aucun accès à `window`/DOM, aucun import React — même discipline que lib/studio/editor-prefs.ts
// et lib/studio/studio-mode.ts. C'est ce qui le rend testable dans la voie parallèle.
import type { Scene } from "./scene";
import type { FormatKey } from "./formats";

export type CachedPreview = {
  dataUri: string;
  degraded: boolean;
  overflowingLayerIds: string[];
  lowResLayerIds: string[];
};

// FNV-1a 32 bits sur la sérialisation de la scène. Un hachage 32 bits COLLISIONNE (et une collision
// ici afficherait la mauvaise image, pas seulement un cache raté), donc la clé ne se réduit JAMAIS
// au seul hachage : elle porte AUSSI la longueur de la sérialisation. Deux scènes distinctes
// doivent alors collisionner sur le hachage ET faire exactement la même longueur d'octets pour se
// confondre — un régime bien plus sûr, pour un coût nul.
function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

export function previewCacheKey(
  templateId: string,
  scene: Scene,
  format: FormatKey | undefined,
  articleId: string | null | undefined,
): string {
  const serialized = JSON.stringify(scene);
  // `articleId` : `undefined` et `null` désignent tous deux « valeurs d'exemple » côté
  // previewTemplate — ils DOIVENT donc produire la même clé, sans quoi le même rendu serait calculé
  // deux fois selon la façon dont l'appelant a exprimé « aucun article ».
  return [
    templateId,
    format ?? "-",
    articleId ?? "-",
    serialized.length,
    fnv1a(serialized),
  ].join("|");
}

// Estimation des octets réels derrière une data-URI base64 : 4 caractères encodent 3 octets.
// Approximatif (l'en-tête « data:image/png;base64, » et le remplissage `=` ne sont pas défalqués),
// mais c'est un BUDGET, pas une comptabilité — une erreur de quelques pourcents est sans effet.
function estimateBytes(v: CachedPreview): number {
  return Math.ceil(v.dataUri.length * 0.75);
}

export interface PreviewCache {
  get(key: string): CachedPreview | undefined;
  set(key: string, value: CachedPreview): void;
  delete(key: string): void;
  clear(): void;
  /** Total estimé actuellement retenu, en octets. */
  bytes(): number;
  /** Clés dans l'ordre LRU, de la plus ancienne à la plus récente. */
  keys(): string[];
}

// Bornée en OCTETS et non en entrées : un PNG 1080×1920 en data-URI pèse 1 à 2 Mo, quand une
// vignette 1200×630 en pèse une fraction. Un plafond exprimé en NOMBRE d'entrées retiendrait donc,
// selon les formats consultés, entre quelques mégaoctets et plusieurs centaines — un budget qui ne
// veut rien dire. `Map` conserve l'ordre d'insertion : un `delete` suivi d'un `set` suffit à
// remettre une clé en tête de récence, sans structure chaînée séparée.
export function createPreviewCache(maxBytes: number): PreviewCache {
  const map = new Map<string, CachedPreview>();
  let total = 0;

  function drop(key: string): void {
    const existing = map.get(key);
    if (existing === undefined) return;
    total -= estimateBytes(existing);
    map.delete(key);
  }

  return {
    get(key) {
      const hit = map.get(key);
      if (hit === undefined) return undefined;
      map.delete(key);
      map.set(key, hit); // rafraîchit la récence — c'est ce qui en fait une LRU et non une FIFO.
      return hit;
    },
    set(key, value) {
      drop(key); // réécriture : on retire l'ancien poids avant d'ajouter le nouveau, jamais les deux.
      const size = estimateBytes(value);
      // Une entrée plus grosse à elle seule que le budget ne peut pas y tenir : la mettre en cache
      // reviendrait à vider tout le reste ET à dépasser quand même. On la laisse simplement passer
      // sans la retenir — l'appelant l'affiche, elle n'est juste pas mémoïsée.
      if (size > maxBytes) return;
      map.set(key, value);
      total += size;
      while (total > maxBytes) {
        const oldest = map.keys().next();
        if (oldest.done === true) break;
        drop(oldest.value);
      }
    },
    delete: drop,
    clear() { map.clear(); total = 0; },
    bytes: () => total,
    keys: () => [...map.keys()],
  };
}

export const PREVIEW_CACHE_MAX_BYTES = 48 * 1024 * 1024;

// L'instance PARTAGÉE. Voir l'en-tête du fichier : c'est sa portée module qui porte toute la valeur.
export const previewCache = createPreviewCache(PREVIEW_CACHE_MAX_BYTES);
```

- [ ] **Step 4: Ajouter le fichier de test à la voie parallèle**

Dans `scripts/test-fast.ts`, à l'intérieur du `Set` `PURE_FILES`, sur la ligne qui contient déjà `"studio-property-panel.test.ts", "studio-public-api.test.ts", "studio-rail.test.ts",` — ajouter `"studio-preview-cache.test.ts",` en respectant l'ordre alphabétique du bloc.

- [ ] **Step 5: Lancer le test pour le voir passer**

```bash
bun test tests/studio-preview-cache.test.ts
```

Attendu : PASS, tous les cas verts.

- [ ] **Step 6: Commit**

```bash
git add lib/studio/preview-cache.ts tests/studio-preview-cache.test.ts scripts/test-fast.ts
git commit -m "feat(studio): mémo LRU d'aperçu borné en octets, en portée module"
```

---

### Task 2: Vocabulaire pur du mode Rendu (sélection, navigation, zoom)

**Files:**
- Modify: `lib/studio/studio-mode.ts`
- Modify: `lib/studio/relayout.ts` (accueille `sceneForFormat`)
- Modify: `components/studio/render-mode.tsx` (ré-exporte `sceneForFormat` depuis son nouveau domicile, pour ne pas casser l'import existant du test)
- Modify: `tests/studio-mode.test.ts`
- Modify: `tests/studio-render-mode.test.ts` (import de `sceneForFormat`)

**Interfaces:**
- Consumes: `PreservedView`, `ModeShortcutTarget` (déjà dans `studio-mode.ts`), `FormatKey`/`FORMAT_KEYS` (`lib/studio/formats.ts`), `relayoutToFormat` (`lib/studio/relayout.ts`).
- Produces:
  - `focusedFormat(view: PreservedView): FormatKey | null`
  - `type FormatNavAction = "prev" | "next" | "exit" | null`
  - `formatNavAction(e: ModeShortcutEvent): FormatNavAction`
  - `ZOOM_STEPS: readonly number[]`
  - `zoomStep(current: number | "fit", direction: 1 | -1): number`
  - `sceneForFormat(scene: Scene, key: FormatKey, native: FormatKey): Scene` — désormais dans `lib/studio/relayout.ts`

- [ ] **Step 1: Écrire les tests qui échouent**

Ajouter à la fin de `tests/studio-mode.test.ts` :

```ts
import { focusedFormat, formatNavAction, zoomStep, ZOOM_STEPS } from "@/lib/studio/studio-mode";

// Refonte « Rendu réel » : `PreservedView.selectedId` CHANGE DE SENS. Avant, `null` voulait dire
// « le format natif est promu dans la grande case » ; désormais il veut dire « aucun format
// focalisé — on est sur la planche ». `focusedFormat` est le seul lecteur autorisé de ce champ côté
// Rendu réel : il garde le composant d'une valeur qui ne serait pas une vraie clé de format.
describe("focusedFormat", () => {
  const base = { zoom: "fit" as const, scrollX: 0, scrollY: 0 };

  it("`null` signifie la planche, pas un format", () => {
    expect(focusedFormat({ ...base, selectedId: null })).toBeNull();
  });

  it("une clé de format réelle est renvoyée telle quelle", () => {
    expect(focusedFormat({ ...base, selectedId: "story" })).toBe("story");
  });

  it("une valeur qui n'est PAS une clé de format retombe sur la planche plutôt que de faire planter un indexage", () => {
    expect(focusedFormat({ ...base, selectedId: "layer-42" })).toBeNull();
    expect(focusedFormat({ ...base, selectedId: "" })).toBeNull();
  });
});

describe("formatNavAction", () => {
  const div = { tagName: "DIV" };

  it("flèches et Échap pilotent la navigation entre formats", () => {
    expect(formatNavAction({ key: "ArrowLeft", target: div })).toBe("prev");
    expect(formatNavAction({ key: "ArrowRight", target: div })).toBe("next");
    expect(formatNavAction({ key: "Escape", target: div })).toBe("exit");
  });

  it("ignore toute autre touche", () => {
    expect(formatNavAction({ key: "a", target: div })).toBeNull();
    expect(formatNavAction({ key: "ArrowUp", target: div })).toBeNull();
  });

  it("ne détourne JAMAIS une combinaison portant un modificateur", () => {
    expect(formatNavAction({ key: "ArrowLeft", metaKey: true, target: div })).toBeNull();
    expect(formatNavAction({ key: "ArrowRight", ctrlKey: true, target: div })).toBeNull();
    expect(formatNavAction({ key: "ArrowLeft", altKey: true, target: div })).toBeNull();
  });

  it("est inerte quand le focus est dans un champ de saisie — même discipline qu'isModeToggleShortcut", () => {
    expect(formatNavAction({ key: "ArrowLeft", target: { tagName: "INPUT" } })).toBeNull();
    expect(formatNavAction({ key: "ArrowRight", target: { tagName: "TEXTAREA" } })).toBeNull();
    expect(formatNavAction({ key: "Escape", target: { tagName: "DIV", isContentEditable: true } })).toBeNull();
  });
});

describe("zoomStep", () => {
  it("l'échelle est bornée à 100 % — au-delà on inspecterait un agrandissement, pas une typographie", () => {
    expect(ZOOM_STEPS[ZOOM_STEPS.length - 1]).toBe(1);
    expect(zoomStep(1, 1)).toBe(1);
  });

  it("ne descend jamais sous le premier cran", () => {
    expect(zoomStep(ZOOM_STEPS[0]!, -1)).toBe(ZOOM_STEPS[0]);
  });

  it("monte et descend d'un cran à la fois", () => {
    expect(zoomStep(0.25, 1)).toBe(0.5);
    expect(zoomStep(0.5, -1)).toBe(0.25);
  });

  it("depuis « fit », zoomer entre par le milieu de l'échelle plutôt que par un bord arbitraire", () => {
    const entry = zoomStep("fit", 1);
    expect(ZOOM_STEPS).toContain(entry);
    expect(entry).toBeGreaterThan(ZOOM_STEPS[0]!);
    expect(entry).toBeLessThanOrEqual(1);
  });

  it("une valeur hors échelle est ramenée au cran adjacent le plus proche, jamais renvoyée telle quelle", () => {
    expect(ZOOM_STEPS).toContain(zoomStep(0.42, 1));
    expect(ZOOM_STEPS).toContain(zoomStep(0.42, -1));
  });
});
```

- [ ] **Step 2: Lancer le test pour le voir échouer**

```bash
bun test tests/studio-mode.test.ts
```

Attendu : ÉCHEC — `focusedFormat is not a function` (ou une erreur d'import équivalente).

- [ ] **Step 3: Implémenter dans `lib/studio/studio-mode.ts`**

Ajouter en tête du fichier :

```ts
import { FORMAT_KEYS, type FormatKey } from "./formats";
```

Puis, **réécrire** le commentaire de contrat de `PreservedView` : le paragraphe qui décrit `selectedId` en Rendu réel comme « le FORMAT actuellement promu dans la grande case (…) ou `null` pour le format natif » décrit un contrat révolu. Le remplacer par :

```ts
//   - en Rendu réel (components/studio/render-mode.tsx), `selectedId` porte le format FOCALISÉ :
//     `null` = aucun, c'est-à-dire la PLANCHE (components/studio/render/proof-sheet.tsx) ; une
//     FormatKey = ce format est ouvert en inspection (components/studio/render/format-focus.tsx).
//     `zoom` ("fit" ou une fraction de ZOOM_STEPS jusqu'à 1 = 100 %) et `scrollX`/`scrollY` ne
//     servent QU'À la vue d'inspection — la planche ne zoome ni ne conserve son défilement.
//     Ce champ ne doit JAMAIS être indexé directement dans FORMAT_PRESETS : passer par
//     `focusedFormat` ci-dessous, qui garde le composant d'une valeur qui n'en serait pas une.
```

Puis ajouter à la fin du fichier :

```ts
// ─────────────────────────────────────────────────────────────────────────────
// Le SEUL lecteur autorisé de `PreservedView.selectedId` côté Rendu réel. `selectedId` est un
// `string | null` générique partagé avec le mode Montage : rien dans le type ne garantit qu'il
// porte une clé de format, et un futur appelant qui y rangerait autre chose (un id de calque, par
// exemple) ne doit pas faire planter un indexage de FORMAT_PRESETS.
export function focusedFormat(view: PreservedView): FormatKey | null {
  if (view.selectedId === null) return null;
  return (FORMAT_KEYS as readonly string[]).includes(view.selectedId)
    ? (view.selectedId as FormatKey)
    : null;
}

// Navigation clavier DANS la vue d'inspection — même discipline que isModeToggleShortcut ci-dessus,
// et pour les mêmes raisons : prédicat PUR sur des primitifs (testable sans jsdom), inerte sous
// modificateur (← / → avec Cmd sont des raccourcis navigateur d'historique) et inerte quand le
// focus est dans un champ de saisie.
export type FormatNavAction = "prev" | "next" | "exit" | null;

export function formatNavAction(e: ModeShortcutEvent): FormatNavAction {
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  const tagName = e.target?.tagName?.toUpperCase() ?? "";
  if (TYPING_TAGS.has(tagName)) return null;
  if (e.target?.isContentEditable) return null;
  if (e.key === "ArrowLeft") return "prev";
  if (e.key === "ArrowRight") return "next";
  if (e.key === "Escape") return "exit";
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Échelle de zoom DISCRÈTE de la vue d'inspection. Discrète et non continue : « fit » est réalisé
// en CSS pur (`object-contain`), donc son échelle numérique n'est jamais connue du JS — un zoom
// continu partant de « fit » n'aurait aucun point de départ. Une échelle fixe est prévisible pour
// l'utilisateur et testable ici, sans DOM.
//
// Plafonnée à 1 : au-delà des pixels natifs du format, on inspecte un agrandissement, pas une
// typographie. C'est la même borne que l'ancien MAX_RENDER_ZOOM, conservée volontairement.
export const ZOOM_STEPS = [0.1, 0.25, 0.5, 0.75, 1] as const;

export function zoomStep(current: number | "fit", direction: 1 | -1): number {
  // Depuis « fit », on entre par le milieu de l'échelle : un utilisateur qui clique « + » depuis
  // l'ajustement veut agrandir de façon perceptible, pas atterrir sur 10 %.
  if (current === "fit") {
    const middle = ZOOM_STEPS[Math.floor(ZOOM_STEPS.length / 2)]!;
    return direction === 1 ? middle : ZOOM_STEPS[0]!;
  }
  const exact = ZOOM_STEPS.indexOf(current as (typeof ZOOM_STEPS)[number]);
  if (exact !== -1) {
    const next = Math.min(Math.max(exact + direction, 0), ZOOM_STEPS.length - 1);
    return ZOOM_STEPS[next]!;
  }
  // Valeur hors échelle (une vue restaurée d'un état plus ancien, par exemple) : on rejoint le cran
  // adjacent dans la direction demandée, jamais la valeur brute.
  const above = ZOOM_STEPS.find((s) => s > current);
  const below = [...ZOOM_STEPS].reverse().find((s) => s < current);
  if (direction === 1) return above ?? ZOOM_STEPS[ZOOM_STEPS.length - 1]!;
  return below ?? ZOOM_STEPS[0]!;
}
```

- [ ] **Step 4: Déplacer `sceneForFormat` vers `lib/studio/relayout.ts`**

Ajouter à la fin de `lib/studio/relayout.ts` (adapter les imports de `Scene`/`FormatKey` s'ils n'y sont pas déjà) :

```ts
// LE gabarit RÉAGENCÉ pour `key`, pas seulement redimensionné. `key === native` est une identité
// EXACTE (raccourci : `relayoutToFormat` serait de toute façon une identité mathématique dans ce
// cas précis — « identité au format d'accueil »).
//
// Vivait dans components/studio/render-mode.tsx jusqu'à la refonte de la planche. Déplacée ici
// parce que ses DEUX appelants sont désormais des enfants de render-mode.tsx (proof-sheet.tsx et
// format-focus.tsx) : l'y laisser aurait fait importer le parent par ses propres enfants, une
// dépendance circulaire. Sa place naturelle est de toute façon à côté de `relayoutToFormat`, dont
// elle n'est qu'un raccourci.
export function sceneForFormat(scene: Scene, key: FormatKey, native: FormatKey): Scene {
  if (key === native) return scene;
  return relayoutToFormat(scene, key);
}
```

Dans `components/studio/render-mode.tsx`, **supprimer** la définition locale de `sceneForFormat` (l'actuelle ligne ~106) et la remplacer par une ré-exportation, afin que l'import existant de `tests/studio-render-mode.test.ts` continue de résoudre jusqu'à la Tâche 6 :

```ts
export { sceneForFormat } from "@/lib/studio/relayout";
```

- [ ] **Step 5: Lancer les tests pour les voir passer**

```bash
bun test tests/studio-mode.test.ts tests/studio-render-mode.test.ts tests/studio-relayout.test.ts
```

Attendu : PASS. Si `tests/studio-render-mode.test.ts` échoue sur l'import de `sceneForFormat`, la ré-exportation de l'étape 4 est manquante ou mal orthographiée.

- [ ] **Step 6: Commit**

```bash
git add lib/studio/studio-mode.ts lib/studio/relayout.ts components/studio/render-mode.tsx tests/studio-mode.test.ts
git commit -m "feat(studio): vocabulaire pur du mode Rendu — focusedFormat, navigation, échelle de zoom"
```

---

### Task 3: Extraction du cœur d'aperçu en hook

**Files:**
- Create: `hooks/use-preview.ts`
- Modify: `components/studio/preview-pane.tsx`
- Modify: `components/studio/render-mode.tsx` (supprimer le passage de `onResult`, devenu inexistant)
- Modify: `tests/studio-preview.test.ts` (étendre la garantie structurelle)

**Interfaces:**
- Consumes: `previewCache`, `previewCacheKey` (Tâche 1) ; `previewTemplate` (`lib/actions/studio-preview-actions.ts`).
- Produces:
  - `PREVIEW_DEBOUNCE_MS: number` (800)
  - `type PreviewState = { status: "idle" } | { status: "loading" } | { status: "ready"; dataUri: string; degraded: boolean; overflow: boolean; lowRes: boolean } | { status: "error"; message: string }`
  - `usePreview(input: { templateId: string; scene: Scene; format?: FormatKey; articleId?: string | null; enabled?: boolean }): { state: PreviewState; refresh: () => void }`

- [ ] **Step 1: Écrire le test structurel qui échoue**

Dans `tests/studio-preview.test.ts`, à l'intérieur du `describe("previewTemplateCore — garantie structurelle …")` existant, **après** le test `"renderScene() lui-même …"`, ajouter :

```ts
  // Refonte « Rendu réel » : le cœur réseau de l'aperçu vit désormais dans hooks/use-preview.ts, que
  // preview-pane.tsx ET la planche consomment tous les deux. La garantie « l'aperçu n'écrit rien »
  // doit donc partir AUSSI de ce fichier, sinon l'extraction l'aurait silencieusement contournée.
  //
  // Subtilité : on ne peut PAS simplement fermer transitivement depuis use-preview.ts. Il importe
  // une Server Action ("use server"), dont le graphe atteint légitimement @/db — c'est le rôle
  // MÊME de ce module frontière (requireUser/requirePermission). Le graphe client s'arrête donc aux
  // modules "use server" : ce qui est vérifié, c'est que le CLIENT ne peut atteindre le moteur que
  // PAR cette frontière-là, et par aucune autre. La propreté de ce qu'il y a derrière la frontière
  // reste couverte par les deux tests ci-dessus, qui partent de preview-core.ts.
  function isServerModule(file: string): boolean {
    const head = readFileSync(file, "utf8").slice(0, 200);
    return /^\s*["']use server["']/m.test(head);
  }

  function clientClosure(entry: string): { files: Set<string>; serverEntrypoints: Set<string> } {
    const files = new Set<string>();
    const serverEntrypoints = new Set<string>();
    const stack = [entry];
    while (stack.length) {
      const file = stack.pop()!;
      if (files.has(file)) continue;
      files.add(file);
      for (const spec of importsOf(file)) {
        const resolved = resolveModule(spec, file);
        if (!resolved || files.has(resolved)) continue;
        if (isServerModule(resolved)) { serverEntrypoints.add(resolved); continue; }
        stack.push(resolved);
      }
    }
    return { files, serverEntrypoints };
  }

  it("hooks/use-preview.ts n'atteint le moteur QUE par la Server Action gardée previewTemplate", () => {
    const { files, serverEntrypoints } = clientClosure(path.join(REPO_ROOT, "hooks/use-preview.ts"));
    // Une seule frontière serveur, et c'est la bonne.
    expect([...serverEntrypoints]).toEqual([path.join(REPO_ROOT, "lib/actions/studio-preview-actions.ts")]);
    // Et côté client, aucun chemin vers l'écriture ni vers le moteur en direct.
    expect(files.has(storeModule)).toBe(false);
    expect(files.has(renderForArticleModule)).toBe(false);
    expect(files.has(dbModule)).toBe(false);
    expect(files.has(path.join(REPO_ROOT, "lib/studio/render.ts"))).toBe(false);
  });
```

- [ ] **Step 2: Lancer le test pour le voir échouer**

```bash
bun test tests/studio-preview.test.ts -t "n'atteint le moteur QUE par"
```

Attendu : ÉCHEC — `ENOENT` sur `hooks/use-preview.ts` (le fichier n'existe pas encore).

- [ ] **Step 3: Écrire le hook**

Créer `hooks/use-preview.ts` :

```ts
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { previewTemplate } from "@/lib/actions/studio-preview-actions";
import { previewCache, previewCacheKey, type CachedPreview } from "@/lib/studio/preview-cache";
import type { Scene } from "@/lib/studio/scene";
import type { FormatKey } from "@/lib/studio/formats";

// hooks/use-preview.ts — le cœur SANS UI de l'aperçu réel, extrait de components/studio/preview-pane.tsx
// lors de la refonte du mode « Rendu réel ».
//
// Pourquoi l'extraction : avant elle, il existait DEUX chemins de rendu — le <PreviewPane> complet
// (différé, garde anti-périmé, sélecteur d'article) et l'appel previewTemplate() écrit à la main
// dans les vignettes du filmstrip, sans cache et sans le même différé. Deux chemins pour une seule
// question, qui pouvaient diverger. Il n'en reste qu'un.
//
// Différé 800 ms après stabilisation, exactement comme avant : l'aperçu n'écrit rien côté serveur,
// un différé plus court que l'autosauvegarde (1500 ms) n'a donc pas le même coût. Et la scène
// ENVOYÉE est toujours celle des props — jamais le brouillon en base, qui peut avoir ~700 ms de
// retard (voir le correctif « Critique 1, revue Lot 2 » documenté dans preview-pane.tsx).
export const PREVIEW_DEBOUNCE_MS = 800;

export type PreviewState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; dataUri: string; degraded: boolean; overflow: boolean; lowRes: boolean }
  | { status: "error"; message: string };

function readyFrom(v: CachedPreview): PreviewState {
  return {
    status: "ready",
    dataUri: v.dataUri,
    degraded: v.degraded,
    overflow: v.overflowingLayerIds.length > 0,
    lowRes: v.lowResLayerIds.length > 0,
  };
}

export interface UsePreviewInput {
  templateId: string;
  scene: Scene;
  /** Fait calculer `overflowingLayerIds` côté serveur pour CE format (voir PreviewTemplateInput.format). */
  format?: FormatKey;
  /** `null`/`undefined` = valeurs d'exemple. Les deux produisent la même clé de cache. */
  articleId?: string | null;
  /** `false` : aucun appel réseau, aucune transition d'état. Porte à la fois la lecture seule
   *  (stockage R2 absent) et le gating de visibilité des tuiles de la planche. Défaut : `true`. */
  enabled?: boolean;
}

export function usePreview(input: UsePreviewInput): { state: PreviewState; refresh: () => void } {
  const { templateId, scene, format, articleId, enabled = true } = input;
  const key = previewCacheKey(templateId, scene, format, articleId);

  // Un succès de cache doit être visible DÈS LE PREMIER RENDU sous la nouvelle clé — sinon revenir
  // de l'inspection vers la planche, ou faire un aller-retour Montage⇄Rendu, ferait clignoter huit
  // squelettes pour des images déjà en mémoire. D'où l'ajustement d'état PENDANT le rendu (patron
  // documenté par React pour « dériver un état d'un changement de props ») plutôt qu'un effet, qui
  // ne s'exécuterait qu'après une première peinture vide.
  const [renderedKey, setRenderedKey] = useState(key);
  const [state, setState] = useState<PreviewState>(() => {
    const hit = previewCache.get(key);
    return hit ? readyFrom(hit) : { status: "idle" };
  });
  if (key !== renderedKey) {
    setRenderedKey(key);
    const hit = previewCache.get(key);
    setState(hit ? readyFrom(hit) : { status: "loading" });
  }

  const requestIdRef = useRef(0);
  const [nonce, setNonce] = useState(0);

  // « Actualiser » : purge l'entrée de CETTE clé puis relance. Utile pour le seul cas qu'un hachage
  // de scène ne peut pas voir — une image source modifiée à distance, dont l'URL n'a pas changé.
  const keyRef = useRef(key);
  keyRef.current = key;
  const refresh = useCallback(() => {
    previewCache.delete(keyRef.current);
    setNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const hit = previewCache.get(key);
    if (hit) { setState(readyFrom(hit)); return; }

    const id = ++requestIdRef.current;
    setState({ status: "loading" });
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const res = await previewTemplate({
            templateId, scene, format, articleId: articleId ?? undefined,
          });
          // Garde anti-périmé : une requête plus récente est repartie entre-temps, sa réponse ne
          // doit pas être écrasée par celle-ci, arrivée en second à cause de la latence.
          if (id !== requestIdRef.current) return;
          if (res.ok) {
            const value: CachedPreview = {
              dataUri: res.dataUri, degraded: res.degraded,
              overflowingLayerIds: res.overflowingLayerIds, lowResLayerIds: res.lowResLayerIds,
            };
            previewCache.set(key, value);
            setState(readyFrom(value));
          } else {
            setState({ status: "error", message: res.message });
          }
        } catch (e) {
          if (id !== requestIdRef.current) return;
          setState({ status: "error", message: e instanceof Error ? e.message : "Aperçu impossible." });
        }
      })();
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // `scene`/`templateId`/`format`/`articleId` sont TOUS déjà encodés dans `key` (par contenu, pas
    // par identité d'objet) — les lister en plus ferait re-déclencher l'effet à chaque nouveau rendu
    // du parent, puisque `sceneForFormat` renvoie un objet neuf à chaque appel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled, nonce]);

  return { state, refresh };
}
```

- [ ] **Step 4: Réécrire `preview-pane.tsx` autour du hook**

Dans `components/studio/preview-pane.tsx` :

1. Supprimer `PREVIEW_DEBOUNCE_MS`, le type local `PreviewState`, `requestIdRef`, `runPreview` et le `useEffect` de différé — tout cela vit désormais dans le hook.
2. Supprimer la prop `onResult` de `PreviewPaneProps` **et son commentaire de bloc** : son unique consommateur était `render-mode.tsx`, qui n'utilise plus `PreviewPane` du tout. Une prop sans appelant est du code mort.
3. Conserver **à l'identique** : l'export `ARTICLE_SELECTABLE_CONTEXTS`, l'état local `articleId`, le `<Select>`, tous les `data-testid` (`preview-pane`, `preview-degraded-badge`, `preview-lowres-badge`, `preview-disabled`, `preview-error`), le `data-action="refresh-preview"` et l'ensemble des libellés français.

Le corps du composant devient :

```tsx
export function PreviewPane({ templateId, context, scene, articles, disabled }: PreviewPaneProps) {
  const [articleId, setArticleId] = useState<string | null>(null);
  const { state, refresh } = usePreview({ templateId, scene, articleId, enabled: !disabled });
  const showArticlePicker = ARTICLE_SELECTABLE_CONTEXTS.includes(context) && !!articles?.length;
  // …JSX inchangé, à ceci près que `state.lowRes` remplace l'ancien `state.lowRes` calculé sur place
  // et que le bouton Actualiser appelle `refresh` au lieu de `runPreview`.
}
```

- [ ] **Step 5: Retirer `onResult` de son ancien appelant**

Dans `components/studio/render-mode.tsx`, supprimer la ligne `onResult={(res) => setDegraded(res?.degraded ?? false)}` du `<PreviewPane>`. Le fichier est réécrit intégralement en Tâche 6 ; ici on ne fait que le maintenir compilable.

- [ ] **Step 6: Lancer les tests**

```bash
bun test tests/studio-preview.test.ts -t "n'atteint le moteur QUE par"
bun run test:pure
```

Attendu : le test structurel PASSE, et la voie parallèle reste entièrement verte — en particulier `studio-no-r2.test.ts` et `studio-render-mode.test.ts`, qui rendent `PreviewPane`.

Si le test structurel échoue en signalant une frontière serveur inattendue, ne **pas** élargir l'assertion : c'est que le hook a acquis un import qu'il ne devrait pas avoir.

- [ ] **Step 7: Commit**

```bash
git add hooks/use-preview.ts components/studio/preview-pane.tsx components/studio/render-mode.tsx tests/studio-preview.test.ts
git commit -m "refactor(studio): extraire le cœur de l'aperçu en hook adossé au cache"
```

---

### Task 4: La planche (`proof-sheet.tsx`)

**Files:**
- Create: `components/studio/render/proof-sheet.tsx`
- Create: `tests/studio-proof-sheet.test.ts`
- Modify: `scripts/test-fast.ts` (`PURE_FILES`)

**Interfaces:**
- Consumes: `usePreview` (Tâche 3), `sceneForFormat` (Tâche 2), `FORMAT_PRESETS`/`FORMAT_KEYS`.
- Produces:
  - `type TileOutcome = { ready: boolean; overflow: boolean; lowRes: boolean }`
  - `interface ProofSheetProps { templateId; scene; nativeFormat; articleId; disabled?; onFocus: (f: FormatKey) => void; onTileOutcome: (f: FormatKey, o: TileOutcome) => void; initialOutcomes?: Partial<Record<FormatKey, TileOutcome>> }`
  - `export function ProofSheet(props: ProofSheetProps): JSX.Element`
- `data-testid` posés : `proof-sheet`, `proof-tile` (avec `data-format`), `proof-tile-native`, `proof-tile-overflow`, `proof-tile-lowres`, `proof-tile-download`.

- [ ] **Step 1: Écrire le test qui échoue**

Créer `tests/studio-proof-sheet.test.ts` :

```ts
import { describe, it, expect } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProofSheet, type ProofSheetProps } from "@/components/studio/render/proof-sheet";
import { parseScene, type Scene } from "@/lib/studio/scene";
import { FORMAT_KEYS } from "@/lib/studio/formats";

// react-dom/server, PAS de DOM — même convention que tests/studio-render-mode.test.ts. Aucun effet
// ne s'exécute : ce fichier ne vérifie donc QUE ce qui est vrai au premier rendu, et les états
// post-réseau passent par l'amorce `initialOutcomes` (même convention que RenderModeProps.initialDegraded).

function fixtureScene(): Scene {
  return parseScene({
    schemaVersion: 1,
    canvas: { width: 1080, height: 1350, background: "#101010" },
    layers: [
      {
        id: "title", name: "Titre", visible: true, locked: false,
        frame: { x: 40, y: 40, w: 1000, h: 100 },
        type: "text", content: "Titre de test",
        font: { family: "Noto Sans", size: 48, weight: 700 },
        color: "#FFFFFF", align: "left", vAlign: "top", lineHeight: 1.2,
      },
    ],
  });
}

function props(overrides?: Partial<ProofSheetProps>): ProofSheetProps {
  return {
    templateId: "11111111-1111-1111-1111-111111111111",
    scene: fixtureScene(),
    nativeFormat: "ig_portrait",
    articleId: null,
    onFocus: () => {},
    onTileOutcome: () => {},
    ...overrides,
  };
}

function render(p: ProofSheetProps): string {
  return renderToStaticMarkup(React.createElement(ProofSheet, p));
}

// Extraction ANCRÉE sur les vrais attributs — jamais une recherche de sous-chaîne naïve, qui
// ferait de faux positifs sur un className contenant le même mot.
function tileFormats(html: string): string[] {
  return [...html.matchAll(/data-testid="proof-tile"[^>]*data-format="([^"]+)"/g)].map((m) => m[1]!);
}

describe("ProofSheet — la planche des 8 formats", () => {
  it("rend UNE tuile par format, aucune omise, aucune en double", () => {
    const formats = tileFormats(render(props()));
    expect(formats).toHaveLength(FORMAT_KEYS.length);
    expect(new Set(formats)).toEqual(new Set(FORMAT_KEYS));
  });

  it("inclut le format NATIF — la planche montre les 8, pas « les autres »", () => {
    expect(tileFormats(render(props({ nativeFormat: "story" })))).toContain("story");
  });

  it("marque le format natif, et lui seul", () => {
    const html = render(props({ nativeFormat: "story" }));
    const marked = [...html.matchAll(/data-testid="proof-tile-native"[^>]*data-format="([^"]+)"/g)].map((m) => m[1]!);
    expect(marked).toEqual(["story"]);
  });

  it("le marqueur natif n'utilise PAS l'accent primaire (The Actions-Only Rule, DESIGN.md)", () => {
    const html = render(props({ nativeFormat: "story" }));
    const tag = html.match(/<[^>]*data-testid="proof-tile-native"[^>]*>/)![0];
    expect(tag).not.toMatch(/bg-primary|text-primary\b/);
  });

  it("le bouton de téléchargement n'est PAS imbriqué dans le bouton d'ouverture — un <button> dans un <button> est du HTML invalide", () => {
    const html = render(props());
    // Isole la première tuile, puis vérifie qu'aucun bouton n'en contient un autre.
    const tile = html.split('data-testid="proof-tile"')[1]!.split('data-testid="proof-tile"')[0]!;
    const opener = tile.indexOf('data-testid="proof-tile-open"');
    const closeOfOpener = tile.indexOf("</button>", opener);
    const download = tile.indexOf('data-testid="proof-tile-download"');
    expect(opener).toBeGreaterThanOrEqual(0);
    expect(download).toBeGreaterThanOrEqual(0);
    expect(download).toBeGreaterThan(closeOfOpener); // frère, pas enfant.
  });

  it("n'affiche une alerte de débordement QUE pour les formats réellement concernés", () => {
    const html = render(props({ initialOutcomes: { story: { ready: true, overflow: true, lowRes: false } } }));
    const flagged = [...html.matchAll(/data-testid="proof-tile-overflow"[^>]*data-format="([^"]+)"/g)].map((m) => m[1]!);
    expect(flagged).toEqual(["story"]);
  });

  it("n'affiche AUCUNE alerte quand aucun format n'est concerné — la légende suit la donnée, elle n'est pas figée dans le JSX", () => {
    const html = render(props());
    expect(html).not.toContain('data-testid="proof-tile-overflow"');
    expect(html).not.toContain('data-testid="proof-tile-lowres"');
  });

  it("affiche l'alerte « image agrandie » indépendamment de l'alerte de débordement", () => {
    const html = render(props({ initialOutcomes: { fb_link: { ready: true, overflow: false, lowRes: true } } }));
    const flagged = [...html.matchAll(/data-testid="proof-tile-lowres"[^>]*data-format="([^"]+)"/g)].map((m) => m[1]!);
    expect(flagged).toEqual(["fb_link"]);
    expect(html).not.toContain('data-testid="proof-tile-overflow"');
  });
});
```

- [ ] **Step 2: Lancer le test pour le voir échouer**

```bash
bun test tests/studio-proof-sheet.test.ts
```

Attendu : ÉCHEC — `Cannot find module '@/components/studio/render/proof-sheet'`.

- [ ] **Step 3: Écrire le composant**

> Ce fichier importe `previewFileName` depuis `./export`, créé à l'étape 4. Il ne compilera donc qu'une fois les deux étapes faites — c'est attendu ; le premier lancement de test n'intervient qu'à l'étape 6. Faire les étapes 3 et 4 avant de lancer quoi que ce soit.

Créer `components/studio/render/proof-sheet.tsx` :

```tsx
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Download } from "lucide-react";
import { usePreview } from "@/hooks/use-preview";
import { sceneForFormat } from "@/lib/studio/relayout";
import { FORMAT_PRESETS, FORMAT_KEYS, type FormatKey } from "@/lib/studio/formats";
import { previewFileName } from "./export";
import type { Scene } from "@/lib/studio/scene";

// components/studio/render/proof-sheet.tsx — la PLANCHE de contrôle : les huit formats côte à côte,
// chacun ouvrant l'inspection au clic. Remplace l'ancien duo « grande case + bande de sept
// vignettes de 112px », dont la bande gaspillait l'axe le plus large de l'écran pour des images
// trop petites pour juger quoi que ce soit.
//
// HAUTEUR DE TUILE UNIFORME, rendu en boîte-aux-lettres à son ratio réel à l'intérieur : l'objet de
// cette vue est de balayer huit choses d'un seul regard, et des hauteurs irrégulières cassent ce
// balayage. La forme relative de chaque format reste lisible puisque le rendu, lui, garde son ratio.
//
// Aucun point de rupture : `auto-fill` + `minmax(240px, 1fr)` donne 1 colonne à 380px, 2 vers 560,
// 3 vers 820, 4 à 5 au-delà de 1440 — la même règle du téléphone au 27 pouces.
const TILE_FRAME_HEIGHT = "h-40"; // 160px — la même pour les huit, cf. ci-dessus.

export type TileOutcome = { ready: boolean; overflow: boolean; lowRes: boolean };

export interface ProofSheetProps {
  templateId: string;
  scene: Scene;
  /** Format natif du gabarit (render_templates.format) — celui qui porte le marqueur « natif ». */
  nativeFormat: FormatKey;
  /** `null` = valeurs d'exemple. Pilote LES HUIT tuiles : c'est ce qui fait que la planche ne ment
   *  plus par rapport au sélecteur d'article (défaut n°7 de la spec). */
  articleId: string | null;
  disabled?: boolean;
  onFocus: (format: FormatKey) => void;
  /** Remonte le résultat de CHAQUE tuile au parent, qui en compose la pastille d'agrégation. */
  onTileOutcome: (format: FormatKey, outcome: TileOutcome) => void;
  // Amorce de test UNIQUEMENT — même convention que RenderModeProps.initialDegraded : la vraie
  // composition ne la fournit JAMAIS. `react-dom/server` n'exécute aucun effet, donc sans elle
  // aucun test statique ne pourrait atteindre un état post-réseau.
  initialOutcomes?: Partial<Record<FormatKey, TileOutcome>>;
}

function ProofTile({
  templateId, scene, nativeFormat, format, articleId, disabled, onFocus, onTileOutcome, initial,
}: {
  templateId: string; scene: Scene; nativeFormat: FormatKey; format: FormatKey;
  articleId: string | null; disabled?: boolean;
  onFocus: (f: FormatKey) => void;
  onTileOutcome: (f: FormatKey, o: TileOutcome) => void;
  initial?: TileOutcome;
}) {
  const preset = FORMAT_PRESETS[format];
  const containerRef = useRef<HTMLDivElement>(null);

  // Gating de visibilité — conservé de l'ancien FilmstripThumb, et plus nécessaire que jamais : en
  // grille, un grand écran rend les huit tuiles visibles d'emblée, donc les huit partent. Sur un
  // téléphone, une seule. `.disconnect()` à la première apparition : on veut découvrir l'existence
  // de la tuile une fois, pas re-déclencher à chaque passage dans le viewport.
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: "200px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Mémoïsé : `relayoutToFormat` est un vrai calcul, et sans cela il serait refait pour les huit
  // tuiles à chaque rendu du parent (une frappe ailleurs dans l'éditeur, par exemple).
  const variant = useMemo(
    () => sceneForFormat(scene, format, nativeFormat),
    [scene, format, nativeFormat],
  );

  const { state } = usePreview({
    templateId, scene: variant, format, articleId, enabled: visible && !disabled,
  });

  const outcome: TileOutcome = state.status === "ready"
    ? { ready: true, overflow: state.overflow, lowRes: state.lowRes }
    : (initial ?? { ready: false, overflow: false, lowRes: false });

  // Remonte au parent pour la pastille d'agrégation. Dans les dépendances : les trois champs, pas
  // l'objet — recréé à chaque rendu, il bouclerait indéfiniment.
  useEffect(() => {
    onTileOutcome(format, outcome);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [format, outcome.ready, outcome.overflow, outcome.lowRes]);

  const dataUri = state.status === "ready" ? state.dataUri : null;

  return (
    // `relative` + DEUX BOUTONS FRÈRES : un <button> dans un <button> est du HTML invalide et le
    // navigateur déstructure l'arbre. Le bouton d'ouverture est en `absolute inset-0` sous le bouton
    // de téléchargement, qui reste atteignable au clavier et se révèle au survol COMME AU FOCUS.
    <div
      ref={containerRef}
      data-testid="proof-tile"
      data-format={format}
      className="group relative flex flex-col gap-1.5 rounded-xl p-2 ring-1 ring-foreground/10 transition-colors hover:ring-foreground/20 focus-within:ring-foreground/20"
    >
      <span className={`flex ${TILE_FRAME_HEIGHT} items-center justify-center overflow-hidden rounded-lg bg-muted/30`}>
        {dataUri !== null && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={dataUri} alt={`Aperçu — ${preset.label}`} className="max-h-full max-w-full object-contain" />
        )}
        {state.status === "loading" && (
          <span
            className="animate-pulse rounded bg-muted"
            style={{ aspectRatio: `${preset.width} / ${preset.height}`, height: "100%" }}
          />
        )}
        {state.status === "idle" && <span className="text-[10px] text-muted-foreground">En attente…</span>}
        {state.status === "error" && <span className="text-[10px] text-destructive">Échec du rendu</span>}
      </span>

      <span className="flex items-baseline justify-between gap-2">
        <span className="truncate text-xs font-medium">{preset.label}</span>
        <span className="shrink-0 text-[11px] text-muted-foreground">{preset.width}×{preset.height}</span>
      </span>

      {format === nativeFormat && (
        <span
          data-testid="proof-tile-native"
          data-format={format}
          className="w-fit rounded-4xl bg-muted px-1.5 text-[10px] text-muted-foreground"
          title="Le format natif du gabarit — celui dans lequel il a été conçu."
        >
          natif
        </span>
      )}

      {outcome.overflow && (
        <span
          data-testid="proof-tile-overflow" data-format={format}
          className="truncate text-[10px] text-amber-600 dark:text-amber-500"
          title="Un texte contraint dépasse sa limite de lignes dans ce format — il risque de déborder du cadre. Mesuré avec la police de repli, approximatif si ce calque porte une police personnalisée."
        >
          Texte déborde
        </span>
      )}
      {outcome.lowRes && (
        <span
          data-testid="proof-tile-lowres" data-format={format}
          className="truncate text-[10px] text-amber-600 dark:text-amber-500"
          title="La photo source est plus petite que son cadre dans ce format : elle est agrandie, donc floue. Réduire le cadre ou fournir une image plus grande — aucun réglage du gabarit ne peut compenser."
        >
          Image agrandie
        </span>
      )}

      <button
        type="button"
        data-testid="proof-tile-open"
        data-format={format}
        className="absolute inset-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        onClick={() => onFocus(format)}
      >
        <span className="sr-only">Inspecter {preset.label}</span>
      </button>

      {dataUri !== null && (
        <a
          data-testid="proof-tile-download"
          data-format={format}
          href={dataUri}
          download={previewFileName(templateId, format)}
          title={`Télécharger ${preset.label} en PNG`}
          className="absolute right-3 top-3 rounded-lg bg-background/90 p-1 opacity-0 ring-1 ring-foreground/10 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <Download className="size-3.5" />
          <span className="sr-only">Télécharger {preset.label}</span>
        </a>
      )}
    </div>
  );
}

export function ProofSheet({
  templateId, scene, nativeFormat, articleId, disabled, onFocus, onTileOutcome, initialOutcomes,
}: ProofSheetProps) {
  return (
    <div
      data-testid="proof-sheet"
      className="grid min-h-0 flex-1 auto-rows-min gap-3 overflow-auto rounded-xl bg-[var(--canvas-backdrop)] p-3"
      style={{ gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))" }}
    >
      {FORMAT_KEYS.map((format) => (
        <ProofTile
          key={format}
          templateId={templateId} scene={scene} nativeFormat={nativeFormat} format={format}
          articleId={articleId} disabled={disabled}
          onFocus={onFocus} onTileOutcome={onTileOutcome}
          initial={initialOutcomes?.[format]}
        />
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Créer la dépendance minimale `previewFileName`**

`proof-sheet.tsx` importe `previewFileName` depuis `./export`, dont la Tâche 7 écrit le reste. Créer dès maintenant `components/studio/render/export.ts` avec **uniquement** cette fonction (la Tâche 7 l'étend, elle ne la réécrit pas) :

```ts
import { FORMAT_PRESETS, type FormatKey } from "@/lib/studio/formats";

// components/studio/render/export.ts — nommage et orchestration des exports PNG du mode Rendu réel.
//
// Le nom porte le format ET ses dimensions : un dossier de téléchargements où traînent huit PNG du
// même gabarit doit rester lisible sans les ouvrir.
export function previewFileName(templateId: string, format: FormatKey): string {
  const preset = FORMAT_PRESETS[format];
  return `${templateId}-${format}-${preset.width}x${preset.height}.png`;
}
```

- [ ] **Step 5: Ajouter le test à la voie parallèle**

Dans `scripts/test-fast.ts`, ajouter `"studio-proof-sheet.test.ts",` au `Set` `PURE_FILES`, en respectant l'ordre alphabétique du bloc.

- [ ] **Step 6: Lancer les tests**

```bash
bun test tests/studio-proof-sheet.test.ts
```

Attendu : PASS, tous les cas verts.

- [ ] **Step 7: Commit**

```bash
git add components/studio/render/proof-sheet.tsx components/studio/render/export.ts tests/studio-proof-sheet.test.ts scripts/test-fast.ts
git commit -m "feat(studio): planche de contrôle des 8 formats"
```

---

### Task 5: La vue d'inspection (`format-focus.tsx`)

**Files:**
- Create: `components/studio/render/format-focus.tsx`
- Create: `tests/studio-format-focus.test.ts`
- Modify: `scripts/test-fast.ts` (`PURE_FILES`)

**Interfaces:**
- Consumes: `usePreview` (Tâche 3) ; `sceneForFormat`, `focusedFormat`, `formatNavAction`, `zoomStep`, `ZOOM_STEPS` (Tâche 2) ; `previewFileName` (Tâche 4).
- Produces:
  - `interface FormatFocusProps { templateId; scene; nativeFormat; format: FormatKey; articleId; disabled?; view: PreservedView; onViewChange: (v: PreservedView) => void; onExit: () => void; onFormatChange: (f: FormatKey) => void; outcomes: Partial<Record<FormatKey, TileOutcome>>; initialState?: PreviewState }`
  - `export function FormatFocus(props: FormatFocusProps): JSX.Element`
- `data-testid` posés : `format-focus` (avec `data-format`), `format-focus-back`, `format-focus-strip`, `format-focus-pill` (avec `data-format`), `format-focus-surface`, `format-focus-zoom`, `format-focus-download`, `format-focus-overflow`, `format-focus-lowres`, `format-focus-degraded`.

- [ ] **Step 1: Écrire le test qui échoue**

Créer `tests/studio-format-focus.test.ts` :

```ts
import { describe, it, expect } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FormatFocus, type FormatFocusProps } from "@/components/studio/render/format-focus";
import { parseScene, type Scene } from "@/lib/studio/scene";
import { FORMAT_KEYS, FORMAT_PRESETS } from "@/lib/studio/formats";
import type { PreservedView } from "@/lib/studio/studio-mode";

function fixtureScene(): Scene {
  return parseScene({
    schemaVersion: 1,
    canvas: { width: 1080, height: 1350, background: "#101010" },
    layers: [
      {
        id: "title", name: "Titre", visible: true, locked: false,
        frame: { x: 40, y: 40, w: 1000, h: 100 },
        type: "text", content: "Titre de test",
        font: { family: "Noto Sans", size: 48, weight: 700 },
        color: "#FFFFFF", align: "left", vAlign: "top", lineHeight: 1.2,
      },
    ],
  });
}

function props(overrides?: Partial<FormatFocusProps>): FormatFocusProps {
  const view: PreservedView = { selectedId: "story", zoom: "fit", scrollX: 0, scrollY: 0 };
  return {
    templateId: "11111111-1111-1111-1111-111111111111",
    scene: fixtureScene(), nativeFormat: "ig_portrait", format: "story", articleId: null,
    view, onViewChange: () => {}, onExit: () => {}, onFormatChange: () => {},
    outcomes: {},
    ...overrides,
  };
}

const render = (p: FormatFocusProps) => renderToStaticMarkup(React.createElement(FormatFocus, p));

describe("FormatFocus — l'inspection d'un format", () => {
  it("annonce le format inspecté et ses dimensions", () => {
    const html = render(props());
    expect(html).toContain('data-testid="format-focus"');
    expect(html).toMatch(/data-testid="format-focus"[^>]*data-format="story"/);
    expect(html).toContain(FORMAT_PRESETS.story.label);
    expect(html).toContain("1080×1920");
  });

  it("la bande de formats propose les HUIT — on doit pouvoir en changer sans repasser par la planche", () => {
    const html = render(props());
    const pills = [...html.matchAll(/data-testid="format-focus-pill"[^>]*data-format="([^"]+)"/g)].map((m) => m[1]!);
    expect(new Set(pills)).toEqual(new Set(FORMAT_KEYS));
  });

  it("marque d'une puce les formats signalés, et eux seuls", () => {
    const html = render(props({ outcomes: { fb_link: { ready: true, overflow: true, lowRes: false } } }));
    const dotted = [...html.matchAll(/data-testid="format-focus-pill-dot"[^>]*data-format="([^"]+)"/g)].map((m) => m[1]!);
    expect(dotted).toEqual(["fb_link"]);
  });

  it("en mode « fit », la surface n'impose AUCUNE largeur en pixels — c'est le bug d'origine qu'on ne réintroduit pas", () => {
    const html = render(props());
    const surface = html.match(/<[^>]*data-testid="format-focus-surface"[^>]*>/)![0];
    expect(surface).not.toMatch(/aspect-ratio/);
    expect(surface).not.toMatch(/width:\s*\d/);
  });

  it("en zoom explicite, la surface porte bien une largeur en pixels dérivée du format", () => {
    const view: PreservedView = { selectedId: "story", zoom: 0.5, scrollX: 0, scrollY: 0 };
    const html = render(props({ view }));
    // 1080 × 0.5 = 540
    expect(html).toMatch(/data-testid="format-focus-surface"[\s\S]{0,400}?540/);
  });

  it("affiche les alertes en PHRASES complètes, pas en étiquettes tronquées — c'est ici qu'il y a la place", () => {
    const html = render(props({
      initialState: { status: "ready", dataUri: "data:image/png;base64,AA", degraded: false, overflow: true, lowRes: true },
    }));
    expect(html).toContain('data-testid="format-focus-overflow"');
    expect(html).toContain('data-testid="format-focus-lowres"');
    expect(html).toMatch(/police de repli/);      // la réserve d'approximation, VISIBLE et non plus enfouie dans un title=
    expect(html).toMatch(/plus petite que/);
  });

  it("n'affiche aucune alerte quand le rendu n'en signale pas — la légende suit la donnée", () => {
    const html = render(props({
      initialState: { status: "ready", dataUri: "data:image/png;base64,AA", degraded: false, overflow: false, lowRes: false },
    }));
    expect(html).not.toContain('data-testid="format-focus-overflow"');
    expect(html).not.toContain('data-testid="format-focus-lowres"');
    expect(html).not.toContain('data-testid="format-focus-degraded"');
  });

  it("propose le retour à la planche et le téléchargement du format inspecté", () => {
    const html = render(props({
      initialState: { status: "ready", dataUri: "data:image/png;base64,AA", degraded: false, overflow: false, lowRes: false },
    }));
    expect(html).toContain('data-testid="format-focus-back"');
    expect(html).toMatch(/data-testid="format-focus-download"[^>]*download="[^"]*story-1080x1920\.png"/);
  });
});
```

- [ ] **Step 2: Lancer le test pour le voir échouer**

```bash
bun test tests/studio-format-focus.test.ts
```

Attendu : ÉCHEC — `Cannot find module '@/components/studio/render/format-focus'`.

- [ ] **Step 3: Écrire le composant**

Créer `components/studio/render/format-focus.tsx` :

```tsx
"use client";

import { useEffect, useMemo, useRef } from "react";
import { ArrowLeft, Download, Maximize2, Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { usePreview, type PreviewState } from "@/hooks/use-preview";
import { sceneForFormat } from "@/lib/studio/relayout";
import { formatNavAction, zoomStep, type PreservedView } from "@/lib/studio/studio-mode";
import { FORMAT_PRESETS, FORMAT_KEYS, type FormatKey } from "@/lib/studio/formats";
import { previewFileName } from "./export";
import type { TileOutcome } from "./proof-sheet";
import type { Scene } from "@/lib/studio/scene";

// components/studio/render/format-focus.tsx — UN format, en grand, zoomable et exportable.
//
// LE défaut d'origine que ce fichier corrige : l'ancienne grande case était un <PreviewPane>, qui
// imposait `aspectRatio: canvas.width/height` à sa boîte image, LUI-MÊME enveloppé dans un
// `width:100%;height:100%` sous `overflow-hidden`. Pour une story (1080×1920) la boîte calculait
// 1,78× la largeur du conteneur en hauteur : rognée, jamais ajustée. « Ajuster à l'écran »
// n'ajustait pas.
//
// Le correctif n'est pas un calcul plus malin, c'est la SUPPRESSION des deux règles imbriquées : en
// mode « fit », un simple `object-contain` dans un conteneur `flex-1 min-h-0` ajuste correctement,
// sans la moindre mesure JS. Le zoom explicite, lui, pose une largeur en pixels et laisse défiler.
export interface FormatFocusProps {
  templateId: string;
  scene: Scene;
  nativeFormat: FormatKey;
  format: FormatKey;
  articleId: string | null;
  disabled?: boolean;
  view: PreservedView;
  onViewChange: (view: PreservedView) => void;
  onExit: () => void;
  onFormatChange: (format: FormatKey) => void;
  /** Résultats connus de la planche — alimente les puces d'alerte de la bande de formats. */
  outcomes: Partial<Record<FormatKey, TileOutcome>>;
  // Amorce de test UNIQUEMENT — même convention que RenderModeProps.initialDegraded.
  initialState?: PreviewState;
}

export function FormatFocus({
  templateId, scene, nativeFormat, format, articleId, disabled,
  view, onViewChange, onExit, onFormatChange, outcomes, initialState,
}: FormatFocusProps) {
  const preset = FORMAT_PRESETS[format];
  const variant = useMemo(
    () => sceneForFormat(scene, format, nativeFormat),
    [scene, format, nativeFormat],
  );
  const live = usePreview({ templateId, scene: variant, format, articleId, enabled: !disabled });
  const state = initialState ?? live.state;

  // ← / → / Échap. La DÉCISION vit dans lib/studio/studio-mode.ts (pure, testée sans DOM) ; ce
  // composant ne fait que traduire l'événement réel du navigateur en littéral avant de l'interroger.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as (HTMLElement | null);
      const action = formatNavAction({
        key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey,
        target: target ? { tagName: target.tagName, isContentEditable: target.isContentEditable } : null,
      });
      if (action === null) return;
      e.preventDefault();
      if (action === "exit") { onExit(); return; }
      const index = FORMAT_KEYS.indexOf(format);
      const next = action === "next"
        ? (index + 1) % FORMAT_KEYS.length
        : (index - 1 + FORMAT_KEYS.length) % FORMAT_KEYS.length;
      onFormatChange(FORMAT_KEYS[next]!);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [format, onExit, onFormatChange]);

  // Défilement : ÉCRAN -> état à chaque défilement, état -> ÉCRAN seulement au changement de format
  // ou de zoom — jamais à chaque rendu, sous peine de figer le défilement natif du navigateur en
  // réécrivant sa position à chaque frappe ailleurs dans l'éditeur.
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollLeft = view.scrollX;
    el.scrollTop = view.scrollY;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [format, view.zoom]);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    onViewChange({ ...view, scrollX: el.scrollLeft, scrollY: el.scrollTop });
  }

  const dataUri = state.status === "ready" ? state.dataUri : null;
  const isFit = view.zoom === "fit";
  const pixelWidth = isFit ? null : Math.round(preset.width * (view.zoom as number));

  return (
    <div
      data-testid="format-focus" data-format={format}
      className="flex min-h-0 flex-1 flex-col gap-2"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button" variant="ghost" size="sm"
          data-testid="format-focus-back" onClick={onExit}
        >
          <ArrowLeft />Planche
        </Button>
        <span className="text-sm font-medium">{preset.label}</span>
        <span className="text-xs text-muted-foreground">{preset.width}×{preset.height}</span>

        <div className="ml-auto flex items-center gap-1 rounded-lg border p-0.5" data-testid="format-focus-zoom">
          <Button
            type="button" variant={isFit ? "secondary" : "ghost"} size="icon-sm"
            title="Ajuster à l'écran" data-action="zoom-fit"
            onClick={() => onViewChange({ ...view, zoom: "fit" })}
          >
            <Maximize2 />
          </Button>
          <Button
            type="button" variant="ghost" size="icon-sm"
            title="Réduire" data-action="zoom-out"
            onClick={() => onViewChange({ ...view, zoom: zoomStep(view.zoom, -1) })}
          >
            <Minus />
          </Button>
          <span className="min-w-10 text-center text-xs tabular-nums text-muted-foreground">
            {isFit ? "Ajusté" : `${Math.round((view.zoom as number) * 100)} %`}
          </span>
          <Button
            type="button" variant="ghost" size="icon-sm"
            title="Agrandir — jamais au-delà de 100 % : au-dessus des pixels natifs, on inspecterait un agrandissement, pas une typographie."
            data-action="zoom-in"
            onClick={() => onViewChange({ ...view, zoom: zoomStep(view.zoom, 1) })}
          >
            <Plus />
          </Button>
        </div>

        {dataUri !== null && (
          <a
            data-testid="format-focus-download"
            href={dataUri} download={previewFileName(templateId, format)}
            title={`Télécharger ${preset.label} en PNG`}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <Download className="size-4" />PNG
          </a>
        )}
      </div>

      <div className="flex gap-1 overflow-x-auto pb-1" data-testid="format-focus-strip">
        {FORMAT_KEYS.map((key) => {
          const o = outcomes[key];
          const flagged = o?.overflow === true || o?.lowRes === true;
          return (
            <button
              key={key} type="button"
              data-testid="format-focus-pill" data-format={key}
              onClick={() => onFormatChange(key)}
              className={cn(
                "flex shrink-0 items-center gap-1 rounded-4xl px-2 py-0.5 text-[11px] transition-colors",
                key === format ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/60",
              )}
            >
              {FORMAT_PRESETS[key].label}
              {flagged && (
                <span
                  data-testid="format-focus-pill-dot" data-format={key}
                  className="size-1.5 rounded-4xl bg-amber-600 dark:bg-amber-500"
                />
              )}
            </button>
          );
        })}
      </div>

      {state.status === "ready" && state.degraded && (
        <Badge variant="secondary" data-testid="format-focus-degraded">
          Rendu dégradé — une police est repliée sur la police par défaut.
        </Badge>
      )}
      {state.status === "ready" && state.overflow && (
        <p className="text-xs text-amber-600 dark:text-amber-500" data-testid="format-focus-overflow">
          Un texte contraint dépasse sa limite de lignes dans ce format : il risque de déborder du
          cadre. Mesure faite avec la police de repli — approximative si ce calque porte une police
          personnalisée.
        </p>
      )}
      {state.status === "ready" && state.lowRes && (
        <p className="text-xs text-amber-600 dark:text-amber-500" data-testid="format-focus-lowres">
          La photo source est plus petite que son cadre dans ce format : elle est agrandie, donc
          floue. Réduire le cadre ou fournir une image plus grande — aucun réglage du gabarit ne peut
          compenser.
        </p>
      )}

      <div
        ref={scrollRef} onScroll={handleScroll}
        className={cn(
          "min-h-0 flex-1 rounded-xl bg-[var(--canvas-backdrop)] p-4",
          isFit ? "flex items-center justify-center overflow-hidden" : "overflow-auto",
        )}
      >
        {/* En « fit » : AUCUNE largeur imposée, AUCUN aspect-ratio — `object-contain` dans ce
            conteneur flex ajuste seul. En zoom : une largeur en pixels, et le conteneur défile. */}
        <div
          data-testid="format-focus-surface"
          className={isFit ? "flex h-full w-full items-center justify-center" : undefined}
          style={pixelWidth === null ? undefined : { width: pixelWidth }}
        >
          {dataUri !== null && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={dataUri} alt={`Rendu — ${preset.label}`}
              className={isFit ? "max-h-full max-w-full object-contain" : "w-full"}
            />
          )}
          {state.status === "loading" && (
            <span className="text-xs text-muted-foreground">Génération du rendu…</span>
          )}
          {state.status === "idle" && <span className="text-xs text-muted-foreground">En attente…</span>}
          {state.status === "error" && (
            <p className="p-3 text-center text-xs text-destructive">{state.message}</p>
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Ajouter le test à la voie parallèle**

Dans `scripts/test-fast.ts`, ajouter `"studio-format-focus.test.ts",` au `Set` `PURE_FILES`, en respectant l'ordre alphabétique.

- [ ] **Step 5: Lancer les tests**

```bash
bun test tests/studio-format-focus.test.ts
```

Attendu : PASS.

- [ ] **Step 6: Commit**

```bash
git add components/studio/render/format-focus.tsx tests/studio-format-focus.test.ts scripts/test-fast.ts
git commit -m "feat(studio): vue d'inspection d'un format, fit réellement ajusté"
```

---

### Task 6: Le routeur et la barre d'outils (`render-mode.tsx`)

**Files:**
- Modify: `components/studio/render-mode.tsx` (réécriture complète)
- Modify: `tests/studio-render-mode.test.ts` (réécriture)

**Interfaces:**
- Consumes: `ProofSheet`/`TileOutcome` (Tâche 4), `FormatFocus` (Tâche 5), `focusedFormat` (Tâche 2), `ARTICLE_SELECTABLE_CONTEXTS` (`preview-pane.tsx`).
- Produces: `RenderModeProps` conservant `templateId, context, scene, format, articles, disabled, view, onViewChange` — **`initialDegraded`, `initialStale` et `initialOverflowFormats` disparaissent**, remplacés par `initialOutcomes?: Partial<Record<FormatKey, TileOutcome>>`.
- `data-testid` posés : `render-mode`, `render-toolbar`, `render-article-select`, `render-sample-chip`, `render-warning-summary`, `render-refresh-all`.

- [ ] **Step 1: Réécrire le test**

Remplacer intégralement `tests/studio-render-mode.test.ts`. Conserver `fixtureScene` tel quel, puis :

```ts
import { describe, it, expect } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RenderMode, type RenderModeProps } from "@/components/studio/render-mode";
import { sceneForFormat } from "@/lib/studio/relayout";
import { parseScene, type Scene } from "@/lib/studio/scene";
import { FORMAT_KEYS, type FormatKey } from "@/lib/studio/formats";
import { relayoutToFormat } from "@/lib/studio/relayout";
import type { PreservedView } from "@/lib/studio/studio-mode";

// (fixtureScene() — inchangée, reprise du fichier d'origine)

function props(overrides?: Partial<RenderModeProps>): RenderModeProps {
  const view: PreservedView = { selectedId: null, zoom: "fit", scrollX: 0, scrollY: 0 };
  return {
    templateId: "11111111-1111-1111-1111-111111111111",
    context: "article_image", scene: fixtureScene(), format: "ig_portrait",
    view, onViewChange: () => {},
    ...overrides,
  };
}

const render = (p: RenderModeProps) => renderToStaticMarkup(React.createElement(RenderMode, p));

describe("RenderMode — routeur planche ⇄ inspection", () => {
  it("`selectedId: null` ouvre la PLANCHE, pas une inspection", () => {
    const html = render(props());
    expect(html).toContain('data-testid="proof-sheet"');
    expect(html).not.toContain('data-testid="format-focus"');
  });

  it("une clé de format ouvre l'inspection de CE format, et referme la planche", () => {
    const view: PreservedView = { selectedId: "story", zoom: "fit", scrollX: 0, scrollY: 0 };
    const html = render(props({ view }));
    expect(html).toMatch(/data-testid="format-focus"[^>]*data-format="story"/);
    expect(html).not.toContain('data-testid="proof-sheet"');
  });

  it("une valeur qui n'est pas un format retombe sur la planche plutôt que de faire planter le composant", () => {
    const view: PreservedView = { selectedId: "layer-42", zoom: "fit", scrollX: 0, scrollY: 0 };
    expect(render(props({ view }))).toContain('data-testid="proof-sheet"');
  });

  it("ne rend NI rail NI panneau accosté NI inspecteur — le rendu prend tout l'espace", () => {
    const html = render(props());
    expect(html).not.toContain('data-testid="editor-rail"');
    expect(html).not.toContain('data-testid="panel-host"');
  });
});

describe("RenderMode — provenance", () => {
  it("un contexte éligible AVEC articles affiche le sélecteur, qui pilote toute la planche", () => {
    const html = render(props({
      context: "article_image",
      articles: [{ id: "a1", title: "Un article" }],
    }));
    expect(html).toContain('data-testid="render-article-select"');
  });

  it("un contexte à saisie manuelle n'a pas de sélecteur mais dit d'où viennent les valeurs", () => {
    const html = render(props({ context: "quote_card", articles: [] }));
    expect(html).not.toContain('data-testid="render-article-select"');
    expect(html).toContain('data-testid="render-sample-chip"');
  });

  it("ne porte PLUS les deux paragraphes de provenance de l'ancienne version — le sélecteur pilote les huit tuiles, il n'y a plus rien à démentir", () => {
    const html = render(props({ context: "article_image", articles: [{ id: "a1", title: "Un article" }] }));
    expect(html).not.toContain("quel que soit l'article choisi");
    expect(html).not.toContain('data-testid="render-filmstrip-provenance"');
  });
});

describe("RenderMode — agrégation des alertes", () => {
  it("aucune pastille quand rien n'est signalé", () => {
    const html = render(props({
      initialOutcomes: Object.fromEntries(
        FORMAT_KEYS.map((k) => [k, { ready: true, overflow: false, lowRes: false }]),
      ) as Partial<Record<FormatKey, { ready: boolean; overflow: boolean; lowRes: boolean }>>,
    }));
    expect(html).not.toContain('data-testid="render-warning-summary"');
  });

  // Le texte de la pastille ne suit PAS immédiatement le `>` du bouton : une icône <svg> le
  // précède. Un `([^<]*)` naïf capturerait donc la chaîne vide et TOUTES les assertions
  // ci-dessous passeraient sur `expect("").toContain(…)` — non : elles échoueraient, mais
  // pour la mauvaise raison, et un `toMatch` mal ancré pourrait tout aussi bien passer à tort.
  // On extrait le contenu complet du bouton, puis on en retire les balises.
  function summaryText(html: string): string {
    const opened = html.indexOf('data-testid="render-warning-summary"');
    if (opened === -1) return "";
    const bodyStart = html.indexOf(">", opened) + 1;
    const bodyEnd = html.indexOf("</button>", bodyStart);
    return html.slice(bodyStart, bodyEnd).replace(/<[^>]*>/g, "").trim();
  }

  it("compte les formats signalés — pas les alertes, un format à deux alertes compte pour un", () => {
    const html = render(props({
      initialOutcomes: {
        story: { ready: true, overflow: true, lowRes: true },
        fb_link: { ready: true, overflow: true, lowRes: false },
      },
    }));
    expect(summaryText(html)).toMatch(/^2 formats à vérifier/);
  });

  it("se QUALIFIE tant que les huit formats ne sont pas rendus — compter une tuile jamais rendue comme saine serait un mensonge", () => {
    const html = render(props({
      initialOutcomes: {
        story: { ready: true, overflow: true, lowRes: false },
        fb_link: { ready: true, overflow: false, lowRes: false },
      },
    }));
    expect(summaryText(html)).toBe("1 format à vérifier sur 2 rendus");
  });

  it("laisse tomber la qualification une fois les huit formats rendus", () => {
    const outcomes = Object.fromEntries(
      FORMAT_KEYS.map((k) => [k, { ready: true, overflow: k === "story", lowRes: false }]),
    ) as Partial<Record<FormatKey, { ready: boolean; overflow: boolean; lowRes: boolean }>>;
    expect(summaryText(render(props({ initialOutcomes: outcomes })))).toBe("1 format à vérifier");
  });
});

describe("sceneForFormat", () => {
  it("est l'identité EXACTE au format d'accueil", () => {
    const scene = fixtureScene();
    expect(sceneForFormat(scene, "ig_portrait", "ig_portrait")).toBe(scene);
  });

  it("délègue à relayoutToFormat pour tout autre format — jamais une seconde implémentation qui pourrait diverger", () => {
    const scene = fixtureScene();
    expect(sceneForFormat(scene, "story", "ig_portrait")).toEqual(relayoutToFormat(scene, "story"));
  });
});
```

- [ ] **Step 2: Lancer le test pour le voir échouer**

```bash
bun test tests/studio-render-mode.test.ts
```

Attendu : ÉCHEC — `proof-sheet` absent, `initialOutcomes` inconnu de `RenderModeProps`.

- [ ] **Step 3: Réécrire `components/studio/render-mode.tsx`**

Remplacer intégralement le contenu par :

```tsx
"use client";

import { useCallback, useState } from "react";
import { RefreshCw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ProofSheet, type TileOutcome } from "./render/proof-sheet";
import { FormatFocus } from "./render/format-focus";
import { ARTICLE_SELECTABLE_CONTEXTS } from "./preview-pane";
import { downloadAllFormats } from "./render/export";
import { previewCache } from "@/lib/studio/preview-cache";
import { focusedFormat, type PreservedView } from "@/lib/studio/studio-mode";
import { FORMAT_KEYS, type FormatKey } from "@/lib/studio/formats";
import type { Scene } from "@/lib/studio/scene";
import type { TemplateContext } from "@/lib/studio/tokens";
import type { PreviewArticleOption } from "@/lib/queries/studio";

// components/studio/render-mode.tsx — « Rendu réel », le second mode de l'éditeur : aucun rail,
// aucun panneau accosté, aucune colonne de propriétés (editor-shell.tsx ne rend rien de tout cela
// sous `mode === "rendu"`).
//
// Ce fichier n'est plus qu'un ROUTEUR et une barre d'outils. Toute la matière vit dans ses deux
// enfants : render/proof-sheet.tsx (la planche des huit formats) et render/format-focus.tsx
// (l'inspection d'un format). `view.selectedId` décide lequel des deux est monté — voir
// `focusedFormat` (lib/studio/studio-mode.ts), le seul lecteur autorisé de ce champ ici.
//
// CE QUI A DISPARU avec la refonte, et pourquoi :
//   - la « grande case » qui était un <PreviewPane> complet : elle apportait un SECOND en-tête, un
//     SECOND badge « dégradé », son propre bouton Actualiser et son propre sélecteur d'article,
//     imbriqués dans ceux de ce fichier ;
//   - l'état `stale` / le badge « Périmé » / le bouton « ↻ rendre » : une scène modifiée produit
//     désormais une clé de cache différente (lib/studio/preview-cache.ts), donc une tuile est soit à
//     jour, soit en cours de chargement. Un seul modèle de fraîcheur, plus deux ;
//   - les deux paragraphes de provenance : le sélecteur d'article pilote maintenant LES HUIT tuiles,
//     il n'y a donc plus d'écart à démentir en toutes lettres.
const SAMPLE_OPTION = "__sample__";

export interface RenderModeProps {
  templateId: string;
  context: TemplateContext;
  scene: Scene;
  /** Format NATIF du gabarit (render_templates.format) — celui qui porte le marqueur « natif ». */
  format: FormatKey;
  articles?: PreviewArticleOption[];
  disabled?: boolean;
  /** État de vue partagé avec le mode Montage (lib/studio/studio-mode.ts#PreservedView). ICI,
   *  `selectedId` porte le format FOCALISÉ (`null` = la planche) et `zoom`/`scrollX`/`scrollY` la
   *  vue d'inspection. Contrôlé par l'appelant (editor-shell.tsx) — JAMAIS de useState interne pour
   *  ces quatre champs : c'est ce qui les fait survivre à un aller-retour de mode, puisque rien
   *  d'eux ne vit dans cet arbre. */
  view: PreservedView;
  onViewChange: (view: PreservedView) => void;
  // Amorce de test UNIQUEMENT — la vraie composition ne la fournit JAMAIS. `react-dom/server`
  // n'exécute aucun effet, donc aucun résultat de tuile n'existe à un rendu statique.
  initialOutcomes?: Partial<Record<FormatKey, TileOutcome>>;
}

export function RenderMode({
  templateId, context, scene, format, articles, disabled, view, onViewChange, initialOutcomes,
}: RenderModeProps) {
  const focused = focusedFormat(view);
  const [articleId, setArticleId] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<Partial<Record<FormatKey, TileOutcome>>>(
    initialOutcomes ?? {},
  );
  const [exporting, setExporting] = useState<{ done: number; total: number } | null>(null);

  const handleTileOutcome = useCallback((key: FormatKey, outcome: TileOutcome) => {
    setOutcomes((prev) => {
      const before = prev[key];
      if (before !== undefined && before.ready === outcome.ready
        && before.overflow === outcome.overflow && before.lowRes === outcome.lowRes) return prev;
      return { ...prev, [key]: outcome };
    });
  }, []);

  // Ne compte QUE les formats dont le rendu a abouti. Une tuile jamais entrée dans le viewport n'a
  // rien à déclarer : la compter comme saine serait un mensonge, la compter comme suspecte aussi.
  // Tant que les huit ne sont pas connus, la pastille se qualifie (« … sur 5 rendus ») — c'est la
  // conséquence directe du gating de visibilité, et la dire est plus honnête que la masquer.
  const rendered = FORMAT_KEYS.filter((k) => outcomes[k]?.ready === true);
  const flagged = rendered.filter((k) => outcomes[k]!.overflow || outcomes[k]!.lowRes);
  const allRendered = rendered.length === FORMAT_KEYS.length;

  const showArticlePicker = ARTICLE_SELECTABLE_CONTEXTS.includes(context) && !!articles?.length;

  function focusFormat(key: FormatKey) {
    onViewChange({ ...view, selectedId: key, zoom: "fit", scrollX: 0, scrollY: 0 });
  }

  function exitFocus() {
    onViewChange({ ...view, selectedId: null });
  }

  // Purge les entrées de la scène courante puis laisse les tuiles visibles se relancer. Le seul cas
  // qu'un hachage de scène ne peut pas voir : une image source modifiée à distance, dont l'URL n'a
  // pas changé.
  function refreshAll() {
    previewCache.clear();
    setOutcomes({});
  }

  async function exportAll() {
    setExporting({ done: 0, total: FORMAT_KEYS.length });
    try {
      await downloadAllFormats({
        templateId, scene, nativeFormat: format, articleId,
        onProgress: (done, total) => setExporting({ done, total }),
      });
    } finally {
      setExporting(null);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-3" data-testid="render-mode">
      <div className="flex flex-wrap items-center gap-2" data-testid="render-toolbar">
        {showArticlePicker ? (
          <Select
            value={articleId ?? SAMPLE_OPTION} disabled={disabled}
            onValueChange={(v) => setArticleId(v === SAMPLE_OPTION ? null : v)}
          >
            <SelectTrigger className="w-full sm:w-64" data-testid="render-article-select">
              {/* Base UI ne dérive PAS le libellé affiché du <SelectItem> correspondant — il faut le
                  mapper explicitement, même correctif que preview-pane.tsx. */}
              <SelectValue placeholder="Valeurs d'exemple">
                {(v: string | null) => (v && v !== SAMPLE_OPTION
                  ? articles!.find((a) => a.id === v)?.title ?? v
                  : "Valeurs d'exemple")}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={SAMPLE_OPTION}>Valeurs d&rsquo;exemple</SelectItem>
              {articles!.map((a) => <SelectItem key={a.id} value={a.id}>{a.title}</SelectItem>)}
            </SelectContent>
          </Select>
        ) : (
          <span
            data-testid="render-sample-chip"
            className="rounded-4xl bg-muted px-2 py-0.5 text-xs text-muted-foreground"
          >
            Valeurs d&rsquo;exemple
          </span>
        )}

        {flagged.length > 0 && (
          <button
            type="button"
            data-testid="render-warning-summary"
            onClick={() => focusFormat(flagged[0]!)}
            title="Ouvrir le premier format signalé"
            className="inline-flex h-8 items-center gap-1.5 rounded-4xl bg-amber-600/15 px-2.5 text-xs text-amber-700 transition-colors hover:bg-amber-600/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 dark:text-amber-500"
          >
            <TriangleAlert className="size-3.5" />
            {allRendered
              ? `${flagged.length} format${flagged.length > 1 ? "s" : ""} à vérifier`
              : `${flagged.length} format${flagged.length > 1 ? "s" : ""} à vérifier sur ${rendered.length} rendu${rendered.length > 1 ? "s" : ""}`}
          </button>
        )}

        <div className="ml-auto flex items-center gap-1">
          <Button
            type="button" variant="outline" size="sm"
            data-testid="render-refresh-all" data-action="refresh-all"
            disabled={disabled} onClick={refreshAll}
            title="Refaire tous les rendus — utile si une image source a changé sans que son URL change."
          >
            <RefreshCw />Actualiser
          </Button>
          <Button
            type="button" variant="outline" size="sm"
            data-testid="render-export-all"
            disabled={disabled || exporting !== null} onClick={() => void exportAll()}
          >
            {exporting === null ? "Tout télécharger" : `${exporting.done}/${exporting.total}`}
          </Button>
        </div>
      </div>

      {focused === null ? (
        <ProofSheet
          templateId={templateId} scene={scene} nativeFormat={format} articleId={articleId}
          disabled={disabled} onFocus={focusFormat} onTileOutcome={handleTileOutcome}
          initialOutcomes={initialOutcomes}
        />
      ) : (
        <FormatFocus
          templateId={templateId} scene={scene} nativeFormat={format} format={focused}
          articleId={articleId} disabled={disabled}
          view={view} onViewChange={onViewChange}
          onExit={exitFocus} onFormatChange={focusFormat}
          outcomes={outcomes}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 4: Lancer les tests**

```bash
bun test tests/studio-render-mode.test.ts
```

Attendu : PASS. `downloadAllFormats` n'existe pas encore — l'import échouera : passer à la Tâche 7 **puis** revenir lancer cette commande. Pour garder cette tâche autonome, créer d'abord dans `components/studio/render/export.ts` la signature minimale que la Tâche 7 remplit :

```ts
export async function downloadAllFormats(_input: {
  templateId: string; scene: Scene; nativeFormat: FormatKey; articleId: string | null;
  onProgress: (done: number, total: number) => void;
}): Promise<void> {
  throw new Error("Non implémenté — voir la Tâche 7.");
}
```

(les imports de type `Scene`/`FormatKey` sont à ajouter en tête de `export.ts`).

- [ ] **Step 5: Commit**

```bash
git add components/studio/render-mode.tsx components/studio/render/export.ts tests/studio-render-mode.test.ts
git commit -m "feat(studio): routeur planche/inspection et barre d'outils unifiée"
```

---

### Task 7: Export PNG

**Files:**
- Modify: `components/studio/render/export.ts`
- Create: `tests/studio-render-export.test.ts`
- Modify: `scripts/test-fast.ts` (`PURE_FILES`)

**Interfaces:**
- Consumes: `previewFileName` (Tâche 4), `previewCache`/`previewCacheKey` (Tâche 1), `sceneForFormat` (Tâche 2), `previewTemplate`.
- Produces:
  - `previewFileName(templateId: string, format: FormatKey): string` (déjà présente)
  - `downloadAllFormats(input: { templateId; scene; nativeFormat; articleId; onProgress; deps? }): Promise<void>`
  - `type ExportDeps = { render: (format: FormatKey) => Promise<string | null>; save: (dataUri: string, fileName: string) => void; delay: (ms: number) => Promise<void> }` — injection permettant de tester l'orchestration **sans DOM et sans réseau**.

- [ ] **Step 1: Écrire le test qui échoue**

Créer `tests/studio-render-export.test.ts` :

```ts
import { describe, it, expect } from "bun:test";
import { previewFileName, downloadAllFormats, type ExportDeps } from "@/components/studio/render/export";
import { parseScene, type Scene } from "@/lib/studio/scene";
import { FORMAT_KEYS, type FormatKey } from "@/lib/studio/formats";

function fixtureScene(): Scene {
  return parseScene({
    schemaVersion: 1,
    canvas: { width: 1080, height: 1350, background: "#101010" },
    layers: [],
  });
}

const TPL = "11111111-1111-1111-1111-111111111111";

describe("previewFileName", () => {
  it("porte le format ET ses dimensions — huit PNG du même gabarit doivent rester distinguables sans les ouvrir", () => {
    expect(previewFileName(TPL, "story")).toBe(`${TPL}-story-1080x1920.png`);
    expect(previewFileName(TPL, "fb_link")).toBe(`${TPL}-fb_link-1200x630.png`);
  });

  it("ne produit jamais deux noms identiques pour deux formats différents", () => {
    const names = new Set(FORMAT_KEYS.map((f) => previewFileName(TPL, f)));
    expect(names.size).toBe(FORMAT_KEYS.length);
  });
});

describe("downloadAllFormats", () => {
  function spyDeps(failing: FormatKey[] = []): ExportDeps & { saved: string[]; delays: number[] } {
    const saved: string[] = [];
    const delays: number[] = [];
    return {
      saved, delays,
      render: async (format) => (failing.includes(format) ? null : `data:image/png;base64,${format}`),
      save: (_dataUri, fileName) => { saved.push(fileName); },
      delay: async (ms) => { delays.push(ms); },
    };
  }

  it("télécharge un fichier par format", async () => {
    const deps = spyDeps();
    await downloadAllFormats({
      templateId: TPL, scene: fixtureScene(), nativeFormat: "ig_portrait", articleId: null,
      onProgress: () => {}, deps,
    });
    expect(deps.saved).toHaveLength(FORMAT_KEYS.length);
    expect(deps.saved).toContain(previewFileName(TPL, "story"));
  });

  it("espace les téléchargements — un navigateur qui en reçoit huit d'un coup en avale une partie", async () => {
    const deps = spyDeps();
    await downloadAllFormats({
      templateId: TPL, scene: fixtureScene(), nativeFormat: "ig_portrait", articleId: null,
      onProgress: () => {}, deps,
    });
    expect(deps.delays.length).toBeGreaterThanOrEqual(FORMAT_KEYS.length - 1);
    expect(deps.delays.every((d) => d > 0)).toBe(true);
  });

  it("rapporte une progression qui atteint réellement le total", async () => {
    const seen: Array<[number, number]> = [];
    await downloadAllFormats({
      templateId: TPL, scene: fixtureScene(), nativeFormat: "ig_portrait", articleId: null,
      onProgress: (done, total) => seen.push([done, total]), deps: spyDeps(),
    });
    expect(seen[seen.length - 1]).toEqual([FORMAT_KEYS.length, FORMAT_KEYS.length]);
  });

  it("un format qui échoue à rendre est SAUTÉ, sans interrompre les autres", async () => {
    const deps = spyDeps(["story"]);
    await downloadAllFormats({
      templateId: TPL, scene: fixtureScene(), nativeFormat: "ig_portrait", articleId: null,
      onProgress: () => {}, deps,
    });
    expect(deps.saved).toHaveLength(FORMAT_KEYS.length - 1);
    expect(deps.saved).not.toContain(previewFileName(TPL, "story"));
  });
});
```

- [ ] **Step 2: Lancer le test pour le voir échouer**

```bash
bun test tests/studio-render-export.test.ts
```

Attendu : ÉCHEC — `ExportDeps` n'est pas exporté / `downloadAllFormats` lève « Non implémenté ».

- [ ] **Step 3: Compléter `components/studio/render/export.ts`**

Remplacer le corps du fichier (en conservant `previewFileName` à l'identique) par :

```ts
import { previewTemplate } from "@/lib/actions/studio-preview-actions";
import { previewCache, previewCacheKey } from "@/lib/studio/preview-cache";
import { sceneForFormat } from "@/lib/studio/relayout";
import { FORMAT_PRESETS, FORMAT_KEYS, type FormatKey } from "@/lib/studio/formats";
import type { Scene } from "@/lib/studio/scene";

// components/studio/render/export.ts — nommage et orchestration des exports PNG du mode Rendu réel.
//
// Aucun zip : un fichier unique exigerait une dépendance (jszip) pour un gain qui ne le justifie pas
// à huit fichiers. On enchaîne donc huit téléchargements espacés — un navigateur qui en reçoit huit
// dans la même frame en avale silencieusement une partie. Chrome demande une confirmation unique
// pour les téléchargements multiples : c'est un fait à connaître, pas un motif d'y renoncer.
const DOWNLOAD_SPACING_MS = 150;

export function previewFileName(templateId: string, format: FormatKey): string {
  const preset = FORMAT_PRESETS[format];
  return `${templateId}-${format}-${preset.width}x${preset.height}.png`;
}

// Les trois effets de bord de cet orchestrateur — rendre, enregistrer, attendre — sont INJECTABLES.
// C'est ce qui rend la logique d'enchaînement (ordre, espacement, progression, saut d'un échec)
// testable sans DOM ni réseau, dans la voie parallèle. La vraie composition ne les fournit jamais.
export type ExportDeps = {
  render: (format: FormatKey) => Promise<string | null>;
  save: (dataUri: string, fileName: string) => void;
  delay: (ms: number) => Promise<void>;
};

export async function downloadAllFormats(input: {
  templateId: string;
  scene: Scene;
  nativeFormat: FormatKey;
  articleId: string | null;
  onProgress: (done: number, total: number) => void;
  deps?: ExportDeps;
}): Promise<void> {
  const { templateId, scene, nativeFormat, articleId, onProgress } = input;
  const deps = input.deps ?? defaultDeps(templateId, scene, nativeFormat, articleId);
  const total = FORMAT_KEYS.length;

  for (let i = 0; i < FORMAT_KEYS.length; i++) {
    const format = FORMAT_KEYS[i]!;
    const dataUri = await deps.render(format);
    // Un format qui échoue est SAUTÉ : sept exports valides valent mieux qu'un abandon global à
    // cause du huitième.
    if (dataUri !== null) deps.save(dataUri, previewFileName(templateId, format));
    onProgress(i + 1, total);
    if (i < FORMAT_KEYS.length - 1) await deps.delay(DOWNLOAD_SPACING_MS);
  }
}

function defaultDeps(
  templateId: string, scene: Scene, nativeFormat: FormatKey, articleId: string | null,
): ExportDeps {
  return {
    // Réutilise le mémo : les formats déjà affichés sur la planche ne sont pas re-rendus, seuls les
    // manquants coûtent un aller-retour.
    render: async (format) => {
      const variant = sceneForFormat(scene, format, nativeFormat);
      const key = previewCacheKey(templateId, variant, format, articleId);
      const hit = previewCache.get(key);
      if (hit) return hit.dataUri;
      const res = await previewTemplate({
        templateId, scene: variant, format, articleId: articleId ?? undefined,
      });
      if (!res.ok) return null;
      previewCache.set(key, {
        dataUri: res.dataUri, degraded: res.degraded,
        overflowingLayerIds: res.overflowingLayerIds, lowResLayerIds: res.lowResLayerIds,
      });
      return res.dataUri;
    },
    save: (dataUri, fileName) => {
      const a = document.createElement("a");
      a.href = dataUri;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
    },
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}
```

- [ ] **Step 4: Ajouter le test à la voie parallèle**

Dans `scripts/test-fast.ts`, ajouter `"studio-render-export.test.ts",` au `Set` `PURE_FILES`, en respectant l'ordre alphabétique.

- [ ] **Step 5: Lancer les tests**

```bash
bun test tests/studio-render-export.test.ts tests/studio-render-mode.test.ts
```

Attendu : PASS pour les deux.

- [ ] **Step 6: Commit**

```bash
git add components/studio/render/export.ts tests/studio-render-export.test.ts scripts/test-fast.ts
git commit -m "feat(studio): export PNG par format et téléchargement des huit"
```

---

### Task 8: Rendu réel jusqu'au mobile

**Files:**
- Modify: `components/studio/editor-shell.tsx` (~ligne 805 et ~ligne 991)
- Modify: `components/studio/mode-switch.tsx`
- Modify: `tests/studio-editor-shell.test.ts`
- Modify: `tests/studio-mode-switch.test.ts`

**Interfaces:**
- Consumes: `RenderMode` (Tâche 6), `useEditorLayout` (existant).
- Produces: `ModeSwitchProps` gagne `montageDisabled?: boolean`.

- [ ] **Step 1: Écrire les tests qui échouent**

Ajouter à `tests/studio-mode-switch.test.ts`. **Le sélecteur est `data-action="mode-montage"`** — `mode-switch.tsx` ne pose aucun `data-mode` :

```ts
describe("ModeSwitch — Montage indisponible sous 768px", () => {
  it("désactive le côté Montage et dit pourquoi", () => {
    const html = renderToStaticMarkup(
      React.createElement(ModeSwitch, { mode: "rendu" as const, onChange: () => {}, montageDisabled: true }),
    );
    const montage = html.match(/<button[^>]*data-action="mode-montage"[^>]*>/)![0];
    expect(montage).toContain("disabled");
    expect(montage).toMatch(/écran plus large/);
  });

  it("laisse le côté Montage actif par défaut — la prop est additive", () => {
    const html = renderToStaticMarkup(
      React.createElement(ModeSwitch, { mode: "montage" as const, onChange: () => {} }),
    );
    const montage = html.match(/<button[^>]*data-action="mode-montage"[^>]*>/)![0];
    expect(montage).not.toContain("disabled");
  });

  it("le côté « Rendu réel » n'est JAMAIS désactivé — c'est précisément lui qui doit rester atteignable", () => {
    const html = renderToStaticMarkup(
      React.createElement(ModeSwitch, { mode: "montage" as const, onChange: () => {}, montageDisabled: true }),
    );
    const rendu = html.match(/<button[^>]*data-action="mode-rendu"[^>]*>/)![0];
    expect(rendu).not.toContain("disabled");
  });
});
```

Ajouter à `tests/studio-editor-shell.test.ts`, **dans le `describe` réactif existant** (« EditorShell — réactif : editorLayoutMode pilote la composition réellement montée »), afin de réutiliser son `installDom()`/`installLayoutTestGlobals()` et son helper `mountAtWidth(px)`. Ce fichier est un test **DOM** (jsdom + `act`), pas un rendu statique : les cas ci-dessous sont `async` et interrogent `container.querySelector`, comme ses voisins.

```ts
  it("700px + Rendu réel : la planche remplace TooSmallState — une grille d'images n'a besoin ni de rail ni d'inspecteur", async () => {
    const { container, unmount } = await mountAtWidth(700);

    // On part de Montage (l'état initial de la coque) : TooSmallState, comme le test voisin l'exige.
    expect(container.querySelector('[data-testid="editor-too-small"]')).not.toBeNull();

    // Le ModeSwitch DOIT rester monté ici, sans quoi ce clic serait impossible — et Rendu réel
    // inatteignable sur téléphone. C'est la préuve positive de la garde retirée en Tâche 8.
    const rendu = container.querySelector('[data-action="mode-rendu"]') as HTMLButtonElement | null;
    expect(rendu).not.toBeNull();
    await act(async () => { rendu!.click(); });

    expect(container.querySelector('[data-testid="render-mode"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="proof-sheet"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="editor-too-small"]')).toBeNull();
    // Et toujours aucune des quatre régions de Montage.
    expect(container.querySelector('[data-testid="editor-rail"]')).toBeNull();

    unmount();
  });

  it("700px : le côté Montage du ModeSwitch est désactivé — sa mise en page à quatre régions n'y tient pas", async () => {
    const { container, unmount } = await mountAtWidth(700);
    const montage = container.querySelector('[data-action="mode-montage"]') as HTMLButtonElement | null;
    expect(montage).not.toBeNull();
    expect(montage!.disabled).toBe(true);
    unmount();
  });

  it("1400px : le côté Montage reste actif — la désactivation suit RÉELLEMENT le palier, elle n'est pas figée", async () => {
    const { container, unmount } = await mountAtWidth(1400);
    const montage = container.querySelector('[data-action="mode-montage"]') as HTMLButtonElement | null;
    expect(montage!.disabled).toBe(false);
    unmount();
  });
```

> `act` est déjà importé par ce fichier via son harnais (`tests/dom-harness.ts`). Si ce n'est pas le cas, l'ajouter depuis `react` — **ne pas** importer `react-dom/test-utils`, déprécié en React 19.

- [ ] **Step 2: Lancer les tests pour les voir échouer**

```bash
bun test tests/studio-mode-switch.test.ts tests/studio-editor-shell.test.ts
```

Attendu : ÉCHEC — `montageDisabled` inconnu, et `editor-too-small` rendu là où `render-mode` est attendu.

- [ ] **Step 3: Rendre le côté Montage désactivable**

Dans `components/studio/mode-switch.tsx` : ajouter `montageDisabled?: boolean` aux props, et sur le bouton `data-mode="montage"` poser `disabled={montageDisabled}` ainsi que, quand la prop est vraie, `title="Montage nécessite un écran plus large — la mise en page (rail, panneau, canevas, inspecteur) n'y tient pas."`. Ne rien changer d'autre : le raccourci « R » et le second bouton restent tels quels.

- [ ] **Step 4: Inverser la garde de `editor-shell.tsx`**

À la ligne ~991, remplacer :

```tsx
{layout === "too-small" ? (
  <TooSmallState … />
) : mode === "montage" ? (
```

par :

```tsx
{/* Refonte « Rendu réel » : `too-small` ne garde plus QUE Montage. Rendu réel est de la
    CONSULTATION — une grille d'images n'a besoin ni de rail, ni de panneau accosté, ni
    d'inspecteur — et DESIGN.md pose la posture « mobile is for quick consult/approve ». C'est
    donc la seule surface du studio qui a sa place sur un téléphone. Montage, lui, cède toujours
    la place à TooSmallState sous 768px : sa mise en page à quatre régions n'y tient pas. */}
{mode === "rendu" ? (
  <RenderMode … />
) : layout === "too-small" ? (
  <TooSmallState … />
) : (
```

en déplaçant le bloc `<RenderMode …/>` existant (aujourd'hui dans la branche `else` du ternaire `mode === "montage"`) vers cette première branche, props inchangées.

À la ligne ~805, retirer la garde `layout !== "too-small"` autour de `<ModeSwitch …/>` et lui passer `montageDisabled={layout === "too-small"}` :

```tsx
<ModeSwitch mode={mode} onChange={changeMode} montageDisabled={layout === "too-small"} />
```

- [ ] **Step 5: Relire les autres gardes `too-small` du fichier**

Chercher toutes les occurrences restantes :

```bash
grep -n 'too-small' components/studio/editor-shell.tsx
```

Pour chacune, vérifier qu'elle n'ampute pas Rendu réel de quelque chose dont il a besoin (le `SaveIndicator` de la ligne ~829, notamment : un mode de consultation n'écrit rien, il n'en a donc pas besoin — le laisser masqué est correct). Consigner en commentaire toute garde laissée intentionnellement en place.

- [ ] **Step 6: Lancer la suite parallèle complète**

```bash
bun run test:pure
```

Attendu : entièrement vert. C'est le premier point du plan où tous les morceaux coexistent.

- [ ] **Step 7: Vérifier dans un vrai navigateur**

Démarrer l'aperçu et ouvrir un gabarit du studio, puis, en Rendu réel :
1. la planche affiche huit tuiles, toutes de même hauteur, chacune à son ratio ;
2. cliquer une tuile ouvre l'inspection **et le rendu remplit réellement la zone** — c'est la vérification du défaut n°2, celle qu'aucun test statique ne fait ;
3. `Échap` revient à la planche ; `←`/`→` changent de format ;
4. revenir de l'inspection vers la planche **ne fait clignoter aucun squelette** (le mémo fonctionne) ;
5. basculer Montage ⇄ Rendu (touche « R ») et revenir : idem, aucun re-rendu ;
6. réduire la fenêtre à 375px : la grille passe à une colonne, `ModeSwitch` reste visible, le côté Montage est désactivé ;
7. changer d'article : **les huit** tuiles se mettent à jour, pas une seule.

Le point 1 est aussi le moment de trancher pour de bon le compromis « hauteur uniforme » (risque n°5 de la spec) : si une story y paraît trop petite pour être jugée, le dire plutôt que de laisser filer.

- [ ] **Step 8: Commit**

```bash
git add components/studio/editor-shell.tsx components/studio/mode-switch.tsx tests/studio-editor-shell.test.ts tests/studio-mode-switch.test.ts
git commit -m "feat(studio): Rendu réel disponible jusqu'au mobile"
```

---

## Vérification finale

- [ ] `bun run test:pure` — entièrement vert.
- [ ] `bun test tests/studio-preview.test.ts` — la garantie structurelle (voie DB, plus lente) tient toujours, y compris le nouveau cas partant de `hooks/use-preview.ts`.
- [ ] `bunx tsc --noEmit` — aucune erreur de types.
- [ ] `grep -rn "initialStale\|refreshNonce\|render-filmstrip\|onResult" components/studio/` ne renvoie plus rien : aucun vestige de l'ancienne version.
