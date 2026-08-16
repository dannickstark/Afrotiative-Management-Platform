import { describe, it, expect } from "bun:test";
import path from "node:path";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RenderMode, type RenderModeProps } from "@/components/studio/render-mode";
import { sceneForFormat } from "@/lib/studio/relayout";
import { parseScene, type Scene } from "@/lib/studio/scene";
import { FORMAT_KEYS, type FormatKey } from "@/lib/studio/formats";
import { relayoutToFormat } from "@/lib/studio/relayout";
import type { PreservedView } from "@/lib/studio/studio-mode";

// tests/studio-render-mode.test.ts — chantier D, Tâche 6 : RenderMode n'est plus qu'un ROUTEUR entre
// la planche (components/studio/render/proof-sheet.tsx) et l'inspection d'un format
// (components/studio/render/format-focus.tsx), plus une barre d'outils. react-dom/server
// (renderToStaticMarkup), PAS de DOM — même convention que le reste de cette suite.
//
// RULING 2 (revue de tâche) : deux describes de l'ancienne version restent VRAIS et porteurs après
// la refonte — ils prouvent que `sceneForFormat` délègue RÉELLEMENT à `relayoutToFormat`, et que la
// planche et la génération (lib/studio/index.ts#renderForArticle) relayoutent IDENTIQUEMENT, sans
// deuxième implémentation qui pourrait diverger. Conservés VERBATIM ci-dessous (seul le mot
// « filmstrip », qui ne désigne plus rien dans l'UI actuelle, est renommé en « planche » dans les
// titres/commentaires ; l'import de `sceneForFormat` passe de components/studio/render-mode.tsx à
// @/lib/studio/relayout, où la fonction vit désormais). Tout le reste de ce fichier est la
// réécriture de la Tâche 6.

function fixtureScene(): Scene {
  return parseScene({
    schemaVersion: 1,
    canvas: { width: 1080, height: 1350, background: "#101010" },
    layers: [
      {
        id: "title", name: "Titre", visible: true, locked: false,
        frame: { x: 40, y: 40, w: 1000, h: 100 },
        type: "text", content: "Titre de test",
        font: { family: "Noto Sans", size: 48, weight: 700 },
        color: "#FFFFFF", align: "left", vAlign: "top", lineHeight: 1.2,
      },
    ],
  });
}

function props(overrides?: Partial<RenderModeProps>): RenderModeProps {
  const view: PreservedView = { selectedId: null, zoom: "fit", scrollX: 0, scrollY: 0 };
  return {
    templateId: "11111111-1111-1111-1111-111111111111",
    context: "article_image", scene: fixtureScene(), format: "ig_portrait",
    view, onViewChange: () => {},
    ...overrides,
  };
}

const render = (p: RenderModeProps) => renderToStaticMarkup(React.createElement(RenderMode, p));

describe("RenderMode — routeur planche ⇄ inspection", () => {
  it("`selectedId: null` ouvre la PLANCHE, pas une inspection", () => {
    const html = render(props());
    expect(html).toContain('data-testid="proof-sheet"');
    expect(html).not.toContain('data-testid="format-focus"');
  });

  it("une clé de format ouvre l'inspection de CE format, et referme la planche", () => {
    const view: PreservedView = { selectedId: "story", zoom: "fit", scrollX: 0, scrollY: 0 };
    const html = render(props({ view }));
    expect(html).toMatch(/data-testid="format-focus"[^>]*data-format="story"/);
    expect(html).not.toContain('data-testid="proof-sheet"');
  });

  it("une valeur qui n'est pas un format retombe sur la planche plutôt que de faire planter le composant", () => {
    const view: PreservedView = { selectedId: "layer-42", zoom: "fit", scrollX: 0, scrollY: 0 };
    expect(render(props({ view }))).toContain('data-testid="proof-sheet"');
  });

  it("ne rend NI rail NI panneau accosté NI inspecteur — le rendu prend tout l'espace", () => {
    const html = render(props());
    expect(html).not.toContain('data-testid="editor-rail"');
    expect(html).not.toContain('data-testid="panel-host"');
  });
});

