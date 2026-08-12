# Afrotiative — Studio Pro · Chantier D : Contraintes durables & multi-format — Spécification

**Date :** 2026-08-12
**Programme :** « Studio Pro » — la refonte du studio en outil professionnel (chantiers A→E ; voir la note
de cadrage ci-dessous). Ce document couvre le **chantier D**, choisi en premier.
**Statut :** Conception validée en atelier — prête pour le plan d'implémentation
**Portée moteur :** Satori (l'export) ne change pas. La géométrie du studio, elle, change en profondeur :
c'est un ajout au schéma + un moteur pur, pas une retouche.

---

## Cadrage du programme (contexte)

Audit du 2026-08-12 (code + recherche Figma/Canva/Sketch + captures Playwright de l'éditeur réel) :
le studio est *correctement construit au niveau données/réducteur* mais, comme **outil de conception**,
c'est une forme d'administration à largeur fixe : éditeur imbriqué dans la coque back-office (deux
navigations concurrentes), inspecteur vide béant, plan de travail flottant petit (« 59 % » d'ajustement),
aucun vrai zoom/pan, aucun raccourci ⌘Z/copier-coller, galerie de gabarits en **tableau texte** sans
vignette, et — le point soulevé par l'utilisateur — **aucune ancre durable**. Direction validée : garder
l'**identité éditoriale** décidée (monogramme + Lora, terracotta appliqué avec cohérence) et adopter la
**structure** des outils pros. Le programme se découpe en cinq chantiers, chacun spec → plan → exécution :

- **A** Coque « canevas d'abord » & IA (plein cadre, rail repliable, panneaux redimensionnables, galerie
  visuelle, tiroirs responsifs).
- **B** Interactions pros (zoom/pan réels, ⌘Z/redo/copier/coller/dupliquer/grouper, barre contextuelle
  flottante, menu clic-droit).
- **C** Refonte de l'inspecteur (champs à glissement « scrubby », vrai sélecteur de couleur, curseurs,
  « + ajouter une propriété », ordre mémoire-musculaire).
- **D (CE DOCUMENT)** Ancrage durable & multi-format.
- **E** Craft visuel & marque (thème des surcouches du canevas, mouvement, états vides, rythme).

Le chantier D passe en premier parce qu'il change le **modèle géométrique** sur lequel tout le reste se
pose, et parce que c'est le manque fonctionnel le plus criant.

---

## L'idée qui unifie « ancrage » et « multi-format »

Dans ce produit, **le canevas ne se redimensionne jamais au glisser** — il « se redimensionne » quand le
**même gabarit est rendu dans un AUTRE format** (1200×675 → 1080×1920). Donc l'ancrage durable et
l'adaptation multi-format sont **le même mécanisme** : une fonction pure, dirigée par les contraintes,

```
relayout(scene, cibleW, cibleH) -> Frame[]   // pure, sans interface, entièrement testable
```

qui prend les cadres d'origine (au format d'accueil) + les contraintes de chaque calque + les dimensions
cibles, et rend les nouveaux cadres. C'est précisément le défaut relevé par l'utilisateur : `align.ts`
d'aujourd'hui **repositionne une fois** (`frames -> frames`, rien de stocké) ; ici la position devient
une **règle durable** qui suit le redimensionnement.

---

## 1 · Schéma — des contraintes par calque

Chaque calque gagne un champ optionnel :

```ts
constraints?: {
  h: "left" | "right" | "leftRight" | "center" | "scale";   // défaut "left"
  v: "top"  | "bottom" | "topBottom" | "center" | "scale";   // défaut "top"
}
```

Le modèle 5×5 de Figma, confirmé par la recherche comme le standard de l'industrie (dévier de ce modèle
rend la fonctionnalité plus dure à apprendre à équivalence technique). Les **écarts (gaps) sont
implicites et durables** : `left` conserve la distance au bord gauche ; `right` conserve la distance au
bord droit ; `leftRight` conserve les DEUX écarts et **étire** la largeur ; `center` conserve le
décalage au centre ; `scale` met à l'échelle proportionnellement. Unité : **pixels** (décision de la
feuille de route U5). Défaut `{h:"left", v:"top"}` = comportement actuel exact.

