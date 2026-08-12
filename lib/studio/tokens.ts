import { colorFieldsOf, type Scene, type Layer } from "./scene";

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

export const CHANNELS = ["facebook", "instagram", "whatsapp", "x", "tiktok", "linkedin"] as const;
export type Channel = (typeof CHANNELS)[number];

// Libellé français canonique d'un canal — UNE seule source, réutilisée à la fois par le registre
// de diffusion (lib/diffusion/channels.ts, SOCIAL_CHANNELS[...].label) et par les sélecteurs de
// canal du studio (components/studio/templates-table.tsx, components/studio/manual-generate.tsx).
// Ce module (lib/studio/tokens.ts) n'importe rien de lourd (pas de @/db) : il reste importable tel
// quel depuis un composant CLIENT — contrairement à lib/diffusion/channels.ts, qui entraîne le
// barrel @/lib/studio et, via lui, @/db (voir le commentaire de templates-table.tsx sur ses imports
// directs). Avant cette constante, ces trois endroits recopiaient chacun leur propre
// Record<Channel, string> : celle de templates-table.tsx était typée Record<string, string>, PAS
// Record<Channel, string> — donc un canal ajouté à CHANNELS sans mise à jour de cette copie
// n'aurait déclenché AUCUNE erreur de compilation, juste un sélecteur de canal affichant `undefined`
// pour le nouveau canal (constaté en ajoutant LinkedIn — voir le rapport de tâche D7).
export const CHANNEL_LABELS: Record<Channel, string> = {
  facebook: "Facebook",
  instagram: "Instagram",
  whatsapp: "WhatsApp",
  x: "X",
  tiktok: "TikTok",
  linkedin: "LinkedIn",
};

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

// La dimension COULEUR n'est plus une liste recopiée à la main par type de calque (U4 Tâche 2) : elle
// vient de `colorFieldsOf` (lib/studio/scene.ts), le marcheur dérivé du schéma que `resolveTokens`
// (lib/studio/values.ts) consulte aussi pour la substitution — les deux ne peuvent donc plus diverger.
// Ce qui RESTE ici, spécifique à chaque type, est la dimension NON-couleur : le slot d'image, le slot
// d'URL du QR, le contenu du texte — trois choses que `colorFieldsOf` ne connaît pas et n'a pas à
// connaître.
function usesInLayer(layer: Layer): TokenUse[] {
  const where = `calque « ${layer.name || layer.id} »`;
  const uses: TokenUse[] = [];

  switch (layer.type) {
    case "image":
      if (layer.source.kind === "slot") {
        uses.push({ token: layer.source.slot, expected: "image", where });
      }
      break;
    case "qr":
      uses.push({ token: layer.slot, expected: "url", where });
      break;
    case "text":
      uses.push(...tokensInString(layer.content).map((t) => ({ token: t, expected: "text" as const, where })));
      break;
    case "shape":
      break;
  }

  uses.push(
    ...colorFieldsOf(layer).flatMap((field) =>
      tokensInString(field.get()).map((t) => ({ token: t, expected: "color" as const, where }))),
  );

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
