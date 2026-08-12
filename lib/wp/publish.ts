import {
  db, articles, articleSources, articleTags, wpCategories, wpTags, distributions, articleRevisions,
} from "@/db";
import { and, eq, desc } from "drizzle-orm";
import { getWpConfig } from "./config";
import { WordPressClient, WordPressError, type WpPostPayload } from "./client";
import { isSafePublicHttpUrl } from "@/lib/url-guard";
import { blockingGapsForArticle, MISSING_LABEL } from "@/lib/pipeline/completeness";
import { renderForArticle, type RenderStore } from "@/lib/studio";

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

// Distingue un échec du RENDU (V3 §2 — durcissement délibéré, voir buildPublishPayload) d'un échec
// de TRANSPORT WordPress (WordPressError, réseau…) : publishArticle/republishArticle renvoient le
// message français du moteur (lib/studio) TEL QUEL pour celui-ci, sans le préfixe générique
// "La publication sur WordPress a échoué :" de wpErrorMessage — ce n'est pas WordPress qui a
// échoué ici, c'est l'image qui n'a pas pu être générée, et l'éditeur doit voir directement la
// cause nommée par le moteur (V1 §3 dette assignée à V3 — voir aussi Task 4/completeness.ts).
class RenderFailedError extends Error {}

// PURE — decides, from renderForArticle's TYPED discriminator (lib/studio/index.ts,
// RenderForArticleResult["reason"]), whether a failed article_image render should fall back
// silently to the raw image ("fallback") or hard-fail the whole publish ("fail"). Revue finale V3,
// Important 1 : extraite en fonction pure et exportée précisément pour être testée contre les DEUX
// valeurs de `reason` indépendamment du texte français de `message` (tests/wp-publish-render.test.ts)
// — avant cette extraction, buildPublishPayload comparait `render.message` au texte exact
// « Stockage R2 non configuré. », si bien qu'un simple changement de copie aurait pu faire basculer
// silencieusement tout le comportement de publication (fail-open ↔ fail-closed). Même discipline que
// buildPostBody/handleTabOpen (image-panel.tsx) dans ce dépôt : la décision vit hors de la fonction
// qui l'utilise, pas dans une branche opaque au milieu d'un try/catch.
export function renderFailureOutcome(reason: "storage_unconfigured" | "render_failed"): "fallback" | "fail" {
  return reason === "storage_unconfigured" ? "fallback" : "fail";
}

// Lightweight SSRF guard for the featured-image fetch below. featuredImageUrl is article data
// (LLM-produced or editor-entered) that ends up passed straight to server-side fetch() — without
// a check, a crafted/careless value could be used to probe internal services (localhost, cloud
// metadata endpoints, RFC1918 ranges) from the server. Best-effort only (no DNS-rebinding
// protection), but cheap and matches the fail-soft contract: callers treat a rejected URL exactly
// like any other image failure. Delegates to the shared lib/url-guard.ts predicate — also used by
// testFeed (lib/actions/feed-actions.ts) — kept as a local re-export so existing imports/tests of
// `isFetchableImageUrl` from this module keep working unchanged.
export const isFetchableImageUrl = isSafePublicHttpUrl;

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

