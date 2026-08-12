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
import type { FormatKey } from "@/lib/studio/formats";

export async function previewTemplate(input: {
  templateId: string;
  /** Scène courante de l'éditeur (client) — voir lib/studio/preview-core.ts:PreviewTemplateInput.scene
   * (correctif Critique 1, revue Lot 2) : prioritaire sur le brouillon en base, revalidée par
   * previewTemplateCore comme n'importe quelle autre donnée cliente. */
  scene?: unknown;
  values?: TokenValues;
  articleId?: string | null;
  /** Chantier D, Tâche 6 (handoff H1) — voir lib/studio/preview-core.ts:PreviewTemplateInput.format. */
  format?: FormatKey;
}) {
  const user = await requireUser();
  requirePermission(user.role, "template", "read");
  return previewTemplateCore(input);
}
