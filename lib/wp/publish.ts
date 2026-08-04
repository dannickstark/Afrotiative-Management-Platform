import {
  db, articles, articleSources, articleTags, wpCategories, wpTags, distributions, articleRevisions,
} from "@/db";
import { and, eq, desc } from "drizzle-orm";
import { getWpConfig } from "./config";
import { WordPressClient, WordPressError, type WpPostPayload } from "./client";

export type PostSource = { mediaName: string; url: string };

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

// PURE — no I/O. Assembles the WordPress post HTML content: the article body, then (when
// sources are present) a French "Sources" footer listing each source's media name linked to its
// url, then (when an image credit is present) a credit line — linked to imageSourceUrl when
// given, plain text otherwise. Used both by publishArticle/republishArticle and directly unit-
// tested (task brief Step 1).
export function buildPostBody(input: {
  bodyHtml: string;
  sources: PostSource[];
  imageCredit?: string | null;
  imageSourceUrl?: string | null;
}): string {
  const { bodyHtml, sources, imageCredit, imageSourceUrl } = input;
  let html = bodyHtml;

  if (sources.length > 0) {
    const items = sources
      .map(
        (s) =>
          `<li><a href="${escapeAttr(s.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(s.mediaName)}</a></li>`,
      )
      .join("");
    html += `\n<h3>Sources</h3>\n<ul>${items}</ul>`;
  }

  if (imageCredit) {
    const credit = imageSourceUrl
      ? `<a href="${escapeAttr(imageSourceUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(imageCredit)}</a>`
      : escapeHtml(imageCredit);
    html += `\n<p><em>Crédit image : ${credit}</em></p>`;
  }

  return html;
}

export type PublishResult = { ok: boolean; message: string; postId?: number };
export type ActionResult = { ok: boolean; message: string };

const COMBINING_DIACRITICS = new RegExp("[̀-ͯ]", "g"); // marks left by NFD decomposition

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFD")
    .replace(COMBINING_DIACRITICS, "") // strip accents, e.g. "économie" -> "economie"
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "tag";
}

function filenameFromUrl(url: string, mime: string): string {
  try {
    const { pathname } = new URL(url);
    const base = pathname.split("/").filter(Boolean).pop() || "image";
    if (/\.[a-z0-9]{2,5}$/i.test(base)) return base;
    const ext = mime.split("/")[1]?.split(";")[0]?.trim() || "jpg";
    return `${base}.${ext}`;
  } catch {
    return "image.jpg";
  }
}

function wpErrorMessage(prefix: string, err: unknown): string {
  const reason = err instanceof WordPressError ? err.message : err instanceof Error ? err.message : String(err);
  return `${prefix} : ${reason}`;
}

type Distribution = typeof distributions.$inferSelect;

// The most recent distributions row for (articleId, 'wordpress'), if any — used both to decide
// create-vs-update (idempotency) and as the base row for the upsert below.
async function latestDistribution(articleId: string): Promise<Distribution | null> {
  const [row] = await db
    .select()
    .from(distributions)
    .where(and(eq(distributions.articleId, articleId), eq(distributions.channel, "wordpress")))
    .orderBy(desc(distributions.at))
    .limit(1);
  return row ?? null;
}

// Updates the existing distributions row for this article+channel when one exists (regardless of
// its previous status/externalId — e.g. a prior 'failed' attempt with no externalId), otherwise
// inserts a fresh one. This is what keeps re-publish attempts from piling up duplicate rows.
async function upsertDistribution(
  articleId: string,
  existing: Distribution | null,
  patch: { status: "sent" | "failed"; externalId?: string },
): Promise<void> {
  if (existing) {
    await db
      .update(distributions)
      .set({ status: patch.status, externalId: patch.externalId ?? existing.externalId, at: new Date() })
      .where(eq(distributions.id, existing.id));
  } else {
    await db.insert(distributions).values({
      articleId, channel: "wordpress", status: patch.status, externalId: patch.externalId ?? null, at: new Date(),
    });
  }
}

type ArticleForPublish = {
  id: string;
  title: string;
  bodyHtml: string;
  excerpt: string | null;
  categoryId: string | null;
  categoryName: string | null;
  featuredImageUrl: string | null;
  imageCredit: string | null;
  imageSourceUrl: string | null;
  sources: PostSource[];
  tags: { id: string; tagName: string; isNew: boolean }[];
};

