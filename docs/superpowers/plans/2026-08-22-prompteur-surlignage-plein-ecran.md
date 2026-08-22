# Surlignage des mots-clés & prompteur plein écran — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surligner des mots-clés (palette de 4 couleurs) dans le texte d'un beat, dans l'éditeur ET dans le prompteur, et lire le prompteur en plein écran forcé fond blanc / texte noir avec surlignages colorés.

**Architecture:** Surlignage inline `<mark class="hl-<couleur>">` dans `spokenText`, autorisé par une extension ciblée de `sanitizeArticleHtml` (avec passe post-DOMPurify contraignant les classes). Une marque TipTap maison + une palette de toolbar prop-gardée. Le prompteur devient une instance plein écran du même éditeur surlignable. Aucune migration.

**Tech Stack:** Next.js, TipTap v3 (`@tiptap/core` `Mark.create`), DOMPurify + JSDOM, Tailwind v4 (CSS-first), `bun test`. Aucune dépendance runtime nouvelle (`@tiptap/core` déjà transitif — à déclarer).

**Spec:** `docs/superpowers/specs/2026-08-22-prompteur-surlignage-plein-ecran-design.md`

## Global Constraints

- **Copie UI en français.**
- **AUCUNE migration.** Les surlignages vivent dans `spokenText` (colonne existante).
- **Palette fermée de 4** : `jaune`, `vert`, `rouge`, `bleu`. Classe unique par span : `hl-<couleur>`. Source de vérité unique dans `lib/highlight.ts` (pur).
- **Sécurité (surface critique) :** `sanitizeArticleHtml` est la seule porte. Après extension, un `<mark>` ne survit QUE avec une classe **exactement** `hl-jaune|hl-vert|hl-rouge|hl-bleu` ; toute autre `class` (sur mark ou autre élément) est retirée ; un `<mark>` sans classe valide est dénoué. `style`/`data-*` restent interdits (`ALLOW_DATA_ATTR: false` inchangé). Testé par injection.
- **Contrôle de surlignage prop-gardé** (`allowHighlight`) : l'éditeur d'**articles** ne le reçoit pas → inchangé.
- **Le prompteur** rend et édite le HTML (corrige le bug actuel qui affiche `spokenText` en texte brut). Persiste via `updateBeat` gardé (`video:manage`), qui ré-assainit côté serveur. Adopter le `spokenText` **renvoyé** par l'action (déjà assaini), pas le HTML local.
- **Plein écran** = `element.requestFullscreen()` avec repli overlay `fixed inset-0` si l'appel échoue. Conteneur prompteur en **fond blanc / texte noir codés en dur**, indépendant de `.dark`.
- **Tests purs** dans `PURE_FILES`. Pas de test unitaire de l'éditeur TipTap (nécessite un navigateur) — la logique pure (couleurs↔classes) et l'assainisseur sont testés ; l'UI éditeur/prompteur est validée par `typecheck` + `build` + preuve manuelle.

---

## File Structure

| Fichier | Rôle | Action |
|---|---|---|
| `lib/highlight.ts` | Palette + helpers couleur↔classe (pur) | Créer |
| `lib/sanitize.ts` | Assainisseur | Modifier — autoriser `<mark>`/`class` + passe de contrainte |
| `components/article/highlight-mark.ts` | Marque TipTap maison | Créer |
| `components/article/editor-toolbar.tsx` | Palette de surlignage prop-gardée | Modifier |
| `components/article/rich-editor.tsx` | `allowHighlight` + `className` | Modifier |
| `components/video/beat-inspector.tsx` | Passe `allowHighlight` | Modifier |
| `components/video/tournage-view.tsx` | Prompteur éditable + plein écran + persistance | Modifier |
| `app/globals.css` | Classes `.hl-*` + scope prompteur forcé clair | Modifier |
| `package.json` | Déclarer `@tiptap/core` | Modifier |
| `scripts/test-fast.ts` | Allowlist tests purs | Modifier |

