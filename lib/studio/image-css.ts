// lib/studio/image-css.ts — Properties Pro P1, Tâche 2 : le mappage CSS du cadrage avancé d'une
// image (`sizing`/`focal`/`tile`/`customSize`, lib/studio/scene.ts#imageLayer).
//
// ZÉRO IMPORT — c'est une FEUILLE, au sens le plus strict : aucun `import`, ni de valeur ni de type.
// Contrairement à lib/studio/shapes.ts (qui importe des TYPES depuis scene.ts, effacés à la
// compilation), ce module n'importe RIEN — les formes qu'il consomme sont décrites STRUCTURELLEMENT
// ci-dessous. C'est ce qui le rend importable depuis n'importe quel contexte, y compris un futur
// moteur Satori (Tâche 3) qui n'a pas de raison de dépendre du schéma zod. TypeScript accepte quand
// même un `ImageLayer` réel (celui de scene.ts) là où ce fichier attend son type local — un objet qui
// porte PLUS de champs que nécessaire satisfait toujours un type structurel qui en demande moins.
//
// DEUX variantes de position, pour DEUX moteurs de rendu (§0 : deux chemins de rendu indépendants) :
//   - `focalToPosition` → `%`, correcte dans le NAVIGATEUR (l'aperçu, `imageCss` ci-dessous).
//   - `focalToPositionPx` → pixels CALCULÉS, pour SATORI (Tâche 3), dont le `%` de
//     `background-position` est bogué (mesuré à la Tâche 1, spike) — d'où une formule qui a besoin de
//     la taille EFFECTIVE de l'image peinte (`effImg`), que seul l'appelant connaît (l'intrinsèque de
//     l'asset). Les deux formules sont ÉQUIVALENTES en principe (un pourcentage de l'espace de jeu),
//     mais seule la version pixels survit au moteur Satori.

/** Le point focal d'une image — coordonnées NORMALISÉES [0,1], `{0.5,0.5}` = centre. */
export type ImageFocal = { x: number; y: number };

/** Le réglage de mosaïque d'une image — `scale` est une fraction de la taille INTRINSÈQUE de
 *  l'asset (1 = taille naturelle), `axis` restreint la répétition à un seul axe ou aux deux. */
export type ImageTile = { scale: number; axis: "both" | "x" | "y" };

/** Une taille de fond explicite, en pixels — pour `sizing: "custom"`. */
export type ImageCustomSize = { w: number; h: number };

/** LE sous-ensemble structurel d'`ImageLayer` (lib/studio/scene.ts) que ce module consomme. Pas un
 *  import : une DESCRIPTION locale, suffisante pour que TypeScript accepte un `ImageLayer` réel
 *  (structurellement compatible, un sur-ensemble de champs) sans que ce fichier en dépende. */
export type ImageLayer = {
  fit: "cover" | "contain";
  sizing?: "cover" | "contain" | "stretch" | "tile" | "custom";
  focal?: ImageFocal;
  tile?: ImageTile;
  customSize?: ImageCustomSize;
  frame: { x: number; y: number; w: number; h: number };
};

/** Le résultat de `imageCss` — PAS de `backgroundBlendMode` (adjudiqué à la Tâche 1 (spike) : Satori
 *  ne sait pas peindre de fondu, l'exposer ferait mentir l'aperçu sur ce que l'export produit). */
export type ImageCss = {
  backgroundSize: string;
  backgroundRepeat: string;
  backgroundPosition: string;
};

// Multiplie une fraction [0,1] par 100 et la formate en pourcentage CSS, sans la traîne de
// virgule flottante d'une multiplication brute (ex. 0.1 * 100 === 10.000000000000002). Arrondi à
// trois décimales — largement assez pour un point focal, et JS efface les zéros de fin tout seul
// (50, pas 50.000) au passage en chaîne.
function toPercent(fraction: number): string {
  return `${Math.round(fraction * 100 * 1000) / 1000}%`;
}

/**
 * Le point focal en POURCENTAGE `background-position` — correct dans le NAVIGATEUR. `{0.5,0.5}` ou
 * l'absence de point focal donnent le centre, `{0,1}` le coin bas-gauche, `{1,0}` le coin haut-droit
 * (l'axe Y d'un point focal suit la convention CSS : 0 = haut, 1 = bas).
 */
export function focalToPosition(focal?: ImageFocal): string {
  const x = focal?.x ?? 0.5;
  const y = focal?.y ?? 0.5;
  return `${toPercent(x)} ${toPercent(y)}`;
}

/**
 * Le point focal en PIXELS — la variante que le moteur SATORI (Tâche 3) doit utiliser à la place de
 * `focalToPosition`, parce que `background-position` en `%` y est bogué (mesuré à la Tâche 1). La
 * formule est celle d'un `background-position` en pourcentage RÉÉCRITE en pixels : la position du
 * point (0,0) de l'image dans l'espace de jeu (`frame.w − effImg.w`, `frame.h − effImg.h`), pondérée
 * par le point focal. `effImg` (la taille EFFECTIVE de l'image peinte, après mise à l'échelle) doit
 * être fournie par l'appelant — ce module ne connaît pas la taille intrinsèque de l'asset.
 */
export function focalToPositionPx(
  layer: ImageLayer,
  effImg: { w: number; h: number },
): string {
  const x = layer.focal?.x ?? 0.5;
  const y = layer.focal?.y ?? 0.5;
  const px = Math.round((layer.frame.w - effImg.w) * x);
  const py = Math.round((layer.frame.h - effImg.h) * y);
  return `${px}px ${py}px`;
}

