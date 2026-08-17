import { describe, it, expect } from "bun:test";
import { videoSettingsSchema } from "@/lib/validation";
import { DEFAULT_BRIEF_TEMPLATE, buildBrief } from "@/lib/video/brief";
import { VIDEO_SETTINGS_KEYS } from "@/lib/queries/video-settings";

describe("videoSettingsSchema", () => {
  it("accepte des réglages plausibles", () => {
    expect(videoSettingsSchema.safeParse({ briefTemplate: "Bonjour", wordsPerMinute: 155 }).success).toBe(true);
  });

  it("refuse un modèle vide", () => {
    expect(videoSettingsSchema.safeParse({ briefTemplate: "", wordsPerMinute: 155 }).success).toBe(false);
  });

  it("refuse une cadence hors bornes", () => {
    expect(videoSettingsSchema.safeParse({ briefTemplate: "x", wordsPerMinute: 20 }).success).toBe(false);
    expect(videoSettingsSchema.safeParse({ briefTemplate: "x", wordsPerMinute: 500 }).success).toBe(false);
  });
});

describe("VIDEO_SETTINGS_KEYS", () => {
  it("les réglages vidéo exposent l'interrupteur MCP", () => {
    // Le point : sans ce champ dans la projection, l'interrupteur ne serait jamais lu et ne
    // fermerait rien — la garde de la Task 4 serait un décor.
    expect(VIDEO_SETTINGS_KEYS).toContain("mcpEnabled");
  });
});

describe("modèle par défaut", () => {
  it("produit un brief exploitable sans aucune variable inconnue", () => {
    const r = buildBrief(DEFAULT_BRIEF_TEMPLATE, {
      titre: "T", sujet: "S", plateforme: "YouTube long", duree_cible: "12 min", ratio: "16:9",
      article_titre: "", article_url: "", article_extrait: "",
    });
    expect(r.unknown).toEqual([]);
    expect(r.text).toContain("schema_version");
  });
});
