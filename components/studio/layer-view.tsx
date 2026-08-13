"use client";

import { useEffect, useState, type CSSProperties } from "react";
import type { Frame, Layer } from "@/lib/studio/scene";
import { textStyleFor, gradientCss } from "@/lib/studio/element";
import { layerBorder, layerBoxShadow, layerSupportsRotation, shapeCssFor } from "@/lib/studio/shapes";
import { imageCss, tileBackgroundSize } from "@/lib/studio/image-css";
import { resolveLayerColorsForDisplay } from "@/lib/studio/values";
import { SAMPLE_VALUES } from "@/lib/studio/sample-values";
import { SELECTION, LOCKED_OUTLINE } from "@/lib/studio/overlay-theme";

// Rendu PUREMENT visuel d'UN calque, en pixels du gabarit (le parent — canvas.tsx — applique déjà
// `transform: scale(k)` sur son conteneur, donc ce composant ne connaît pas l'échelle) — À UNE
// EXCEPTION PRÈS : `scale`, ci-dessous, sert UNIQUEMENT à compenser la largeur du contour de
// sélection (voir son usage dans le style plus bas). Ce contour vit, comme toute la géométrie de ce
// composant, à l'intérieur du conteneur `transform: scale(k)` de canvas.tsx — une largeur de
// contour en pixels GABARIT non compensée rend donc à `2k` px écran, imperceptible pour un format
// comme `story` (k≈0,31), exactement le même défaut que les poignées de canvas.tsx (revue Lot 2,
// Important 3). Pas de logique de glisser/redimensionner/rotation ici : ça reste dans canvas.tsx +
// hooks/use-layer-drag (Tâche 6), pour que ce fichier ne fasse qu'une seule chose et la fasse bien —
// le contrat de la Tâche 5 est « affiche la scène », pas « rend la scène manipulable ».
export interface LayerViewProps {
  layer: Layer;
  /** Cadre à peindre — celui du calque par défaut, ou une prévisualisation live pendant un geste
   * (fournie par canvas.tsx / use-layer-drag.ts, Tâche 6). Séparé de `layer.frame` pour que Task 6
   * puisse afficher un aperçu SANS committer d'action au réducteur à chaque pointermove. */
  frame: Frame;
  rotation: number;
  selected: boolean;
  /** Source résolue pour un calque image/qr (URL d'asset déjà téléchargé, ou data URI). Absente
   * pour un calque `source.kind === "slot"` : l'éditeur n'a jamais de valeur de jeton (voir le
   * commentaire de imageContent ci-dessous). */
  image?: string;
  /** Échelle du canevas parent — sert SEULEMENT à compenser le contour de sélection (voir plus
   * haut). Par défaut 1 (contour à sa taille nominale) pour tout appelant qui n'a pas d'échelle à
   * fournir. */
  scale?: number;
  onPointerDown?: (e: React.PointerEvent<HTMLDivElement>) => void;
  /** Chantier B, Tâche 7 (spec §5) — le clic droit sur CE calque. Même discipline que
   * `onPointerDown` juste au-dessus (voir `interactive` plus bas) : un calque VERROUILLÉ ne reçoit
   * JAMAIS ce gestionnaire, quel que soit l'appelant — un clic droit dessus bouillonne donc jusqu'au
   * gestionnaire `onContextMenu` de la RACINE (canvas.tsx), qui ouvre le menu CANEVAS plutôt que
   * celui de ce calque (la règle de repli U3 nommée dans le brief T7, appliquée ici par la MÊME
   * absence de gestionnaire qui fait déjà fonctionner le clic gauche traversant, pas par une garde
   * `if (layer.locked)` séparée qui pourrait diverger de celle du pointeur). */
  onContextMenu?: (e: React.MouseEvent<HTMLDivElement>) => void;
}

function frameStyle(frame: Frame, rotation: number, layer: Layer): CSSProperties {
  // U3 Tâche 3 (arbitrage A) : une forme DÉCOUPÉE ne tourne pas — et c'est le NAVIGATEUR qui doit
  // renoncer, pas seulement satori. Le navigateur, lui, tournerait très bien la découpe : c'est
  // précisément le problème. Satori ne tourne que le remplissage (réserve 2 de la sonde), donc toute
  // scène portant déjà une rotation sur un triangle s'afficherait ici autrement que dans le PNG livré
  // — le §0 du plan U3. L'éditeur ne simule donc pas une rotation que l'export ne sait pas faire.
  // `rotation` est la valeur PEINTE (elle peut venir d'un aperçu de geste, canvas.tsx), d'où le filtre
  // sur la prop plutôt qu'un appel à `layerRotation(layer)` qui ignorerait l'aperçu.
  const applied = layerSupportsRotation(layer) ? rotation : 0;
  return {
    position: "absolute",
    left: frame.x,
    top: frame.y,
    width: frame.w,
    height: frame.h,
    transform: applied ? `rotate(${applied}deg)` : undefined,
    opacity: layer.opacity,
    boxSizing: "border-box",
  };
}

