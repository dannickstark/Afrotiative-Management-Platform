import { describe, it, expect } from "bun:test";
import { SETTINGS_CHILDREN } from "@/components/shell/nav-items";
import { SETTINGS_ICON } from "@/components/settings/settings-nav";

// Round de correction (Task 6/7) : `8aded41` a corrigé un plantage réel — `/settings/mcp` (Task 7)
// et `/settings/video` (Task 8, préexistant) manquaient toutes deux d'entrée dans
// SETTINGS_ICON (components/settings/settings-nav.tsx), un `Record<string, typeof Rss>` que
// TypeScript ne peut pas vérifier exhaustivement. `Icon` résolvait alors à `undefined` et
// `<Icon className="size-4" />` faisait planter TOUTE page de réglages pour tout rôle voyant
// l'onglet manquant — pas seulement l'onglet lui-même. Aucun test ne couvrait ce fichier ; c'est
// la vraie leçon du plantage, pas seulement le correctif ponctuel.
describe("SETTINGS_ICON — exhaustivité", () => {
  it("a une icône pour CHAQUE entrée de SETTINGS_CHILDREN", () => {
    for (const child of SETTINGS_CHILDREN) {
      expect(SETTINGS_ICON[child.href]).toBeDefined();
    }
  });

  it("ne pointe vers aucune route absente de SETTINGS_CHILDREN (pas d'icône morte)", () => {
    const hrefs = new Set(SETTINGS_CHILDREN.map((c) => c.href));
    for (const href of Object.keys(SETTINGS_ICON)) {
      expect(hrefs.has(href)).toBe(true);
    }
  });
});
