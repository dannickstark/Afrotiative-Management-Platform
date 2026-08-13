// tests/studio-no-popover-in-canvas.test.ts — U4 Tâche 6, correctif de revue finale : GARDE
// STRUCTURELLE contre la récidive de l'incident "TOKEN_LABELS depuis token-picker.tsx".
//
// L'INCIDENT (voir task-6-report.md, « Post-review fix ») : components/studio/canvas.tsx a
// initialement importé `TOKEN_LABELS` depuis components/studio/token-picker.tsx — qui importe aussi
// Popover/PopoverContent/PopoverTrigger (@base-ui/react/popover) pour le SÉLECTEUR de jetons
// lui-même. Un composant qui n'a besoin QUE de la table de libellés se retrouvait donc à tirer tout
// l'arbre Popover statiquement. Sous `bun test` SANS `--isolate` (le mode par défaut de ce dépôt),
// ça gèle `@base-ui/utils/useIsoLayoutEffect` en no-op pour le reste du process dès que le fichier
// fautif s'évalue avant qu'un AUTRE fichier (tests/studio-interactions.test.ts) n'ait eu la chance
// d'installer son propre DOM — et ça fait SAUTER SILENCIEUSEMENT trois de ses tests comportementaux
// les plus forts (TokenPicker illégal inerte au clic, SelectField illégal non sélectionnable, le
// seam Images onPick). Le correctif : `TOKEN_LABELS` vit maintenant dans lib/studio/token-labels.ts,
// un module PUR (aucun JSX, aucun import de composant) — ce chemin d'import n'a donc plus jamais
// besoin d'exister EN DEHORS de token-picker.tsx lui-même (qui le RÉ-EXPORTE pour ses propres
// consommateurs, manual-generate.tsx et panels/images-panel.tsx).
//
// CE QUE CE FICHIER GARDE, ET POURQUOI EN LISANT LA SOURCE PLUTÔT QU'EN import ANT LES MODULES :
// une régression ici est un import STATIQUE, présent qu'un test l'exerce ou non — un test qui
// MONTERAIT canvas.tsx pour vérifier son comportement ne redeviendrait rouge que par ricochet
// (des tests d'un AUTRE fichier sautant silencieusement, comme l'incident l'a montré : aucun test
// n'a jamais échoué, ils ont seulement cessé de s'exécuter). Lire le texte source, sans jamais
// évaluer/importer les modules eux-mêmes, prouve directement « cet import n'existe pas » sans
// dépendre de l'ORDRE d'exécution des fichiers dans le process `bun test` — la variable même qui
// rendait l'incident original si difficile à repérer.
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const CANVAS_SOURCE_PATH = join(REPO_ROOT, "components/studio/canvas.tsx");
const TESTS_DIR = join(REPO_ROOT, "tests");

// Spécificateurs INTERDITS dans ces deux familles de fichiers : le module du SÉLECTEUR de jetons
// (qui tire Popover pour son propre usage) et les modules Popover eux-mêmes, sous n'importe laquelle
// de leurs deux formes d'import réelles dans ce dépôt (relative depuis components/studio/, ou
// absolue via l'alias "@/…").
const FORBIDDEN_SPECIFIER_SUFFIXES = [
  "/token-picker", // components/studio/token-picker.tsx — RÉ-EXPORTE TOKEN_LABELS mais tire Popover
  "/components/ui/popover", // le wrapper shadcn du Popover
  "@base-ui/react/popover", // la primitive base-ui elle-même
  // Chantier B, Tâche 7 — le menu contextuel du clic droit. `canvas-context-menu.tsx` porte le VRAI
  // composant base-ui (Menu/Portal/Positioner, voir son en-tête et celui de
  // components/ui/context-menu.tsx) ; `canvas.tsx` ne doit JAMAIS le résoudre, même pour un TYPE
  // seul (`CanvasContextMenuPayload` est définie LOCALEMENT dans canvas.tsx pour cette raison). Le
  // même garde-fou structurel qui a détecté l'incident original attrape donc, par construction,
  // toute régression future qui réintroduirait ce risque par ce chemin-ci.
  "/canvas-context-menu", // components/studio/canvas-context-menu.tsx — le composant base-ui RÉEL
  "/components/ui/context-menu", // le wrapper shadcn du menu contextuel (@base-ui/react/menu)
] as const;

// N'inspecte QUE les lignes qui sont RÉELLEMENT des déclarations `import`/`export … from` — jamais
// une correspondance de sous-chaîne naïve sur le texte entier du fichier. Sans cette discipline, ce
// garde-fou se déclencherait FAUX POSITIF sur ses propres commentaires (ce fichier, et
// tests/studio-canvas.test.ts, MENTIONNENT tous deux "token-picker" en prose, entre guillemets, pour
// documenter précisément ce qu'il ne faut PAS importer) — le même piège que la leçon de la Tâche 1
// citée ailleurs dans ce dépôt (« une classe utilitaire dans className peut faire un faux positif en
// recherche de sous-chaîne naïve »).
const IMPORT_FROM_RE = /^\s*(?:import\b[^;]*?|export\s*\{[^}]*\})\s*from\s+["']([^"']+)["']/gm;