// Espace réservé pour tout ce que l'éditeur ne peut pas peindre lui-même : un `{{slot}}` d'image
// non résolu (aucune valeur de jeton disponible hors rendu réel, spec §2/§4) ou un asset introuvable.
function Placeholder({ label }: { label: string }) {
  return (
    <div
      style={{
        width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center",
        background: "repeating-linear-gradient(45deg, #444 0, #444 8px, #333 8px, #333 16px)",
        color: "#eee", fontSize: 12, textAlign: "center", overflow: "hidden", padding: 4,
      }}
    >
      {label}
    </div>
  );
}

// La taille INTRINSÈQUE d'un asset, lue au runtime (Properties Pro P1, Tâche 4) — SEUL endroit du
// composant qui a besoin de connaître la vraie taille de l'image : `imageCss` (image-css.ts) est un
// module PUR, zéro import, qui ne reçoit jamais l'image elle-même (voir son commentaire de tête) et
// renvoie donc `backgroundSize: "auto"` pour `sizing:"tile"`, quel que soit `scale`.
//
// PARITÉ MOSAÏQUE (correctif revue de branche). `"auto"` fait tuiler le navigateur à la taille
// ORIGINALE de la source, alors que l'export (Satori) tuile à la taille BORNÉE au plafond
// `cap = 2×max(cadre)` — `prepared.w/h × scale` (element.ts#effectiveImage, images.ts#prepareImage).
// Pour toute vraie photo dont le côté long dépasse ce plafond (le cas COURANT), ces deux tailles
// DIFFÈRENT — donc des compteurs de répétition et une origine de tuile différents entre Montage et
// Rendu réel (§0 WYSIWYG). L'aperçu doit donc tuiler au MÊME intrinsèque borné : on sonde la taille
// naturelle pour TOUTE mosaïque (plus seulement `scale !== 1` — le bornage peut changer la taille même
// à `scale === 1`) et on la borne via `tileBackgroundSize` (image-css.ts, la MÊME arithmétique que
// sharp). Ce hook ne se déclenche donc QUE pour `sizing === "tile"` — pas de chargement d'image
// superflu pour cover/contain/stretch/custom, qui n'ont pas besoin de la taille naturelle.
function useNaturalSize(src: string | undefined, active: boolean): { w: number; h: number } | null {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    if (!active || !src) {
      setSize(null);
      return;
    }
    let cancelled = false;
    // `document.createElement("img")` plutôt que `new Image()` (équivalents dans un vrai navigateur) :
    // le harnais DOM des tests (tests/dom-harness.ts) installe `document` explicitement mais PAS le
    // constructeur global `Image` (absent de sa liste DOM_GLOBAL_KEYS) — cette forme reste donc
    // exerçable sous jsdom sans étendre le harnais pour un seul appelant.
    const probe = document.createElement("img");
    probe.onload = () => {
      if (!cancelled) setSize({ w: probe.naturalWidth, h: probe.naturalHeight });
    };
    probe.src = src;
    return () => {
      cancelled = true;
    };
  }, [src, active]);
  return size;
}

