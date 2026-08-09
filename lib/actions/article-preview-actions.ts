"use server";
// lib/actions/article-preview-actions.ts — la SEULE porte gardée vers renderForArticle pour
// l'onglet « Aperçu final » de la page article (V3, Tâche 2). Comme tout module "use server",
// CHAQUE export est un Server Action appelable SANS authentification propre (voir le commentaire
// en tête de lib/actions/taxonomy-actions.ts) : requireUser() + requirePermission() d'abord,
// toujours. Fichier séparé de lib/actions/article-actions.ts pour la même raison que
// studio-preview-actions.ts est séparé de studio-actions.ts : un aperçu (lecture seule) n'a pas
// vocation à cohabiter avec les actions d'écriture de l'article.
import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";
import { renderForArticle, type RenderForArticleResult } from "@/lib/studio";

// Délègue intégralement à renderForArticle et renvoie SA forme de résultat inchangée (spec V3 §1) :
// c'est le moteur (V1) qui décide des quatre états — rendu, aucun gabarit, informations manquantes,
// stockage non configuré — le rôle de cette action se limite à l'autorisation. context fixé à
// "article_image" : c'est le SEUL contexte que ce panneau montre (les aperçus par réseau social
// vivront dans le panneau Diffusion, D1 — hors portée ici, voir §Objectif/Hors portée du design).
export async function previewArticleImage(articleId: string): Promise<RenderForArticleResult> {
  const user = await requireUser();
  requirePermission(user.role, "article", "edit");
  return renderForArticle(articleId, { context: "article_image" });
}
