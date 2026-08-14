// lib/queries/openrouter-tokens.ts — Task 6: the masked read for /settings/integrations. Plain
// query helper, NOT "use server" (same split as lib/diffusion/settings-core.ts's
// getChannelSettings / lib/queries/settings.ts): a read has no side effect to guard behind a
// Server Action network entry point, and access is gated at the page/layout level, not per query
// function — same convention as every other lib/queries/*.ts file.
//
// MaskedToken selects ONLY non-secret columns — tokenCiphertext is never named in the drizzle
// `.select({...})` projection below, so the ciphertext physically cannot appear in the returned
// shape (not caller discipline: there's nothing to omit because it was never fetched). Same idiom
// as settings-core.ts's SocialChannelSettings/omitCredentials, but stricter: that type strips the
// blob AFTER a full-row read; this one never selects it in the first place.
import { asc } from "drizzle-orm";
import { db, openrouterTokens } from "@/db";

export type MaskedToken = {
  id: string;
  label: string;
  active: boolean;
  lastStatus: string | null;
  cooldownUntil: Date | null;
  lastUsedAt: Date | null;
  sortOrder: number;
};

export async function getOpenRouterTokensMasked(): Promise<MaskedToken[]> {
  return db
    .select({
      id: openrouterTokens.id,
      label: openrouterTokens.label,
      active: openrouterTokens.active,
      lastStatus: openrouterTokens.lastStatus,
      cooldownUntil: openrouterTokens.cooldownUntil,
      lastUsedAt: openrouterTokens.lastUsedAt,
      sortOrder: openrouterTokens.sortOrder,
    })
    .from(openrouterTokens)
    .orderBy(asc(openrouterTokens.sortOrder), asc(openrouterTokens.createdAt));
}