function ImageContent({ layer, image }: { layer: Extract<Layer, { type: "image" }>; image?: string }) {
  // Un jeton ({{slot}}) n'a de valeur qu'au rendu réel (article/valeurs saisies) — l'éditeur n'en
  // a jamais, par construction (spec §2 : « l'éditeur n'a pas les valeurs de jeton »). Donc PAS de
  // tentative de résolution ici, un espace réservé nommé systématiquement.
  //
  // CHEMIN UNIQUE (aligné sur le verdict soupape de la Tâche 3, element.ts#imageNode) : un calque
  // IMAGE est un `<div>` de FOND, PLUS un `<img objectFit>` — c'est ce qui rend l'aperçu et l'export
  // d'accord PIXEL POUR PIXEL sur `sizing`/`focal`/`tile`/`customSize` (§0 : désaccord WYSIWYG interdit).
  // `imageCss` (image-css.ts, Tâche 2) est LA MÊME fonction pure que le moteur consulte pour
  // `backgroundSize`/`backgroundRepeat` ; seule la variante de POSITION diverge — voir le commentaire
  // de tête d'image-css.ts : `%` (ici, correct dans le NAVIGATEUR) contre pixels calculés côté Satori
  // (dont le `%` de `background-position` est bogué, spike Tâche 1). Les deux formules sont
  // équivalentes en principe ; ce sont les DEUX SEULS points de divergence volontaires de tout ce
  // fichier, documentés ici pour qu'un futur lecteur ne les prenne pas pour un oubli de parité.
  // RÈGLE DES HOOKS (correctif revue) — `useNaturalSize` DOIT s'exécuter à CHAQUE rendu de ce
  // composant, quelle que soit la branche qui retourne ensuite : `LayerView` est keyée par
  // `layer.id` (même fibre React d'un rendu à l'autre), et un calque `source.kind === "asset"` peint
  // souvent avec `image` encore `undefined` au premier rendu (résolution ASYNC via
  // `images?.get(layer.id)`, canvas.tsx) avant qu'un rendu suivant ne lui passe l'URL résolue.
  // Poser ce hook APRÈS les `return` de placeholder (comme la première version de cette tâche le
  // faisait) le fait tantôt s'exécuter (rendu avec `src`), tantôt PAS (rendu sans `src`, ou calque
  // `slot`) sur cette même fibre — exactement le nombre de hooks qui varie d'un rendu à l'autre que
  // React interdit (« Rendered more hooks than during the previous render »). `src`/`needsNaturalSize`
  // se calculent donc AVANT tout `return`, en code ordinaire (pas des hooks), et le hook les consomme
  // inconditionnellement ; il gère déjà `!active || !src` en interne (repli `null`), donc l'appeler
  // avec un `src` encore `undefined` ou `needsNaturalSize` à `false` est sans danger.
  const src = layer.source.kind === "url" ? layer.source.url : image;
  const sizing = layer.sizing ?? (layer.fit === "cover" ? "cover" : "contain");
  const scale = layer.tile?.scale ?? 1;
  // TOUTE mosaïque a besoin de la taille naturelle (voir `useNaturalSize` ci-dessus) : le bornage au
  // plafond peut changer la taille de tuile même à `scale === 1`, dès que la source dépasse le plafond.
  const needsNaturalSize = sizing === "tile";
  const natural = useNaturalSize(src, needsNaturalSize);

  if (layer.source.kind === "slot") return <Placeholder label={`{{${layer.source.slot}}}`} />;
  if (!src) return <Placeholder label={layer.name || "Image"} />;

  const css = imageCss(layer);
  // Voir useNaturalSize ci-dessus : LE SEUL cas où `imageCss` ne suffit pas — pour une mosaïque, il
  // renvoie `"auto"`, qui tuile à la taille ORIGINALE de la source et diverge de l'export dès qu'elle
  // dépasse le plafond. On la remplace par l'intrinsèque BORNÉE × scale (`tileBackgroundSize`, la même
  // arithmétique que sharp côté export), MAIS seulement une fois la sonde résolue : tant que `natural`
  // est `null` (premier rendu, chargement async), on garde `"auto"` le temps d'un rendu plutôt qu'un
  // flash à 0×0 px — le rendu suivant, avec la taille naturelle connue, pose la valeur bornée exacte.
  const backgroundSize = needsNaturalSize && natural
    ? tileBackgroundSize(natural, layer.frame, scale)
    : css.backgroundSize;

  return (
    <div
      data-testid="image-content"
      style={{
        width: "100%", height: "100%",
        backgroundImage: `url(${src})`,
        backgroundSize,
        backgroundRepeat: css.backgroundRepeat,
        backgroundPosition: css.backgroundPosition,
        // `imageLayer.radius`, un NOMBRE (lib/studio/scene.ts:46) — et NON son homonyme
        // `shapeLayer.radius`, qui est `number | string` depuis l'arbitrage C (« 50% » pour l'ellipse).
        // Deux champs de même nom et de types différents ; ce qui les tient à l'écart ici est le
        // narrowing du prop (`Extract<Layer, { type: "image" }>`), donc le typechecker. Voir
        // lib/studio/element.ts#imageNode pour la garde du chemin d'export et
        // tests/studio-shapes.test.ts, « les DEUX champs `radius` du schéma restent SÉPARÉS ».
        borderRadius: layer.radius,
        filter: layer.blur ? `blur(${layer.blur}px)` : undefined,
      }}
    />
  );
}