---

## Task 1: Palette pure + assainisseur (surface de sécurité)

**Files:**
- Create: `lib/highlight.ts`
- Modify: `lib/sanitize.ts`
- Test: `tests/highlight.test.ts` (pur, nouveau), `tests/sanitize.test.ts` (pur, existant — étendre)
- Modify: `scripts/test-fast.ts`

**Interfaces:**
- Produces: `HIGHLIGHT_COLORS` (tuple), `HighlightColor`, `classForColor(color): string`, `colorForClass(cls): HighlightColor | null`. `sanitizeArticleHtml` accepte désormais `<mark class="hl-*">`.

- [ ] **Step 1: Écrire les tests purs (échouent)**

Créer `tests/highlight.test.ts` :

```ts
import { expect, test } from "bun:test";
import { HIGHLIGHT_COLORS, classForColor, colorForClass } from "@/lib/highlight";

test("classForColor / colorForClass aller-retour", () => {
  for (const c of HIGHLIGHT_COLORS) {
    expect(classForColor(c)).toBe(`hl-${c}`);
    expect(colorForClass(`hl-${c}`)).toBe(c);
  }
});
test("colorForClass rejette l'invalide", () => {
  expect(colorForClass("hl-x")).toBeNull();
  expect(colorForClass("hl-jaune evil")).toBeNull(); // exact match seulement
  expect(colorForClass("evil")).toBeNull();
  expect(colorForClass("")).toBeNull();
});
```

Étendre `tests/sanitize.test.ts` avec :

```ts
test("garde un <mark class=hl-jaune> valide", () => {
  const out = sanitizeArticleHtml('<p><mark class="hl-jaune">climat</mark></p>');
  expect(out).toContain('<mark class="hl-jaune">climat</mark>');
});
test("dénoue un <mark> sans classe valide", () => {
  const out = sanitizeArticleHtml("<p><mark>x</mark></p>");
  expect(out).not.toContain("<mark");
  expect(out).toContain("x");
});
test("classe invalide sur <mark> → dénoué, rien de l'injection ne survit", () => {
  const out = sanitizeArticleHtml('<p><mark class="hl-x evilclass">x</mark></p>');
  expect(out).not.toContain("<mark");
  expect(out).not.toContain("evilclass");
});
test("class retirée sur un élément non-mark", () => {
  expect(sanitizeArticleHtml('<p class="evilclass">x</p>')).toBe("<p>x</p>");
});
test("style sur mark supprimé ; span non autorisé", () => {
  expect(sanitizeArticleHtml('<p><mark style="background:red">x</mark></p>')).not.toContain("style");
  expect(sanitizeArticleHtml('<p><span class="hl-jaune">x</span></p>')).not.toContain("hl-jaune");
});
```

- [ ] **Step 2: Lancer et vérifier l'échec**

Run: `bun test tests/highlight.test.ts tests/sanitize.test.ts` → FAIL (module + comportement absents).

- [ ] **Step 3: Écrire `lib/highlight.ts`**

```ts
export const HIGHLIGHT_COLORS = ["jaune", "vert", "rouge", "bleu"] as const;
export type HighlightColor = (typeof HIGHLIGHT_COLORS)[number];

const CLASS_RE = /^hl-(jaune|vert|rouge|bleu)$/;

export function classForColor(color: HighlightColor): string {
  return `hl-${color}`;
}
export function colorForClass(cls: string): HighlightColor | null {
  const m = CLASS_RE.exec(cls.trim());
  return m ? (m[1] as HighlightColor) : null;
}
```

- [ ] **Step 4: Étendre `lib/sanitize.ts`**

1. Import : `import { colorForClass } from "@/lib/highlight";`
2. `ALLOWED_TAGS` : ajouter `"mark"`.
3. `ALLOWED_ATTR` : ajouter `"class"`. (Laisser `ALLOW_DATA_ATTR: false`.)
4. Dans le bloc JSDOM (après la passe `<a rel>`, avant le `return`), ajouter la passe de contrainte :

