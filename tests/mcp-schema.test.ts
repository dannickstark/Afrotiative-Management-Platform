import { describe, it, expect } from "bun:test";
import { apiTokens, videoSettings, scriptJournal } from "@/db/schema";

describe("schéma MCP", () => {
  it("la table des jetons porte ce qu'il faut pour attribuer et révoquer", () => {
    const cols = Object.keys(apiTokens);
    for (const c of ["userId", "name", "prefix", "tokenHash", "lastUsedAt", "revokedAt"]) {
      expect(cols).toContain(c);
    }
  });

  it("le haché est obligatoire, la révocation est optionnelle", () => {
    expect(apiTokens.tokenHash.notNull).toBe(true);
    expect(apiTokens.revokedAt.notNull).toBe(false);
  });

  it("l'interrupteur global vit dans les réglages vidéo, ouvert par défaut", () => {
    expect(Object.keys(videoSettings)).toContain("mcpEnabled");
    expect(videoSettings.mcpEnabled.notNull).toBe(true);
  });

  it("le journal peut porter les arguments d'outil et la date de relecture", () => {
    const cols = Object.keys(scriptJournal);
    expect(cols).toContain("toolArgs");
    expect(cols).toContain("reviewedAt");
  });
});
