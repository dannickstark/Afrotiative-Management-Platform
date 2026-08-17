"use server";
// lib/actions/mcp-actions.ts — Task 6: le SEUL point d'entrée réseau gardé sur lib/queries/mcp.ts.
// Motif de lib/actions/openrouter-token-actions.ts : "use server" en tête, garde en tête de chaque
// export, et aucun secret dans une valeur de retour — SAUF createApiToken, dont c'est précisément
// le contrat, une seule fois (voir lib/queries/mcp.ts's createApiTokenCore).
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { can, requirePermission } from "@/lib/rbac";
import { createApiTokenCore, revokeApiTokenCore, setMcpEnabledCore } from "@/lib/queries/mcp";
import { apiTokenSchema } from "@/lib/validation";

// Voir/gérer SES PROPRES jetons demande "video:manage" (les trois rôles, journaliste compris —
// c'est lui qui écrit les scripts). `seesAll` (voir les jetons de toute l'équipe, actionner
// l'interrupteur) se calcule séparément avec "video:configure" (admin + éditeur) — jamais
// l'inverse : un porteur de "configure" a forcément "manage" (lib/rbac.ts), mais pas
// réciproquement.
async function guard() {
  const u = await requireUser();
  requirePermission(u.role, "video", "manage");
  return { user: u, seesAll: can(u.role, "video", "configure") };
}

export async function createApiToken(
  input: unknown,
): Promise<{ ok: true; tokenId: string; token: string } | { ok: false; message: string }> {
  const { user } = await guard();
  const parsed = apiTokenSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0].message };

  const { tokenId, token } = await createApiTokenCore({
    userId: user.id,
    name: parsed.data.name,
    scope: { canWrite: parsed.data.canWrite, canReadArticles: parsed.data.canReadArticles },
  });
  revalidatePath("/settings/mcp");
  return { ok: true, tokenId, token };
}

export async function revokeApiToken(tokenId: string): Promise<{ ok: boolean; message?: string }> {
  const { user, seesAll } = await guard();
  const res = await revokeApiTokenCore({ tokenId, userId: user.id, seesAll });
  if (res.ok) revalidatePath("/settings/mcp");
  return res;
}

export async function setMcpEnabled(enabled: boolean): Promise<{ ok: boolean; message?: string }> {
  const { user, seesAll } = await guard();
  // L'interrupteur est le geste d'urgence — réservé à "video:configure" (admin/éditeur), pas à
  // "video:manage" comme le reste de cette garde : sans cette distinction, un journaliste pourrait
  // couper tous les agents de l'équipe.
  if (!seesAll) return { ok: false, message: "Action réservée aux éditeurs et administrateurs." };
  await setMcpEnabledCore({ enabled, userId: user.id });
  revalidatePath("/settings/mcp");
  return { ok: true };
}