function ShapeContent({ layer }: { layer: Extract<Layer, { type: "shape" }> }) {
  // U4 Tâche 3 — `layer` ici est déjà le calque D'AFFICHAGE (LayerView l'a résolu via
  // `resolveLayerColorsForDisplay` avant de descendre jusqu'à `LayerContent`) : un `fill` lié à un
  // jeton porte donc déjà la couleur d'ÉCHANTILLON, jamais la chaîne « {{jeton}} » brute — l'ancien
  // espace réservé à hachures diagonales (qui masquait purement et simplement la couleur choisie,
  // le défaut que le §0 du plan U4 nomme) n'a plus lieu d'être.
  const fillStyle: CSSProperties = typeof layer.fill === "string"
    ? { backgroundColor: layer.fill === "transparent" ? undefined : layer.fill }
    : { backgroundImage: gradientCss(layer.fill) };

  // `layerBorder` et NON `layer.border` (revue U3 Tâche 3, Medium 4) : sur une forme découpée, le
  // navigateur clippe l'élément ENTIER — bordure comprise — tandis que satori laisse le contour
  // rectangulaire autour du remplissage découpé (réserve 3 de la sonde). Laisser passer la bordure ici
  // livrerait donc un éditeur en désaccord avec son propre export, le §0 de ce sous-projet. La
  // description tranche (lib/studio/shapes.ts#supportsBorder), les deux chemins la posent — même
  // discipline que la rotation juste au-dessus.
  const painted = layerBorder(layer);
  const borderStyle: CSSProperties = {};
  if (painted) {
    const sides = painted.sides ?? ["top", "right", "bottom", "left"];
    const css = `${painted.width}px solid ${painted.color}`;
    for (const s of sides) {
      const key = `border${s[0].toUpperCase()}${s.slice(1)}` as keyof CSSProperties;
      (borderStyle as Record<string, string>)[key] = css;
    }
  }

  return (
    <div
      style={{
        width: "100%", height: "100%",
        ...fillStyle, ...borderStyle,
        // `layerBoxShadow` et NON `layer.shadow` (U3 Tâche 4) : une forme DÉCOUPÉE ne porte pas
        // d'ombre, et il faut que ce soit vrai ICI autant que dans l'export. Le navigateur découpe
        // l'ombre portée avec le reste de l'élément, satori n'en peint aucune non plus (mesuré,
        // réserve 4) — les deux sont d'accord, mais pour deux raisons indépendantes dont l'une est un
        // accident d'implémentation. La description tranche (shapes.ts#supportsShadow), les deux
        // chemins la posent, et l'accord ne dépend plus du hasard. `undefined` ne sérialise RIEN, donc
        // une forme sans ombre reste octet pour octet celle d'avant cette tâche.
        boxShadow: layerBoxShadow(layer),
        // C'EST le point de contact avec lib/studio/shapes.ts — LA MÊME description que le moteur
        // d'export interroge (element.ts:shapeNode). Ne pas redériver la géométrie ici : c'est
        // exactement la divergence silencieuse que §0 du plan U3 décrit (le designer dessine une
        // forme, l'image exportée en contient une autre, aucun test ne rougit), et c'est la même
        // discipline que TextContent applique déjà avec textStyleFor.
        ...shapeCssFor(layer),
      }}
    />
  );
}

// « Représentatif » (contrat Tâche 5) : pas de vrai QR code généré côté client (ça reste un calcul
// serveur, lib/studio/render.ts), juste un aperçu reconnaissable aux couleurs du calque.
function QrContent({ layer }: { layer: Extract<Layer, { type: "qr" }> }) {
  return (
    <div
      style={{
        width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center",
        background: layer.bg, color: layer.fg, border: `1px solid ${layer.fg}`,
        fontSize: 11, fontWeight: 600,
      }}
    >
      QR
    </div>
  );
}

function TextContent({ layer }: { layer: Extract<Layer, { type: "text" }> }) {
  // C'EST le point de contact avec textStyleFor — la même fonction que le moteur de rendu (V1) et
  // la sonde d'auto-ajustement utilisent déjà (lib/studio/element.ts). Ne pas redériver le style de
  // texte ici : c'est exactement la dérive que l'extraction de textStyleFor a corrigée.
  return (
    <div style={{ width: "100%", height: "100%", display: "flex", ...textStyleFor(layer) }}>
      {layer.content}
    </div>
  );
}