```ts
    // Le `class` n'est autorisé QUE sur un <mark> portant EXACTEMENT une classe de surlignage.
    // Toute autre classe (sur mark ou n'importe quel élément) est retirée.
    dom.window.document.querySelectorAll("[class]").forEach((el) => {
      const ok = el.tagName.toLowerCase() === "mark" && colorForClass(el.getAttribute("class") ?? "");
      if (!ok) el.removeAttribute("class");
    });
    // Un <mark> sans classe de surlignage valide est dénoué (contenu préservé).
    dom.window.document.querySelectorAll("mark").forEach((m) => {
      if (!colorForClass(m.getAttribute("class") ?? "")) m.replaceWith(...Array.from(m.childNodes));
    });
```

Note : l'ordre — d'abord retirer les classes invalides, puis dénouer les `<mark>` devenus sans classe valide. `<span>`/`<div>` ne sont pas dans `ALLOWED_TAGS` → déjà supprimés par DOMPurify avant cette passe.

- [ ] **Step 5: Lancer, inscrire le pur, typecheck**

Ajouter `"highlight.test.ts"` au `PURE_FILES` (`sanitize.test.ts` y est déjà).
Run: `bun test tests/highlight.test.ts tests/sanitize.test.ts && bun run test:pure && bun run typecheck`
Expected: PASS + exit 0.

- [ ] **Step 6: Commit**

```bash
git add lib/highlight.ts lib/sanitize.ts tests/highlight.test.ts tests/sanitize.test.ts scripts/test-fast.ts
git commit -m "feat(video): autoriser le surlignage <mark class=hl-*> dans l'assainisseur"
```

---

## Task 2: Marque TipTap + palette + éditeur prop-gardé

**Files:**
- Modify: `package.json` (déclarer `@tiptap/core`)
- Create: `components/article/highlight-mark.ts`
- Modify: `components/article/editor-toolbar.tsx`, `components/article/rich-editor.tsx`, `components/video/beat-inspector.tsx`
- Modify: `app/globals.css` (classes `.hl-*`)

**Interfaces:**
- Consumes: `lib/highlight.ts` (Task 1).
- Produces: `HighlightMark` (marque TipTap) ; `RichEditor`/`EditorToolbar` acceptent `allowHighlight?: boolean` et `RichEditor` un `className?: string`.

- [ ] **Step 1: Déclarer `@tiptap/core`**

