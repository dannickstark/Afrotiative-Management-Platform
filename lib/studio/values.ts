import type { Scene, Layer, Gradient } from "./scene";
import { extractTokens, type TokenId } from "./tokens";

export type TokenValues = Partial<Record<TokenId, string>>;

// Erreur typée : le message est en français et NOMME les jetons manquants, parce qu'un rédacteur
// qui voit « il manque des informations » ne peut rien en faire.
export class MissingTokensError extends Error {
  constructor(public readonly tokens: string[]) {
    super(`Valeurs manquantes pour : ${tokens.join(", ")}.`);
    this.name = "MissingTokensError";
  }
}

const TOKEN_IN_TEXT = /\{\{\s*([a-zA-Z][\w.]*)\s*\}\}/g;

function substitute(value: string, values: TokenValues): string {
  return value.replace(TOKEN_IN_TEXT, (_m, token: string) => values[token as TokenId] ?? "");
}

function resolveGradient(gradient: Gradient, values: TokenValues): Gradient {
  return { ...gradient, stops: gradient.stops.map((s) => ({ ...s, color: substitute(s.color, values) })) };
}

// Renvoie une NOUVELLE scène ; l'entrée n'est jamais mutée (les scènes viennent d'un cache ou
// d'une ligne de base et peuvent être réutilisées).
//
// La substitution couvre EXACTEMENT les champs qu'extractTokens (tokens.ts) scanne, sans quoi les
// deux fonctions divergeraient : arrière-plan du canevas, source/overlay d'image, contenu/couleur/
// ombre/contour de texte, remplissage (couleur unie ou dégradé) et bordure de forme, avant-plan/
// fond de QR code.
export function resolveTokens(scene: Scene, values: TokenValues): Scene {
  const missing = [...new Set(
    extractTokens(scene)
      .map((u) => u.token)
      .filter((t) => !values[t as TokenId]),
  )];
  if (missing.length > 0) throw new MissingTokensError(missing.sort());

  const layers: Layer[] = scene.layers.map((layer): Layer => {
    switch (layer.type) {
      case "image": {
        const source = layer.source.kind === "slot"
          ? { kind: "url" as const, url: values[layer.source.slot as TokenId]! }
          : layer.source;
        const overlay = layer.overlay !== undefined ? substitute(layer.overlay, values) : undefined;
        return { ...layer, source, ...(overlay !== undefined ? { overlay } : {}) };
      }
      case "qr": {
        // qrLayer.slot n'est PAS substitué ici : seul render.ts sait transformer une URL en bitmap
        // QR, donc le slot reste un identifiant de jeton jusqu'au rendu. fg/bg, en revanche, sont
        // des couleurs comme les autres et sont résolues normalement.
        return { ...layer, fg: substitute(layer.fg, values), bg: substitute(layer.bg, values) };
      }
      case "text": {
        const shadow = layer.shadow
          ? { ...layer.shadow, color: substitute(layer.shadow.color, values) }
          : undefined;
        const stroke = layer.stroke
          ? { ...layer.stroke, color: substitute(layer.stroke.color, values) }
          : undefined;
        return {
          ...layer,
          content: substitute(layer.content, values),
          color: substitute(layer.color, values),
          ...(shadow ? { shadow } : {}),
          ...(stroke ? { stroke } : {}),
        };
      }
      case "shape": {
        const fill = typeof layer.fill === "string"
          ? substitute(layer.fill, values)
          : resolveGradient(layer.fill, values);
        const border = layer.border
          ? { ...layer.border, color: substitute(layer.border.color, values) }
          : undefined;
        return { ...layer, fill, ...(border ? { border } : {}) };
      }
    }
  });

  return {
    ...scene,
    canvas: { ...scene.canvas, background: substitute(scene.canvas.background, values) },
    layers,
  };
}
