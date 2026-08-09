// lib/studio/sample-values.ts — jeu d'échantillons français (Tâche 10, spec §4).
//
// Couvre la TOTALITÉ du catalogue TOKEN_KINDS (pas seulement les jetons des trois gabarits de
// démarrage, db/studio-templates.ts) : c'est ce qui permet à un gabarit tout juste créé, dans
// N'IMPORTE QUEL contexte, de se prévisualiser immédiatement sans qu'un rédacteur ait à saisir quoi
// que ce soit (spec §4 : « à défaut, un jeu d'échantillons français intégré »).
// lib/studio/preview-core.ts filtre ces valeurs par CONTEXT_TOKENS[contexte] au moment de l'aperçu
// — exactement comme lib/studio/bindings.ts:articleTokenValues filtre déjà les siennes — donc ce
// module n'a pas à se soucier lui-même de ce qui est légal dans quel contexte.
import type { TokenValues } from "./values";
import { DEFAULT_CATEGORY_COLOR } from "./default-category-color";

// Service d'images de test public et stable (https://picsum.photos), sans dépendance à un compte ou
// une clé — deux graines distinctes pour ne pas prévisualiser deux fois EXACTEMENT la même photo
// derrière « image de l'article » et « logo de la marque ».
export const SAMPLE_ARTICLE_IMAGE_URL = "https://picsum.photos/seed/afrotiative-article/1200/800";
export const SAMPLE_BRAND_LOGO_URL = "https://picsum.photos/seed/afrotiative-logo/400/400";

export const SAMPLE_VALUES: TokenValues = {
  "article.title": "Le cacao camerounais bat un record d'exportation en 2026",
  "article.excerpt":
    "La filière cacaoyère enregistre sa meilleure campagne depuis dix ans, portée par une hausse des cours mondiaux.",
  "article.date": "9 août 2026",
  "article.byline": "Afrotiative Media",
  "article.image": SAMPLE_ARTICLE_IMAGE_URL,
  "article.url": "https://afrotiative.example/actualites/cacao-record-exportation-2026",
  "category.name": "Économie",
  "category.color": DEFAULT_CATEGORY_COLOR,
  "source.names": "Ecofin, Jeune Afrique",
  "brand.logo": SAMPLE_BRAND_LOGO_URL,
  "quote.text": "Cette récolte confirme que nos producteurs peuvent rivaliser avec les plus grands.",
  "quote.attribution": "Awa Ndiaye, présidente de la coopérative Cacao Plus",
  "edition.title": "La lettre du vendredi",
  "edition.date": "9 août 2026",
  "recap.title": "Cette semaine en Afrique",
  "recap.item1": "Le cacao camerounais bat un record d'exportation.",
  "recap.item2": "Le franc CFA se stabilise face à l'euro.",
  "recap.item3": "Une nouvelle ligne ferroviaire relie Douala à Yaoundé.",
};
