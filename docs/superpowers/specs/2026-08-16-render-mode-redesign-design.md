# Design — Refonte du mode « Rendu réel » : planche de contrôle, inspection, export

Date: 2026-08-16
Status: approved-for-planning (pending user spec review)
Branch: `feat/render-mode-proof-sheet`

Le second mode de l'éditeur de gabarits (`components/studio/render-mode.tsx`, chantier U1 §5) est
remplacé par une **planche de contrôle** des huit formats, dont chaque tuile ouvre une **vue
d'inspection** plein-espace, zoomable et téléchargeable. La refonte corrige aussi le socle : le
« fit » cassé, le double chrome hérité de `PreviewPane`, les deux modèles de fraîcheur concurrents,
l'incohérence article entre la grande case et la bande, le coût de rendu non mémoïsé, et l'absence
totale d'adaptation responsive.

## Décisions verrouillées avec l'utilisateur

1. **Rôle de la vue** : planche multi-formats + inspection fine au clic + export. Les trois, pas un choix.
2. **Portée** : refonte visuelle **et** correction du socle (les bugs de dimensionnement ne sont pas du style).
3. **Responsive** : jusqu'au mobile. `too-small` ne doit plus bloquer Rendu réel.
4. **Coût de rendu** : mémoïsation côté client, hors du cycle de vie du composant.
5. **Relation planche ⇄ inspection** : deux états sur **une même surface** (approche A), pas de
   surimpression modale, pas de split permanent.
6. **Hauteur des tuiles** : uniforme, rendu en boîte-aux-lettres à son ratio réel à l'intérieur.
7. **Zoom tactile** : boutons *Ajuster* / *100 %* + défilement natif. Pas de geste de pincement.
8. **`PreservedView.selectedId`** : son sens change en place. Pas de champ `focusedFormat` parallèle.
9. **Export** : PNG par format + « tout télécharger » en téléchargements séquentiels. **Pas** de dépendance zip.

## Défauts constatés que cette refonte corrige

Établis par lecture du code, pas supposés — chacun est référencé à sa ligne.

| # | Défaut | Preuve |
|---|---|---|
| 1 | Double chrome : la grande case est un `<PreviewPane>` qui apporte son propre en-tête, son bouton *Actualiser*, son badge `degraded` et son sélecteur d'article, imbriqués dans l'en-tête de `RenderMode` qui porte un **second** badge `degraded` et le zoom. | `render-mode.tsx:362-418` + `preview-pane.tsx:112-165` |
| 2 | « Ajuster à l'écran » ne peut pas ajuster : `PreviewPane` impose `aspectRatio: canvas.width/height` à sa boîte image, et `RenderMode` l'enveloppe dans `width:100%;height:100%` au sein d'un conteneur `overflow-hidden`. Pour une story (1080×1920) la boîte calcule 1,78× la largeur du conteneur en hauteur : rognée, jamais ajustée. | `preview-pane.tsx:169` + `render-mode.tsx:397-411` |
| 3 | Le zoom n'a que deux états (`fit` / `1`), et à « 100 % » la boîte interne recalcule sa propre taille : ce n'est donc pas un 100 % pixel, ce qui annule sa seule raison d'être déclarée (« inspecter la typo »). | `render-mode.tsx:56, 405-411` |
| 4 | Sept vignettes de 112px (`w-28`) empilant libellé + dimensions + jusqu'à deux alertes ambre, dans un défilement horizontal, pendant que l'axe le plus large de l'écran est inutilisé. | `render-mode.tsx:227-281, 446` |
| 5 | Deux paragraphes explicatifs en permanence à l'écran, compensant une mise en page qui ne se dit pas elle-même. | `render-mode.tsx:391-395, 430-432` |
| 6 | Deux modèles de fraîcheur contradictoires : la grande case se rafraîchit seule à 800 ms, la bande passe « Périmé » et exige un `↻` manuel. | `render-mode.tsx:303-318, 434-444` |
| 7 | La bande ment vis-à-vis de la grande case : `FilmstripThumb` n'envoie jamais `articleId`. Choisir un article ne met à jour qu'une moitié de l'écran. | `render-mode.tsx:206` |
| 8 | Rien n'est actionnable : aucun téléchargement, aucune copie, aucune ouverture en taille réelle. | absence dans `render-mode.tsx` |
| 9 | Les alertes ne s'agrègent pas — impossible de savoir d'un coup d'œil combien de formats posent problème. | `render-mode.tsx:256-280` |
| 10 | Aucune adaptation responsive : les paliers de `useEditorLayout` ne remodèlent que Montage ; sous 768px l'éditeur entier cède la place à `TooSmallState`, **y compris** Rendu réel. | `editor-shell.tsx:805, 991-992` |
| 11 | Entrer dans le mode déclenche jusqu'à huit rendus satori/resvg/sharp non cachés, refaits à chaque aller-retour de mode. | `render-mode.tsx:39-55` |

