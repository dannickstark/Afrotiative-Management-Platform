import { describe, it, expect } from "bun:test";
import { beatKind, scriptPlatform, videoProjects, scriptBeats, scriptJournal } from "@/db/schema";

describe("schéma vidéo", () => {
  it("expose les types de beat prévus par le spec", () => {
    expect(beatKind.enumValues).toEqual([
      "narration", "question", "reponse", "insert", "broll",
      "transition", "texte_ecran", "son", "note",
    ]);
  });

  it("expose les plateformes prévues", () => {
    expect(scriptPlatform.enumValues).toEqual([
      "youtube_long", "youtube_short", "tiktok", "reel", "interview",
    ]);
  });

  it("un beat porte l'identifiant externe et l'instantané d'import", () => {
    const cols = Object.keys(scriptBeats);
    expect(cols).toContain("externalId");
    expect(cols).toContain("importedSnapshot");
    expect(cols).toContain("locallyEditedAt");
  });

  it("un projet peut être rattaché à un article, sans obligation", () => {
    expect(videoProjects.articleId.notNull).toBe(false);
  });

  it("le journal conserve le payload brut", () => {
    expect(Object.keys(scriptJournal)).toContain("rawPayload");
  });
});