async function loadArticleForPublish(articleId: string): Promise<ArticleForPublish | null> {
  const [row] = await db
    .select({ article: articles, categoryName: wpCategories.name })
    .from(articles)
    .leftJoin(wpCategories, eq(articles.categoryId, wpCategories.id))
    .where(eq(articles.id, articleId));
  if (!row) return null;
  const sources = await db.select().from(articleSources).where(eq(articleSources.articleId, articleId));
  const tags = await db.select().from(articleTags).where(eq(articleTags.articleId, articleId));
  return {
    id: row.article.id,
    title: row.article.title,
    bodyHtml: row.article.bodyHtml,
    excerpt: row.article.excerpt,
    categoryId: row.article.categoryId,
    categoryName: row.categoryName,
    featuredImageUrl: row.article.featuredImageUrl,
    imageCredit: row.article.imageCredit,
    imageSourceUrl: row.article.imageSourceUrl,
    sources: sources.map((s) => ({ mediaName: s.mediaName, url: s.url })),
    tags,
  };
}

// Resolves the article's category + tags against WordPress BY NAME (never trusting the possibly-
// stale seeded wp_categories.wpId/wp_tags.wpId mirrors), backfilling those mirrors with the real
// WordPress ids as a side effect and flipping article_tags.is_new to false once a tag is confirmed
// to exist (or now exists) on WordPress.
async function resolveTaxonomy(
  wp: WordPressClient,
  article: ArticleForPublish,
): Promise<{ categoryId: number; tagIds: number[] }> {
  const categoryId = await wp.resolveOrCreateCategory(article.categoryName!);
  if (article.categoryId) {
    await db.update(wpCategories).set({ wpId: categoryId }).where(eq(wpCategories.id, article.categoryId));
  }

  const tagIds: number[] = [];
  if (article.tags.length > 0) {
    const mirrors = await db.select().from(wpTags);
    const byLowerName = new Map(mirrors.map((t) => [t.name.toLowerCase(), t]));
    for (const tag of article.tags) {
      const wpTagId = await wp.resolveOrCreateTag(tag.tagName);
      tagIds.push(wpTagId);
      const mirror = byLowerName.get(tag.tagName.toLowerCase());
      if (mirror) {
        await db.update(wpTags).set({ wpId: wpTagId }).where(eq(wpTags.id, mirror.id));
      } else {
        await db.insert(wpTags).values({ name: tag.tagName, slug: slugify(tag.tagName), wpId: wpTagId });
      }
      if (tag.isNew) await db.update(articleTags).set({ isNew: false }).where(eq(articleTags.id, tag.id));
    }
  }

  return { categoryId, tagIds };
}

