# Surlignage des mots-clés & prompteur plein écran — design

Amélioration du **mode prompteur** (SP4, `tournage-view.tsx`) : pouvoir **surligner des
mots-clés** dans le texte d'un beat avec une **palette de 4 couleurs**, les distinguer
nettement à la lecture, et afficher le prompteur en **plein écran forcé fond blanc / texte
noir** (surlignages colorés). Le surlignage se fait dans les **deux surfaces** : l'éditeur de
beat (onglet Écriture) et le prompteur lui-même.

## Objectif et périmètre

- **But** : marquer des mots importants (4 couleurs), les voir surlignés partout où le texte
  s'affiche, et lire le prompteur en plein écran lisible.
- **Hors périmètre** : surlignage dans l'éditeur d'**articles** (le contrôle est réservé à la
  vidéo via une prop) ; couleurs hors des 4 ; annotations autres que le surlignage ; IA.

## Décisions verrouillées (ne pas rouvrir)

1. **Surlignage inline** dans `spokenText` : `<mark class="hl-<couleur>">…</mark>`. Palette
   **fermée** de 4 : `jaune`, `vert`, `rouge`, `bleu`. Classe (pas de `style` inline ni de
   `data-*`) → valeur contrainte et sûre.
2. **Surlignage dans les deux modes** : éditeur de beat (Écriture) ET prompteur (instance
   plein écran du même éditeur surlignable).
3. **Plein écran = API navigateur** `element.requestFullscreen()`. Le conteneur prompteur
   **force fond blanc / texte noir** quel que soit le thème de l'app.
4. **Aucune migration** : les surlignages vivent dans `spokenText` existant.

## 1. Modèle de surlignage (`<mark class="hl-*">`)

- Couleurs = ensemble fermé exporté `HIGHLIGHT_COLORS = ["jaune", "vert", "rouge", "bleu"]`
  (nouvelle constante, ex. `lib/video/highlight.ts` pur) + type `HighlightColor`.
- Rendu : `<mark class="hl-jaune">…</mark>`. Une seule couleur par span ; imbrication non
  gérée (re-surligner remplace).

## 2. Assainissement (sécurité — surface critique)

`lib/sanitize.ts` `sanitizeArticleHtml` :
- Ajouter `"mark"` à `ALLOWED_TAGS` et `"class"` à `ALLOWED_ATTR`.
- **Passe post-DOMPurify** (dans la même fonction) : parcourir les éléments ; ne conserver
  l'attribut `class` que sur un `<mark>` ET seulement si la valeur est exactement une classe
  de la liste `hl-jaune|hl-vert|hl-rouge|hl-bleu` — sinon retirer l'attribut `class`. Un
  `<mark>` sans classe valide est **dénoué** (remplacé par son contenu) pour éviter un
  surlignage par défaut/incolore. Toute `class` sur un élément non-`mark` est retirée.
- Objectif : autoriser `class` globalement dans DOMPurify (nécessaire techniquement) tout en
  garantissant qu'aucune classe arbitraire ne survit — seul un `<mark>` correctement coloré
  passe. C'est le seul changement sensible ; il est couvert par des tests dédiés.
- Appliqué automatiquement à tous les chemins d'écriture de `spokenText` (`updateBeatCore`,
  imports, régénération) puisqu'ils passent tous par `sanitizeArticleHtml`.

## 3. Éditeur : contrôle de surlignage (palette)

- Nouvelle **marque TipTap « highlight »** basée sur classe, multicouleur (rend
  `<mark class="hl-<couleur>">`, `parseHTML` reconnaît `mark[class^="hl-"]`). Module ex.
  `components/article/highlight-mark.ts`.
- Un contrôle **« Surligner »** dans `editor-toolbar.tsx` : les 4 couleurs + « Retirer ».
  **Prop-gardé** : `RichEditor`/`EditorToolbar` gagnent `allowHighlight?: boolean` ; le
  contrôle n'apparaît que si vrai. L'éditeur d'articles ne passe PAS la prop → inchangé.
- Le beat-inspector (`components/video/beat-inspector.tsx`) monte `RichEditor` avec
  `allowHighlight`.

## 4. Les deux surfaces d'édition

