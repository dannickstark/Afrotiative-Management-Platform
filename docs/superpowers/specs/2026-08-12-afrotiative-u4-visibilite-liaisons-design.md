# Afrotiative — U4 : Visibilité des liaisons — Spécification

**Date :** 2026-08-12
**Statut :** Conception validée en atelier — prête pour le plan d'implémentation
**Branche :** `feat/u4-visibilite-liaisons` (sur `main`, après la fusion de U0–U3 via PR #12)
**Feuille de route :** `2026-08-10-afrotiative-studio-ux-roadmap.md`, sous-projet U4
**Portée moteur/schéma :** le moteur de rendu (Satori) ne change pas ; le schéma `scene.ts` gagne un
marqueur d'introspection sur `hexColor`, sans nouveau champ de données.

---

## Le problème

Les liaisons de données — les `{{jetons}}` qu'un gabarit porte — sont aujourd'hui **invisibles ou
mensongères** dans l'éditeur :

1. **Une couleur liée à un jeton disparaît à l'écran.** Le chemin de peinture navigateur
   (`components/studio/layer-view.tsx`) reçoit la scène BRUTE, sans `resolveTokens`. Résultat mesuré
   (relevé de territoire, 2026-08-12) : `ShapeContent` (:101-107) détecte un `fill` en jeton et peint
   un placeholder rayé, mais `TextContent` (:166-175, couleur/ombre/contour), `QrContent` (:152-164,
   fg/bg) et l'arrière-plan du canevas (`canvas.tsx:214`) laissent filer `« {{category.color}} »` comme
   CSS invalide → **ignoré silencieusement**. Le calque « Bordure catégorie » du gabarit par défaut
   livré (`db/studio-templates.ts:18`) est ainsi **entièrement invisible** dans l'éditeur, alors qu'il
   rend correctement dans le PNG exporté.
2. **Rien ne montre quels calques sont liés.** Il faut sélectionner chaque calque pour voir s'il porte
   un jeton.
3. **Le sélecteur de jetons cache les jetons illégaux** au lieu de les montrer désactivés avec le
   motif : `TokenPicker` (`token-picker.tsx`) *omet* ce que `tokensFor(context, kind)` ne renvoie pas.
4. **`parseScene` ne remonte que la PREMIÈRE erreur Zod** (`scene.ts:249`, `issues[0]`). Un gabarit
   portant trois liaisons illégales en signale une ; on la corrige, on enregistre, on rencontre la
   suivante.
5. **La liste des champs-couleur est recopiée à la main dans DEUX endroits** — `tokens.ts#extractTokens`
   (ce que `validateScene` vérifie) et `values.ts#resolveTokens` (la substitution avant rendu) — tenues
   en phase par un commentaire et un test aller-retour, pas par une dérivation. §0 généralisé (U3 Tâche
   4) : les consommateurs d'un champ sont plus nombreux que les deux chemins de rendu, et une liste
   recopiée dérive tôt ou tard.

---

## Le plafond du moteur (inchangé)

Satori rend le PNG ; l'éditeur peint dans le navigateur. Les deux chemins doivent **s'accorder** — c'est
la leçon §0 répétée tout au long de U1→U3. U4 ne change pas le moteur : il fait converger l'éditeur
vers ce que le moteur produit déjà (couleurs résolues), et rend explicite ce qui était caché
(liaisons).

---

## Les cinq composants

### Composant 1 — Les couleurs liées se peignent avec leur valeur d'échantillon

**Décision d'atelier :** montrer la couleur d'échantillon (et non un indicateur de liaison).

Le chemin de peinture navigateur résout les jetons de COULEUR vers `SAMPLE_VALUES`
(`lib/studio/sample-values.ts:19-39`, qui couvre tout le catalogue `TOKEN_KINDS`, dont
`category.color`) **au moment du rendu uniquement**. `state.scene` reste brut et éditable ; la
résolution est une transformation d'affichage, pas une mutation d'état.

- Champs concernés (ceux qu'énumère le Composant 2) : `text.color`, `text.shadow.color`,
  `text.stroke.color`, `qr.fg`, `qr.bg`, `shape.fill` (chaîne ou arrêts de dégradé), `shape.border.color`,
  `shape.shadow.color`, `image.overlay`, `canvas.background`.
- Le placeholder rayé du `fill` de forme (`layer-view.tsx:101-107`) est REMPLACÉ par la couleur
  d'échantillon résolue — l'indication « ce calque est lié » passe au Composant 5, pas au rendu de la
  couleur.
- **Hors périmètre :** les jetons d'IMAGE (slot) gardent leur placeholder actuel (`ImageContent:78`) ;
  les jetons de TEXTE dans le CONTENU (`text.content`) gardent leur affichage actuel — leur visibilité
  de liaison relève du Composant 5. U4 = dette COULEUR.

**Garde-fou obligatoire (leçon §0) :** un test prouve que la couleur résolue par l'éditeur et celle
résolue par l'export (`element.ts` après `resolveTokens`) sont **identiques** pour un même champ et une
même valeur d'échantillon. Sans quoi l'éditeur pourrait « corriger » l'invisibilité tout en divergeant
de l'export — le défaut exact que U4 répare.

### Composant 2 — La liste des champs-couleur, dérivée du schéma

**Décision d'atelier :** dériver du schéma (et non garder les deux listes avec un garde de dérive).

`scene.ts:15-18` définit un unique nœud partagé `hexColor` (`z.string().refine(...)`), consommé par
CHAQUE champ-couleur du schéma. Aujourd'hui il n'est pas introspectable (pas de `.brand()` / `.meta()`).
U4 :

1. **Marque `hexColor`** d'une étiquette d'introspection (registre `z.registry` ou `.meta()` de Zod v4,
   à confirmer par le spike ci-dessous).
2. **Un seul marcheur** — `colorFieldsOf(layer)` (et le champ `canvas.background`) — parcourt un calque
   et renvoie les chemins/valeurs des champs-couleur, dérivés du marquage. `extractTokens` (`tokens.ts`)
   ET `resolveTokens` (`values.ts`) le consomment, retirant les deux listes recopiées.
3. **Garde structurelle** (motif `SHAPE_KINDS`/tripwire) : un test affirme que le marcheur trouve
   EXACTEMENT les champs-couleur du schéma, de sorte qu'un champ-couleur ajouté au schéma sans passer
   par `hexColor`, ou un `hexColor` non couvert par le marcheur, fasse rougir un test — pas dériver en
   silence.

**Risque et spike (stop-and-report) :** l'introspection d'un schéma Zod v4 pour marcher un arbre imbriqué
n'a jamais été faite dans ce dépôt. La Tâche 1 est un **spike qui s'arrête et rend compte** : prouver
qu'on peut, à partir d'un `hexColor` marqué, énumérer les chemins-couleur d'un calque donné, à travers
`z.object`, `z.union` (le `fill`), `z.array` (les arrêts de dégradé) et `z.optional` (ombre/contour).
Si l'introspection ne porte pas, le repli — garder les deux listes + une garde de dérive qui marche le
schéma par identité de nœud — est décidé par l'humain avant tout engagement de refactor. (Précédent :
le spike clipPath de U3 Tâche 1.)

### Composant 3 — `parseScene` remonte TOUTES les erreurs

`parseScene` (`scene.ts:246-261`) collecte AUJOURD'HUI `issues[0]` seul. U4 :

- Parcourt **toutes** les `parsed.error.issues`, chacune traduite comme aujourd'hui (`frenchZodMessages`
  pour les codes intégrés, `.message` tel quel pour les `custom` déjà en français), préfixée de son
  chemin.
