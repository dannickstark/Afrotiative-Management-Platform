# Afrotiative — Studio visuel : refonte de l'interface — Feuille de route

**Date :** 2026-08-10
**Statut :** Décisions validées en atelier (compagnon visuel) — exécution sous-projet par sous-projet
**Portée :** L'interface d'édition de `/studio`, livrée en V2. Le moteur de rendu (V1) ne change pas.
**Précédent :** `2026-08-09-afrotiative-studio-diffusion-roadmap.md` — ce document en est le pendant
pour l'éditeur, pas pour la diffusion.

Ce document est le registre durable des décisions d'interface. Chaque sous-projet U1 → U5 reçoit
ensuite son propre spec → plan → exécution.

---

## Point de départ (relevé dans le code, 2026-08-10)

Ce qui existe : quatre types de calques (`image`, `text`, `shape`, `qr`), huit préréglages de format,
déplacement/redimensionnement/rotation, panneau de calques (ordre, visibilité, verrou), annuler/refaire,
auto-enregistrement, brouillon/publié avec historique de versions, bibliothèque d'assets et de polices,
aperçu du rendu réel.

Ce qui manque ou gêne, tel que constaté :

| Constat | Preuve |
|---|---|
| **Sélection unique** — pas de multi-sélection nulle part | `selectedId: string \| null` (`components/studio/canvas.tsx`) |
| Donc **ni alignement, ni distribution, ni déplacement groupé** | conséquence directe du point ci-dessus |
| **Aucun magnétisme, aucun repère** | `computeResizedFrame` / `computeRotationDeg` ne reçoivent aucune cible de magnétisme (`hooks/use-layer-drag.ts`) |
| **Le redimensionnement dérive sur un calque pivoté** | `computeResizedFrame` travaille en espace non pivoté ; les poignées sont rendues dans un conteneur `rotate(Ndeg)` et le delta du pointeur arrive en espace écran |
| **Une seule forme : le rectangle** | `shape: z.literal("rect")` (`lib/studio/scene.ts`) |
| **La géométrie est la dernière section du panneau** | `<Section title="Cadre">` à la ligne 646 de `property-panel.tsx`, après Texte / Police / Apparence / Ombre / Contour |
| **Le panneau de propriétés fait 674 lignes** | presque le double du fichier studio suivant |
| **Propriétés et aperçu se partagent 300 px** | `grid-cols-[220px_1fr_300px]`, colonne de droite empilée (`editor-shell.tsx:287`) |
| **Rien ne montre quels calques sont dynamiques** | il faut sélectionner chaque calque pour voir s'il porte un `{{jeton}}` |
| **Pas de re-mise en page entre formats** | les cadres sont en pixels absolus ; huit préréglages de 1,9:1 à 0,5625:1 |

S'y ajoutent les défauts déjà consignés à l'issue de V2 : l'aperçu ignore `image.overlay` que le
moteur composite bien, les flèches et `Suppr` n'agissent que si le canevas a le focus DOM, un geste
sans mouvement pousse quand même une entrée d'annulation, aucun réessai après un
auto-enregistrement en échec, `parseScene` ne remonte que la **première** erreur Zod.

---

## Le plafond du moteur (contrainte, non négociable ici)

Satori rend ces gabarits, et **le moteur ne change pas** — décision confirmée en atelier. Donc :

**Disponible :** flexbox, `position: absolute`, `transform`, `border-radius` (dont quatre valeurs),
`box-shadow`, `text-shadow`, dégradés, `objectFit`/`objectPosition`, `lineClamp`, `opacity`,
`overflow: hidden`, `filter`, **`clipPath`**.

**Indisponible :** CSS Grid, `z-index` (l'ordre de peinture **est** l'ordre du tableau de calques),
`calc()`, `backdrop-filter`, flou en CSS (le flou passe par une pré-passe raster `sharp`), WOFF2,
RTL, ligatures et crénage.