## Architecture cible

```
components/studio/render-mode.tsx          routeur mince : planche ⇄ focus, barre d'outils partagée
components/studio/render/proof-sheet.tsx   la grille des 8 tuiles          (nouveau)
components/studio/render/format-focus.tsx  un format, zoomable, exportable (nouveau)
hooks/use-preview.ts                       le cœur sans UI de l'aperçu     (nouveau, extrait)
lib/studio/preview-cache.ts                mémo LRU borné en octets, PUR   (nouveau)
components/studio/preview-pane.tsx         réécrit AUTOUR du hook, sortie inchangée
```

---

## §1 — État et navigation

`PreservedView` (`lib/studio/studio-mode.ts`) est réutilisé tel quel, **avec un changement de sens
de `selectedId`** :

- **Avant** : `null` = « le format natif est promu dans la grande case » ; un `FormatKey` = « ce
  format est promu ».
- **Après** : `null` = « aucun format focalisé → la planche » ; un `FormatKey` = « ce format est en
  inspection ».

Entrer en Rendu réel atterrit donc sur la planche. `zoom`/`scrollX`/`scrollY` ne servent plus qu'à
la vue d'inspection. La garantie « selection, zoom et scroll survivent à l'aller-retour de mode »
(spec U1 §5) est préservée à l'identique : c'est toujours l'appelant (`editor-shell.tsx`) qui tient
l'état, `RenderMode` n'a toujours aucun `useState` pour ces quatre champs.

Le long commentaire de contrat de `studio-mode.ts:30` décrit l'ancien sens ; il est **réécrit**, pas
seulement le code. Un commentaire qui décrit un contrat révolu est pire qu'aucun commentaire.

Navigation :
- clic sur une tuile → `onViewChange({ ...view, selectedId: format, zoom: "fit", scrollX: 0, scrollY: 0 })` ;
- `Échap` ou le bouton retour → `selectedId: null` ;
- `←` / `→` en inspection → format précédent/suivant dans l'ordre de `FORMAT_KEYS` ;
- ces raccourcis suivent la discipline de `isModeToggleShortcut` (`studio-mode.ts`) : ils sont
  **inertes quand le focus est dans un champ de saisie** et n'interceptent jamais une combinaison
  portant un modificateur.

## §2 — La planche (`proof-sheet.tsx`)