describe("RenderMode — provenance", () => {
  it("un contexte éligible AVEC articles affiche le sélecteur, qui pilote toute la planche", () => {
    const html = render(props({
      context: "article_image",
      articles: [{ id: "a1", title: "Un article" }],
    }));
    expect(html).toContain('data-testid="render-article-select"');
  });

  it("un contexte à saisie manuelle n'a pas de sélecteur mais dit d'où viennent les valeurs", () => {
    const html = render(props({ context: "quote_card", articles: [] }));
    expect(html).not.toContain('data-testid="render-article-select"');
    expect(html).toContain('data-testid="render-sample-chip"');
  });

  it("ne porte PLUS les deux paragraphes de provenance de l'ancienne version — le sélecteur pilote les huit tuiles, il n'y a plus rien à démentir", () => {
    const html = render(props({ context: "article_image", articles: [{ id: "a1", title: "Un article" }] }));
    expect(html).not.toContain("quel que soit l'article choisi");
    expect(html).not.toContain('data-testid="render-filmstrip-provenance"');
  });
});

describe("RenderMode — agrégation des alertes", () => {
  it("aucune pastille quand rien n'est signalé", () => {
    const html = render(props({
      initialOutcomes: Object.fromEntries(
        FORMAT_KEYS.map((k) => [k, { ready: true, overflow: false, lowRes: false }]),
      ) as Partial<Record<FormatKey, { ready: boolean; overflow: boolean; lowRes: boolean }>>,
    }));
    expect(html).not.toContain('data-testid="render-warning-summary"');
  });

  // Le texte de la pastille ne suit PAS immédiatement le `>` du bouton : une icône <svg> le
  // précède. Un `([^<]*)` naïf capturerait donc la chaîne vide et TOUTES les assertions
  // ci-dessous passeraient sur `expect("").toContain(…)` — non : elles échoueraient, mais
  // pour la mauvaise raison, et un `toMatch` mal ancré pourrait tout aussi bien passer à tort.
  // On extrait le contenu complet du bouton, puis on en retire les balises.
  function summaryText(html: string): string {
    const opened = html.indexOf('data-testid="render-warning-summary"');
    if (opened === -1) return "";
    const bodyStart = html.indexOf(">", opened) + 1;
    const bodyEnd = html.indexOf("</button>", bodyStart);
    return html.slice(bodyStart, bodyEnd).replace(/<[^>]*>/g, "").trim();
  }

  it("compte les formats signalés — pas les alertes, un format à deux alertes compte pour un", () => {
    const html = render(props({
      initialOutcomes: {
        story: { ready: true, overflow: true, lowRes: true },
        fb_link: { ready: true, overflow: true, lowRes: false },
      },
    }));
    expect(summaryText(html)).toMatch(/^2 formats à vérifier/);
  });

  it("se QUALIFIE tant que les huit formats ne sont pas rendus — compter une tuile jamais rendue comme saine serait un mensonge", () => {
    const html = render(props({
      initialOutcomes: {
        story: { ready: true, overflow: true, lowRes: false },
        fb_link: { ready: true, overflow: false, lowRes: false },
      },
    }));
    expect(summaryText(html)).toBe("1 format à vérifier sur 2 rendus");
  });

  it("laisse tomber la qualification une fois les huit formats rendus", () => {
    const outcomes = Object.fromEntries(
      FORMAT_KEYS.map((k) => [k, { ready: true, overflow: k === "story", lowRes: false }]),
    ) as Partial<Record<FormatKey, { ready: boolean; overflow: boolean; lowRes: boolean }>>;
    expect(summaryText(render(props({ initialOutcomes: outcomes })))).toBe("1 format à vérifier");
  });
});