- **Écriture** : le `RichEditor` du beat-inspector (déjà là) gagne la palette ; sélectionner
  des mots → couleur. Persiste via `updateBeat({ spokenText })` existant.
- **Prompteur** : devient une **instance plein écran du même éditeur surlignable**, stylée
  grand, fond blanc / texte noir. On peut y surligner (réutilise marque + persistance).
  Corrige aussi le bug actuel : le prompteur rend `spokenText` en **texte brut**
  (`{beat.spokenText}`) et affiche donc les balises `<p>` littérales — il rendra désormais le
  texte formaté.
  - Le prompteur enregistre les changements (surlignage ou édition) via `updateBeat({ beatId,
    spokenText })` (débounce léger côté client, ou à la navigation prev/suivant). Réutilise
    `onSaved` pour rafraîchir.

## 5. Plein écran (lumière forcée)

- Bouton **« Plein écran »** dans le prompteur → `ref.current.requestFullscreen()`. `Échap`
  sort (comportement navigateur). Un `fullscreenchange` listener met à jour l'état local
  (afficher « Quitter le plein écran »).
- Le conteneur prompteur **code en dur** `background:#fff; color:#000` (indépendant de la
  classe `.dark`), grand type (`text-2xl`→`text-3xl`), navigation prev/suivant + log rapide
  toujours accessibles.

## 6. CSS des surlignages

Dans `app/globals.css`, définir `.hl-jaune/.hl-vert/.hl-rouge/.hl-bleu` (couleur de fond +
texte lisible) :
- Teintes discrètes mais lisibles dans le thème app (clair ET sombre — le texte reste
  lisible sur la teinte).
- Variante vive sur blanc portée par le conteneur prompteur (fond forcé blanc) — teintes
  saturées derrière texte noir (contraste AA).
Les couleurs sortent de la même famille que les tokens de statut existants
(`--status-pending` ambre, `--status-approved` vert, `--status-rejected` rouge,
`--status-in-review` indigo) pour la cohérence.

## Sécurité & gestion des erreurs

- Le seul vecteur est le `class` autorisé : la passe post-sanitize garantit qu'aucune classe
  hors `hl-*` sur `<mark>` ne survit, et qu'aucun autre élément ne conserve de `class`.
  `<mark>` sans classe valide → dénoué. Testé explicitement (injection de `class`
  arbitraire, `<mark style=…>`, `<span class=…>`, `<mark class="hl-x evil">`).
- `requestFullscreen()` peut rejeter (pas de geste utilisateur, navigateur non supporté) :
  envelopper dans un `try/catch`, tomber sur un overlay `fixed inset-0` de repli (fond blanc)
  si le plein écran natif échoue — le prompteur reste utilisable.
- L'écriture depuis le prompteur passe par `updateBeat` gardé (`video:manage`) et le
  `sanitizeArticleHtml` serveur — aucun HTML non assaini n'est persisté.

## Tests

- **Purs** : `sanitizeArticleHtml` — conserve `<mark class="hl-jaune">`, dénoue `<mark>` sans
  classe, retire une classe invalide sur `<mark>` (`hl-x`, `evil`), retire `class` sur un
  `<span>`/`<p>`, ignore `style`. `HIGHLIGHT_COLORS`/`HighlightColor` exportés.
- **UI (purs)** : la toolbar rend la palette quand `allowHighlight` et RIEN quand absent
  (article inchangé) ; le prompteur rend le HTML surligné (pas les balises brutes) et affiche
  le bouton « Plein écran ».
- Nouveaux tests purs inscrits dans `PURE_FILES`.

## Contraintes héritées

- `lib/sanitize.ts` reste la seule porte d'assainissement ; le changement s'y concentre.
- `lib/video/highlight.ts` et la marque TipTap restent purs (pas de `@/db`).
- Copie UI en français ; shadcn/ui + Tailwind v4 ; réutiliser `RichEditor`/`EditorToolbar`,
  `updateBeat`, et les tokens de couleur.
- Aucun impact sur l'éditeur d'articles (contrôle prop-gardé).

Voir [[video-module-roadmap]] et [[execution-mode-subagent-driven]]. Amont : `tournage-view.tsx`
(prompteur SP4), `components/article/rich-editor.tsx` (TipTap), `lib/sanitize.ts`.
