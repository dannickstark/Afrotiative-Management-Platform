import { isSafePublicHttpUrl } from "@/lib/url-guard";

// Les sept informations dont l'absence est détectable sur un article. L'ORDRE de ce tableau est
// l'ordre canonique : toute liste persistée (articles.missing_fields) ou affichée le respecte,
// pour que deux articles présentant les mêmes manques soient toujours décrits à l'identique.
export const MISSING_FIELD_KEYS = [
  "sources",
  "categoryId",
  "featuredImageUrl",
  "imageCredit",
  "imageSourceUrl",
  "excerpt",
  "tags",
] as const;

export type MissingField = (typeof MISSING_FIELD_KEYS)[number];

// Les manques qui EMPÊCHENT la publication. `excerpt` et `tags` sont purement indicatifs : un
// article sans tags se publie parfaitement. Cette constante est la définition unique de
// « bloquant » — lib/wp/publish.ts et l'interface la consomment, personne ne la redéclare.
export const BLOCKING_FIELDS: readonly MissingField[] = [
  "sources",
  "categoryId",
  "featuredImageUrl",
  "imageCredit",
  "imageSourceUrl",
];

export const MISSING_LABEL: Record<MissingField, string> = {
  sources: "Sources",
  categoryId: "Catégorie",
  featuredImageUrl: "Image à la une",
  imageCredit: "Crédit image",
  imageSourceUrl: "Source de l'image",
  excerpt: "Chapô",
  tags: "Tags",
};

export type SourceRef = { mediaName: string; url: string };

// Le sous-ensemble d'un brouillon d'article que ces règles observent. Volontairement structurel
// (et non `ArticleDraft`) : les champs image sont `.nullish()` dans le schéma Zod, et ce module
// doit accepter aussi bien un brouillon fraîchement généré qu'une ligne relue en base.
export type CompletenessDraft = {
  category: string;
  bodyHtml: string;
  excerpt: string;
  tags: string[];
  featuredImageUrl?: string | null;
  imageCredit?: string | null;
  imageSourceUrl?: string | null;
  confidence: {
    categoryUncertain?: boolean;
    imageMissing?: boolean;
    clusterUncertain?: boolean;
    aiDegraded?: boolean;
  };
};

function filled(v: string | null | undefined): boolean {
  return typeof v === "string" && v.trim().length > 0;
}

// Remet une liste de clés dans l'ordre canonique et la dédoublonne.
export function sortMissingFields(fields: MissingField[]): MissingField[] {
  return MISSING_FIELD_KEYS.filter((k) => fields.includes(k));
}

/**
 * PUR — aucune I/O. Les informations manquantes d'un brouillon, dans l'ordre canonique.
 *
 * `categoryId` mérite une note : à ce stade la catégorie n'est qu'un NOM. Sa résolution en
 * identifiant n'a lieu que dans persistArticle (resolveCategoryId) et peut échouer même sur un
 * nom plausible — persistArticle complète donc cette clé après coup. C'est la seule clé
 * réconciliée plus tard ; les six autres sont entièrement déterminées ici.
 */
export function checkCompleteness(
  draft: CompletenessDraft,
  sources: SourceRef[],
  categoryNames: string[],
): MissingField[] {
  const missing: MissingField[] = [];

  if (sources.length === 0) missing.push("sources");

  if (!categoryNames.includes(draft.category) || draft.confidence.categoryUncertain === true) {
    missing.push("categoryId");
  }

  if (!filled(draft.featuredImageUrl)) {
    missing.push("featuredImageUrl");
  } else {
    // Rien à créditer sans image : ces deux clés ne sont réclamées QUE lorsqu'une image existe.
    if (!filled(draft.imageCredit)) missing.push("imageCredit");
    if (!filled(draft.imageSourceUrl)) missing.push("imageSourceUrl");
  }

  if (!filled(draft.excerpt)) missing.push("excerpt");
  if (draft.tags.length === 0) missing.push("tags");

  return sortMissingFields(missing);
}

/**
 * PUR — les manques BLOQUANTS d'un article déjà persisté, dérivés de ses colonnes réelles.
 *
 * Utilisé par publishArticle plutôt qu'une lecture de articles.missing_fields, pour deux raisons :
 * les articles antérieurs à la migration ont une colonne vide et échapperaient à la garde ; et un
 * article corrigé à la main via l'éditeur voit ses colonnes changer immédiatement. Les deux
 * chemins partagent ce module, donc l'affichage et l'application ne peuvent pas diverger.
 */
export function blockingGapsForArticle(a: {
  categoryId: string | null;
  categoryName: string | null;
  featuredImageUrl: string | null;
  imageCredit: string | null;
  imageSourceUrl: string | null;
  sourceCount: number;
}): MissingField[] {
  const missing: MissingField[] = [];
  if (a.sourceCount === 0) missing.push("sources");
  if (!a.categoryId || !filled(a.categoryName)) missing.push("categoryId");
  if (!filled(a.featuredImageUrl)) {
    missing.push("featuredImageUrl");
  } else {
    if (!filled(a.imageCredit)) missing.push("imageCredit");
    if (!filled(a.imageSourceUrl)) missing.push("imageSourceUrl");
  }
  return sortMissingFields(missing);
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * PUR — la source à créditer pour une image : celle dont le domaine correspond à l'hôte de
 * l'image (le crédit revient au média qui l'a publiée), à défaut la première source de l'article.
 * La correspondance tolère les sous-domaines dans les deux sens (`cdn.ecofin.com` ↔ `ecofin.com`).
 */
export function sourceForImage(imageUrl: string, sources: SourceRef[]): SourceRef | null {
  if (sources.length === 0) return null;
  const imgHost = hostOf(imageUrl);
  if (imgHost) {
    const match = sources.find((s) => {
      const h = hostOf(s.url);
      return h !== null && (h === imgHost || imgHost.endsWith(`.${h}`) || h.endsWith(`.${imgHost}`));
    });
    if (match) return match;
  }
  return sources[0];
}

/**
 * PUR — chapô de repli : texte brut du corps, tronqué sur une frontière de mot. Suffisant pour
 * qu'un article ne parte jamais sans chapô ; un éditeur peut toujours le réécrire.
 */
export function excerptFromHtml(html: string, max = 200): string {
  const text = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

// Réexporté pour que repairDraft (Task 2) et les tests partagent le même garde-fou d'URL.
export { isSafePublicHttpUrl };
