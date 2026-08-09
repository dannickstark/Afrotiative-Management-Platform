"use server";
// lib/actions/studio-manual-actions.ts — la SEULE porte gardée vers renderManualCore. Tout export
// d'un module "use server" est une Server Action appelable SANS authentification propre (voir le
// commentaire en tête de lib/actions/taxonomy-actions.ts) : requireUser() + requirePermission()
// d'abord, toujours — même raisonnement que lib/actions/studio-actions.ts et
// lib/actions/studio-preview-actions.ts, sur un fichier séparé par cohérence avec ces deux-là (un
// fichier par « famille » d'actions studio).
//
// Gardé par "template:manage", PAS "template:read" comme previewTemplate : contrairement à l'aperçu
// (lecture seule), renderManual ÉCRIT — R2 + une ligne `renders` (spec §7) — donc c'est la même
// classe d'action que créer/publier un gabarit, pas que le consulter. Éditeur et admin ont les trois
// droits (lib/rbac.ts) ; ce choix n'élargit donc l'accès à personne de plus que "read" ne l'aurait
// fait ici, il documente juste correctement la nature de l'action pour la prochaine fois que la
// matrice RBAC change.
import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";
import { renderManualCore } from "@/lib/studio/manual-core";
import type { TokenValues } from "@/lib/studio/values";
import type { TemplateContext, Channel } from "@/lib/studio/tokens";

export async function renderManual(input: {
  context: TemplateContext;
  channel?: Channel | null;
  categoryId?: string | null;
  values: TokenValues;
}) {
  const user = await requireUser();
  requirePermission(user.role, "template", "manage");
  return renderManualCore(input);
}