- **Plus** la vérification d'identifiants en double (`scene.ts:255-259`), qui est une source d'erreur
  indépendante des `issues` Zod : elle rejoint la liste au lieu de lever séparément.
- **Joint** le tout dans un unique `SceneError.message` (une erreur par ligne). Rétro-compatible :
  d'après le relevé de territoire, tous les appelants ou bien testent `instanceof SceneError` et lisent
  `.message` (`template-core.ts:218`, `preview-core.ts:91`, `index.ts`, `manual-core.ts:117`), ou bien
  s'appuient sur le fait que ça LÈVE (`editor-state.ts:243` rejette le patch ; `resolve.ts:51`,
  `queries/studio.ts:209`, `db/studio-templates.ts:115` laissent propager). Aucun ne dépend d'une seule
  erreur ni d'une structure ; le contrat `throw SceneError(message)` tient. Précédent en dépôt :
  `validateScene` renvoie déjà `string[]` et les appelants font `errors.join(...)`.

### Composant 4 — Le sélecteur de jetons : légaux seulement, illégaux désactivés avec le motif

`TokenPicker` (`token-picker.tsx:40-94`) *omet* aujourd'hui les jetons hors contexte (`tokensFor`
filtre à `CONTEXT_TOKENS[context]` ∩ `kind`). U4 :

