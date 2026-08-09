import type { Scene, Layer } from "./scene";

export type TokenKind = "text" | "image" | "color" | "url";

// Le catalogue COMPLET des jetons injectables. Ajouter un jeton ici ne suffit pas : il faut aussi
// l'exposer dans au moins un contexte (CONTEXT_TOKENS) et lui fournir une valeur (bindings.ts).
export const TOKEN_KINDS = {
  "article.title": "text",
  "article.excerpt": "text",
  "article.date": "text",
  "article.byline": "text",
  "article.image": "image",
  "article.url": "url",
  "category.name": "text",
  "category.color": "color",
  "source.names": "text",
  "brand.logo": "image",
  "quote.text": "text",
  "quote.attribution": "text",
  "edition.title": "text",
  "edition.date": "text",
  "recap.title": "text",
  "recap.item1": "text",
  "recap.item2": "text",
  "recap.item3": "text",
} as const satisfies Record<string, TokenKind>;

export type TokenId = keyof typeof TOKEN_KINDS;
export const TOKEN_IDS = Object.keys(TOKEN_KINDS) as TokenId[];

export const TEMPLATE_CONTEXTS = [
  "article_image", "social_post", "quote_card", "newsletter_header", "recap_card",
] as const;
export type TemplateContext = (typeof TEMPLATE_CONTEXTS)[number];

export const CHANNELS = ["facebook", "instagram", "whatsapp", "x", "tiktok"] as const;
export type Channel = (typeof CHANNELS)[number];

const ARTICLE_COMMON = [
  "article.title", "article.excerpt", "article.date", "article.byline", "article.image",
  "category.name", "category.color", "source.names", "brand.logo",
] as const;

// LA contrainte d'ordonnancement du programme : `article.url` n'existe qu'APRÈS la publication
// WordPress. L'image à la une du site, elle, est rendue AVANT. Un gabarit article_image qui
// référencerait article.url produirait donc toujours une valeur vide — on le refuse plutôt que de
// laisser le piège en place, et on le refuse au moment de PUBLIER le gabarit, pas devant un
// rédacteur au moment du rendu.
export const CONTEXT_TOKENS: Record<TemplateContext, readonly TokenId[]> = {
  article_image: ARTICLE_COMMON,
  social_post: [...ARTICLE_COMMON, "article.url"],
  quote_card: ["quote.text", "quote.attribution", "article.title", "category.name", "category.color", "brand.logo"],
  newsletter_header: ["edition.title", "edition.date", "brand.logo"],
  recap_card: ["recap.title", "recap.item1", "recap.item2", "recap.item3", "brand.logo"],
};

export type TokenUse = { token: string; expected: TokenKind; where: string };

const TOKEN_IN_TEXT = /\{\{\s*([a-zA-Z][\w.]*)\s*\}\}/g;

function tokensInString(value: string): string[] {
  return [...value.matchAll(TOKEN_IN_TEXT)].map((m) => m[1]);
}

function usesInLayer(layer: Layer): TokenUse[] {
  const where = `calque « ${layer.name || layer.id} »`;
  const uses: TokenUse[] = [];

  switch (layer.type) {
    case "image":
      if (layer.source.kind === "slot") {
        uses.push({ token: layer.source.slot, expected: "image", where });
      }
      // Scan imageLayer.overlay
      if (layer.overlay) {
        uses.push(...tokensInString(layer.overlay).map((t) => ({ token: t, expected: "color" as const, where })));
      }
      break;
    case "qr":
      uses.push({ token: layer.slot, expected: "url", where });
      // Scan qrLayer.fg and qrLayer.bg
      uses.push(...tokensInString(layer.fg).map((t) => ({ token: t, expected: "color" as const, where })));
      uses.push(...tokensInString(layer.bg).map((t) => ({ token: t, expected: "color" as const, where })));
      break;
    case "text":
      uses.push(...tokensInString(layer.content).map((t) => ({ token: t, expected: "text" as const, where })));
      uses.push(...tokensInString(layer.color).map((t) => ({ token: t, expected: "color" as const, where })));
      // Scan textLayer.shadow.color
      if (layer.shadow) {
        uses.push(...tokensInString(layer.shadow.color).map((t) => ({ token: t, expected: "color" as const, where })));
      }
      // Scan textLayer.stroke.color
      if (layer.stroke) {
        uses.push(...tokensInString(layer.stroke.color).map((t) => ({ token: t, expected: "color" as const, where })));
      }
      break;
    case "shape": {
      const colors = typeof layer.fill === "string" ? [layer.fill] : layer.fill.stops.map((s) => s.color);
      if (layer.border) colors.push(layer.border.color);
      uses.push(...colors.flatMap((c) => tokensInString(c).map((t) => ({ token: t, expected: "color" as const, where }))));
      break;
    }
  }

  return uses;
}

// Les slots d'un gabarit sont DÉRIVÉS de sa scène, jamais déclarés à côté. Une liste parallèle
// dériverait tôt ou tard de la scène réelle ; ici c'est structurellement impossible.
export function extractTokens(scene: Scene): TokenUse[] {
  const uses = scene.layers.flatMap(usesInLayer);
  // Scan scene.canvas.background
  uses.push(...tokensInString(scene.canvas.background).map((t) => ({ token: t, expected: "color" as const, where: "arrière-plan du canevas" })));
  return uses;
}

// French labels for TokenKind values
const TOKEN_KIND_LABELS: Record<TokenKind, string> = {
  text: "texte",
  image: "image",
  color: "couleur",
  url: "URL",
};

// Renvoie la liste des problèmes, en français, prête à afficher. Tableau vide = valide.
export function validateScene(scene: Scene, context: TemplateContext): string[] {
  const allowed = new Set<string>(CONTEXT_TOKENS[context]);
  const errors: string[] = [];
  for (const use of extractTokens(scene)) {
    const kind = TOKEN_KINDS[use.token as TokenId];
    if (!kind) {
      errors.push(`${use.where} : jeton inconnu « ${use.token} ».`);
      continue;
    }
    if (!allowed.has(use.token)) {
      errors.push(
        `${use.where} : le jeton « ${use.token} » n'est pas disponible dans ce contexte. ` +
        `Jetons disponibles : ${CONTEXT_TOKENS[context].join(", ")}.`,
      );
      continue;
    }
    if (kind !== use.expected) {
      errors.push(
        `${use.where} : le jeton « ${use.token} » est de type « ${TOKEN_KIND_LABELS[kind]} », ` +
        `or un « ${TOKEN_KIND_LABELS[use.expected]} » est attendu ici.`,
      );
    }
  }
  return errors;
}
