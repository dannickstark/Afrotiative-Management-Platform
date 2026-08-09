import { describe, it, expect } from "bun:test";

// V3 (Tâche 1) : nul code applicatif n'importait lib/studio avant que V3 ajoute
// previewArticleImage (lib/actions/article-preview-actions.ts) — le PREMIER module "use server" à
// tirer lib/studio/render.ts (donc sharp / @resvg/resvg-js / satori) dans le graphe d'une VRAIE
// Server Action bundlée par Turbopack. Ce test importe exactement le même chemin — le barrel public
// "@/lib/studio" (voir son propre commentaire : « API publique de V1. V3 (onglet Aperçu) et D1
// (panneau Diffusion) n'appellent que ceci. ») — que previewArticleImage.
//
// Ce que ce test NE PROUVE PAS : que Turbopack sait bundler cette chaîne. `bun test` exécute ce
// fichier nativement via le module loader de Bun, jamais à travers le bundler Server Actions de
// Next — exactement pourquoi le 500 de production sur @resvg/resvg-js (V2, Tâche 10) n'avait
// déclenché AUCUN échec `bun test`, seulement une vérification en navigateur réel. La preuve réelle
// est `bun run build` (voir next.config.ts et le rapport de tâche) ; ce test n'est qu'un garde-fou
// bon marché contre une régression bien plus bête — un export renommé, cassé, ou un cycle
// d'imports silencieux dans lib/studio/index.ts qui laisserait renderForArticle à `undefined`.
describe("import chain — lib/studio depuis une Server Action", () => {
  it("le barrel public charge et expose renderForArticle comme fonction", async () => {
    const mod = await import("@/lib/studio");
    expect(typeof mod.renderForArticle).toBe("function");
  });
});
