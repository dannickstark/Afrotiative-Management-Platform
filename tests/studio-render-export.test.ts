import { describe, it, expect } from "bun:test";
import { previewFileName, downloadAllFormats, type ExportDeps } from "@/components/studio/render/export";
import { parseScene, type Scene } from "@/lib/studio/scene";
import { FORMAT_KEYS, type FormatKey } from "@/lib/studio/formats";

function fixtureScene(): Scene {
  return parseScene({
    schemaVersion: 1,
    canvas: { width: 1080, height: 1350, background: "#101010" },
    layers: [],
  });
}

const TPL = "11111111-1111-1111-1111-111111111111";

describe("previewFileName", () => {
  it("porte le format ET ses dimensions — huit PNG du même gabarit doivent rester distinguables sans les ouvrir", () => {
    expect(previewFileName(TPL, "story")).toBe(`${TPL}-story-1080x1920.png`);
    expect(previewFileName(TPL, "fb_link")).toBe(`${TPL}-fb_link-1200x630.png`);
  });

  it("ne produit jamais deux noms identiques pour deux formats différents", () => {
    const names = new Set(FORMAT_KEYS.map((f) => previewFileName(TPL, f)));
    expect(names.size).toBe(FORMAT_KEYS.length);
  });
});

describe("downloadAllFormats", () => {
  function spyDeps(failing: FormatKey[] = []): ExportDeps & { saved: string[]; delays: number[] } {
    const saved: string[] = [];
    const delays: number[] = [];
    return {
      saved, delays,
      render: async (format) => (failing.includes(format) ? null : `data:image/png;base64,${format}`),
      save: (_dataUri, fileName) => { saved.push(fileName); },
      delay: async (ms) => { delays.push(ms); },
    };
  }

  it("télécharge un fichier par format", async () => {
    const deps = spyDeps();
    await downloadAllFormats({
      templateId: TPL, scene: fixtureScene(), nativeFormat: "ig_portrait", articleId: null,
      onProgress: () => {}, deps,
    });
    expect(deps.saved).toHaveLength(FORMAT_KEYS.length);
    expect(deps.saved).toContain(previewFileName(TPL, "story"));
  });

  it("espace les téléchargements — un navigateur qui en reçoit huit d'un coup en avale une partie", async () => {
    const deps = spyDeps();
    await downloadAllFormats({
      templateId: TPL, scene: fixtureScene(), nativeFormat: "ig_portrait", articleId: null,
      onProgress: () => {}, deps,
    });
    expect(deps.delays.length).toBeGreaterThanOrEqual(FORMAT_KEYS.length - 1);
    expect(deps.delays.every((d) => d > 0)).toBe(true);
  });

  it("rapporte une progression qui atteint réellement le total", async () => {
    const seen: Array<[number, number]> = [];
    await downloadAllFormats({
      templateId: TPL, scene: fixtureScene(), nativeFormat: "ig_portrait", articleId: null,
      onProgress: (done, total) => seen.push([done, total]), deps: spyDeps(),
    });
    expect(seen[seen.length - 1]).toEqual([FORMAT_KEYS.length, FORMAT_KEYS.length]);
  });

  it("un format qui échoue à rendre est SAUTÉ, sans interrompre les autres", async () => {
    const deps = spyDeps(["story"]);
    await downloadAllFormats({
      templateId: TPL, scene: fixtureScene(), nativeFormat: "ig_portrait", articleId: null,
      onProgress: () => {}, deps,
    });
    expect(deps.saved).toHaveLength(FORMAT_KEYS.length - 1);
    expect(deps.saved).not.toContain(previewFileName(TPL, "story"));
  });
});
