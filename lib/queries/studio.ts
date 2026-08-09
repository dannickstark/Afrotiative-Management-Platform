import { db, renderTemplates, renderTemplateVersions, wpCategories } from "@/db";
import { and, eq } from "drizzle-orm";
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
