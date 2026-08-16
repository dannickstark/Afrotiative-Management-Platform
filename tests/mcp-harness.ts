import { db, apiTokens, videoProjects, user as userTable } from "@/db";
import { eq } from "drizzle-orm";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { generateToken } from "@/lib/mcp/token";
import { registerTools } from "@/lib/mcp/tools";
import type { McpActor } from "@/lib/mcp/auth";
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
  opts?: { revokeVideoManage?: boolean },
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
    cleanup: async () => {
      // `api_tokens.user_id` est en cascade, mais on supprime explicitement : le nettoyage doit
      // rester lisible même si la contrainte change.
      await db.delete(apiTokens).where(eq(apiTokens.id, token.id));
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
