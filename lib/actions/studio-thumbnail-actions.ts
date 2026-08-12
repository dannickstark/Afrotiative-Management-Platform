"use server";
// lib/actions/studio-thumbnail-actions.ts — la SEULE porte gardée vers renderTemplateThumbnailCore.
// Tout export d'un module "use server" est une Server Action appelable SANS authentification
// propre (voir le commentaire en tête de lib/actions/taxonomy-actions.ts) : requireUser() +
// requirePermission() d'abord, toujours — même raisonnement que lib/actions/studio-preview-actions.ts
// (la vignette de galerie est une lecture seule, ressource "template" action "read", exactement
// comme l'aperçu de l'éditeur), sur un fichier séparé pour garder ce chemin de LECTURE indépendant
// du fichier d'écriture (lib/actions/studio-actions.ts) qui exige "manage"/"publish".
import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";
import { renderTemplateThumbnailCore } from "@/lib/studio/thumbnail-core";

export async function renderTemplateThumbnail(templateId: string) {
  const user = await requireUser();
  requirePermission(user.role, "template", "read");
  return renderTemplateThumbnailCore({ templateId });
}