Conséquence pour les formes : ellipse et cercle par `border-radius: 50%`, trait par un cadre fin
pivoté, et **toute la famille polygonale — triangle, étoile, hexagone, chevron, flèche, bulle — par
`clip-path: polygon(...)`**. Les modes de fusion et le flou en direct restent hors de portée.

> **Réserve à lever avant U3 :** la présence de `clipPath` dans la liste vient de la documentation de
> Satori, pas d'un polygone effectivement rendu par ce projet. U3 commence par une étoile rendue et
> comparée pixel à pixel, avant tout engagement de schéma.

---

## Décisions d'interface (atelier du 2026-08-10)

| Sujet | Décision |
|---|---|
| **Coque** | **Rail d'icônes libellées + un panneau large accosté par catégorie**, repliable par un chevron sur son bord et un raccourci — motif emprunté à Canva (captures fournies en atelier). Canevas portant des pastilles flottantes (format, zoom) + rail de propriétés à droite. Écarté : une barre d'outils **modale** (« armer l'outil rectangle »). On **clique une forme dans la galerie et elle atterrit** sur le plan de travail ; sélectionner-déplacer reste le comportement permanent du canevas, pas un outil. |
| **Catégories du rail** | `Modèles` · `Éléments` · `Texte` · `Images` · `Marque` · `Calques`. Le panneau de calques cesse d'être un panneau flottant : il devient une entrée du rail. `Modèles` est ce sur quoi ouvre un gabarit vierge — c'est la réponse à « que voit-on à la création ». |
| **Le panneau « Texte » porte les jetons** | Là où Canva propose du contenu générique, ce produit propose des **liaisons**. La section « Texte dynamique » liste les jetons de l'article — titre, chapô, rubrique, signature, date — et **un clic insère un calque déjà lié**, stylé depuis un préréglage. C'est le transfert le plus utile des captures : les liaisons deviennent explorables au lieu d'être cachées derrière un champ. Les jetons illégaux dans le contexte du gabarit s'affichent désactivés avec le motif. |
| **Chaque panneau** | Une recherche en haut, **une** action principale (« Ajouter une zone de texte », « Importer des fichiers »), puis des sections : « Utilisés récemment », préréglages, catégories. Les préréglages de texte se dessinent **à leur taille réelle** (Titre / Sous-titre / Corps). |
| **Aperçu** | **Ce n'est plus un panneau, c'est un mode.** Un commutateur flottant `Montage ⇄ Rendu réel`, centré au-dessus du plan de travail, plus le raccourci `R`. En mode rendu, toute la chrome d'édition disparaît. |
| **Contenu du mode rendu** | Le format courant en grand, les sept autres en bande de vignettes cliquables en dessous. |
| **Rail de propriétés** | Bande de géométrie **épinglée** en haut (X / Y / L / H / rotation / opacité), qui ne défile jamais ; sections par type repliables en dessous, état mémorisé. Écarté : des onglets dans le rail — ils cachent des propriétés liées les unes des autres (on perdrait l'ombre de vue en réglant la couleur dont elle tombe). |
| **Liaisons de données** | Les calques liés à un jeton portent un contour d'accent et une étiquette de jeton **sur le plan de travail**, derrière un interrupteur « voir les liaisons ». |
| **Surface de travail** | Le jeu complet : règles, grille, repères intelligents, zones sûres. Règles et grille **disponibles mais désactivées par défaut**, état mémorisé par utilisateur. Zones sûres **actives** sur les formats `story` et `ig_portrait`, inactives sur les formats de lien. |
| **Gestes** | `Maj` contraint le redimensionnement au rapport d'aspect, `Maj` aimante la rotation par pas de 15°, `Alt` redimensionne depuis le centre. État (sélection, zoom, défilement) préservé au passage d'un mode à l'autre. |
| **Ancres** | Chaque côté d'un calque peut être **ancré au côté correspondant du canevas, avec une valeur**. Un seul côté ancré sur un axe : la taille est conservée à distance fixe. Les deux côtés ancrés : la largeur (ou la hauteur) devient **dérivée** et le calque s'étire. Aucun côté ancré sur un axe : le calque reste centré proportionnellement. |
| **Unité des ancres** | **Pixels uniquement.** Une marge de 48 px reste 48 px dans tous les formats — prévisible, cohérent avec le stockage actuel du cadre, et c'est ce qu'un graphiste entend par « marge ». Écarté : une unité par côté (px ou %), plus expressif pour les formats hauts mais qui double les cas à tester dans la re-mise en page. |
| **Indicateur d'enregistrement** | Il quitte l'en-tête pour voisiner le commutateur de mode : « Enregistré » / « Enregistrement… » / « Échec — réessayer ». Ce dernier état n'existe pas aujourd'hui : c'est le réessai d'auto-enregistrement manquant. |

---

## Découpage en sous-projets

Le découpage initialement proposé (formes / manipulation / multi-format / finition) ne survit pas aux
décisions : la barre d'outils n'a rien à offrir sans les nouvelles formes, la bande de formats ne dit
la vérité qu'une fois la re-mise en page acquise, et les repères sont inséparables de la
multi-sélection. D'où ce re-découpage, dans cet ordre.

### U1 — Coque, rail et modes — ✅ Livré (2026-08-11)
Rail d'icônes libellées avec ses six catégories, un panneau accosté par catégorie (recherche, action
principale, sections), pastilles flottantes, commutateur de mode, mode rendu avec sa bande de
formats, restructuration du rail de propriétés (bande épinglée + sections repliables), indicateur
d'enregistrement avec son état d'échec. **Aucune modification du moteur ni du schéma.** C'est le
contenant dans lequel tout le reste vient se poser, donc il passe en premier : la galerie
« Éléments » doit exister avant que U3 y ajoute des tuiles, et le mode rendu avant qu'il porte une
bande de formats.

Les panneaux n'affichent que ce qui existe déjà — la galerie « Éléments » ne montre que le rectangle
et le QR code tant que U3 n'a pas livré les autres formes, **sans boutons désactivés pour des choses
qui ne fonctionnent pas**. Réutilise les surfaces déjà écrites plutôt que de les réécrire :
`asset-library.tsx`, `asset-picker.tsx`, `token-picker.tsx` et `templates-table.tsx` existent et
migrent depuis leurs modales et pages vers les panneaux.

**Frontière avec U4, à ne pas confondre :** U1 utilise la connaissance de légalité que `tokens.ts`
porte déjà, en lecture, pour griser un jeton indisponible dans le contexte du gabarit. U4 livre
l'autre moitié — le sélecteur de jetons **à l'intérieur des champs** du rail de propriétés, et
`parseScene` qui remonte toutes les erreurs au lieu de la première.

#### Ce qui a été livré, et à quel prix

Sept tâches, chacune revue ; cinq ont demandé une vague de correctifs, puis une revue complète du
sous-projet et sa propre vague. Le rail à six catégories libellées avec son panneau accosté ;
« Texte dynamique » où un clic insère un calque déjà lié au jeton ; la galerie de formes bornée par
`SHAPE_KINDS`, exporté par `scene.ts` et consommé par le schéma comme par la garde ;
`Montage ⇄ Rendu réel` avec sa bande de formats chargée paresseusement ; la géométrie épinglée hors du
conteneur de défilement ; les pastilles, règles et grille ; et le réessai d'enregistrement qui repart
sans exiger une modification. Spec : `2026-08-10-afrotiative-u1-shell-modes-design.md` ; plan :
`../plans/2026-08-10-afrotiative-u1-shell-modes.md`.

#### La leçon de U1, qui vaut pour U2 → U5

**Six tests verts sur une propriété non tenue**, dont quatre parce qu'un composant était testé isolé
alors que la production le compose autrement :

| Test vert | Propriété non tenue |
|---|---|
| Ombre portée de l'artboard | Le conteneur `CanvasChrome`, identique au pixel et en `overflow-hidden`, la rognait |
| Grille rendue quand activée | Elle peignait **sous** l'artboard opaque : le bouton changeait d'état, l'écran non |
| `preserveView(preserveView(v)) === v` | Vrai pour `x => x` — l'identité aurait suffi |
| Garde de complétude des formes | Comparait un miroir recopié à la main, pas le vrai schéma |
| Jeton illégal grisé | Utilisait un jeton de genre `url`, qui n'aurait jamais pu être une ligne |
| — | Et l'aperçu n'avait **jamais quitté** la colonne des propriétés : la promesse centrale du spec, non tenue pendant six des sept tâches, l'omission vivant dans la couture entre deux tâches chacune défendable |

**Cinq de ces défauts venaient du plan lui-même**, pas de l'implémentation — chacun est désormais
consigné comme amendement daté dans le plan. La règle qui en sort, à appliquer dès U2 : **tester la
composition là où la composition est le risque**, et demander de chaque test porteur non pas
« passe-t-il ? » mais « que faudrait-il pour qu'il échoue ? ».

Deux motifs à réutiliser : une **source canonique** consommée par le schéma *et* par la garde
(`SHAPE_KINDS`), et l'**extraction des prédicats purs** testés sur des objets littéraux
(`isModeToggleShortcut`, `toggleCollapse`, `computeCanvasScale`) — ce dépôt n'a pas de harnais DOM, et
deux revues ont reproché des prédicats laissés en ligne alors qu'ils étaient purs.

#### Dette reportée à l'issue de U1

| Point | Où | Pour qui |
|---|---|---|
| `role="radiogroup"` au-dessus d'enfants qui ne sont pas des `radio` — une promesse ARIA échangée contre une autre ; `role="group"` ou aucun rôle conviendrait | `mode-switch.tsx` | U2 |
| La recherche du panneau Images peut vider l'affichage de l'asset courant quand celui-ci sort de la liste filtrée | `panels/images-panel.tsx` | U2 |
| L'ouverture forcée de « Modèles » sur un gabarit vide est persistée : elle suit l'utilisateur d'un gabarit à l'autre jusqu'à fermeture | `editor-prefs.ts`, `use-editor-prefs.ts` | U2 |
| `EditorPrefs.zoom` reste non branché — le spec §7 ne demande que la pastille, mais un champ persisté qui ne vaut jamais que `"fit"` ne doit pas traverser un troisième sous-projet | `editor-prefs.ts` | U2 : brancher ou supprimer |
| Cinq coutures non couvertes faute de harnais DOM : le `onPick` d'Images, le `onClick` des styles, celui des lignes de jetons, l'enregistrement du `keydown` de `⌘/`, et le passage de `prefs.rulers` à l'effet d'échelle. Une mutation dans l'une des cinq laisserait la suite verte | — | **candidat sérieux : installer un harnais DOM avant U2** |
| `DYNAMIC_TEXT_LABELS` redouble 11 libellés de `TOKEN_LABELS` (aucun fichier de `lib/studio` ne peut importer depuis `components/`) | `dynamic-text.ts` | quand un libellé canonique montera dans `tokens.ts` |
| Les vignettes de la bande ne remontent pas leur propre indicateur `degraded` — seule la grande case le fait | `render-mode.tsx` | faible : le repli de police suit le jeu de polices de la scène, pas le format |
| `getTaxonomy()` ramène des `wpTags` que personne ne consomme ; `listTemplates()` tourne à chaque ouverture d'éditeur pour un panneau que la plupart des sessions n'ouvrent pas | `queries/settings.ts`, `studio/[id]/page.tsx` | opportuniste |

### U2 — Surface de précision — ✅ Livré (2026-08-11), avec U0 — PR #11
Magnétisme et repères intelligents (bords et centres des calques voisins, centre et tiers du plan de
travail, espacement égal entre voisins), règles, grille, zones sûres, les trois modificateurs de
geste, multi-sélection avec alignement et distribution, et **le correctif de la dérive au
redimensionnement d'un calque pivoté — précédé d'un test qui la reproduit**, pour être sûr de
corriger le vrai défaut. Le plus gros morceau, et celui qui répond réellement à « construire un
gabarit est fastidieux ».

**Livré aussi : U0, le harnais DOM**, sans nouvelle dépendance, opt-in par fichier (jamais dans
`test-setup.ts` : un DOM global changerait silencieusement la branche exercée par ~1300 tests).

#### La leçon de U2 : les fonctions de choix

**Quatre défauts que la suite verte ne voyait pas, et les quatre étaient des fonctions de choix** —
chacune tenait toutes ses propriétés *en chaque point testé* et sautait *entre* les points.

| Défaut | Mesure |
|---|---|
| Verrou de ratio (Maj) | **198 px** de saut pour un mouvement de curseur de 0,002 px, invisible à 79 tests verts |
| Son propre correctif | Réintroduit en plus étroit via un drapeau de clamp partagé |
| Choix du candidat d'accroche | **2593 px**, soit 324× la borne voulue |
| `computeRotationDeg` | Un geste de 20° depuis 170° rendait **−340°** |

**Le quatrième n'a été trouvé que parce que la revue finale s'est vu demander s'il en existait un
quatrième.** À faire systématiquement en U3–U5 : lister les fonctions de choix introduites, et
balayer chacune.

**La mutation est le seul juge qui ait trouvé quelque chose.** Deux pratiques n'ont rien attrapé et
sont abandonnées : le décompte d'`expect()` comme mesure de force d'assertion, et `bun run build`
comme preuve de la frontière client/`@db` (un pool `pg` dans un chunk client ne fait pas échouer le
build de façon fiable — c'est le parcours du graphe de valeurs, plus un grep du bundle, qui tranche).

**Sept assertions ne pouvaient pas échouer**, dont une garde « anti-vacuité » elle-même vacuante, et
deux pièges de sous-chaîne naïve (`not.toContain("disabled")` que `disabled:pointer-events-none`
satisfait ; `not.toContain("height:0px")` que React ne sérialise jamais ainsi).

#### Défauts de plan #9, #10 et #11 — une forme qu'une revue par tâche ne peut pas voir

**#9 et #10 partagent exactement la même structure** : le fichier nommé dans le plan était correct
pour la sélection **simple** et faux pour le cas général, l'écart créé par une tâche **antérieure** et
hérité par la liste de fichiers d'une tâche **ultérieure**, sans qu'aucun des deux textes ne le
signale. C'est la même famille que la promesse centrale de U1, non tenue pendant six tâches sur sept.
**À vérifier avant d'écrire le plan de U3** : quelle décision d'une tâche antérieure rend faux un
fichier que je m'apprête à nommer ?

**#11** — « frères visibles et **déverrouillés** » comme références d'accrochage. Une référence est en
**lecture seule** ; l'exclusion venait de U2 Tâche 4, où elle est juste pour une autre raison. Coût
réel : verrouiller un fond pour cesser de le bousculer est la façon normale de construire un gabarit,
donc **verrouiller détruisait la capacité à s'aligner dessus**.

#### Dette reportée depuis U2

| Point | Statut |
|---|---|
| Clic simple sur un calque **déjà sélectionné** ne réduit plus la sélection | Régression connue, jugée non bloquante. Les outils de référence réduisent au `pointerup` **sans glissement** ; l'arbitrage n'a porté que sur le `pointerdown`. Contournement : cliquer le vide, puis le calque. |
| `role="radiogroup"` au-dessus d'enfants `aria-pressed` (`mode-switch.tsx`) | Vrai défaut d'accessibilité, **antérieur à U2**. À traiter en U3. |
| Recherche d'Images qui peut vider l'affichage de l'asset courant | Antérieur, hors diff |
| Ouverture forcée de « Modèles » persistée entre gabarits | Antérieur, hors diff |
| `studio-canvas.test.ts` structurellement aveugle au câblage des guides | Accepté : `studio-interactions` le couvre, `k ≠ 1` compris |
| Décompte de tests faux dans le corps d'un commit (Tâche 4) | Accepté : réécrire l'historique est disproportionné, le rapport est juste |

### U3 — Système de formes
Ellipse, trait, famille polygonale par `clipPath`, rayon par coin, ombres sur les formes. Commence
par la vérification `clipPath` décrite plus haut. Peu coûteux, immédiatement visible, et c'est ce qui
donne sa raison d'être à la barre d'outils.

### U4 — Visibilité des liaisons
Étiquettes sur le plan de travail, plus les deux correctifs qui leur appartiennent : un sélecteur de
jetons qui **n'offre que les jetons légaux dans le contexte du gabarit** (les autres désactivés avec
le motif), et `parseScene` qui remonte **toutes** les erreurs au lieu de la première. Aujourd'hui un
gabarit portant trois liaisons illégales en signale une, on la corrige, on enregistre, et on
rencontre la suivante.

### U5 — Adaptation multi-format
Les ancres par côté avec valeurs, une fonction de re-mise en page **pure** (donc testable sans
interface), et les surcharges de cadre par format pour les cas où un graphiste doit intervenir. C'est
ce qui transforme la bande de vignettes de U1, d'un diagnostic, en un outil de travail.

**Deux limites à énoncer, pas à découvrir :** les ancres ne sauvent pas toute mise en page d'un saut
1,9:1 → 0,5625:1 — elles réduisent la fréquence des surcharges, elles ne les suppriment pas. Et
ancrer un calque de texte change sa largeur, donc ses retours à la ligne, ce qui interagit avec
`autoFit` et `maxLines` : c'est le cas où « la re-mise en page a bien fonctionné » devient
discrètement « le titre fait quatre lignes et il est coupé ». Des tests d'abord, sur ce cas précis.

---

## Ce qui n'a pas été retenu, et pourquoi

- **Changer de moteur de rendu.** Un backend navigateur donnerait modes de fusion, flou réel,
  `z-index`. Rejeté : on perdrait le rendu déterministe à ~100 ms sans navigateur, et tous les
  gabarits existants seraient à migrer. Les formes manquantes s'obtiennent par `clipPath`.
- **L'aperçu en panneau, quelle que soit la variante** (onglet dans le rail, division du canevas, ou
  les deux). Un aperçu large de 110 px répond à « est-ce que ça a rendu », jamais à « est-ce que la
  typographie tient ». Le mode plein écran répond aux deux.
- **Des onglets dans le rail de propriétés.** Moins de défilement sur une capture d'écran, pire à
  l'usage.
- **La carte des liaisons** (chaque jeton et ce qui l'utilise, y compris l'inutilisé). Bonne idée
  d'audit, mais elle ne se justifie qu'avec plus de gabarits qu'on ne peut en garder en tête. À
  reconsidérer après U4.
- **La grille de huit formats à poids égal** en mode rendu. Excellente pour une relecture finale,
  inutilisable pour juger un rendu de près. Éventuellement un troisième mode, plus tard.
- **Une barre d'outils modale.** Voir la décision « Coque » : on clique une forme, elle atterrit.
- **Ce que les captures de Canva contiennent et qui ne transfère pas** : la barre de génération par
  IA (la génération de légendes existe déjà, et le studio n'est pas son endroit), l'écosystème
  d'applications, l'audio, la vidéo, la 3D et les animations (aucun support du moteur, aucun cas
  d'usage), les couronnes et fonctions payantes (outil mono-locataire), les banques d'illustrations
  et de photos (les images viennent des articles et de R2, pas d'un catalogue), les grilles et
  maquettes (Satori n'a pas CSS Grid, et les préréglages de format font déjà ce travail de cadrage).
