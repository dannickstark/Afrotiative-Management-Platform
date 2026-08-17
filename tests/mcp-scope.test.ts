import { describe, it, expect } from "bun:test";
import { TOOL_REGISTRY } from "@/lib/mcp/registry";
import { refusPourPortee, FULL_SCOPE, type McpScope } from "@/lib/mcp/scope";

const LECTURE_SEULE: McpScope = { canWrite: false, canReadArticles: true };
const SANS_ARTICLES: McpScope = { canWrite: true, canReadArticles: false };
const RIEN: McpScope = { canWrite: false, canReadArticles: false };

describe("domaine des outils", () => {
  // Sans cette assertion, un futur outil pourrait recevoir "video" par distraction et échapper à
  // l'axe articles sans que rien ne le signale.
  it("chaque outil du registre déclare un domaine connu", () => {
    for (const spec of TOOL_REGISTRY) {
      expect(["video", "article"]).toContain(spec.domain);
    }
  });

  it("seuls list_articles et get_article relèvent du domaine article", () => {
    const article = TOOL_REGISTRY.filter((t) => t.domain === "article").map((t) => t.name).sort();
    expect(article).toEqual(["get_article", "list_articles"]);
  });
});

describe("refusPourPortee", () => {
  it("une portée complète ne refuse aucun outil", () => {
    for (const spec of TOOL_REGISTRY) {
      expect(refusPourPortee(spec, FULL_SCOPE)).toBeNull();
    }
  });

  // Assertions écrites en ITÉRANT le registre : une liste de noms recopiée cesserait silencieusement
  // de tout couvrir au prochain outil ajouté.
  it("sans écriture, tous les outils d'écriture sont refusés et aucune lecture ne l'est", () => {
    for (const spec of TOOL_REGISTRY) {
      const refus = refusPourPortee(spec, LECTURE_SEULE);
      if (spec.kind === "ecriture") expect(refus).toBe("Ce jeton est en lecture seule. Créez un jeton avec l'écriture pour cette action.");
      else expect(refus).toBeNull();
    }
  });

  it("sans accès aux articles, seuls les outils du domaine article sont refusés", () => {
    for (const spec of TOOL_REGISTRY) {
      const refus = refusPourPortee(spec, SANS_ARTICLES);
      if (spec.domain === "article") expect(refus).toBe("Ce jeton n'a pas accès aux articles.");
      else expect(refus).toBeNull();
    }
  });

  it("portée vide : un seul message, celui de l'axe le plus spécifique", () => {
    // `get_article` est en lecture ET dans le domaine article : seul l'axe articles s'applique.
    const getArticle = TOOL_REGISTRY.find((t) => t.name === "get_article")!;
    expect(refusPourPortee(getArticle, RIEN)).toBe("Ce jeton n'a pas accès aux articles.");
    // Un outil d'écriture du domaine vidéo ne peut être refusé que par l'axe écriture.
    const createProject = TOOL_REGISTRY.find((t) => t.name === "create_video_project")!;
    expect(refusPourPortee(createProject, RIEN)).toBe("Ce jeton est en lecture seule. Créez un jeton avec l'écriture pour cette action.");
  });
});
