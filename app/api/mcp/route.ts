import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { authenticateMcp } from "@/lib/mcp/auth";
import { registerTools } from "@/lib/mcp/tools";

export const runtime = "nodejs";

// Sans état entre requêtes (pas de `sessionIdGenerator`) : chaque appel s'authentifie, agit et
// journalise. Rien à maintenir côté serveur — c'est aussi ce qui rendra le passage à OAuth
// (SP1 ter) indolore, la porte d'entrée étant le seul élément à changer.
async function handle(req: Request): Promise<Response> {
  const auth = await authenticateMcp(req.headers.get("authorization"));
  if (!auth.ok) {
    return Response.json({ error: auth.message }, { status: auth.status });
  }
  const server = new McpServer({ name: "afrotiative-video", version: "1.0.0" });
  registerTools(server, auth.actor);
  const transport = new WebStandardStreamableHTTPServerTransport({});
  await server.connect(transport);
  return transport.handleRequest(req);
}

export { handle as GET, handle as POST, handle as DELETE };