// Builds the full WordPress post payload (title/content/excerpt/status/categories/tags/
// featured_media) for an article — shared by publishArticle and republishArticle so both send the
// SAME shape: republishing re-resolves taxonomy and re-uploads the featured image, so a taxonomy
// or image correction made after the first publish propagates on the next republish, not just on
// title/body/excerpt edits.
//
// `renderStore` — injecté par les tests uniquement (même convention que renderForArticle,
// lib/studio/index.ts : `store`/`fetchImpl`/`assets` y sont tous des overrides réservés aux
// tests). Un MemoryRenderStore ou tout autre RenderStore de test permet d'exercer le VRAI rendu
// article_image sans compte R2 réel. Les vrais appelants (approveAndPublish, publishDueArticles,
// republier depuis /article) ne le fournissent jamais — production laisse renderForArticle choisir
// son R2RenderStore par défaut. Revue finale V3, Minor 3 : ignoré hors `bun test` (gate
// process.env.NODE_ENV === "test", même convention que lib/studio/images.ts:prepareImage) — sans
// ça, ce paramètre de test s'étendait à deux fonctions EXPORTÉES de production comme un simple
// positionnel, sans aucune protection contre un futur appelant de production qui le fournirait par
// erreur (même si, ce fichier n'ayant pas de directive "use server", il n'est pas RPC-accessible).
async function buildPublishPayload(
  wp: WordPressClient,
  article: ArticleForPublish,
  renderStore?: RenderStore,
): Promise<WpPostPayload> {
  const store = process.env.NODE_ENV === "test" ? renderStore : undefined;
  const { categoryId, tagIds } = await resolveTaxonomy(wp, article);

  // V3 §2 — l'image réellement PUBLIÉE est désormais celle GÉNÉRÉE par le gabarit article_image
  // (résolu pour la catégorie de l'article), produite ICI, au moment de publier — pas pendant le
  // pipeline normal : « les images ne sont pas générées pendant le pipeline normal ; elles le sont
  // au moment où on approuve et publie » (demande utilisateur, design §Objectif).
  // articles.featuredImageUrl n'est JAMAIS réécrit, ni ici ni ailleurs : il reste la trace de
  // l'image d'origine (crédit, lien source), et c'est ce dont le gabarit repart à CHAQUE rendu (le
  // cache par inputHash de V1 s'en charge — un rendu identique ne relance jamais renderScene).
  let featuredImageUrl = article.featuredImageUrl;
  // Chantier D, Tâche 6 — "website_featured" (lib/studio/formats.ts) est LE format cible de l'image
  // à la une : un gabarit article_image résolu dont le canevas natif diffère (ex. repris d'un autre
  // format, ou le gabarit par défaut du contexte) est désormais RELAYOUTÉ (relayoutToFormat, T2)
  // avant rendu, au lieu d'être téléversé à ses dimensions d'origine quelles qu'elles soient.
  const render = await renderForArticle(article.id, { context: "article_image", store, format: "website_featured" });
  if (render.ok) {
    // { ok: true, url } : un rendu a été produit — c'est CETTE url qui sera téléversée ci-dessous,
    // à la place de l'image brute. { ok: true, url: null } : aucun gabarit résolu pour ce
    // contexte/cette catégorie — cas normal, pas une erreur (spec §2 point 2) ; featuredImageUrl
    // garde sa valeur d'origine, comportement inchangé depuis avant V3.
    if (render.url) featuredImageUrl = render.url;
  } else if (renderFailureOutcome(render.reason) === "fail") {
    // DURCISSEMENT délibéré (V3 §2 point 3), à bien distinguer de uploadFeaturedImage ci-dessous
    // qui reste FAIL-SOFT : une fois un gabarit article_image configuré, l'image générée EST
    // l'illustration de l'article, et publier sans elle produirait un article visiblement cassé
    // sur le site public — contrairement à l'image brute injoignable d'aujourd'hui, que
    // uploadFeaturedImage avale silencieusement. Un échec clair et réessayable (l'article reste
    // `approved`, voir publishArticle/republishArticle) vaut mieux : on fait échouer toute la
    // publication ici, avec le message français du moteur (lib/studio), TEL QUEL — voir
    // RenderFailedError plus haut.
    throw new RenderFailedError(render.message);
  } else {
    // Seule exception au durcissement ci-dessus : le stockage R2 n'est pas configuré DU TOUT
    // (render.reason === "storage_unconfigured", PAS une comparaison sur render.message — revue
    // finale V3, Important 1 : voir renderFailureOutcome ci-dessus). C'est un réglage d'OPÉRATEUR
    // (le studio visuel n'est pas activé), pas un échec par article — le tableau d'erreurs du
    // design (§4) ne liste d'ailleurs cette situation que côté onglet Aperçu, jamais côté
    // Publication. Tant que R2 n'est pas configuré, aucun gabarit n'a jamais pu être prévisualisé
    // ni validé non plus, donc rien à durcir : on retombe sur l'image brute, exactement comme avant
    // V3 — c'est le chemin qu'exercent tests/wp-publish.test.ts et tests/publish-due.test.ts (aucun
    // des deux ne configure R2 ni n'injecte de renderStore).
    //
    // Ce repli n'était auparavant TRACÉ NULLE PART (revue finale V3, Important 1) : un opérateur
    // ayant configuré des gabarits puis perdu ses identifiants R2 (variables effacées, pas
    // seulement invalidées) voyait chaque publication réussir avec l'image brute, sans le moindre
    // indice que le rendu avait été court-circuité. Ce log est cette trace — même politique que
    // renderForArticle (lib/studio/index.ts), qui logue déjà tout échec de rendu franc.
    console.error(
      `[wp/publish] Stockage R2 non configuré — repli sur l'image brute pour l'article ${article.id} ` +
      "(contrôle de stockage échoué avant toute tentative de rendu article_image).",
    );
  }

  const mediaId = featuredImageUrl
    ? await uploadFeaturedImage(wp, featuredImageUrl)
    : undefined;

  return {
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
}

// Fail-soft featured image: downloads the article's featuredImageUrl and uploads it to WordPress
// media. ANY failure (network, non-2xx, upload rejected) is swallowed here — the caller publishes
// the post without featured_media rather than blocking the whole publish over a bad image.
async function uploadFeaturedImage(wp: WordPressClient, featuredImageUrl: string): Promise<number | undefined> {
  try {
    if (!isFetchableImageUrl(featuredImageUrl)) throw new Error("URL d'image non autorisée");
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
// exactly as it was (still 'approved'), so the operation is safely retryable — this now covers a
// failing article_image render (V3 §2) exactly like a genuine WordPress transport failure.
//
// `renderStore` — voir le commentaire de buildPublishPayload : injecté par les tests uniquement.
export async function publishArticle(
  articleId: string,
  actorId?: string | null,
  renderStore?: RenderStore,
): Promise<PublishResult> {
  const cfg = getWpConfig();
  if (!cfg) return { ok: false, message: "WordPress non configuré." };

  const article = await loadArticleForPublish(articleId);
  if (!article) return { ok: false, message: "Article introuvable." };

  // Garde de complétude unique — l'ensemble bloquant est DÉRIVÉ des colonnes réelles de
  // l'article (et non lu dans articles.missing_fields) pour deux raisons : les articles
  // antérieurs à la migration ont une colonne vide et y échapperaient ; et un article corrigé
  // à la main voit ses colonnes changer immédiatement, sans attendre un recalcul. Les deux
  // chemins partagent lib/pipeline/completeness.ts, donc l'affichage dans /queue et le refus
  // ici ne peuvent pas diverger.
  const gaps = blockingGapsForArticle({
    categoryId: article.categoryId,
    categoryName: article.categoryName,
    featuredImageUrl: article.featuredImageUrl,
    imageCredit: article.imageCredit,
    imageSourceUrl: article.imageSourceUrl,
    sourceCount: article.sources.length,
  });
  if (gaps.length > 0) {
    return {
      ok: false,
      message: `Informations manquantes : ${gaps.map((g) => MISSING_LABEL[g]).join(", ")}.`,
    };
  }

  const wp = new WordPressClient(cfg);
  const existingDist = await latestDistribution(articleId);

  try {
    const payload = await buildPublishPayload(wp, article, renderStore);

    const result = existingDist?.externalId
      ? await wp.updatePost(Number(existingDist.externalId), payload)
      : await wp.createPost(payload);

    await upsertDistribution(articleId, existingDist, { status: "sent", externalId: String(result.id) });
    // scheduledAt is cleared here — ONLY on a successful publish — so the schedule is "consumed":
    // a taken-down (unpublished) article can never be auto-re-published by publishDueArticles off
    // a stale past scheduledAt. A FAILED publish must NOT clear it (see the catch block below),
    // otherwise a still-approved article that failed to publish would silently lose its retry.
    await db
      .update(articles)
      .set({ status: "published", publishedAt: new Date(), scheduledAt: null, updatedAt: new Date() })
      .where(eq(articles.id, articleId));
    await db.insert(articleRevisions).values({ articleId, actorId: actorId ?? null, action: "publié sur WordPress" });

    return { ok: true, message: "Publié sur WordPress.", postId: result.id };
  } catch (err) {
    await upsertDistribution(articleId, existingDist, { status: "failed" });
    // Un RenderFailedError porte déjà le message français du moteur (lib/studio) — le renvoyer TEL
    // QUEL, sans le préfixe générique de wpErrorMessage réservé aux vraies erreurs de transport WP
    // (voir le commentaire de RenderFailedError plus haut).
    const message = err instanceof RenderFailedError
      ? err.message
      : wpErrorMessage("La publication sur WordPress a échoué", err);
    return { ok: false, message };
  }
}

// Sets the WordPress post to draft and moves the article back to 'approved' (a human can
// re-publish it later — the distributions row's externalId is preserved so a subsequent
// publishArticle/republishArticle updates the SAME post rather than creating a new one).
export async function unpublishArticle(articleId: string, actorId?: string | null): Promise<ActionResult> {
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
    // Belt-and-suspenders alongside the clear-on-publish-success above: even if scheduledAt were
    // somehow still set at this point, a take-down must never leave a past schedule in place for
    // publishDueArticles to pick back up and auto-republish.
    await db.update(articles).set({ status: "approved", scheduledAt: null, updatedAt: new Date() }).where(eq(articles.id, articleId));
    await db.insert(articleRevisions).values({ articleId, actorId: actorId ?? null, action: "dépublié de WordPress" });
    return { ok: true, message: "Article dépublié de WordPress." };
  } catch (err) {
    return { ok: false, message: wpErrorMessage("La dépublication WordPress a échoué", err) };
  }
}

// Pushes the article's current full payload (title/body/excerpt rebuilt through buildPostBody,
// PLUS re-resolved category/tags and a re-uploaded featured image — same shape as publishArticle,
// via the shared buildPublishPayload helper) to the SAME WordPress post. Since the user chose the
// full republish lifecycle rather than a raw content PATCH, this lets a taxonomy or featured-image
// correction made after the first publish propagate on republish too. The article stays
// 'published'; publishedAt is left untouched — which also means the article_image render's
// inputHash is stable across republishes, so a republish right after the original publish is a
// cache hit (V1's inputHash cache), not a second render (spec V3 §5).
//
// `renderStore` — voir le commentaire de buildPublishPayload : injecté par les tests uniquement.
export async function republishArticle(
  articleId: string,
  actorId?: string | null,
  renderStore?: RenderStore,
): Promise<ActionResult> {
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
    const payload = await buildPublishPayload(wp, article, renderStore);
    const result = await wp.updatePost(Number(existingDist.externalId), payload);
    await upsertDistribution(articleId, existingDist, { status: "sent", externalId: String(result.id) });
    await db.insert(articleRevisions).values({ articleId, actorId: actorId ?? null, action: "republié sur WordPress" });
    return { ok: true, message: "Article republié sur WordPress." };
  } catch (err) {
    const message = err instanceof RenderFailedError
      ? err.message
      : wpErrorMessage("La republication WordPress a échoué", err);
    return { ok: false, message };
  }
}
