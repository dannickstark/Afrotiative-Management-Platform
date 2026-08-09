"use server";
// lib/actions/studio-preview-actions.ts — la SEULE porte gardée vers previewTemplateCore. Tout
// export d'un module "use server" est une Server Action appelable SANS authentification propre
// (voir le commentaire en tête de lib/actions/taxonomy-actions.ts) : requireUser()+
// requirePermission() d'abord, toujours — même raisonnement que lib/actions/studio-actions.ts, sur
// un fichier séparé pour que l'aperçu (lecture seule, ressource "template" action "read") reste
// indépendant du fichier d'écriture qui, lui, exige "manage"/"publish".
import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";
import { previewTemplateCore } from "@/lib/studio/preview-core";
import type { TokenValues } from "@/lib/studio/values";

export async function previewTemplate(input: { templateId: string; values?: TokenValues; articleId?: string | null }) {
  const user = await requireUser();
  requirePermission(user.role, "template", "read");
  return previewTemplateCore(input);
}
