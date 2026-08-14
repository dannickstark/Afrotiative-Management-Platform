import { db, articles, articleSources, wpCategories } from "@/db";
import { and, asc, desc, eq, ilike, sql, type SQL } from "drizzle-orm";
import { sortMissingFields, type MissingField } from "@/lib/pipeline/completeness";
import type { ArticleStatus } from "@/lib/format";
import { resolveQueueSort, type QueueSortCol } from "./queue-sort";

export const QUEUE_PAGE_SIZE = 25;

const STATUSES: ArticleStatus[] = [
  "draft", "pending", "in_review", "approved", "published", "rejected",
];

export type QueueStatusFilter = ArticleStatus | "all";
export type SourceBucket = "single" | "multiple";

// Ré-exportés depuis le module pur sibling (queue-sort.ts) : la resolution de tri elle-même n'a
// aucune I/O et doit rester importable depuis bun test sans tirer le client DB — voir
// tests/queue-sort.test.ts, qui importe le module pur directement plutôt que via ce fichier.
export { resolveQueueSort, type QueueSortCol };

export type QueueFilters = {
  status: QueueStatusFilter;
  search?: string;
  categoryId?: string;
  source?: SourceBucket;
  sortColumn: QueueSortCol;
  sortDirection: "asc" | "desc";
  page: number;
  pageSize: number;
};

export type QueueRow = {
  id: string; title: string; excerpt: string | null;
  categoryName: string | null; sourceCount: number;
  imageUrl: string | null; generatedAt: Date | null; status: string;
  low: boolean; score: number | null;
  missingFields: MissingField[];
};

export type QueuePage = { rows: QueueRow[]; total: number; page: number; pageCount: number };

// Métacaractères LIKE échappés pour qu'un % ou _ tapé par l'utilisateur soit cherché
// littéralement (ESCAPE par défaut = antislash). Identique à lib/queries/published.ts.
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * PUR — paramètres d'URL bruts → filtres typés. Aucune I/O, donc directement testable.
 * Le défaut porte tout le sens de ce sous-projet : SANS paramètre, la file est « en attente ».
 * Les autres statuts restent atteignables via ?status=…, et ?status=all lève le filtre.
 * Calque de parsePublishedSearchParams.
 */
export function parseQueueSearchParams(
  sp: Record<string, string | string[] | undefined>,
): QueueFilters {
  const str = (v: string | string[] | undefined): string | undefined => {
    const s = Array.isArray(v) ? v[0] : v;
    return s && s.trim() ? s.trim() : undefined;
  };

  const statusRaw = str(sp.status);
  const status: QueueStatusFilter =
    statusRaw === "all" ? "all"
      : STATUSES.includes(statusRaw as ArticleStatus) ? (statusRaw as ArticleStatus)
        : "pending";

  const srcRaw = str(sp.src);
  const source = srcRaw === "single" || srcRaw === "multiple" ? srcRaw : undefined;

  // En-têtes de colonnes cliquables (task B2) : `?sort=<colonne>&dir=asc|desc`, résolus via la
  // liste blanche de queue-sort.ts. Remplace l'ancien menu déroulant oldest/newest/score.
  // Une arrivée NUE sur /queue (aucun `?sort`) doit reproduire EXACTEMENT l'ancien tri par
  // défaut — le plus ancien d'abord — donc ce cas est traité à part plutôt que via le repli
  // générique de resolveQueueSort (qui vaut « date desc », le plus récent d'abord, et ne sert
  // qu'aux clics explicites / entrées invalides).
  const sortRaw = str(sp.sort);
  const { column: sortColumn, direction: sortDirection } =
    sortRaw === undefined
      ? { column: "date" as const, direction: "asc" as const }
      : resolveQueueSort(sortRaw, str(sp.dir));

  const pageRaw = Number(str(sp.page));
  const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? Math.floor(pageRaw) : 1;

  return {
    status, search: str(sp.q), categoryId: str(sp.cat), source, sortColumn, sortDirection,
    page, pageSize: QUEUE_PAGE_SIZE,
  };
}

// Sous-requête corrélée réutilisée par le SELECT et par le filtre « sources » — une seule
// définition pour que les deux ne puissent pas compter différemment.
const SOURCE_COUNT = sql<number>`(select count(*) from ${articleSources} s where s.article_id = ${articles.id})`;