Grille CSS `repeat(auto-fill, minmax(240px, 1fr))`, `gap-3`, posée sur `--canvas-backdrop`
(DESIGN.md : « Atelier Canvas », hue ~75 — la surface d'atelier, pas un panneau utilitaire).

**Hauteur de tuile uniforme**, rendu centré en boîte-aux-lettres à son ratio réel à l'intérieur du
cadre. Justification : l'objet de cette vue est de balayer huit choses d'un seul regard, et des
hauteurs irrégulières cassent ce balayage ; la forme relative de chaque format reste lisible
puisque le rendu, lui, garde son ratio.

Anatomie d'une tuile, de haut en bas :
1. **cadre de rendu** — `ring-1 ring-foreground/10`, `rounded-xl`, remplissage `muted/30`, image en
   `object-contain` ;
2. **rangée méta** — libellé du format (Inter, `text-xs font-medium`) et dimensions
   (`text-[11px] text-muted-foreground`) ;
3. **puces d'alerte**, uniquement quand elles s'appliquent réellement à ce format.

Le format natif du gabarit porte un marqueur discret `natif` — **neutre, jamais terracotta**
(DESIGN.md, *The Actions-Only Rule* : l'accent est réservé aux actions primaires).

La tuile est un `<div class="relative">` contenant **deux boutons frères**, jamais imbriqués : un
`<button>` en `absolute inset-0` qui ouvre l'inspection, et le bouton de téléchargement
positionné au-dessus de lui (`absolute` + `z`) dans le coin du cadre, révélé au survol/focus. Un
`<button>` dans un `<button>` est du HTML invalide et le navigateur déstructure l'arbre — d'où les
deux frères plutôt qu'une tuile-bouton avec un `stopPropagation`. Le bouton de téléchargement reste
atteignable au clavier (il suit la tuile dans l'ordre de tabulation) et devient visible au focus,
pas seulement au survol. Séparation par filet et bascule tonale, **jamais d'ombre au repos**
(DESIGN.md, *The Hairline-Not-Shadow Rule*).

États d'une tuile : squelette **au ratio réel du format** (pas un `…` centré), image, ou erreur
compacte avec une action *Réessayer* locale.

## §3 — L'inspection (`format-focus.tsx`)

En-tête : retour `←`, nom du format, dimensions, alertes développées **en phrases complètes**, puis
le contrôle de zoom, puis le téléchargement.

Sous l'en-tête, une bande fine de huit pastilles de format (l'active marquée, une puce d'alerte là
où il y en a) : elle permet de parcourir les formats sans repasser par la planche. Défilement
horizontal sur écran étroit.

La surface de rendu prend **tout** l'espace restant :
- `fit` : l'échelle est calculée par un `ResizeObserver` sur le conteneur, confrontée au ratio du
  format. **Aucune boîte `aspect-ratio` nulle part** — c'est la correction du défaut n°2, obtenue en
  supprimant la règle de dimensionnement imbriquée plutôt qu'en la contournant ;
- zoom continu 0,1 → 1,0 : ⌘/Ctrl + molette, boutons `−`/`+`, et deux boutons d'accrochage
  *Ajuster* et *100 %* ;
- plafond maintenu à 1,0 (l'actuel `MAX_RENDER_ZOOM`) : au-delà des pixels natifs on inspecte un
  agrandissement, pas une typographie. L'infobulle **le dit**, au lieu de laisser la limite
  inexpliquée ;
- au-delà de « fit », la surface défile ; le défilement est reporté dans `view.scrollX/scrollY`
  comme aujourd'hui (écran → état à chaque défilement, état → écran uniquement au changement de
  format).

**Tactile** : *Ajuster* / *100 %* et défilement natif. Pas de geste de pincement — disproportionné
pour cette passe, décision n°7.

## §4 — Couche rendu et cache

### `lib/studio/preview-cache.ts` — pur, sans DOM

- `previewCacheKey(templateId, scene, format, articleId)` : hachage FNV-1a de la sérialisation de la
  scène, concaténé aux trois autres champs. Fonction **pure**, donc couverte par `test:pure`.
- `createPreviewCache(maxBytes)` : LRU **bornée en octets, pas en entrées**. Un PNG 1080×1920 en
  data-URI pèse 1–2 Mo ; huit formats sur quelques révisions de scène dépasseraient largement une
  centaine de mégaoctets si on comptait des entrées. Taille estimée par `dataUri.length * 0.75`,
  éviction du plus ancien jusqu'à repasser sous le budget. Budget par défaut : **48 Mo**.
- L'instance partagée vit en **portée module** — c'est précisément ce qui lui fait survivre au
  démontage de `RenderMode` lors d'un aller-retour Montage⇄Rendu, ce qu'un `useRef` ou un contexte
  ne feraient pas.
- La fabrique est exportée pour que les tests puissent instancier un cache à budget minuscule et
  **observer réellement** l'éviction, plutôt que de la supposer.

### `hooks/use-preview.ts` — le cœur sans UI

Extrait de `preview-pane.tsx` sans changement de comportement : différé de 800 ms, garde
`requestIdRef` contre les réponses périmées, lecture/écriture du cache, et une entrée `enabled` (qui
absorbe à la fois `disabled` et le gating de visibilité).

Retourne `{ status, dataUri, degraded, overflow, lowRes, refresh }`.

Conséquences :
- `PreviewPane` est réécrit autour du hook. **Sa sortie et ses `data-testid` sont inchangés** — la
  colonne propriétés du mode Montage ne doit connaître aucune régression ;
- l'appel `previewTemplate` propre à `FilmstripThumb` (`render-mode.tsx:206`) disparaît au profit du
  même hook : un seul chemin de rendu, un seul cache, un seul différé ;
- les tuiles passent `enabled: isVisible`. L'`IntersectionObserver` existant est **conservé**
  (`rootMargin: "200px"`, `.disconnect()` à la première apparition) ;
- sur un succès de cache, le hook résout dès le premier rendu : **aucun clignotement de chargement**
  au retour d'une inspection ou d'un aller-retour de mode. C'est le bénéfice visible de la mémo.

### Provenance / article

`articleId` remonte de l'état interne de `PreviewPane` vers `RenderMode`, et alimente **les huit
tuiles et l'inspection**. C'est la correction du défaut n°7. En mode Montage, `PreviewPane` continue
de posséder son `articleId` en interne — inchangé.

Coût assumé : changer d'article coûte désormais jusqu'à huit rendus au lieu d'un. Le gating de
visibilité et la mémo le rendent supportable (un téléphone n'affiche qu'une tuile ; un 27" en
affiche huit). C'est le prix pour que l'écran cesse de mentir, et il est payé sciemment.

### Ce qui ne change pas

`previewTemplate` reste le **seul** appel réseau ; aucun chemin n'écrit `renders` ni un objet R2. La
garantie structurelle de `tests/studio-preview.test.ts` (parcours du graphe d'imports réel) est
**étendue** au hook, jamais assouplie — voir §7.

## §5 — Fraîcheur, alertes, provenance

**Supprimés** : `stale`, le badge *Périmé*, `refreshNonce`, `rerenderFilmstrip`, et les deux
paragraphes de provenance. Une scène modifiée produit une clé de cache différente, donc une tuile
est soit à jour, soit en cours de chargement. **Un seul modèle de fraîcheur.**

Conservé : **un** bouton *Actualiser* global dans la barre d'outils, qui purge les entrées de cache
de la scène courante et relance les tuiles visibles. Il reste utile pour un cas que le hachage de
scène ne peut pas voir : une **image source modifiée à distance**, dont l'URL n'a pas changé.

**Agrégation des alertes** : une seule pastille dans la barre d'outils — « 2 formats à vérifier » —
dans l'ambre déjà défini du statut `Pending` (DESIGN.md, palette de statut). Un clic fait défiler
jusqu'à la première tuile signalée.

Le compte ne porte que sur les formats dont le rendu a **effectivement abouti**. Une tuile jamais
entrée dans le viewport n'a pas encore été rendue et n'a donc aucune alerte à déclarer : la compter
comme saine serait un mensonge, la compter comme suspecte aussi. Tant que les huit ne sont pas
résolus, la pastille se qualifie — « 2 formats à vérifier sur 5 rendus » — et ne tombe à sa forme
courte qu'une fois les huit connus. C'est la conséquence directe du gating de visibilité (§4) ;
l'alternative — rendre les huit d'emblée pour pouvoir afficher un compte définitif — annulerait
l'économie que ce gating existe pour produire. Sur la tuile : puces compactes. La **phrase complète** — y
compris la réserve « mesuré avec la police de repli, approximatif » aujourd'hui enfouie dans un
attribut `title` (`render-mode.tsx:261`) — s'affiche dans l'inspection, où il y a la place de
l'écrire.

Les deux alertes existantes sont conservées telles quelles, sans changement de sens :
- **Texte déborde** — `overflowingLayerIds`, mesuré avec la police de repli, donc approximatif ;
- **Image agrandie** — `lowResLayerIds`, constaté par le moteur sur les octets réellement
  téléchargés, donc **sans** réserve d'approximation.

**La provenance devient un contrôle, pas de la prose** : le sélecteur d'article vit dans la barre
d'outils et affiche « Valeurs d'exemple » ou le titre de l'article. Puisqu'il pilote désormais les
huit tuiles, il n'y a plus rien à démentir. Pour les trois contextes à saisie manuelle (citation,
bandeau, récap), qui n'ont jamais d'article associé, une pastille muette « Valeurs d'exemple »
remplace le sélecteur. `ARTICLE_SELECTABLE_CONTEXTS` reste importée depuis `preview-pane.tsx`, comme
aujourd'hui — jamais recopiée.

## §6 — Responsive et `editor-shell.tsx`

- `editor-shell.tsx:991` s'inverse :
  `mode === "rendu" ? <RenderMode/> : layout === "too-small" ? <TooSmallState/> : <Montage/>`.
  `too-small` ne garde **que** Montage. Justification alignée sur DESIGN.md : la posture est
  « desktop-first, tablet correct, mobile secondary — mobile is for quick consult/approve », et
  Rendu réel **est** la surface de consultation du studio. C'est la seule qui y a sa place.
- `editor-shell.tsx:805` : `ModeSwitch` doit rester monté sous 768px, sans quoi Rendu réel est
  inatteignable sur téléphone. Le côté « Montage » y est rendu **désactivé**, avec l'explication
  « Montage nécessite un écran plus large ». Les autres gardes `layout !== "too-small"` du fichier
  (notamment `:829`) sont revues une par une pendant l'implémentation, pour vérifier qu'aucune
  n'ampute Rendu réel de quelque chose dont il a besoin.
- La grille n'a **besoin d'aucun point de rupture** : `minmax(240px, 1fr)` donne 1 colonne à 380px,
  2 vers 560px, 3 vers 820px, 4 à 5 au-delà de 1440px.
- La barre d'outils passe à la ligne ; sous 640px elle se replie sur le sélecteur d'article (en
  `flex-1`) plus un menu `⋯` portant *Actualiser* et *Tout télécharger*.
- L'inspection : en-tête sur deux lignes en étroit, bande de formats défilante, surface de rendu
  inchangée.

## §7 — Export

- **Par format** : `<a download="{templateId}-{format}.png" href={dataUri}>` — la data-URI est déjà
  en main, aucun aller-retour serveur. Présent au survol de la tuile et dans l'en-tête d'inspection.
- **Tout télécharger** : rend d'abord les formats manquants (progression « 3/8 »), puis déclenche
  huit téléchargements séquentiels espacés d'environ 150 ms. Chrome demande une confirmation unique
  pour les téléchargements multiples : c'est un fait à connaître, pas un motif d'y renoncer.
- **Aucune dépendance zip** (décision n°9). Si un `.zip` unique devient nécessaire plus tard, il
  faudra `jszip` (~100 Ko) — hors périmètre ici.
- Désactivé quand `disabled` (stockage R2 non configuré) : le studio entier est inerte dans ce cas,
  simplification d'UX délibérée déjà en place (spec §8), qu'on ne contourne pas.

## §8 — Tests

**Purs** (`bun run test:pure`) :
- `lib/studio/preview-cache.ts` — stabilité de clé (scène identique ⇒ clé identique ; un calque
  déplacé ⇒ clé différente ; `articleId` différent ⇒ clé différente) ; éviction réellement observée
  contre un budget minuscule ; ordre LRU (un accès rafraîchit la récence).
- `lib/studio/studio-mode.ts` — la nouvelle sémantique `selectedId === null ⇒ planche`, et la
  préservation champ par champ inchangée.

**Rendu statique** (`tests/studio-render-mode.test.ts`, largement réécrit) :
- la planche rend huit tuiles portant le bon `data-format` ;
- le marqueur `natif` se pose sur le format natif, et sur lui seul ;
- la pastille d'agrégation compte réellement les formats signalés ;
- la convention d'amorces de test existante (`initialOverflow` / `initialLowRes` /
  `initialDegraded`) est **conservée** : c'est le moyen par lequel ce dépôt affirme des états
  post-réseau sans harnais DOM. Elle est étendue, pas remplacée.
- `sceneForFormat` reste épinglée contre `relayoutToFormat` (garantie §0 : le chemin d'aperçu et le
  chemin de génération appellent la **même** fonction pure).

**Structurel — non négociable** (`tests/studio-preview.test.ts`) :
Ce test parcourt le graphe d'imports réel pour prouver que `lib/studio/store.ts` (donc `saveRender`)
n'est atteignable par **aucun chemin** depuis l'aperçu. Après l'extraction, il doit partir **aussi**
de `hooks/use-preview.ts`. Ce test est **étendu, jamais rétréci** pour faire passer la refonte : si
l'extraction le fait échouer, c'est l'extraction qui est fautive.

## Risques et limites assumées

1. **Changement de contrat sur `PreservedView.selectedId`.** Le sens change en place (décision n°8).
   Aucun autre consommateur n'existe aujourd'hui (`editor-shell.tsx` ne fait que porter l'état), mais
   la documentation de `studio-mode.ts` doit être réécrite en même temps que le code.
2. **`tests/studio-render-mode.test.ts` est largement réécrit.** Attendu : le composant qu'il décrit
   n'existe plus sous cette forme. Ce n'est pas une licence pour affaiblir les assertions — chaque
   garantie de l'ancien fichier qui reste vraie doit reparaître dans le nouveau.
3. **Changer d'article coûte huit rendus** au lieu d'un (§4). Accepté sciemment.
4. **Mémoire du cache** : 48 Mo est un plafond choisi, pas mesuré. À réviser si un profil réel montre
   une pression mémoire sur des machines modestes.
5. **Hauteur de tuile uniforme** (décision n°6) rend une story visiblement petite dans sa tuile.
   C'est le compromis accepté en faveur du balayage ; c'est le point le plus utile à vérifier
   réellement dans le navigateur avant de figer.
6. **Pas de pincement tactile** (décision n°7) : l'inspection fine sur téléphone se limite à
   *Ajuster* / *100 %* et au défilement.