// Fail-soft featured image: downloads the article's featuredImageUrl and uploads it to WordPress
// media. ANY failure (network, non-2xx, upload rejected) is swallowed here — the caller publishes
// the post without featured_media rather than blocking the whole publish over a bad image.
async function uploadFeaturedImage(wp: WordPressClient, featuredImageUrl: string): Promise<number | undefined> {
  try {
    const res = await fetch(featuredImageUrl);
    if (!res.ok) throw new Error(`téléchargement de l'image échoué (${res.status})`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const mime = res.headers.get("content-type") || "application/octet-stream";
    const { id } = await wp.uploadMedia(bytes, filenameFromUrl(featuredImageUrl, mime), mime);
    return id;
  } catch {
    // Fail-soft: the image failure is intentionally not surfaced as a publish failure. The
    // article keeps featuredImageUrl/imageCredit in the DB so an editor can retry via republier
    // once the image is reachable.
    return undefined;
  }
}

// Publishes (or, if already published to WordPress once, updates) an approved article.
//
// Ordering is deliberate: the article's `status` only flips to 'published' AFTER the WordPress
// createPost/updatePost call has actually succeeded (postId in hand) and the distributions row
// has been recorded — never before, so a network failure mid-publish can never leave the article
// half-published. On any failure the distributions row is marked 'failed' and the article is left
// exactly as it was (still 'approved'), so the operation is safely retryable.
export async function publishArticle(articleId: string): Promise<PublishResult> {
  const cfg = getWpConfig();
  if (!cfg) return { ok: false, message: "WordPress non configuré." };

  const article = await loadArticleForPublish(articleId);
  if (!article) return { ok: false, message: "Article introuvable." };
  if (!article.categoryId || !article.categoryName) {
    return { ok: false, message: "Choisissez une catégorie avant de publier." };
  }
  if (article.featuredImageUrl && !article.imageCredit) {
    return { ok: false, message: "Le crédit de l'image est obligatoire." };
  }

  const wp = new WordPressClient(cfg);
  const existingDist = await latestDistribution(articleId);

  try {
    const { categoryId, tagIds } = await resolveTaxonomy(wp, article);

    const mediaId = article.featuredImageUrl
      ? await uploadFeaturedImage(wp, article.featuredImageUrl)
      : undefined;

    const payload: WpPostPayload = {
      title: article.title,
      content: buildPostBody({
        bodyHtml: article.bodyHtml,
        sources: article.sources,
        imageCredit: article.imageCredit,
        imageSourceUrl: article.imageSourceUrl,
      }),
      excerpt: article.excerpt ?? undefined,
      status: "publish",
      categories: [categoryId],
      tags: tagIds,
      featured_media: mediaId,
    };

    const result = existingDist?.externalId
      ? await wp.updatePost(Number(existingDist.externalId), payload)
      : await wp.createPost(payload);

    await upsertDistribution(articleId, existingDist, { status: "sent", externalId: String(result.id) });
    await db
      .update(articles)
      .set({ status: "published", publishedAt: new Date(), updatedAt: new Date() })
      .where(eq(articles.id, articleId));
    await db.insert(articleRevisions).values({ articleId, action: "publié sur WordPress" });

    return { ok: true, message: "Publié sur WordPress.", postId: result.id };
  } catch (err) {
    await upsertDistribution(articleId, existingDist, { status: "failed" });
    return { ok: false, message: wpErrorMessage("La publication sur WordPress a échoué", err) };
  }
}

// Sets the WordPress post to draft and moves the article back to 'approved' (a human can
// re-publish it later — the distributions row's externalId is preserved so a subsequent
// publishArticle/republishArticle updates the SAME post rather than creating a new one).
export async function unpublishArticle(articleId: string): Promise<ActionResult> {
  const cfg = getWpConfig();
  if (!cfg) return { ok: false, message: "WordPress non configuré." };

  const existingDist = await latestDistribution(articleId);
  if (!existingDist?.externalId) {
    return { ok: false, message: "Aucune publication WordPress à dépublier." };
  }

  const wp = new WordPressClient(cfg);
  try {
    await wp.setPostStatus(Number(existingDist.externalId), "draft");
    await upsertDistribution(articleId, existingDist, { status: "sent", externalId: existingDist.externalId });
    await db.update(articles).set({ status: "approved", updatedAt: new Date() }).where(eq(articles.id, articleId));
    await db.insert(articleRevisions).values({ articleId, action: "dépublié de WordPress" });
    return { ok: true, message: "Article dépublié de WordPress." };
  } catch (err) {
    return { ok: false, message: wpErrorMessage("Le dépubliement WordPress a échoué", err) };
  }
}

// Pushes the article's current content (title/body/excerpt — rebuilt through buildPostBody, so
// an edited Sources footer/credit line is reflected) to the SAME WordPress post. The article
// stays 'published'; publishedAt is left untouched.
export async function republishArticle(articleId: string): Promise<ActionResult> {
  const cfg = getWpConfig();
  if (!cfg) return { ok: false, message: "WordPress non configuré." };

  const article = await loadArticleForPublish(articleId);
  if (!article) return { ok: false, message: "Article introuvable." };

  const existingDist = await latestDistribution(articleId);
  if (!existingDist?.externalId) {
    return { ok: false, message: "Aucune publication WordPress à republier." };
  }

  const wp = new WordPressClient(cfg);
  try {
    const content = buildPostBody({
      bodyHtml: article.bodyHtml,
      sources: article.sources,
      imageCredit: article.imageCredit,
      imageSourceUrl: article.imageSourceUrl,
    });
    const result = await wp.updatePost(Number(existingDist.externalId), {
      title: article.title,
      content,
      excerpt: article.excerpt ?? undefined,
    });
    await upsertDistribution(articleId, existingDist, { status: "sent", externalId: String(result.id) });
    await db.insert(articleRevisions).values({ articleId, action: "republié sur WordPress" });
    return { ok: true, message: "Article republié sur WordPress." };
  } catch (err) {
    return { ok: false, message: wpErrorMessage("La republication WordPress a échoué", err) };
  }
}
