import type { Scene, Layer, Gradient, TextLayer, ShapeLayer } from "./scene";
import { layerBorder, layerBoxShadow, layerRotation, shapeCssFor } from "./shapes";
import { focalToPositionPx, tileToRepeat } from "./image-css";
import type { PreparedImage } from "./images";

// Satori accepte un arbre « à la React » sous forme d'objets simples : pas besoin de JSX dans du
// code de bibliothèque.
export type SatoriNode = { type: string; props: Record<string, unknown> };

// Exportée pour components/studio/layer-view.tsx (Tâche 5, éditeur) : un dégradé de forme est une
// chaîne CSS `linear-gradient(...)` valable telle quelle en style React inline — même raisonnement
// que textStyleFor, sur un périmètre plus étroit (pas de piège historique connu ici, juste éviter
// une deuxième implémentation qui pourrait un jour diverger en silence).
export function gradientCss(g: Gradient): string {
  const stops = g.stops.map((s) => `${s.color} ${Math.round(s.at * 100)}%`).join(", ");
  return `linear-gradient(${g.angle}deg, ${stops})`;
}

function frameStyle(layer: Layer): Record<string, unknown> {
  const transforms: string[] = [];
  // `layerRotation` et NON `layer.rotation` (U3 Tâche 3, arbitrage A) : une forme DÉCOUPÉE ne tourne
  // pas, et il faut que ce soit vrai ICI autant que dans l'éditeur. Satori tourne le remplissage mais
  // pas le masque (`<g clip-path>` exprimé dans le repère du parent, réserve 2 de la sonde) : laisser
  // passer la rotation d'un triangle n'aurait pas fait « rien », ça aurait abîmé l'export sur tout
  // cadre non carré — et le navigateur, lui, aurait tourné la découpe. Exactement le désaccord
  // éditeur/export que §0 décrit. lib/studio/shapes.ts porte la décision, les deux chemins la posent.
  const rotation = layerRotation(layer);
  if (rotation) transforms.push(`rotate(${rotation}deg)`);
  return {
    position: "absolute",
    left: layer.frame.x,
    top: layer.frame.y,
    width: layer.frame.w,
    height: layer.frame.h,
    display: "flex",
    ...(layer.opacity !== undefined ? { opacity: layer.opacity } : {}),
    ...(transforms.length ? { transform: transforms.join(" ") } : {}),
  };
}

// Style TEXTE PUR (police, couleur, alignement, effets) — SANS positionnement (frame). Extrait pour
// que render.ts (fitFontSize/autoFit) mesure EXACTEMENT la même boîte de texte que celle réellement
// peinte ici. Avant cette extraction, la sonde d'autoFit reconstruisait sa propre liste de
// propriétés à la main et en oubliait deux (letterSpacing, fontStyle) — un titre avec un
// espacement de lettres large mesurait alors une hauteur trop petite et débordait silencieusement
// une fois réellement peint (vérifié empiriquement : 63px mesuré « tient », mais le même texte
// réellement rendu avec letterSpacing:20 atteint 345px de haut sur un cadre de 220px). Une seule
// source de vérité pour ces propriétés est le seul correctif qui reste correctif : toute nouvelle
// propriété de style texte ajoutée ici profite automatiquement à la mesure d'autoFit.
export function textStyleFor(layer: TextLayer): Record<string, unknown> {
  const justify = layer.align === "center" ? "center" : layer.align === "right" ? "flex-end" : "flex-start";
  const align = layer.vAlign === "middle" ? "center" : layer.vAlign === "bottom" ? "flex-end" : "flex-start";
  return {
    justifyContent: justify,
    alignItems: align,
    fontFamily: layer.font.family,
    fontSize: layer.font.size,
    fontWeight: layer.font.weight,
    fontStyle: layer.font.italic ? "italic" : "normal",
    color: layer.color,
    lineHeight: layer.lineHeight,
    textAlign: layer.align,
    overflow: "hidden",
    ...(layer.letterSpacing !== undefined ? { letterSpacing: layer.letterSpacing } : {}),
    ...(layer.maxLines ? { lineClamp: layer.maxLines } : {}),
    ...(layer.shadow
      ? { textShadow: `${layer.shadow.x}px ${layer.shadow.y}px ${layer.shadow.blur}px ${layer.shadow.color}` }
      : {}),
    ...(layer.stroke
      ? { WebkitTextStroke: `${layer.stroke.width}px ${layer.stroke.color}` }
      : {}),
  };
}

