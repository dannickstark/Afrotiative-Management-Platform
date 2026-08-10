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
| **Coque** | Barre d'outils verticale + panneau de calques repliable + canevas portant des pastilles flottantes (format, zoom) + rail de propriétés à droite. La barre d'outils quitte l'en-tête. |
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

### U1 — Coque et modes
Barre d'outils verticale, panneau de calques repliable, pastilles flottantes, commutateur de mode,
mode rendu avec sa bande de formats, restructuration du rail de propriétés (bande épinglée +
sections repliables), indicateur d'enregistrement avec son état d'échec. **Aucune modification du
moteur ni du schéma.** C'est le contenant dans lequel tout le reste vient se poser, donc il passe en
premier : la barre d'outils doit exister avant que U3 y ajoute des formes, et le mode rendu avant
qu'il porte une bande de formats.

### U2 — Surface de précision
Magnétisme et repères intelligents (bords et centres des calques voisins, centre et tiers du plan de
travail, espacement égal entre voisins), règles, grille, zones sûres, les trois modificateurs de
geste, multi-sélection avec alignement et distribution, et **le correctif de la dérive au
redimensionnement d'un calque pivoté — précédé d'un test qui la reproduit**, pour être sûr de
corriger le vrai défaut. Le plus gros morceau, et celui qui répond réellement à « construire un
gabarit est fastidieux ».

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