describe("sceneForFormat", () => {
  it("est l'identité EXACTE au format d'accueil", () => {
    const scene = fixtureScene();
    expect(sceneForFormat(scene, "ig_portrait", "ig_portrait")).toBe(scene);
  });

  it("délègue à relayoutToFormat pour tout autre format — jamais une seconde implémentation qui pourrait diverger", () => {
    const scene = fixtureScene();
    expect(sceneForFormat(scene, "story", "ig_portrait")).toEqual(relayoutToFormat(scene, "story"));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CONSERVÉ VERBATIM (Ruling 2) — chantier D, Tâche 6 : LE PAYOFF, `sceneForFormat` appelle enfin
// `relayoutToFormat` (T2). Fixture DÉDIÉE : un gabarit natif "x_landscape" (1600×900, formats.ts)
// avec une bande qui s'étire sur presque toute la largeur (`h: "leftRight"`, marge 40px de chaque
// côté à l'accueil -> w:1520). "story" (1080×1920) est BEAUCOUP plus étroit que x_landscape (1600) :
// la bande doit donc y apparaître RÉTRÉCIE une fois relayoutée — exactement le cas du brief (« the
// story thumbnail's scene has the banner spanning the narrower width »).
function fixtureBannerScene(): Scene {
  return parseScene({
    schemaVersion: 1,
    canvas: { width: 1600, height: 900, background: "#101010" },
    layers: [
      {
        id: "banner", name: "Bandeau", visible: true, locked: false,
        frame: { x: 40, y: 40, w: 1520, h: 200 },
        constraints: { h: "leftRight", v: "top" },
        type: "shape", shape: "rect", fill: "#FF0000",
      },
    ],
  });
}

describe("sceneForFormat (chantier D, Tâche 6) — la planche appelle RÉELLEMENT relayoutToFormat, plus un simple swap de canevas", () => {
  it("RED->GREEN : pour un format DIFFÉRENT de l'accueil, la scène retournée EST relayoutToFormat(scene, key) — la bande leftRight y est plus ÉTROITE (§ story, plus étroit que x_landscape)", () => {
    const scene = fixtureBannerScene();
    const variant = sceneForFormat(scene, "story", "x_landscape");
    expect(variant).toEqual(relayoutToFormat(scene, "story"));
    // Chiffre EXACT (table de vérité leftRight, chantier D T2) : 1520 + (1080 - 1600) = 1000 — plus
    // étroit que les 1520px d'accueil. Un `sceneForFormat` qui se contenterait de swapper le canevas
    // (comportement D'AVANT cette tâche) laisserait ce cadre à 1520 inchangé : ce test rougirait.
    const banner = variant.layers.find((l) => l.id === "banner")!;
    expect(banner.frame.w).toBe(1000);
    expect(banner.frame.w).toBeLessThan(scene.layers[0]!.frame.w);
    // Le canevas de la vignette est bien celui de "story", pas celui de l'accueil.
    expect(variant.canvas).toEqual({ width: 1080, height: 1920, background: "#101010" });
  });

  it("au format d'accueil : identité EXACTE — MÊME référence de scène (raccourci documenté, mathématiquement une identité de toute façon — chantier D T2)", () => {
    const scene = fixtureBannerScene();
    expect(sceneForFormat(scene, "x_landscape", "x_landscape")).toBe(scene);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CONSERVÉ VERBATIM (Ruling 2) — §0 — la planche (sceneForFormat, ci-dessus) et la génération
// (lib/studio/index.ts#renderForArticle, chantier D T6) ne doivent JAMAIS pouvoir diverger : les
// DEUX appellent la MÊME fonction pure `relayoutToFormat` (chantier D T2), jamais deux
// implémentations parallèles. Reprend le motif « les deux chemins » déjà établi ailleurs dans ce
// dépôt (U4) : une comparaison directe pour la partie testable en mémoire (planche), une preuve
// STRUCTURELLE — pas simulée — pour la partie qui touche la base (génération), même style que
// tests/studio-preview.test.ts (« garantie structurelle »).
describe("§0 — la planche et la génération relayoutent IDENTIQUEMENT (chantier D, Tâche 6)", () => {
  it("sceneForFormat(scene, format, native) égale EXACTEMENT relayoutToFormat(scene, format) pour CHAQUE format non-natif — pas seulement « story »", () => {
    const scene = fixtureBannerScene();
    for (const key of FORMAT_KEYS.filter((k) => k !== "x_landscape")) {
      expect(sceneForFormat(scene, key, "x_landscape")).toEqual(relayoutToFormat(scene, key));
    }
  });

  it("preuve STRUCTURELLE : lib/studio/index.ts#renderForArticle (le chemin de GÉNÉRATION) importe relayoutToFormat et l'applique à `template.scene`/`o.format` AVANT rendu — pas une seconde implémentation qui pourrait diverger de sceneForFormat", () => {
    const src = readFileSync(path.resolve(import.meta.dir, "..", "lib/studio/index.ts"), "utf8");
    expect(src).toMatch(/import\s*\{\s*relayoutToFormat\s*\}\s*from\s*["']\.\/relayout["']/);
    // La ligne qui applique RÉELLEMENT le relayout au gabarit résolu, avant que `scene` n'atteigne
    // renderScene — mutation qui ferait rougir : revenir à `template.scene` nu (comportement d'avant
    // cette tâche) fait disparaître cette ligne du fichier.
    expect(src).toMatch(/relayoutToFormat\(\s*template\.scene\s*,\s*o\.format\s*\)/);
  });
});
