import { describe, it, expect } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RenderMode, type RenderModeProps } from "@/components/studio/render-mode";
import { parseScene, type Scene } from "@/lib/studio/scene";
import { FORMAT_KEYS, type FormatKey } from "@/lib/studio/formats";
import type { PreservedView } from "@/lib/studio/studio-mode";

// tests/studio-render-mode.test.ts — Tâche 5 (U1, spec §5) : le mode « Rendu réel ».
//
// react-dom/server (renderToStaticMarkup), PAS de DOM — même convention que tests/studio-marque-
// panel.test.ts / studio-texte-panel.test.ts / studio-elements-panel.test.ts (précédents cités par
// le brief). RenderMode compose un vrai <PreviewPane> (état interne "idle" tant qu'aucun effet n'a
// tourné — react-dom/server n'en exécute AUCUN) et sept <FilmstripThumb> (idem) : ce fichier ne
// vérifie donc QUE ce qui est déjà vrai au premier rendu, avant tout aller-retour réseau — c'est
// pour ça que `initialDegraded`/`initialStale` existent (même amorce de test que
// ManualGenerate.initialContext, components/studio/manual-generate.tsx), PAS pour simuler du réseau.
//
// Défauts corrigés par rapport au brief (voir le rapport de la Tâche 5) :
//   - `data-testid="studio-rail"` (pseudo-code du brief) n'existe NULLE PART dans le vrai code —
//     le vrai composant (components/studio/rail.tsx) pose `data-testid="editor-rail"`. Un test qui
//     chercherait "studio-rail" passerait TOUJOURS, même si le rail était accidentellement rendu en
//     mode Rendu réel — un test vide de sens. Corrigé ci-dessous vers le VRAI testid.
//   - `countFilmstripThumbs`/`largeSlotFormat` n'étaient jamais définies dans le brief — écrites ici
//     avec des extractions ANCRÉES sur les vrais attributs (data-testid="filmstrip-thumb"
//     data-format="…", data-testid="render-large" data-format="…"), jamais une recherche de
//     sous-chaîne naïve (leçon de la Tâche 4 : un `className` contenant "disabled:" ferait un faux
//     positif à une recherche `.toContain("disabled")` — même piège pour "data-format" s'il fallait
//     le chercher sans ancre).
//   - Le test de provenance du brief (`toMatch(/valeurs d'exemple|article/i)` sur TOUT le HTML)
//     passerait pour n'importe quel texte contenant le mot « article » n'importe où — remplacé par
//     une assertion sur le contenu du nœud `data-testid="render-provenance"` PRÉCISÉMENT.
//   - Le test « stale »/« degraded » du brief n'exerçait qu'UN SEUL état (`stale: true` /
//     `degraded: true`) — un composant qui afficherait TOUJOURS le badge (ignorant la prop)
//     passerait quand même. Ajouté : le cas `false` correspondant, pour prouver que la légende suit
//     RÉELLEMENT la prop plutôt que d'être un texte figé dans le JSX.

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

function fixtureProps(overrides?: Partial<RenderModeProps>): RenderModeProps {
  const view: PreservedView = { selectedId: null, zoom: "fit", scrollX: 0, scrollY: 0 };
  return {
    templateId: "11111111-1111-1111-1111-111111111111",
    context: "social_post",
    scene: fixtureScene(),
    format: "ig_portrait",
    articles: [],
    disabled: false,
    view,
    onViewChange: () => {},
    ...overrides,
  };
}

function render(props: RenderModeProps): string {
  return renderToStaticMarkup(React.createElement(RenderMode, props));
}

function largeSlotFormat(html: string): string | null {
  return /data-testid="render-large" data-format="([a-z_]+)"/.exec(html)?.[1] ?? null;
}

function filmstripFormats(html: string): string[] {
  return [...html.matchAll(/data-testid="filmstrip-thumb" data-format="([a-z_]+)"/g)].map((m) => m[1]!);
}