function textNode(layer: TextLayer): SatoriNode {
  return {
    type: "div",
    props: {
      "data-layer": layer.id,
      style: {
        ...frameStyle(layer),
        ...textStyleFor(layer),
      },
      children: layer.content,
    },
  };
}

function shapeNode(layer: ShapeLayer): SatoriNode {
  const fill = typeof layer.fill === "string"
    ? (layer.fill === "transparent" ? {} : { backgroundColor: layer.fill })
    : { backgroundImage: gradientCss(layer.fill) };

  // `layerBorder` et NON `layer.border` (revue U3 Tâche 3, Medium 4) : la bordure ÉCHAPPE au
  // découpage ici — satori peint un contour RECTANGULAIRE autour d'un remplissage triangulaire
  // (réserve 3 de la sonde) — là où le navigateur clippe l'élément entier, bordure comprise. Même
  // divergence, même remède que la rotation : la description tranche, les deux chemins la posent.
  const painted = layerBorder(layer);
  const border: Record<string, unknown> = {};
  if (painted) {
    const sides = painted.sides ?? ["top", "right", "bottom", "left"];
    const css = `${painted.width}px solid ${painted.color}`;
    for (const s of sides) {
      border[`border${s[0].toUpperCase()}${s.slice(1)}`] = css;
    }
  }

  // `layerBoxShadow` et NON `layer.shadow` (U3 Tâche 4) : sur une forme découpée, satori ne peint
  // AUCUNE ombre — son masque d'ombre vaut « tout le canevas MOINS la forme découpée » et son contenu
  // est cette même forme, donc l'intersection est vide (mesuré, réserve 4 de la sonde). Le navigateur
  // n'en peint pas davantage. Les deux chemins sont d'accord, mais par deux mécanismes indépendants :
  // la description tranche pour que cet accord soit structurel, et les deux chemins la posent — même
  // discipline que la rotation et la bordure ci-dessus.
  const shadow = layerBoxShadow(layer);

  return {
    type: "div",
    props: {
      "data-layer": layer.id,
      style: {
        ...frameStyle(layer),
        ...fill,
        ...border,
        ...(shadow ? { boxShadow: shadow } : {}),
        // LA géométrie de la forme vient de lib/studio/shapes.ts — jamais d'un `switch` local. Ce
        // fichier ne sait PAS ce qu'est un rectangle ou une ellipse : il demande. C'est ce qui
        // garantit que le PNG exporté et le canevas de l'éditeur (layer-view.tsx, qui demande à la
        // MÊME description) peignent la même chose, plan U3 §0.
        ...shapeCssFor(layer),
      },
    },
  };
}