/** Spécificateurs de module RÉELLEMENT importés/ré-exportés par `source` (jamais un mot trouvé dans
 * un commentaire ou une chaîne ordinaire). */
function importedSpecifiers(source: string): string[] {
  return [...source.matchAll(IMPORT_FROM_RE)].map((m) => m[1]);
}

/** LA règle : `source` importe-t-il, statiquement, l'un des modules interdits ci-dessus ? */
function pullsPopoverTransitively(source: string): boolean {
  return importedSpecifiers(source).some((spec) =>
    FORBIDDEN_SPECIFIER_SUFFIXES.some((suffix) => spec === suffix || spec.endsWith(suffix)),
  );
}

function studioCanvasTestFiles(): string[] {
  return readdirSync(TESTS_DIR)
    .filter((f) => f.startsWith("studio-canvas") && f.endsWith(".test.ts"))
    .map((f) => join(TESTS_DIR, f));
}

describe("garde structurelle — canvas.tsx (production ET tests) ne réimporte plus jamais Popover via token-picker.tsx (U4 Tâche 6)", () => {
  it("components/studio/canvas.tsx n'importe RIEN depuis token-picker.tsx ni Popover directement", () => {
    const source = readFileSync(CANVAS_SOURCE_PATH, "utf8");
    expect(pullsPopoverTransitively(source)).toBe(false);
  });

  it("chaque tests/studio-canvas*.test.ts (au moins un fichier réellement inspecté) suit la même règle", () => {
    const files = studioCanvasTestFiles();
    // Garde-fou du garde-fou : si le glob ne trouve PLUS AUCUN fichier (renommage, déplacement...),
    // ce test ne doit PAS passer par défaut sur un tableau vide — un `.every()` sur `[]` vaudrait
    // `true` sans jamais avoir rien inspecté, exactement le « faux positif sur correspondance vide »
    // que la revue demande d'exclure explicitement.
    expect(files.length).toBeGreaterThan(0);
    for (const path of files) {
      const source = readFileSync(path, "utf8");
      expect(pullsPopoverTransitively(source)).toBe(false);
    }
  });

  // NON-VACUITÉ (revue finale) : preuve que `pullsPopoverTransitively` DÉTECTE réellement un mauvais
  // import plutôt que de renvoyer `false` inconditionnellement — sans ce test, les deux ci-dessus
  // passeraient aussi bien si la fonction ne vérifiait jamais rien. Trois formes réelles de l'import
  // fautif (celles que canvas.tsx et tests/studio-canvas.test.ts ont RÉELLEMENT portées avant le
  // correctif, plus la primitive base-ui nue) — un témoin positif (l'import PUR, actuellement en
  // place) prouve que la fonction ne rougit pas non plus SANS RAISON.
  it("NON-VACUITÉ : la détection reconnaît bien un mauvais import, sous ses formes réelles — pas seulement l'absence de preuve", () => {
    expect(pullsPopoverTransitively('import { TOKEN_LABELS } from "@/components/studio/token-picker";')).toBe(true);
    expect(pullsPopoverTransitively('import { TOKEN_LABELS } from "./token-picker";')).toBe(true);
    expect(pullsPopoverTransitively('import { Popover } from "@/components/ui/popover";')).toBe(true);
    expect(pullsPopoverTransitively('import { Popover } from "@base-ui/react/popover";')).toBe(true);
    // Chantier B, Tâche 7 — les deux nouveaux spécificateurs interdits (menu contextuel), sous les
    // deux formes réelles présentes dans ce dépôt (relative depuis components/studio/, absolue via
    // l'alias "@/…"), y COMPRIS un import de TYPE seul (`import type { … }`) — la forme précise que
    // canvas.tsx doit éviter pour `CanvasContextMenuPayload` (voir son en-tête).
    expect(pullsPopoverTransitively('import { CanvasContextMenu } from "./canvas-context-menu";')).toBe(true);
    expect(pullsPopoverTransitively('import { CanvasContextMenu } from "@/components/studio/canvas-context-menu";')).toBe(true);
    expect(pullsPopoverTransitively('import type { CanvasContextMenuProps } from "./canvas-context-menu";')).toBe(true);
    expect(pullsPopoverTransitively('import { ContextMenu } from "@/components/ui/context-menu";')).toBe(true);
    // Témoin négatif : le remplacement RÉEL (module pur) ne déclenche rien.
    expect(pullsPopoverTransitively('import { TOKEN_LABELS } from "@/lib/studio/token-labels";')).toBe(false);
    // Témoin négatif : une simple MENTION en commentaire, entre guillemets mais sans "from" devant —
    // exactement la forme que les commentaires de CE fichier et de tests/studio-canvas.test.ts
    // utilisent pour documenter l'incident — ne doit PAS déclencher de faux positif.
    expect(pullsPopoverTransitively('// PAS "@/components/studio/token-picker" ici')).toBe(false);
  });
});
