import { db, apiTokens, videoProjects, videoSettings, user as userTable } from "@/db";
import { eq } from "drizzle-orm";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { generateToken } from "@/lib/mcp/token";
import { registerTools } from "@/lib/mcp/tools";
import type { McpActor } from "@/lib/mcp/auth";
import { FULL_SCOPE, type McpScope } from "@/lib/mcp/scope";
import type { Role } from "@/lib/auth";

// Harnais des tests MCP (fichier NON-test : aucun `describe` ici). Il monte un vrai serveur MCP et
// un vrai client reliés par un transport en mémoire — pas d'appel direct au callback enregistré.
// C'est délibéré : la validation d'entrée du SDK s'exécute alors dans le test EXACTEMENT comme en
// production, donc un test vert ne peut pas décrire un comportement que la route HTTP n'a pas.

export type TestActor = McpActor & { cleanup: () => Promise<void> };

// Aucun rôle du produit n'est aujourd'hui privé de `video:manage` (lib/rbac.ts : journaliste,
// éditeur et admin l'ont tous les trois). Pour éprouver réellement la garde sans toucher à la
// matrice, le porteur « sans droit » reçoit un rôle inconnu d'elle — `can()` répond false pour tout
// rôle absent, exactement comme il le fera pour un futur rôle en lecture seule.
const ROLE_SANS_DROIT = "porteur_sans_droit" as Role;

export async function makeActor(
  role: Role,
  // `scope` par défaut à `FULL_SCOPE` : les tests écrits avant la portée (Task 3) construisent leurs
  // acteurs sans jamais la mentionner, et doivent continuer à se comporter comme un jeton d'avant la
  // portée — c'est exactement ce que `FULL_SCOPE` représente (lib/mcp/scope.ts).
  opts?: { revokeVideoManage?: boolean; scope?: McpScope },
): Promise<TestActor> {
  const userId = `test-mcp-${crypto.randomUUID()}`;
  await db.insert(userTable).values({
    id: userId,
    name: "Porteur de test MCP",
    email: `${userId}@exemple.test`,
    role,
  });
  const t = generateToken();
  const [token] = await db.insert(apiTokens).values({
    userId, name: "Jeton de test MCP", prefix: t.prefix, tokenHash: t.tokenHash,
  }).returning();

  return {
    userId,
    tokenId: token.id,
    role: opts?.revokeVideoManage ? ROLE_SANS_DROIT : role,
    scope: opts?.scope ?? FULL_SCOPE,
    cleanup: async () => {
      // `api_tokens.user_id` est en cascade, mais on supprime explicitement : le nettoyage doit
      // rester lisible même si la contrainte change.
      await db.delete(apiTokens).where(eq(apiTokens.id, token.id));
      await db.delete(userTable).where(eq(userTable.id, userId));
    },
  };
}

export type TestUser = { userId: string; role: Role; cleanup: () => Promise<void> };

/**
 * Un utilisateur de test SANS jeton d'API — pour Task 6 (requêtes/actions de réglages), qui
 * s'authentifie par session (`requireUser`), pas par jeton porteur comme `makeActor` ci-dessus.
 */
export async function makeUser(role: Role): Promise<TestUser> {
  const userId = `test-mcp-settings-${crypto.randomUUID()}`;
  await db.insert(userTable).values({
    id: userId,
    name: "Porteur de test réglages MCP",
    email: `${userId}@exemple.test`,
    role,
  });
  return {
    userId,
    role,
    cleanup: async () => {
      // `video_settings` est une ligne UNIQUE ET PARTAGÉE (lib/queries/video-settings.ts) : si ce
      // porteur a basculé l'interrupteur MCP pendant le test (setMcpEnabledCore écrit
      // `updatedBy`), la ligne partagée pointe encore vers lui. Sans ce détachement, la suppression
      // de l'utilisateur ci-dessous violerait `video_settings_updated_by_user_id_fk` — pas parce que
      // le produit se comporte mal, mais parce qu'un utilisateur DE TEST est réellement supprimé en
      // fin de test, ce qu'un compte réel (banni, jamais effacé) ne subit jamais.
      await db.update(videoSettings).set({ updatedBy: null }).where(eq(videoSettings.updatedBy, userId));
      await db.delete(userTable).where(eq(userTable.id, userId));
    },
  };
}

/**
 * Invoque un outil comme le ferait un client MCP réel, et renvoie sa charge utile désérialisée.
 * Un échec d'outil (`isError`) est converti en exception : côté agent, un `isError` est bien un
 * échec d'appel, pas une valeur de retour — les tests l'attendent donc avec `rejects.toThrow()`.
 */
export async function callTool(
  actor: McpActor,
  name: string,
  args: Record<string, unknown>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const server = new McpServer({ name: "afrotiative-video", version: "1.0.0" });
  registerTools(server, actor);

  const client = new Client({ name: "test-mcp-harness", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  try {
    const result = await client.callTool({ name, arguments: args });
    const content = (result.content ?? []) as { type: string; text?: string }[];
    const text = content[0]?.text ?? "";
    if (result.isError) throw new Error(text || `L'outil « ${name} » a échoué.`);
    return text ? JSON.parse(text) : null;
  } finally {
    await client.close();
    await server.close();
  }
}

/** Supprime le projet ; les cascades emportent variantes, beats, inserts et journal. */
export async function cleanupProject(id: string | undefined | null): Promise<void> {
  if (!id) return;
  await db.delete(videoProjects).where(eq(videoProjects.id, id));
}