// La taille EFFECTIVE de l'image peinte (en px du cadre) + le `background-size` correspondant, par
// mode de cadrage. C'est le cœur du chemin unique (Tâche 3) : Satori sait peindre `cover`/`contain`/
// une taille en px/une mosaïque, mais son `background-position` en `%` est bogué (spike, Tâche 1) —
// on lui donne donc la position en PIXELS, calculée par focalToPositionPx à partir de `effImg`.
// `effImg` reproduit EXACTEMENT la mise à l'échelle que Satori applique pour chaque `background-size`,
// pour que la position calculée corresponde à ce qui est réellement peint.
function effectiveImage(
  sizing: "cover" | "contain" | "stretch" | "tile" | "custom",
  frame: { w: number; h: number },
  intrinsic: { w: number; h: number },
  layer: Extract<Layer, { type: "image" }>,
): { effImg: { w: number; h: number }; backgroundSize: string } {
  const { w: fw, h: fh } = frame;
  const { w: iw, h: ih } = intrinsic;
  switch (sizing) {
    case "contain": {
      const s = Math.min(fw / iw, fh / ih);
      return { effImg: { w: iw * s, h: ih * s }, backgroundSize: "contain" };
    }
    case "stretch":
      return { effImg: { w: fw, h: fh }, backgroundSize: "100% 100%" };
    case "custom": {
      // customSize absent malgré sizing:"custom" : le schéma le laisse optionnel (scene.ts, discriminated
      // union), donc c'est LÉGAL même si parseScene le rejette désormais. Ce repli DOIT s'accorder à
      // celui d'`imageCss` (image-css.ts, "contain") sinon l'aperçu (navigateur) et l'export (ce chemin)
      // PEINDRAIENT DIFFÉREMMENT ce cas-limite — exactement le désaccord WYSIWYG que §0 interdit. On
      // retombe donc sur le calcul CONTAIN (letterbox, aspect préservé), identique à imageCss.
      if (!layer.customSize) {
        const s = Math.min(fw / iw, fh / ih);
        return { effImg: { w: iw * s, h: ih * s }, backgroundSize: "contain" };
      }
      const { w: cw, h: ch } = layer.customSize;
      return { effImg: { w: cw, h: ch }, backgroundSize: `${cw}px ${ch}px` };
    }
    case "tile": {
      // `scale` est une fraction de la taille INTRINSÈQUE (image-css.ts). La taille de tuile est donc
      // iw*scale × ih*scale — jamais "auto", puisque scale peut ≠ 1. `background-position` sert alors
      // d'origine de la tuile : la même formule convient.
      const scale = layer.tile?.scale ?? 1;
      return { effImg: { w: iw * scale, h: ih * scale }, backgroundSize: `${iw * scale}px ${ih * scale}px` };
    }
    case "cover":
    default: {
      // Le recadrage focal `cover` vit désormais dans images.ts#prepareImage : l'image préparée arrive
      // DÉJÀ à l'aspect du CADRE (fenêtre focale extraite dans sharp). L'intrinsèque `iw:ih` vaut donc
      // `fw:fh`, `s` couvre EXACTEMENT le cadre, `effImg` == cadre, et focalToPositionPx recalcule une
      // position 0 — aucun débordement, donc pas de plafonnement de position négative par Satori (le bug
      // que le recadrage amont corrige), et AUCUN double emploi du point focal (déjà consommé par sharp).
      const s = Math.max(fw / iw, fh / ih);
      return { effImg: { w: iw * s, h: ih * s }, backgroundSize: "cover" };
    }
  }
}

