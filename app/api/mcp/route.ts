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
    // Le 401 doit annoncer les métadonnées de ressource protégée pour que la découverte OAuth
    // fonctionne (claude.ai web) — le 503 (interrupteur) et les autres statuts n'en ont pas besoin.
    const headers = auth.status === 401
      ? {
          "WWW-Authenticate": `Bearer resource_metadata="${process.env.BETTER_AUTH_URL ?? ""}/.well-known/oauth-protected-resource"`,
          "Access-Control-Expose-Headers": "WWW-Authenticate",
        }
      : undefined;
    return Response.json({ error: auth.message }, { status: auth.status, headers });
  }
  const server = new McpServer({ name: "afrotiative-video", version: "1.0.0" });
  registerTools(server, auth.actor);
  const transport = new WebStandardStreamableHTTPServerTransport({});

  // Serveur et transport sont créés PAR REQUÊTE : sans fermeture, chaque appel laisserait derrière
  // lui un serveur relié à un transport vivant, une fuite proportionnelle au trafic.
  let ferme = false;
  const fermer = async () => {
    if (ferme) return;
    ferme = true;
    await transport.close();
    await server.close();
  };

  let response: Response;
  try {
    await server.connect(transport);
    response = await transport.handleRequest(req);
  } catch (e) {
    await fermer();
    throw e;
  }

  // `handleRequest` rend sa réponse AVANT que le corps ne soit écrit : la charge utile arrive par un
  // flux SSE que le transport alimente ensuite. Fermer ici, tout de suite, tronquerait donc la
  // réponse au lieu de simplement libérer — la fermeture est accrochée à la FIN du flux (`flush`),
  // et à son abandon si le client raccroche. Une réponse sans corps (202, 200 vide) n'a
  // rien à attendre.
  if (!response.body) {
    await fermer();
    return response;
  }

  // `flush` couvre la fin normale du flux ; le `catch` couvre son abandon (client qui raccroche),
  // qui fait échouer le `pipeTo` sans jamais atteindre `flush`.
  // `.catch(() => {})` sur chaque fermeture : un `close()` qui lèverait deviendrait sinon une
  // rejection non gérée, dans un chemin où plus personne n'attend la promesse.
  const relais = new TransformStream({ flush: () => { void fermer().catch(() => {}); } });
  void response.body.pipeTo(relais.writable).catch(() => { void fermer().catch(() => {}); });
  return new Response(relais.readable, {
    status: response.status, statusText: response.statusText, headers: response.headers,
  });
}

export { handle as GET, handle as POST, handle as DELETE };
