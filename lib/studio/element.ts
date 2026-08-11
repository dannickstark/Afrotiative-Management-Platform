import type { Scene, Layer, Gradient, TextLayer, ShapeLayer } from "./scene";
import { shapeCssFor } from "./shapes";

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
  if (layer.rotation) transforms.push(`rotate(${layer.rotation}deg)`);
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

  const border: Record<string, unknown> = {};
  if (layer.border) {
    const sides = layer.border.sides ?? ["top", "right", "bottom", "left"];
    const css = `${layer.border.width}px solid ${layer.border.color}`;
    for (const s of sides) {
      border[`border${s[0].toUpperCase()}${s.slice(1)}`] = css;
    }
  }

  return {
    type: "div",
    props: {
      "data-layer": layer.id,
      style: {
        ...frameStyle(layer),
        ...fill,
        ...border,
        // LA géométrie de la forme vient de lib/studio/shapes.ts — jamais d'un `switch` local. Ce
        // fichier ne sait PAS ce qu'est un rectangle ou une ellipse : il demande. C'est ce qui
        // garantit que le PNG exporté et le canevas de l'éditeur (layer-view.tsx, qui demande à la
        // MÊME description) peignent la même chose, plan U3 §0.
        ...shapeCssFor(layer),
      },
    },
  };
}

function imageNode(layer: Layer, uri: string): SatoriNode {
  const radius = layer.type === "image" && layer.radius ? { borderRadius: layer.radius } : {};
  const fit = layer.type === "image" ? layer.fit : "contain";
  return {
    type: "div",
    props: {
      "data-layer": layer.id,
      style: { ...frameStyle(layer), overflow: "hidden", ...radius },
      children: {
        type: "img",
        props: {
          src: uri,
          width: layer.frame.w,
          height: layer.frame.h,
          style: { objectFit: fit, width: layer.frame.w, height: layer.frame.h, ...radius },
        },
      },
    },
  };
}

// PURE — aucune I/O. `images` associe un ID DE CALQUE à une data URI déjà préparée (calques image
// et qr). Un calque image sans URI préparée est omis : render.ts a déjà échoué franchement si la
// préparation était obligatoire, donc arriver ici sans URI signifie « rien à peindre ».
export function sceneToElement(scene: Scene, images: Map<string, string>): SatoriNode {
  const children: SatoriNode[] = [];

  for (const layer of scene.layers) {
    if (!layer.visible) continue;
    if (layer.type === "image" || layer.type === "qr") {
      const uri = images.get(layer.id);
      if (!uri) continue;
      children.push(imageNode(layer, uri));
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
