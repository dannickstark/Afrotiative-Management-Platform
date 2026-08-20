"use server";
// lib/actions/mcp-oauth-actions.ts — Task 6: server actions du formulaire de consentement OAuth
// (app/(app)/oauth/authorize). N'importe quel utilisateur connecté non banni peut autoriser
// (requireUser suffit, contrairement à mcp-actions.ts qui exige "video:manage") — c'est le
// consentement du plugin better-auth "mcp" qui protège chaque appel d'outil ensuite, en croisant
// la portée choisie ici (upsertOauthScopeCore) avec le rôle de l'utilisateur.
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireUser } from "@/lib/session";
import { upsertOauthScopeCore } from "@/lib/queries/mcp-oauth";

const approveSchema = z.object({
  clientId: z.string().min(1),
  consentCode: z.string().min(1),
  canWrite: z.boolean(),
  canReadArticles: z.boolean(),
});

export async function approveOauthConsent(
  input: { clientId: string; consentCode: string; canWrite: boolean; canReadArticles: boolean },
): Promise<{ ok: false; message: string }> {
  const u = await requireUser(); // tout utilisateur connecté non banni
  const parsed = approveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Requête de consentement invalide." };
  await upsertOauthScopeCore({
    userId: u.id,
    clientId: parsed.data.clientId,
    scope: { canWrite: parsed.data.canWrite, canReadArticles: parsed.data.canReadArticles },
  });
  const res = await auth.api.oAuthConsent({
    body: { accept: true, consent_code: parsed.data.consentCode },
    headers: await headers(),
  });
  redirect(res.redirectURI);
}

export async function denyOauthConsent(consentCode: string): Promise<{ ok: false; message: string }> {
  await requireUser();
  if (!consentCode) return { ok: false, message: "Code de consentement manquant." };
  const res = await auth.api.oAuthConsent({
    body: { accept: false, consent_code: consentCode },
    headers: await headers(),
  });
  redirect(res.redirectURI);
}