**Migration : un no-op observable.** Le champ est OPTIONNEL et son absence VAUT `{left, top}` (comme
`AlignSubject.visible` en U4 : ajouter le champ ne peut pas vider silencieusement un comportement).
Aucun gabarit existant ne bouge tant qu'aucune contrainte n'est posée ni aucun format non-natif demandé.

**Le format d'accueil est déjà stocké** : `scene.canvas.{width,height}` SONT les dimensions d'accueil.
`relayout` les prend comme base ; pas de nouveau champ « home ».

**Surcharges par format** (l'échappatoire manuelle) — champ optionnel au niveau de la scène :

```ts
formatOverrides?: Record<FormatKey, Record<LayerId, Frame>>;
```

Un calque présent dans la surcharge d'un format donné **ignore ses contraintes pour ce format** et prend
le cadre surchargé. Sparse : la plupart des formats n'ont aucune surcharge.

---

## 2 · Le moteur `relayout` (pur) — `lib/studio/relayout.ts`

Pour un calque de cadre d'accueil `{x, y, w, h}`, canevas d'accueil `(BW, BH)`, cible `(TW, TH)`, la
math **par axe** (horizontal ; le vertical est le miroir sur y/h/BH/TH) :

| `h` | nouveau x | nouveau w |
|---|---|---|
| `left` | `x` | `w` |
| `right` | `x + (TW - BW)` | `w` |
| `leftRight` | `x` | `TW - x - (BW - (x + w))` |
| `center` | `TW/2 + (x + w/2 - BW/2) - w/2` | `w` |
| `scale` | `x * TW/BW` | `w * TW/BW` |

Puis clamp de taille minimale (comme `computeResizedFrame`). La fonction est **pure et déterministe** :
c'est là que se concentre la rigueur de test du programme (voir §6). `relayout` applique d'abord les
surcharges du format cible (si présentes), sinon les contraintes.

`relayout(scene, format)` de commodité : résout `FormatKey → (TW,TH)` via `lib/studio/formats.ts` et
renvoie une **nouvelle scène** (cadres re-calculés, `canvas.{width,height}` = dimensions cibles) prête à
peindre/rendre — sans muter la scène d'origine (leçon U4 : transformation, jamais mutation).

---

## 3 · Le widget de contraintes dans l'inspecteur

Le contrôle Figma : un **petit carré cliquable** (les quatre bords + le centre) plus deux menus déroulants
(H et V), placé dans la bande de géométrie épinglée (`geometry-strip.tsx` réserve déjà la place — « U5 y
ajoutera le widget d'ancrage »). Cliquer un bord pose ce pin ; le mapping spatial est ce qui le rend
apprenable d'un coup d'œil (recherche). `Maj` pose la contrainte sur toute une multi-sélection. Le champ
écrit `layer.constraints` via le réducteur (une entrée d'historique par geste).

---

## 4 · Deux limites d'honnêteté, énoncées et surfacées (pas cachées)

De la feuille de route U5, confirmées par la recherche :

1. **Les contraintes réduisent mais n'éliminent pas les surcharges.** Un saut 1,9:1 → 0,5625:1 déplace
   tant les proportions qu'aucun jeu de pins ne sauve toutes les mises en page. Les surcharges par format
   (§1) sont l'échappatoire assumée, exactement comme Figma.
2. **Ancrer un calque de TEXTE change sa largeur → ses retours à la ligne → interagit avec `autoFit`/
   `maxLines`.** `leftRight` ou `scale` sur un titre le rétrécit en format haut ; le titre passe de 1 à 4
   lignes et peut être **coupé** par `maxLines`. `relayout` ne fait que changer le cadre ; le retour à la
   ligne se produit au RENDU (satori). Donc : un test dédié sur ce cas précis, et une **note UI** quand
   un calque de texte contraint dépasse `maxLines` dans un format donné (précédent : les notes de U2/U3
   qui surfacent une limite au lieu de la taire).

---

## 5 · Où ça paie

- **La bande de vignettes du mode « Rendu réel » (U1) devient un vrai outil** : chaque vignette est le
  gabarit `relayout`é pour ce format, pas un diagnostic vide. Cliquer une vignette montre l'adaptation
  réelle.
- **La génération / diffusion produit chaque format de canal depuis UN gabarit** via `relayout`, au lieu
  d'un gabarit reconstruit à la main par format (le point de douleur actuel : `formats.ts` fige un
  gabarit à UN format à la création).

---

## 6 · Qualité — les leçons du programme, appliquées

- **Le moteur pur est le juge.** `relayout` se teste sans interface sur la **matrice 5×5 × sauts
  d'aspect** : les 25 combinaisons de contraintes × plusieurs paires (BW,BH)→(TW,TH) couvrant
  agrandissement, rétrécissement, et les 8 formats réels. Propriétés : au format d'accueil (`TW==BW,
  TH==BH`) `relayout` est **l'identité** (bit pour bit) ; `left+top` préserve l'écart haut-gauche ;
  `leftRight` préserve les deux écarts ; `center` préserve le décalage au centre ; `scale` est
  proportionnel exact. **Fonction de choix** : la sélection surcharge-vs-contrainte est un point de
  bascule — la balayer (continuité, déterminisme sous réordonnancement des surcharges).
- **Migration no-op prouvée** : une scène sans `constraints` `relayout`ée à son format d'accueil est
  identique à l'entrée ; un test l'épingle (le champ optionnel ne peut pas vider un comportement).
- **§0 (les deux chemins s'accordent)** : la scène `relayout`ée rendue par l'éditeur et par l'export
  doivent peindre la même chose — réutiliser le garde-fou U4.
- **Anti-vacuité, mutation seule juge, garde structurelle** : `FormatKey` dérivé de `formats.ts` (jamais
  une liste recopiée), un test-piège si un format est ajouté sans dimensions.
- **Le cas texte-wrap (§4.2) a son propre test** rendu, pas seulement une assertion de cadre.

---

## Découpage en tâches (SDD, dans cet ordre)

1. **Schéma** : champ `constraints?` (défaut left/top, absence = défaut) + `formatOverrides?` + migration
   no-op + tests de migration/validation.
2. **Moteur `relayout` pur** + la matrice 5×5 × sauts d'aspect + les propriétés (identité au format
   d'accueil, préservation des écarts, scale exact) + balayage de la fonction de choix. **Le cœur.**
3. **Le cas texte-wrap/`autoFit`/`maxLines`** : test de rendu sur un titre contraint qui déborde, + la
   note UI « dépasse maxLines dans ce format ».
4. **Widget de contraintes** dans `geometry-strip` (carré cliquable + menus H/V, Maj multi-sélection),
   harnais DOM.
5. **Surcharges par format** : édition d'un cadre dans un format non-natif → écrit `formatOverrides`
   plutôt que le cadre d'accueil ; un calque surchargé ignore ses contraintes pour ce format.
6. **Câblage** : la bande de vignettes « Rendu réel » et la génération/diffusion consomment `relayout`.

---

## Hors périmètre (chantier D)

- Les chantiers A (coque canevas-d'abord), B (zoom/pan/raccourcis/barre contextuelle), C (inspecteur
  scrubby/couleur), E (craft visuel) — sous-projets suivants du programme Studio Pro.
- Le **redimensionnement du canevas au glisser** (n'existe pas ici ; « resize » = changement de format).
- L'auto-layout façon flexbox (le pendant « flux » des contraintes) — les news-templates ancrent des
  éléments libres à un cadre fixe ; le flux est un besoin distinct, à reconsidérer après.
- La refonte de la galerie de gabarits en vignettes (chantier A).