Dans `package.json` `dependencies`, ajouter `"@tiptap/core": "3.29.2"` (déjà présent transitivement ; on l'importe directement). Run: `bun install` (doit être un no-op de résolution — même version). Vérifier `node_modules/@tiptap/core` exporte `Mark`/`mergeAttributes`.

- [ ] **Step 2: Écrire la marque**

Créer `components/article/highlight-mark.ts` :

```ts
import { Mark, mergeAttributes } from "@tiptap/core";
import { classForColor, colorForClass, type HighlightColor } from "@/lib/highlight";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    highlight: {
      setHighlight: (color: HighlightColor) => ReturnType;
      unsetHighlight: () => ReturnType;
    };
  }
}

export const HighlightMark = Mark.create({
  name: "highlight",
  addAttributes() {
    return {
      color: {
        default: null,
        parseHTML: (el) => colorForClass((el as HTMLElement).getAttribute("class") ?? ""),
        renderHTML: (attrs) =>
          attrs.color ? { class: classForColor(attrs.color as HighlightColor) } : {},
      },
    };
  },
  parseHTML() {
    return [{
      tag: "mark",
      getAttrs: (el) => (colorForClass((el as HTMLElement).getAttribute("class") ?? "") ? {} : false),
    }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["mark", mergeAttributes(HTMLAttributes), 0];
  },
  addCommands() {
    return {
      setHighlight: (color) => ({ commands }) => commands.setMark(this.name, { color }),
      unsetHighlight: () => ({ commands }) => commands.unsetMark(this.name),
    };
  },
});
```

- [ ] **Step 3: Palette dans la toolbar (prop-gardée)**

Dans `components/article/editor-toolbar.tsx` :
- Props : `{ editor: Editor; allowHighlight?: boolean }`.
- Ajouter au `useEditorState` selector des indicateurs de couleur active si utile (facultatif) : `hlJaune: editor.isActive("highlight", { color: "jaune" })`, etc.
- Après le cluster de boutons existant, si `allowHighlight`, rendre un cluster « Surligner » : un petit bouton par couleur (`HIGHLIGHT_COLORS`) avec `aria-label={`Surligner ${couleur}`}`, une pastille de couleur (`<span className={`hl-${couleur}`}>` ou un point coloré), `onClick={() => editor.chain().focus().setHighlight(couleur).run()}` ; plus un bouton « Retirer le surlignage » → `editor.chain().focus().unsetHighlight().run()`. Importer `HIGHLIGHT_COLORS` de `@/lib/highlight`.

- [ ] **Step 4: `RichEditor` : `allowHighlight` + `className`**

Dans `components/article/rich-editor.tsx` :
- Props : `{ value; onChange; editable; allowHighlight?: boolean; className?: string }`.
- Import `HighlightMark`.
- `extensions` : ajouter `...(allowHighlight ? [HighlightMark] : [])`.
- `editorProps.attributes.class` : utiliser `className ?? "font-editorial prose prose-neutral dark:prose-invert max-w-none min-h-[420px] focus:outline-none"` (défaut = valeur actuelle).
- Passer `allowHighlight` à `<EditorToolbar editor={editor} allowHighlight={allowHighlight} />`.

- [ ] **Step 5: `beat-inspector` passe la prop**

Dans `components/video/beat-inspector.tsx`, au montage `RichEditor` (~lignes 454-459), ajouter `allowHighlight`.

- [ ] **Step 6: Classes `.hl-*` (thème app)**

Dans `app/globals.css`, HORS de tout `@layer` (comme les `.studio-motion-*`), ajouter les 4 classes — teintes lisibles en clair ET sombre (texte lisible sur la teinte) :

```css
mark.hl-jaune, .hl-jaune { background-color: oklch(0.92 0.16 100); color: oklch(0.2 0 0); border-radius: 2px; }
mark.hl-vert,  .hl-vert  { background-color: oklch(0.9 0.16 150); color: oklch(0.2 0 0); border-radius: 2px; }
mark.hl-rouge, .hl-rouge { background-color: oklch(0.88 0.13 25);  color: oklch(0.2 0 0); border-radius: 2px; }
mark.hl-bleu,  .hl-bleu  { background-color: oklch(0.9 0.1 250);  color: oklch(0.2 0 0); border-radius: 2px; }
```

(Ajuster les valeurs pour un rendu agréable ; le texte reste sombre sur teinte claire dans les deux thèmes — les marques sont lues sur fond de teinte, pas sur le fond de page.)

- [ ] **Step 7: Vérifier (typecheck + build)**

Run: `bun run typecheck && bun run build`
Expected: exit 0 ; build compile l'éditeur. (Pas de test unitaire de l'éditeur — logique pure testée en Task 1 ; rendu validé au build + preuve manuelle.)

- [ ] **Step 8: Commit**

```bash
git add package.json bun.lock components/article/highlight-mark.ts components/article/editor-toolbar.tsx components/article/rich-editor.tsx components/video/beat-inspector.tsx app/globals.css
git commit -m "feat(video): marque de surlignage TipTap et palette prop-gardée"
```

---

## Task 3: Prompteur éditable, plein écran, persistance

