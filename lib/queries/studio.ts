import { db, renderTemplates, renderTemplateVersions, wpCategories, user } from "@/db";
import { and, desc, eq } from "drizzle-orm";
import { parseScene, type Scene } from "@/lib/studio/scene";
import type { TemplateContext } from "@/lib/studio/tokens";
import type { FormatKey } from "@/lib/studio/formats";

export type TemplateRow = {
  id: string;
  name: string;
  context: TemplateContext;
  channel: string | null;
  categoryId: string | null;
  categoryName: string | null;
  format: FormatKey;
  width: number;
  height: number;
  archived: boolean;
  publishedVersion: number | null;
  hasUnpublishedChanges: boolean;
  updatedAt: Date;
};

// Comparaison structurelle, PAS une comparaison texte brute : les clés sont triées récursivement
// avant stringify, comme lib/studio/store.ts:computeInputHash. Ceinture-et-bretelles, PAS une
// protection éprouvée : dans ce dépôt, PostgreSQL canonicalise déjà l'ordre des clés jsonb au
// stockage (vérifié empiriquement dans tests/studio-rbac.test.ts, "false quand seul l'ordre des
// clés diffère…" — retirer ce tri ne fait échouer aucun test), donc ce tri ne change rien en
// pratique ICI. Il reste utile pour deux raisons : (1) une garantie contre une future migration qui
// changerait le type de colonne de `jsonb` vers `json` (qui, lui, préserve l'ordre textuel d'origine
// et ferait un vrai faux positif sans ce tri) et (2) une protection si canonicalJson() est un jour
// réutilisée sur des valeurs n'ayant jamais transité par une colonne jsonb.
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeysDeep((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

// Liste tous les gabarits (tous contextes confondus, actifs et archivés — le tri/filtrage par
// contexte et l'affichage de l'archivage sont la responsabilité de l'appelant, pas de cette
// requête). Groupée par contexte : la responsabilité du groupement vit côté rendu (page/composant),
// pas ici — cette fonction reste une simple projection.
//
// hasUnpublishedChanges est DÉRIVÉ, jamais stocké (V1 §2 / spec §3) : `render_templates` n'a
// délibérément pas de colonne `status`, un gabarit publié avec des modifications en cours étant
// l'état normal. On compare donc ici le brouillon de travail (`scene`) à l'instantané de la version
// EN VIGUEUR (`render_template_versions` à `version = publishedVersion`), jamais à la dernière
// version historique.
//
// Décision pour un gabarit JAMAIS publié (publishedVersion === null, donc aucun instantané à
// comparer) : hasUnpublishedChanges vaut true. Un gabarit qui n'a jamais été publié n'a, par
// définition, rien de public — son brouillon dans son intégralité est donc « non publié », ce qui
// est le signal utile à l'écran (le badge d'état affichera « Brouillon », mais un futur badge « X
// modifications non publiées » sur un gabarit par ailleurs publié doit rester cohérent avec ce même
// booléen plutôt que d'introduire un troisième état caché ici).
export async function listTemplates(): Promise<TemplateRow[]> {
  const rows = await db
    .select({
      id: renderTemplates.id,
      name: renderTemplates.name,
      context: renderTemplates.context,
      channel: renderTemplates.channel,
      categoryId: renderTemplates.categoryId,
      categoryName: wpCategories.name,
      format: renderTemplates.format,
      width: renderTemplates.width,
      height: renderTemplates.height,
      archived: renderTemplates.archived,
      publishedVersion: renderTemplates.publishedVersion,
      updatedAt: renderTemplates.updatedAt,
      scene: renderTemplates.scene,
      publishedScene: renderTemplateVersions.scene,
    })
    .from(renderTemplates)
    .leftJoin(wpCategories, eq(renderTemplates.categoryId, wpCategories.id))
    // Comparaison colonne-à-colonne dans le ON, pas dans le WHERE : un gabarit jamais publié
    // (publishedVersion NULL) ne matche alors AUCUNE ligne de render_template_versions (NULL = NULL
    // n'est jamais vrai en SQL), ce qui laisse publishedScene à null — exactement le signal utilisé
    // ci-dessous pour la branche "jamais publié".
    .leftJoin(
      renderTemplateVersions,
      and(
        eq(renderTemplateVersions.templateId, renderTemplates.id),
        eq(renderTemplateVersions.version, renderTemplates.publishedVersion),
      ),
    )
    .orderBy(renderTemplates.context, renderTemplates.name);

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    context: r.context as TemplateContext,
    channel: r.channel,
    categoryId: r.categoryId,
    categoryName: r.categoryName,
    format: r.format as FormatKey,
    width: r.width,
    height: r.height,
    archived: r.archived,
    publishedVersion: r.publishedVersion,
    hasUnpublishedChanges:
      r.publishedVersion === null ? true : canonicalJson(r.scene) !== canonicalJson(r.publishedScene),
    updatedAt: r.updatedAt,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Tâche 9 — données de /studio/[id] : le gabarit, son brouillon PARSÉ (jamais la valeur jsonb brute
// — parseScene() est le seul chemin de lecture d'une scène, scene.ts:parseScene), l'instantané
// PUBLIÉ le cas échéant, et l'historique complet des versions (nom de l'auteur inclus, pour
// components/studio/version-history.tsx).
export type TemplateVersionRow = {
  version: number;
  publishedAt: Date;
  publishedByName: string | null;
  // L'instantané COMPLET de cette version (PAS seulement ses métadonnées) : components/studio/
  // version-history.tsx le repasse directement à l'éditeur au clic sur *Restaurer*, pour recharger
  // le canevas côté client SANS second aller-retour serveur — restoreVersion() (Server Action) ne
  // renvoie qu'un simple { ok } et reste la SEULE écriture réelle ; ceci n'est qu'une lecture.
  scene: Scene;
};

export type TemplateEditorData = {
  id: string;
  name: string;
  context: TemplateContext;
  channel: string | null;
  categoryId: string | null;
  format: FormatKey;
  width: number;
  height: number;
  archived: boolean;
  publishedVersion: number | null;
  updatedAt: Date;
  scene: Scene;
  publishedScene: Scene | null;
  versions: TemplateVersionRow[];
};

export async function getTemplateById(id: string): Promise<TemplateEditorData | null> {
  const [row] = await db
    .select({
      id: renderTemplates.id,
      name: renderTemplates.name,
      context: renderTemplates.context,
      channel: renderTemplates.channel,
      categoryId: renderTemplates.categoryId,
      format: renderTemplates.format,
      width: renderTemplates.width,
      height: renderTemplates.height,
      archived: renderTemplates.archived,
      publishedVersion: renderTemplates.publishedVersion,
      updatedAt: renderTemplates.updatedAt,
      scene: renderTemplates.scene,
      publishedScene: renderTemplateVersions.scene,
    })
    .from(renderTemplates)
    // Même jointure colonne-à-colonne que listTemplates() ci-dessus, et pour la même raison : un
    // gabarit jamais publié (publishedVersion NULL) ne matche aucune ligne (NULL = NULL n'est
    // jamais vrai en SQL), donc publishedScene reste null — exactement le signal attendu par
        // lib/studio/scene-diff.ts:shouldShowUnpublishedBadge.
    .leftJoin(
      renderTemplateVersions,
      and(
        eq(renderTemplateVersions.templateId, renderTemplates.id),
        eq(renderTemplateVersions.version, renderTemplates.publishedVersion),
      ),
    )
    .where(eq(renderTemplates.id, id));
  if (!row) return null;

  const versionRows = await db
    .select({
      version: renderTemplateVersions.version,
      publishedAt: renderTemplateVersions.publishedAt,
      publishedByName: user.name,
      scene: renderTemplateVersions.scene,
    })
    .from(renderTemplateVersions)
    .leftJoin(user, eq(user.id, renderTemplateVersions.publishedBy))
    .where(eq(renderTemplateVersions.templateId, id))
    .orderBy(desc(renderTemplateVersions.version));

  return {
    id: row.id,
    name: row.name,
    context: row.context as TemplateContext,
    channel: row.channel,
    categoryId: row.categoryId,
    format: row.format as FormatKey,
    width: row.width,
    height: row.height,
    archived: row.archived,
    publishedVersion: row.publishedVersion,
    updatedAt: row.updatedAt,
    // Une scène lue en base est une donnée non fiable (elle a pu être écrite par une version
    // antérieure du code) — parseScene est le seul chemin de lecture, comme partout ailleurs dans
    // lib/studio/. Elle a de toute façon déjà été validée à l'écriture (template-core.ts), donc ce
    // n'est normalement jamais qu'une reconstruction du même objet, jamais un rejet.
    scene: parseScene(row.scene),
    publishedScene: row.publishedScene ? parseScene(row.publishedScene) : null,
    versions: versionRows.map((v) => ({ ...v, scene: parseScene(v.scene) })),
  };
}

// Liste courte des articles récents, pour le sélecteur d'aperçu (Tâche 10, contextes
// article_image / social_post — spec §4). Volontairement minimal : ni recherche ni pagination,
// juste de quoi prévisualiser un gabarit sur un VRAI article sans avoir à en saisir l'identifiant à
// la main. Tous statuts confondus (un rédacteur veut prévisualiser un gabarit sur SON brouillon en
// cours, pas seulement sur des articles déjà publiés).
export type PreviewArticleOption = { id: string; title: string };

export async function listArticlesForPreview(limit = 30): Promise<PreviewArticleOption[]> {
  const rows = await db.query.articles.findMany({
    columns: { id: true, title: true },
    orderBy: (a, { desc: descOrder }) => [descOrder(a.updatedAt)],
    limit,
  });
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tâche 14 — /studio/generer : sélecteur de catégorie du formulaire de saisie manuelle, même modèle
// « canal / catégorie » (portée) que le reste du studio (spec §7). Projection minimale : ce
// sélecteur n'a besoin ni de la couleur ni du slug, seulement de quoi peupler un <Select>.
export type CategoryOption = { id: string; name: string };

export async function listCategoriesForManual(): Promise<CategoryOption[]> {
  return db.select({ id: wpCategories.id, name: wpCategories.name })
    .from(wpCategories)
    .orderBy(wpCategories.name);
}