/**
 * La taille de fond (`background-size`) d'une MOSAÏQUE dans l'APERÇU navigateur (layer-view.tsx),
 * calculée à partir de la taille NATURELLE sondée de l'asset — bornée EXACTEMENT comme
 * images.ts#prepareImage borne l'intrinsèque côté export (côté long ≤ 2×max(cadre), rapport d'aspect
 * préservé, JAMAIS agrandie), puis multipliée par `scale`.
 *
 * POURQUOI ce helper existe (§0 WYSIWYG). `imageCss` renvoie `"auto"` pour une mosaïque parce qu'il est
 * PUR (il ne reçoit jamais l'image, donc ne connaît pas sa taille naturelle). Or Satori (element.ts#
 * effectiveImage, cas "tile") tuile à `prepared.w/h × scale`, où `prepared` est BORNÉE au plafond
 * `cap = 2×max(cadre)`. Pour une vraie photo dont le côté long dépasse ce plafond (le cas courant),
 * `"auto"` fait tuiler l'aperçu à la taille ORIGINALE de la source et l'export à la taille bornée —
 * donc des compteurs de répétition ET une origine de tuile DIFFÉRENTS entre Montage et Rendu réel.
 * Ce helper reproduit le bornage de sharp pour que l'aperçu tuile au MÊME intrinsèque borné que
 * l'export. Un écart sous-pixel (sharp arrondit à l'entier, ici aussi) reste visuellement invisible.
 */
export function tileBackgroundSize(
  natural: { w: number; h: number },
  frame: { w: number; h: number },
  scale: number,
): string {
  const cap = 2 * Math.max(frame.w, frame.h);
  const long = Math.max(natural.w, natural.h);
  // `fit: "inside", withoutEnlargement: true` : on RÉDUIT au plafond si le côté long le dépasse, jamais
  // on n'agrandit (facteur ≤ 1) — identique à `sharp.resize(cap, cap, …)` dans prepareImage.
  const factor = long > cap ? cap / long : 1;
  // Arrondi à l'ENTIER avant ×scale : sharp borne l'intrinsèque à des dimensions entières, puis
  // element.ts multiplie par scale — on reproduit le même ordre pour rester au pixel près de l'export.
  const bw = Math.round(natural.w * factor);
  const bh = Math.round(natural.h * factor);
  return `${bw * scale}px ${bh * scale}px`;
}

/**
 * `background-repeat` pour un réglage de mosaïque. `"x"`/`"y"` restreignent la répétition à un seul
 * axe (`repeat-x`/`repeat-y`), `"both"` — ou l'ABSENCE de réglage — répète sur les deux (`repeat`).
 * PAS de `space`/`round` : ces deux valeurs CSS n'ont pas d'équivalent dans le schéma (adjudiqué à la
 * Tâche 1 (spike), `tile.axis` n'accepte que `both`/`x`/`y`).
 */
export function tileToRepeat(tile?: ImageTile): { backgroundRepeat: string } {
  const axis = tile?.axis ?? "both";
  const backgroundRepeat = axis === "x" ? "repeat-x" : axis === "y" ? "repeat-y" : "repeat";
  return { backgroundRepeat };
}

/**
 * LE mappage complet — le CSS de l'APERÇU (navigateur), `backgroundPosition` en POURCENTAGE (voir
 * `focalToPositionPx` ci-dessus pour l'équivalent pixels que Satori exige à la place).
 *
 * `sizing` retombe sur le champ HISTORIQUE `fit` quand il est absent (`sizing ?? (fit === "cover" ?
 * "cover" : "contain")`) — c'est ce qui rend la migration du schéma no-op : un calque écrit avant
 * cette tâche n'a que `fit`, et `imageCss` continue de lui donner exactement le même
 * `background-size` qu'avant.
 *
 * `tile` : le `scale` d'une mosaïque est une fraction de la taille INTRINSÈQUE de l'asset — que ce
 * module PUR ne connaît pas (il ne reçoit qu'un `ImageLayer`, jamais l'image elle-même). Pour
 * `scale === 1` (taille naturelle), `background-size: auto` est exactement correct : le navigateur
 * peint l'image à sa taille intrinsèque et la répète. Pour un `scale` différent de 1, la taille
 * mise à l'échelle doit être CALCULÉE par l'appelant à partir de l'intrinsèque (composant d'aperçu
 * ou moteur de rendu) — cette fonction reste PURE et émet `"auto"` dans tous les cas ; c'est au
 * consommateur de surcharger `backgroundSize` s'il connaît l'intrinsèque et que `scale !== 1`.
 */
export function imageCss(layer: ImageLayer): ImageCss {
  const sizing = layer.sizing ?? (layer.fit === "cover" ? "cover" : "contain");

  let backgroundSize: string;
  switch (sizing) {
    case "cover":
      backgroundSize = "cover";
      break;
    case "contain":
      backgroundSize = "contain";
      break;
    case "stretch":
      backgroundSize = "100% 100%";
      break;
    case "tile":
      // Voir le commentaire de la fonction : le calque du scale ≠ 1 appartient à l'appelant.
      backgroundSize = "auto";
      break;
    case "custom":
      backgroundSize = layer.customSize
        ? `${layer.customSize.w}px ${layer.customSize.h}px`
        // customSize absent malgré sizing:"custom" — le schéma le laisse optionnel (donc légal, même si
        // parseScene le rejette). Repli sur "contain" (letterbox) : ce MÊME repli est reproduit à
        // l'identique par element.ts#effectiveImage (chemin export) pour que l'aperçu et l'export ne
        // PEIGNENT PAS différemment ce cas-limite (§0, désaccord WYSIWYG interdit).
        : "contain";
      break;
  }

  const backgroundRepeat = sizing === "tile" ? tileToRepeat(layer.tile).backgroundRepeat : "no-repeat";
  const backgroundPosition = focalToPosition(layer.focal);

  return { backgroundSize, backgroundRepeat, backgroundPosition };
}
