"use server";
// lib/actions/openrouter-token-actions.ts — Task 6: the SOLE guarded gate onto openrouter_tokens
// writes. Every export of a "use server" module is a Server Action callable WITHOUT its own
// authentication (see lib/actions/taxonomy-actions.ts's header comment, and
// lib/actions/diffusion-settings-actions.ts's own copy of that same warning) — that's why every
// export below starts with requireUser() + requirePermission(role, "llmTokens", "manage") before
// touching the DB, and why a decrypted token NEVER appears in any of these actions' return values
// (testOpenRouterToken decrypts server-side, uses the plaintext for exactly one fetch, and reports
// only a status string — never the token itself, in the response or in a log line).
import { revalidatePath } from "next/cache";
import { eq, desc } from "drizzle-orm";
import { db, openrouterTokens } from "@/db";
import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";
import { encryptSecret, decryptSecret, getCryptoConfig, CredentialsNotConfiguredError } from "@/lib/diffusion/crypto";
import { getPipelineConfig } from "@/lib/config/pipeline-config";

export type TokenActionResult = { ok: boolean; error?: string };

const NO_KEY_MESSAGE = "Clé de chiffrement (CREDENTIALS_ENCRYPTION_KEY) non configurée.";

// Task 6 — adds one token to the pool. Refuses (does NOT throw) when the encryption key is missing
// or malformed, same "unavailable, not a crash" contract as
// lib/diffusion/settings-core.ts's setChannelCredentialsCore. sortOrder is auto-assigned to
// (current max)+1 — a new token is appended to the end of the rotation, an admin reorders manually
// later if wanted (no reorder UI in this task).
export async function addOpenRouterToken(input: { label: string; token: string }): Promise<TokenActionResult> {
  const user = await requireUser();
  requirePermission(user.role, "llmTokens", "manage");

  const label = input.label.trim();
  const token = input.token.trim();
  if (!label) return { ok: false, error: "Le libellé est requis." };
  if (!token) return { ok: false, error: "Le jeton est requis." };

  if (!getCryptoConfig()) return { ok: false, error: NO_KEY_MESSAGE };

  let tokenCiphertext: string;
  try {
    tokenCiphertext = encryptSecret(token);
  } catch (err) {
    if (err instanceof CredentialsNotConfiguredError) return { ok: false, error: NO_KEY_MESSAGE };
    throw err;
  }

  const [last] = await db
    .select({ sortOrder: openrouterTokens.sortOrder })
    .from(openrouterTokens)
    .orderBy(desc(openrouterTokens.sortOrder))
    .limit(1);
  const sortOrder = (last?.sortOrder ?? -1) + 1;

  await db.insert(openrouterTokens).values({ label, tokenCiphertext, createdBy: user.id, sortOrder });

  revalidatePath("/settings/integrations");
  return { ok: true };
}

export async function deleteOpenRouterToken(id: string): Promise<TokenActionResult> {
  const user = await requireUser();
  requirePermission(user.role, "llmTokens", "manage");

  await db.delete(openrouterTokens).where(eq(openrouterTokens.id, id));

  revalidatePath("/settings/integrations");
  return { ok: true };
}

export async function setOpenRouterTokenActive(id: string, active: boolean): Promise<TokenActionResult> {
  const user = await requireUser();
  requirePermission(user.role, "llmTokens", "manage");

  await db.update(openrouterTokens).set({ active, updatedAt: new Date() }).where(eq(openrouterTokens.id, id));

  revalidatePath("/settings/integrations");
  return { ok: true };
}

// The "Tester" affordance — a FREE OpenRouter /models call (never a token-spending completion,
// same reasoning as lib/actions/integration-actions.ts's testIntegration), decrypting the stored
// token server-side ONLY for the duration of this one fetch. lastStatus is best-effort bookkeeping
// (mirrors lib/ai/token-pool.ts's markTokenResult): "ok" on a 2xx response, "auth_failed" on
// 401/403, "error" for anything else including a thrown network/decrypt error — this function
// never lets a decrypt/network failure escape as an unhandled rejection across the "use server"
// boundary, and never puts the token in its return value or in a log line.
export async function testOpenRouterToken(id: string): Promise<TokenActionResult> {
  const user = await requireUser();
  requirePermission(user.role, "llmTokens", "manage");

  const [row] = await db.select().from(openrouterTokens).where(eq(openrouterTokens.id, id));
  if (!row) return { ok: false, error: "Jeton introuvable." };

  let status: string;
  let result: TokenActionResult;
  try {
    const token = decryptSecret(row.tokenCiphertext);
    const cfg = getPipelineConfig();
    const baseUrl = cfg.openrouter?.baseUrl ?? "https://openrouter.ai/api/v1";
    const res = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      status = "ok";
      result = { ok: true };
    } else if (res.status === 401 || res.status === 403) {
      status = "auth_failed";
      result = { ok: false, error: "Authentification refusée par OpenRouter." };
    } else {
      status = "error";
      result = { ok: false, error: `Échec du test : HTTP ${res.status}.` };
    }
  } catch {
    status = "error";
    result = { ok: false, error: "Échec du test : erreur réseau ou déchiffrement." };
  }

  await db.update(openrouterTokens)
    .set({ lastStatus: status, lastUsedAt: new Date(), updatedAt: new Date() })
    .where(eq(openrouterTokens.id, id));

  revalidatePath("/settings/integrations");
  return result;
}