function imageNode(layer: Layer, prepared: PreparedImage): SatoriNode {
  // ATTENTION, DEUX CHAMPS `radius` DE TYPES DIFFÉRENTS (revue finale U3, Minor 3 — un piège que U3 a
  // créé lui-même) : celui-ci est `imageLayer.radius`, un `z.number()` (lib/studio/scene.ts:46) laissé
  // NUMÉRIQUE délibérément — le migrer achèterait des masques d'image elliptiques, une fonctionnalité,
  // pas un refactor. Son homonyme `shapeLayer.radius` (scene.ts, `cssRadius`) est `number | string`
  // depuis l'arbitrage C, parce qu'une ellipse EXIGE « 50% ». Ne jamais faire passer l'un pour l'autre.
  // La garde `layer.type === "image"` ci-dessous est ce qui les tient à l'écart ICI (`imageNode` est
  // appelé pour les calques image ET qr, et un qr n'a pas de rayon) : la retirer ne COMPILE PAS —
  // vérifié, `layer.radius` sur l'union `Layer` est TS2339. Le versant observable de la séparation est
  // testé dans tests/studio-shapes.test.ts, « les DEUX champs `radius` du schéma restent SÉPARÉS ».
  const radius = layer.type === "image" && layer.radius ? { borderRadius: layer.radius } : {};

  // CHEMIN UNIQUE (Tâche 3, verdict du spike) — un calque IMAGE est un `<div>` de FOND, PAS un `<img>`.
  // C'est ce qui rend le point focal hors-centre possible sur `cover` : l'image n'est plus pré-recadrée
  // au cadre par sharp (prepareImage la remonte à sa taille naturelle bornée), et c'est le fond CSS de
  // Satori qui l'échelonne et la positionne. `background-position` est donné en PIXELS calculés
  // (focalToPositionPx) et NON en `%` : le `%` de Satori est bogué (spike, Tâche 1).
  if (layer.type === "image") {
    const sizing = layer.sizing ?? (layer.fit === "cover" ? "cover" : "contain");
    // Garde contre une intrinsèque nulle (calque QR partage la map mais n'entre jamais ici ; un 0
    // ferait diviser par zéro dans `effectiveImage`) : retombe sur le cadre, inoffensif.
    const intrinsic = { w: prepared.w || layer.frame.w, h: prepared.h || layer.frame.h };
    const { effImg, backgroundSize } = effectiveImage(sizing, layer.frame, intrinsic, layer);
    // `background-repeat` : répétition SEULEMENT en mosaïque (tileToRepeat → repeat/repeat-x/repeat-y
    // selon l'axe), `no-repeat` partout ailleurs — même règle qu'imageCss, mais on appelle directement
    // `tileToRepeat` plutôt qu'imageCss pour ne pas calculer au passage la taille/position en `%` qu'on
    // jette de toute façon (la position part en PIXELS via focalToPositionPx).
    const backgroundRepeat = sizing === "tile" ? tileToRepeat(layer.tile).backgroundRepeat : "no-repeat";
    return {
      type: "div",
      props: {
        "data-layer": layer.id,
        style: {
          ...frameStyle(layer),
          overflow: "hidden",
          ...radius,
          backgroundImage: `url(${prepared.uri})`,
          backgroundSize,
          backgroundRepeat,
          backgroundPosition: focalToPositionPx(layer, effImg),
        },
      },
    };
  }

  // QR — CHEMIN `<img>` INCHANGÉ (un QR est un vecteur déjà à la bonne taille, pas de cadrage avancé).
  return {
    type: "div",
    props: {
      "data-layer": layer.id,
      style: { ...frameStyle(layer), overflow: "hidden", ...radius },
      children: {
        type: "img",
        props: {
          src: prepared.uri,
          width: layer.frame.w,
          height: layer.frame.h,
          style: { objectFit: "contain", width: layer.frame.w, height: layer.frame.h, ...radius },
        },
      },
    },
  };
}

// PURE — aucune I/O. `images` associe un ID DE CALQUE à une image déjà préparée (calques image et qr) :
// `{ uri, w, h }` — la taille intrinsèque `w`/`h` est nécessaire au fond CSS d'une IMAGE (Tâche 3),
// tandis qu'un QR n'utilise que `uri` (render.ts y stocke `w:0, h:0`). Un calque image sans image
// préparée est omis : render.ts a déjà échoué franchement si la préparation était obligatoire, donc
// arriver ici sans image signifie « rien à peindre ».
export function sceneToElement(scene: Scene, images: Map<string, PreparedImage>): SatoriNode {
  const children: SatoriNode[] = [];

  for (const layer of scene.layers) {
    if (!layer.visible) continue;
    if (layer.type === "image" || layer.type === "qr") {
      const prepared = images.get(layer.id);
      if (!prepared) continue;
      children.push(imageNode(layer, prepared));
    } else if (layer.type === "text") {
      children.push(textNode(layer));
    } else {
      children.push(shapeNode(layer));
    }
  }

  const background = scene.canvas.background === "transparent"
    ? {}
    : { backgroundColor: scene.canvas.background };

  return {
    type: "div",
    props: {
      style: {
        display: "flex",
        position: "relative",
        width: scene.canvas.width,
        height: scene.canvas.height,
        ...background,
      },
      children,
    },
  };
}