- Montre les jetons du bon `kind`, en **désactivant** ceux hors contexte avec le **motif** — le motif
  que porte déjà `validateScene` (« n'est pas disponible dans ce contexte »). Le motif de désactivation
  reprend celui, déjà écrit, de `dynamic-text.ts:102-120` (`dynamicTextRowsFor` renvoie
  `available:false` + `reason`).
- **Audit de couverture :** un sélecteur doit exister sur CHAQUE champ liable — contenu de texte
  (`property-panel.tsx:413`, déjà là), tous les `ColorField` (déjà, via `ColorField`), slot d'image
  (`:522`), slot d'URL du QR (`:850`). Ajouter là où il manque ; nommer explicitement les champs qui,
  délibérément, n'en portent pas.
- **Piège d'assertion (leçon U3) :** le composant `Switch`/désactivé de Base UI rend
  `aria-disabled="true"` SANS attribut natif `disabled` — une assertion cherchant `disabled` passerait
  quel que soit l'état. Les tests visent l'état accessible réel, pas la sous-chaîne.

### Composant 5 — Les liaisons visibles sur le plan de travail

Nouvelle préférence d'éditeur `showBindings: boolean` (défaut **désactivé**), persistée exactement comme
`rulers`/`grid`/`safeAreas` :

- `EditorPrefs` (`editor-prefs.ts:20-41`) + `DEFAULT_PREFS` (:43-52) + une ligne `parseBooleanField` dans
  `parsePrefs` (:125-127, le parseur par champ qui ne lève jamais) + le câblage `editor-shell.tsx:492-495`.
- Un **bouton bascule** dans le groupe de boutons de `canvas-chrome.tsx:179-219` (règles/grille/zones
  sûres).
- **Quand activé :** chaque calque portant un `{{jeton}}` (détection via `usesInLayer(layer)`,
  `tokens.ts:85-131`) reçoit un **contour d'accent + une étiquette** nommant son/ses jeton(s) (libellés
  `TOKEN_LABELS`). Rendus dans le conteneur MIS À L'ÉCHELLE (`canvas.tsx:207-216`), à côté des repères de
  magnétisme (`:350-374`), en coordonnées gabarit avec compensation `1/scale` pour garder une taille
  d'écran constante — le motif exact des repères de snap.
- Séparation nette : le Composant 1 (couleurs d'échantillon) s'applique TOUJOURS ; `showBindings` n'ajoute
  QUE la surcouche contour/étiquette. On a écarté « les deux liés à la bascule ».

---

## Découpage en tâches (SDD, dans cet ordre)

1. **Spike — introspection de `hexColor`** (stop-and-report). Prouver qu'on peut énumérer les
   chemins-couleur d'un calque depuis un `hexColor` marqué, à travers object/union/array/optional. Si
   non : rendre compte, l'humain tranche le repli.
2. **Composant 2 — liste dérivée + garde structurelle.** Un marcheur consommé par `extractTokens` et
   `resolveTokens` ; retirer les deux listes recopiées ; le tripwire.
3. **Composant 1 — l'éditeur peint les couleurs liées via les valeurs d'échantillon.** Test
   « les-deux-chemins-s'accordent ».
4. **Composant 3 — `parseScene` toutes erreurs.** Test : plusieurs erreurs simultanées, toutes
   rapportées ; double-id rejoint la liste.
5. **Composant 4 — sélecteur légaux/désactivés-avec-motif + audit de couverture.**
6. **Composant 5 — surcouche de liaisons sur le canevas** (`showBindings` + bouton + contours/étiquettes).

Ordre : la liste dérivée (2) sous-tend le travail couleur (3) ; le spike (1) la précède car il en décide
l'approche. `parseScene` (4) et le sélecteur (5) sont indépendants. La surcouche (6) est le point
d'orgue visible.

---

## Qualité — les leçons du programme, appliquées

- **§0 (les deux chemins s'accordent)** : garde-fou obligatoire du Composant 1 ; c'est le défaut même que
  U4 répare, il ne doit pas être réintroduit par sa correction.
- **Harnais DOM (U0)** pour la surcouche canevas et les interactions du sélecteur.
- **Fonctions de choix** : balayer toute fonction introduite (placement de l'étiquette de liaison,
  résolution d'échantillon par champ) — les quatre défauts invisibles de U2 étaient toutes des fonctions
  de choix.
- **Anti-vacuité** : chaque propriété négative appariée d'un témoin positif ; méfiance des sous-chaînes
  naïves (`disabled` de Base UI, `aria-disabled`) et des gardes « anti-vacuité » elles-mêmes vacuantes.
- **Garde structurelle plutôt que discipline** : la liste-couleur dérivée est pinée par un tripwire, pas
  par un commentaire — 11 des 13 défauts de plan de U3 ont été rattrapés par des implémenteurs
  attentifs ; un tripwire ne dépend de l'attention de personne.
- **La mutation est le seul juge** : les tests portants doivent rougir sous mutation ; le décompte
  d'`expect()` et `bun run build` ne prouvent rien (abandonnés depuis U2).

## Ce qui n'est PAS dans U4

- Les jetons d'IMAGE et de CONTENU texte restant en placeholder/brut (visibilité par la surcouche du
  Composant 5, pas par résolution). U4 = dette COULEUR.
- La carte des liaisons (chaque jeton et ce qui l'utilise) — reportée après U4 par la feuille de route.
- Toute modification du moteur Satori.
- U5 (adaptation multi-format) — sous-projet suivant.
