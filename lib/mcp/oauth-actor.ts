import type { Role } from "@/lib/auth";
import type { McpScope } from "@/lib/mcp/scope";
import type { AuthOutcome } from "@/lib/mcp/auth";

const REJECT = "Jeton d'API invalide ou révoqué.";

export function buildOauthActor(
  { session, owner, scope }: {
    session: { userId: string; clientId: string } | null;
    owner: { role: Role; banned: boolean } | null;
    scope: McpScope;
  },
): AuthOutcome {
  if (!session) return { ok: false, status: 401, message: REJECT };
  if (!owner || owner.banned) return { ok: false, status: 401, message: REJECT };
  return {
    ok: true,
    actor: { userId: session.userId, role: owner.role, tokenId: session.clientId, scope },
  };
}