function provenanceText(html: string): string {
  const m = /data-testid="render-provenance"[^>]*>([^<]*)</.exec(html);
  if (!m) throw new Error("data-testid=\"render-provenance\" introuvable dans le HTML rendu");
  // react-dom/server échappe l'apostrophe en entité HTML (&#x27;) — décodée ici pour que les
  // expressions régulières du test restent lisibles avec de VRAIES apostrophes françaises.
  return m[1]!.replace(/&#x27;/g, "'");
}

// ─────────────────────────────────────────────────────────────────────────────
describe("RenderMode — aucun chrome d'édition (spec §5 : « hides the rail, the panel and the properties rail entirely »)", () => {
  it("ne rend ni le rail, ni le panneau accosté, ni le panneau de propriétés, ni la liste de calques", () => {
    const html = render(fixtureProps());
    expect(html).not.toContain('data-testid="editor-rail"'); // le VRAI testid (rail.tsx) — pas "studio-rail"
    expect(html).not.toContain('data-testid="panel-host"');
    expect(html).not.toContain('data-testid="property-panel"');
    expect(html).not.toContain('data-testid="layer-panel"');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("RenderMode — le format courant en grand, les sept autres en bande (spec §5)", () => {
  it("la case large porte le format demandé, et la bande contient EXACTEMENT les sept autres (identités, pas seulement le compte)", () => {
    const html = render(fixtureProps({ format: "ig_portrait" }));
    expect(largeSlotFormat(html)).toBe("ig_portrait");

    const thumbs = filmstripFormats(html);
    expect(thumbs).toHaveLength(7);
    // Témoin de sabotage (brief) : un composant qui rendrait sept vignettes IDENTIQUES (toujours le
    // même format) passerait un test qui ne compte QUE la longueur. Comparé ici à l'ENSEMBLE réel
    // FORMAT_KEYS \ { format }, trié pour ignorer l'ordre.
    const expected = FORMAT_KEYS.filter((k) => k !== "ig_portrait");
    expect([...thumbs].sort()).toEqual([...expected].sort());
    expect(thumbs).not.toContain("ig_portrait"); // le format promu ne s'auto-liste pas dans sa propre bande
  });

  it("change de format natif -> la case large ET l'ensemble de la bande suivent (pas de valeur figée)", () => {
    const html = render(fixtureProps({ format: "story", scene: { ...fixtureScene(), canvas: { width: 1080, height: 1920, background: "#101010" } } }));
    expect(largeSlotFormat(html)).toBe("story");
    expect(filmstripFormats(html)).not.toContain("story");
    expect(filmstripFormats(html)).toContain("ig_portrait"); // repasse dans la bande puisqu'il n'est plus promu
  });

  it("un format PROMU via view.selectedId prend la case large, et le format natif réapparaît dans la bande", () => {
    const promoted: FormatKey = "wa_square";
    const html = render(fixtureProps({ format: "ig_portrait", view: { selectedId: promoted, zoom: "fit", scrollX: 0, scrollY: 0 } }));
    expect(largeSlotFormat(html)).toBe("wa_square");
    const thumbs = filmstripFormats(html);
    expect(thumbs).not.toContain("wa_square");
    expect(thumbs).toContain("ig_portrait");
    expect(thumbs).toHaveLength(7);
  });

  it("une valeur de view.selectedId qui n'est PAS un format connu retombe sur le format natif, sans planter", () => {
    const html = render(fixtureProps({ view: { selectedId: "un-id-de-calque-quelconque", zoom: "fit", scrollX: 0, scrollY: 0 } }));
    expect(largeSlotFormat(html)).toBe("ig_portrait");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("RenderMode — provenance affichée (spec §5 : « sample values or a chosen article »)", () => {
  it("contexte sans article éligible (recap_card) : énonce « valeurs d'exemple »", () => {
    const html = render(fixtureProps({ context: "recap_card", articles: [] }));
    expect(provenanceText(html)).toMatch(/valeurs d'exemple/i);
  });

  it("contexte éligible (social_post) SANS article fourni : énonce aussi « valeurs d'exemple », pas « article »", () => {
    const html = render(fixtureProps({ context: "social_post", articles: [] }));
    expect(provenanceText(html)).toMatch(/valeurs d'exemple/i);
    expect(provenanceText(html)).not.toMatch(/article choisi/i);
  });

  it("contexte éligible (social_post) AVEC des articles fournis : mentionne explicitement l'article, en plus des valeurs d'exemple", () => {
    const html = render(fixtureProps({
      context: "social_post",
      articles: [{ id: "a1", title: "Un article de test" }],
    }));
    expect(provenanceText(html)).toMatch(/valeurs d'exemple/i);
    expect(provenanceText(html)).toMatch(/article/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("RenderMode — badge « Périmé » + « ↻ rendre » (spec §5 : le rendu est asynchrone)", () => {
  it("stale=false (défaut) : ni badge ni bouton — la légende SUIT la prop, elle n'est pas figée dans le JSX", () => {
    const html = render(fixtureProps({ initialStale: false }));
    expect(html).not.toContain('data-testid="render-stale-badge"');
    expect(html).not.toMatch(/rendre/i);
  });

  it("stale=true : badge « Périmé » et bouton « ↻ rendre » présents", () => {
    const html = render(fixtureProps({ initialStale: true }));
    expect(html).toContain('data-testid="render-stale-badge"');
    expect(html).toMatch(/périmé/i);
    expect(html).toMatch(/rendre/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("RenderMode — drapeau `degraded` du moteur surfacé (spec §5 : « invisible in the UI » avant cette tâche)", () => {
  it("degraded=false (défaut) : aucune mention de police repliée", () => {
    const html = render(fixtureProps({ initialDegraded: false }));
    expect(html).not.toContain('data-testid="render-degraded-badge"');
    expect(html).not.toMatch(/police/i);
  });

  it("degraded=true : un message français mentionnant la police apparaît", () => {
    const html = render(fixtureProps({ initialDegraded: true }));
    expect(html).toContain('data-testid="render-degraded-badge"');
    expect(html).toMatch(/police/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("RenderMode — aucune affordance de réagencement (limite honnête, spec §5 fin : U5 n'existe pas encore)", () => {
  it("n'offre ni « adapter » ni « réagencer », dans AUCUN état (normal, périmé, dégradé)", () => {
    for (const overrides of [{}, { initialStale: true }, { initialDegraded: true }, { disabled: true }]) {
      const html = render(fixtureProps(overrides));
      expect(html).not.toMatch(/adapter|ré-?agencer/i);
    }
  });
});