**Files:**
- Modify: `components/video/tournage-view.tsx` (`PrompteurMode`)
- Modify: `app/globals.css` (scope prompteur forcé clair)

**Interfaces:**
- Consumes: `RichEditor` (`allowHighlight`+`className`, Task 2), `updateBeat` (`@/lib/actions/video-actions`), `TournageBeat` (avec `spokenText` HTML + `id`).

- [ ] **Step 1: Réécrire `PrompteurMode`**

Dans `components/video/tournage-view.tsx` :
1. Importer `updateBeat` (ajouter à l'import existant depuis `@/lib/actions/video-actions`), `RichEditor` (`@/components/article/rich-editor`), `useRef`, `useEffect`.
2. `PrompteurMode({ beats })` :
   - `const router = useRouter(); const [index, setIndex] = useState(0); const beat = beats[index];`
   - État d'édition : `const [html, setHtml] = useState(beat.spokenText);` resynchronisé quand le beat change (`useEffect(() => setHtml(beat.spokenText), [beat.id])`). Un `dirtyRef = useRef(false)`.
   - `const [isSaving, startSaving] = useTransition();`
   - **Sauvegarde** : `async function save()` — si `dirtyRef.current`, `const res = await updateBeat({ beatId: beat.id, spokenText: html }); if (!res.ok) { toast.error(res.message); return; } dirtyRef.current = false; router.refresh();`. Appeler `save()` (via `startSaving`) sur Précédent/Suivant (AVANT de changer l'index), au clic « Enregistrer », et à la sortie du plein écran.
   - **Plein écran** : `const surfaceRef = useRef<HTMLDivElement>(null); const [fs, setFs] = useState(false); const [overlay, setOverlay] = useState(false);`. Bouton « Plein écran » : `try { await surfaceRef.current?.requestFullscreen(); } catch { setOverlay(true); }`. `useEffect` sur `document` `fullscreenchange` → `setFs(!!document.fullscreenElement)` ; quand on quitte, `save()`. Sortie de l'overlay de repli via un bouton « Fermer » + touche Échap (`useEffect` keydown).
   - **Rendu** : le conteneur `surfaceRef` porte la classe `prompteur-surface` (fond blanc/texte noir forcé) ET, si `overlay`, est enveloppé `fixed inset-0 z-50 overflow-auto`. À l'intérieur : le `kindLabel`, un `<RichEditor value={beat.spokenText} onChange={(h) => { setHtml(h); dirtyRef.current = true; }} editable allowHighlight className="prompteur-editor" />` (grand texte via la classe), la `directionNote`, la navigation Précédent/Suivant, `LogButtons`, le bouton Plein écran/Fermer, et « Enregistrer » (désactivé si `isSaving`).
   - `key={beat.id}` sur le `RichEditor` (ou son wrapper) pour le remonter au changement de beat (il ne lit `value` qu'à la création).

Note : garder l'UI simple et à grandes cibles ; ne PAS auto-sauver à chaque frappe (sauver aux transitions/actions). Adopter `res.spokenText` renvoyé n'est pas strictement nécessaire ici car `router.refresh()` recharge les beats — mais ne pas ré-injecter d'HTML local après refresh.

- [ ] **Step 2: CSS scope prompteur (forcé clair)**

Dans `app/globals.css`, HORS `@layer` :

```css
.prompteur-surface { background-color: #fff; color: #000; }
.prompteur-surface .prompteur-editor { font-size: 1.5rem; line-height: 1.4; color: #000; min-height: 40vh; }
@media (min-width: 640px) { .prompteur-surface .prompteur-editor { font-size: 1.875rem; } }
/* Surlignages vifs sur blanc, texte noir (contraste AA) */
.prompteur-surface mark.hl-jaune { background-color: #fde047; color: #000; }
.prompteur-surface mark.hl-vert  { background-color: #86efac; color: #000; }
.prompteur-surface mark.hl-rouge { background-color: #fca5a5; color: #000; }
.prompteur-surface mark.hl-bleu  { background-color: #93c5fd; color: #000; }
/* La toolbar TipTap et le focus outline restent visibles sur blanc */
.prompteur-surface .prose { color: #000; }
```

- [ ] **Step 3: Vérifier (typecheck + build)**

Run: `bun run typecheck && bun run build`
Expected: exit 0 ; `/video/[id]` compile.

- [ ] **Step 4: Commit**

```bash
git add components/video/tournage-view.tsx app/globals.css
git commit -m "feat(video): prompteur éditable, surlignable et plein écran"
```

---

## Task 4: Vérification finale

**Files:** aucun.

- [ ] **Step 1: Suite pure + typecheck + build**

Run: `bun run typecheck && bun run test:pure && bun run build`
Expected: exit 0 partout.

- [ ] **Step 2: Confirmer l'absence de migration**

Run: `bun run db:generate`
Expected: « nothing to migrate ». Si une migration est proposée, s'arrêter et rapporter.

- [ ] **Step 3: Preuve manuelle**

1. Onglet Écriture → inspecteur d'un beat : la palette « Surligner » apparaît ; sélectionner des mots, appliquer une couleur → enregistré (rechargement : le surlignage persiste). L'éditeur d'**articles** N'A PAS la palette.
2. Injection : coller dans le champ un HTML forgé `<mark class="hl-x evil">…</mark>` / `<mark style="background:red">` / `<p class="evil">` → après enregistrement, aucun `evil`/`style`/classe hors `hl-*` ne survit ; un `<mark>` invalide est dénoué.
3. Onglet Tournage → Mode prompteur : le texte s'affiche **formaté** (pas de balises brutes) ; les surlignages sont visibles ; on peut surligner ici aussi et ça persiste.
4. « Plein écran » : le prompteur passe en plein écran navigateur, fond blanc, texte noir, surlignages vifs ; Échap sort ; si `requestFullscreen` échoue, l'overlay de repli s'affiche.
5. Naviguer Précédent/Suivant après une édition sauvegarde bien la modif.

- [ ] **Step 4: État du dépôt**

Run: `git status` (propre) ; `git log --oneline main..HEAD`.

---

## Self-Review (à l'écriture)

- **Couverture spec :** modèle `<mark class=hl-*>` + palette 4 couleurs (T1/T2) ✓ ; assainisseur étendu + passe de contrainte (T1) ✓ ; marque TipTap + palette prop-gardée, article inchangé (T2) ✓ ; surlignage dans les deux surfaces (T2 Écriture, T3 prompteur) ✓ ; prompteur rend le HTML (corrige le bug texte brut) + plein écran forcé clair + repli (T3) ✓ ; persistance via `updateBeat` gardé + ré-assainissement serveur (T3) ✓ ; CSS `.hl-*` app + scope prompteur (T2/T3) ✓ ; aucune migration ✓.
- **Placeholders :** aucun ; code réel pour la logique pure/assainisseur/marque ; l'UI éditeur/prompteur décrite en réécrivant des composants nommés avec le code clé.
- **Cohérence des types :** `HighlightColor`/`classForColor`/`colorForClass` (T1) consommés par la marque (T2) ET l'assainisseur (T1) — source unique ; `allowHighlight`/`className` ajoutés à `RichEditor`/`EditorToolbar` (T2) consommés par beat-inspector (T2) et prompteur (T3) ; `updateBeat` renvoie `spokenText` assaini (adopté après refresh).
- **Risque testé faiblement :** l'UI TipTap (toolbar/marque/prompteur) n'a pas de test unitaire (l'éditeur exige un navigateur) — mitigé par les tests purs de `colorForClass`/assainisseur (le vrai vecteur de sécurité), le `build`, et la preuve manuelle §Step 3.

Voir [[video-module-roadmap]] et [[execution-mode-subagent-driven]].