function LayerContent({ layer, image }: { layer: Layer; image?: string }) {
  switch (layer.type) {
    case "text": return <TextContent layer={layer} />;
    case "image": return <ImageContent layer={layer} image={image} />;
    case "shape": return <ShapeContent layer={layer} />;
    case "qr": return <QrContent layer={layer} />;
  }
}

export function LayerView({
  layer, frame, rotation, selected, image, scale = 1, onPointerDown, onContextMenu,
}: LayerViewProps) {
  const interactive = !layer.locked;
  // U4 Tâche 3 (§0 du plan) — le calque tel que ce composant le PEINT, jamais celui que `state.scene`
  // détient : `resolveLayerColorsForDisplay` (lib/studio/values.ts) ne touche QUE les champs-couleur
  // du schéma (colorFieldsOf, Task 2) — fill/color/shadow.color/stroke.color/border.color/fg/bg — et
  // les remplace par un ÉCHANTILLON quand ils portent un jeton, sans jamais muter `layer` (même
  // discipline immutable que `resolveTokens`, le chemin export). La source d'une image et le contenu
  // d'un texte restent EXACTEMENT ceux du calque d'origine : `colorFieldsOf` ne les connaît pas, donc
  // cette résolution ne les touche pas — un `{{slot}}` d'image garde son espace réservé (Task 6, hors
  // périmètre ici), et un contenu de texte garde sa forme technique brute.
  const displayLayer = resolveLayerColorsForDisplay(layer, SAMPLE_VALUES);
  return (
    <div
      data-layer-id={layer.id}
      data-selected={selected || undefined}
      data-locked={layer.locked || undefined}
      onPointerDown={interactive ? onPointerDown : undefined}
      onContextMenu={interactive ? onContextMenu : undefined}
      // Chantier E Tâche 4 : `studio-motion-outline` (globals.css) — transitionne SEULEMENT
      // `outline-color`/`opacity` en douceur ; la GÉOMÉTRIE (largeur `2/scale`, décalage `1/scale`)
      // reste EXACTEMENT celle d'avant cette tâche (§0 du plan), posée juste en dessous par le style
      // en ligne — cette classe n'ajoute qu'une transition, jamais une valeur. §0 fige la GÉOMÉTRIE et
      // les data-testid, PAS la couleur : « seule la couleur bouge » y est explicitement permis, et
      // c'est ce qui se produit ci-dessous — l'outline SOURCE désormais sa couleur depuis
      // `lib/studio/overlay-theme.ts` (rôle `SELECTION`, revue de branche chantier E : les poignées de
      // canvas.tsx utilisaient déjà ce jeton, l'outline de CE MÊME calque sélectionné dessinait encore
      // un bleu différent en dur — la sélection n'était pas single-sourcée tant que ce fichier restait
      // à l'écart).
      // CONDITIONNÉE à `selected || layer.locked` (exactement le cas où `outline` ci-dessous porte
      // une vraie valeur, jamais `undefined`) — jamais posée inconditionnellement : les témoins HTML
      // figés (tests/studio-shapes.test.ts « identité de sortie avant/après refactor », rendus avec
      // `selected: false`) épinglent l'ABSENCE de tout `class=` sur ce div ; une classe posée pour
      // TOUT calque, sélectionné ou non, romprait ces témoins sans le moindre changement de pixel.
      // Coupée sous `prefers-reduced-motion: reduce`.
      className={selected || layer.locked ? "studio-motion-outline" : undefined}
      style={{
        ...frameStyle(frame, rotation, layer),
        // `2 / scale` (revue Lot 2, Important 3) : voir le commentaire en tête de fichier — sans
        // cette compensation, le contour de sélection s'amenuise avec l'échelle du canevas jusqu'à
        // devenir un liseré à peine visible pour les formats étroits (`story`).
        outline: selected ? `${2 / scale}px solid ${SELECTION}` : layer.locked ? `1px dashed ${LOCKED_OUTLINE}` : undefined,
        outlineOffset: selected ? 1 / scale : undefined,
        cursor: interactive ? "move" : "not-allowed",
        // Un calque verrouillé « ne répond ni au clic ni au glisser » (spec §2) — appliqué au
        // niveau CSS, pas seulement en omettant le gestionnaire React, pour qu'aucun enfant ne
        // puisse non plus intercepter un événement pointeur qui lui serait destiné.
        pointerEvents: interactive ? undefined : "none",
        overflow: layer.type === "shape" ? undefined : "hidden",
      }}
    >
      <LayerContent layer={displayLayer} image={image} />
    </div>
  );
}