// `desc(articles.score)` seul trierait NULLS FIRST (comportement Postgres par défaut pour DESC) :
// les articles JAMAIS notés passeraient devant les mieux notés — l'inverse de ce que « Score »
// doit produire en tri décroissant. Même logique pour `date`. `desc()`/`asc()` renvoient un SQL
// sans méthode `.nulls()` dans cette version de Drizzle (0.45.2 — vérifié : absente de
// sql/sql.d.ts et sql/expressions/select.d.ts) ; un fragment `sql` brut est l'équivalent portable.
// Liste blanche colonne → expression ORDER BY : c'est elle qui empêche un `?sort=` arbitraire
// d'atteindre le SQL — `f.sortColumn` est déjà typé QueueSortCol (resolveQueueSort en garde
// l'unique point d'entrée), donc cette table est exhaustive et jamais indexée par une chaîne brute.
const SORT_EXPR: Record<QueueSortCol, (dir: "asc" | "desc") => SQL> = {
  title: (dir) => (dir === "asc" ? asc(articles.title) : desc(articles.title)),
  category: (dir) => (dir === "asc" ? sql`${wpCategories.name} asc nulls last` : sql`${wpCategories.name} desc nulls last`),
  score: (dir) => (dir === "asc" ? sql`${articles.score} asc nulls last` : sql`${articles.score} desc nulls last`),
  date: (dir) => (dir === "asc" ? sql`${articles.generatedAt} asc nulls last` : sql`${articles.generatedAt} desc nulls last`),
  source: (dir) => (dir === "asc" ? asc(SOURCE_COUNT) : desc(SOURCE_COUNT)),
  status: (dir) => (dir === "asc" ? asc(articles.status) : desc(articles.status)),
};

export async function getQueue(f: QueueFilters): Promise<QueuePage> {
  const conds = [];
  if (f.status !== "all") conds.push(eq(articles.status, f.status));
  if (f.search) conds.push(ilike(articles.title, `%${escapeLike(f.search)}%`));
  if (f.categoryId) conds.push(eq(articles.categoryId, f.categoryId));
  if (f.source === "single") conds.push(sql`${SOURCE_COUNT} <= 1`);
  if (f.source === "multiple") conds.push(sql`${SOURCE_COUNT} > 1`);
  const where = conds.length ? and(...conds) : undefined;

  const total = await db.$count(articles, where);
  const pageCount = Math.max(1, Math.ceil(total / f.pageSize));
  // Borne la page dans l'intervalle valide : un ?page= trop grand renvoie la dernière page
  // plutôt qu'un tableau vide.
  const page = Math.min(Math.max(1, f.page), pageCount);

  const orderBy = SORT_EXPR[f.sortColumn](f.sortDirection);

  const rows = await db.select({
    id: articles.id, title: articles.title, excerpt: articles.excerpt,
    categoryName: wpCategories.name, imageUrl: articles.featuredImageUrl,
    generatedAt: articles.generatedAt, status: articles.status,
    confidenceFlags: articles.confidenceFlags, score: articles.score,
    missingFields: articles.missingFields, sourceCount: SOURCE_COUNT,
  }).from(articles)
    .leftJoin(wpCategories, eq(articles.categoryId, wpCategories.id))
    .where(where)
    .orderBy(orderBy)
    .limit(f.pageSize)
    .offset((page - 1) * f.pageSize);

  return {
    rows: rows.map((r) => ({
      id: r.id, title: r.title, excerpt: r.excerpt, categoryName: r.categoryName,
      sourceCount: Number(r.sourceCount), imageUrl: r.imageUrl,
      generatedAt: r.generatedAt, status: r.status, score: r.score,
      low: Boolean(
        r.confidenceFlags?.categoryUncertain ||
        r.confidenceFlags?.imageMissing ||
        r.confidenceFlags?.clusterUncertain,
      ),
      // Normalisé à la lecture : couvre aussi les lignes écrites avant le sous-projet D.
      missingFields: sortMissingFields((r.missingFields ?? []) as MissingField[]),
    })),
    total, page, pageCount,
  };
}

export type QueuePreview = {
  id: string; title: string; excerpt: string | null; bodyHtml: string;
  imageUrl: string | null; imageCredit: string | null; imageSourceUrl: string | null;
  categoryName: string | null; status: string; score: number | null;
  missingFields: MissingField[];
  sources: { mediaName: string; url: string }[];
};

// Charge le corps d'UN article — délibérément séparé de getQueue, qui ne doit jamais tirer
// N corps d'articles pour n'en afficher aucun.
export async function getQueuePreview(id: string): Promise<QueuePreview | null> {
  const [row] = await db.select({
    id: articles.id, title: articles.title, excerpt: articles.excerpt,
    bodyHtml: articles.bodyHtml, imageUrl: articles.featuredImageUrl,
    imageCredit: articles.imageCredit, imageSourceUrl: articles.imageSourceUrl,
    categoryName: wpCategories.name, status: articles.status, score: articles.score,
    missingFields: articles.missingFields,
  }).from(articles)
    .leftJoin(wpCategories, eq(articles.categoryId, wpCategories.id))
    .where(eq(articles.id, id))
    .limit(1);

  if (!row) return null;

  const sources = await db.select({
    mediaName: articleSources.mediaName, url: articleSources.url,
  }).from(articleSources).where(eq(articleSources.articleId, id));

  return {
    ...row,
    missingFields: sortMissingFields((row.missingFields ?? []) as MissingField[]),
    sources,
  };
}
