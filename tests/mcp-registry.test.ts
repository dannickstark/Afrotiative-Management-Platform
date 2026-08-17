import { describe, it, expect } from "bun:test";
import { TOOL_REGISTRY, toolByName } from "@/lib/mcp/registry";

const EXPECTED = [
  "list_video_projects", "get_script", "get_video_brief", "list_articles", "get_article",
  "list_video_categories",
  "create_video_project", "submit_script", "apply_script",
  "update_beat", "reorder_beats", "update_insert",
];

describe("registre d'outils MCP", () => {
  it("expose exactement les outils prévus par le spec", () => {
    expect(TOOL_REGISTRY.map((t) => t.name).sort()).toEqual([...EXPECTED].sort());
  });

  it("n'expose PAS l'annulation — seul un humain revient en arrière", () => {
    expect(toolByName("revert_journal_entry")).toBeUndefined();
    expect(TOOL_REGISTRY.some((t) => t.name.includes("revert"))).toBe(false);
  });

  it("n'expose aucun outil touchant aux réglages", () => {
    expect(TOOL_REGISTRY.some((t) => /setting|reglage|token|jeton/i.test(t.name))).toBe(false);
  });

  it("classe chaque outil en lecture ou en écriture", () => {
    for (const t of TOOL_REGISTRY) expect(["lecture", "ecriture"]).toContain(t.kind);
  });

  it("les six outils de lecture sont bien classés en lecture", () => {
    const lecture = TOOL_REGISTRY.filter((t) => t.kind === "lecture").map((t) => t.name).sort();
    expect(lecture).toEqual([
      "get_article", "get_script", "get_video_brief", "list_articles", "list_video_categories",
      "list_video_projects",
    ]);
  });

  it("chaque outil porte une description en français, utile et non vide", () => {
    for (const t of TOOL_REGISTRY) {
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.description).not.toMatch(/^[A-Z][a-z]+ the /); // pas d'anglais laissé passer
    }
  });

  it("chaque nom est unique", () => {
    expect(new Set(TOOL_REGISTRY.map((t) => t.name)).size).toBe(TOOL_REGISTRY.length);
  });

  it("chaque outil a un schéma d'entrée", () => {
    for (const t of TOOL_REGISTRY) expect(typeof t.inputSchema).toBe("object");
  });

  it("toolByName retrouve un outil et rejette l'inconnu", () => {
    expect(toolByName("submit_script")?.kind).toBe("ecriture");
    expect(toolByName("inexistant")).toBeUndefined();
  });
});
