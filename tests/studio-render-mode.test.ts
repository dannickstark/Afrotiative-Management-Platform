import { describe, it, expect } from "bun:test";
import path from "node:path";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RenderMode, sceneForFormat, type RenderModeProps } from "@/components/studio/render-mode";
import { parseScene, type Scene } from "@/lib/studio/scene";
import { FORMAT_KEYS, type FormatKey } from "@/lib/studio/formats";
import { relayoutToFormat } from "@/lib/studio/relayout";
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

function decodeApostrophes(s: string): string {
  // react-dom/server échappe l'apostrophe en entité HTML (&#x27;) — décodée ici pour que les
  // expressions régulières du test restent lisibles avec de VRAIES apostrophes françaises.
  return s.replace(/&#x27;/g, "'");
}

function textOf(html: string, testid: string): string {
  const m = new RegExp(`data-testid="${testid}"[^>]*>([^<]*)<`).exec(html);
  if (!m) throw new Error(`data-testid="${testid}" introuvable dans le HTML rendu`);
  return decodeApostrophes(m[1]!);
}

function provenanceText(html: string): string {
  return textOf(html, "render-provenance");
}

function filmstripProvenanceText(html: string): string {
  return textOf(html, "render-filmstrip-provenance");
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
// Important 1 (revue Tâche 5) : la légende de la case large disait « valeurs d'exemple, ou
// l'article choisi… » sans jamais préciser qu'elle décrit UNIQUEMENT la case large — alors que
// FilmstripThumb (components/studio/render-mode.tsx) appelle previewTemplate SANS `articleId`,
// donc la bande entière reste TOUJOURS aux valeurs d'exemple, quel que soit l'article choisi pour
// la case large. Corrigé par une légende SÉPARÉE (`render-filmstrip-provenance`), toujours visible,
// jamais dépendante du contexte/des articles fournis — les tests ci-dessous le prouvent pour les
// DEUX familles de contexte (avec et sans sélecteur d'article dans la case large).
describe("RenderMode — la bande a sa PROPRE légende de provenance, distincte de celle de la case large (Important 1)", () => {
  it("contexte SANS sélecteur d'article (recap_card) : la bande énonce quand même sa portée (toujours des valeurs d'exemple)", () => {
    const html = render(fixtureProps({ context: "recap_card", articles: [] }));
    expect(filmstripProvenanceText(html)).toMatch(/valeurs d'exemple/i);
  });

  it("contexte AVEC sélecteur d'article ET un article fourni : la case large mentionne l'article, la bande précise qu'elle l'ignore quand même", () => {
    const html = render(fixtureProps({
      context: "social_post",
      articles: [{ id: "a1", title: "Un article de test" }],
    }));
    // La case large PEUT montrer l'article (son propre sélecteur, testé plus haut) — la bande, elle,
    // dit explicitement le contraire : c'est le fait précis que Important 1 reprochait d'omettre.
    expect(filmstripProvenanceText(html)).toMatch(/valeurs d'exemple/i);
    expect(filmstripProvenanceText(html)).toMatch(/quel que soit l'article/i);
  });

  it("la légende de la bande ne varie PAS avec showArticlePicker — témoin de sabotage : un texte identique dans les deux contextes ci-dessus", () => {
    const withoutPicker = filmstripProvenanceText(render(fixtureProps({ context: "recap_card", articles: [] })));
    const withPicker = filmstripProvenanceText(render(fixtureProps({
      context: "social_post", articles: [{ id: "a1", title: "Un article de test" }],
    })));
    expect(withoutPicker).toBe(withPicker);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Chantier D, Tâche 6 — LE PAYOFF : `sceneForFormat` appelle enfin `relayoutToFormat` (T2). Fixture
// DÉDIÉE : un gabarit natif "x_landscape" (1600×900, formats.ts) avec une bande qui s'étire sur
// presque toute la largeur (`h: "leftRight"`, marge 40px de chaque côté à l'accueil -> w:1520).
// "story" (1080×1920) est BEAUCOUP plus étroit que x_landscape (1600) : la bande doit donc y
// apparaître RÉTRÉCIE une fois relayoutée — exactement le cas du brief (« the story thumbnail's
// scene has the banner spanning the narrower width »).
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

describe("sceneForFormat (chantier D, Tâche 6) — le filmstrip appelle RÉELLEMENT relayoutToFormat, plus un simple swap de canevas", () => {
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
// §0 — le filmstrip (sceneForFormat, ci-dessus) et la génération (lib/studio/index.ts#renderForArticle,
// chantier D T6) ne doivent JAMAIS pouvoir diverger : les DEUX appellent la MÊME fonction pure
// `relayoutToFormat` (chantier D T2), jamais deux implémentations parallèles. Reprend le motif « les
// deux chemins » déjà établi ailleurs dans ce dépôt (U4) : une comparaison directe pour la partie
// testable en mémoire (filmstrip), une preuve STRUCTURELLE — pas simulée — pour la partie qui touche
// la base (génération), même style que tests/studio-preview.test.ts (« garantie structurelle »).
describe("§0 — le filmstrip et la génération relayoutent IDENTIQUEMENT (chantier D, Tâche 6)", () => {
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

// ─────────────────────────────────────────────────────────────────────────────
// Chantier D, Tâche 6 (handoff H1) — la note « texte tronqué » de FilmstripThumb, épinglée via
// l'amorce de test `initialOverflowFormats` (même convention que initialDegraded/initialStale déjà
// établie plus bas dans ce fichier) puisque react-dom/server n'exécute aucun effet (voir le
// commentaire d'en-tête de RenderModeProps.initialOverflowFormats, render-mode.tsx). Ce test épingle
// donc le CÂBLAGE (la légende suit-elle réellement la donnée par vignette ?), pas la mesure
// satori/maxLines elle-même — celle-ci reste testée bout en bout côté serveur, avec un VRAI rendu,
// dans tests/studio-preview.test.ts (previewTemplateCore + overflowingLayerIds).
describe("FilmstripThumb — la note « texte tronqué » (handoff H1) suit `initialOverflowFormats`, PAR FORMAT", () => {
  it("un format listé dans initialOverflowFormats affiche la note ; un format non listé (anti-vacuité) ne l'affiche PAS", () => {
    const html = render(fixtureProps({ format: "ig_portrait", initialOverflowFormats: ["story"] }));
    // "story" : la note est présente, épinglée à SA vignette précisément (data-format="story").
    expect(html).toMatch(/data-testid="filmstrip-overflow-badge" data-format="story"/);
    // Tous les AUTRES formats de la bande n'en portent AUCUNE — l'anti-vacuité : un composant qui
    // afficherait TOUJOURS la note (ignorant `initialOverflowFormats`) passerait la ligne du dessus
    // mais rougirait ici.
    const badgeFormats = [...html.matchAll(/data-testid="filmstrip-overflow-badge" data-format="([a-z_]+)"/g)].map((m) => m[1]!);
    expect(badgeFormats).toEqual(["story"]);
  });

  it("initialOverflowFormats absent (défaut réel de composition) : AUCUNE vignette n'affiche la note", () => {
    const html = render(fixtureProps({ format: "ig_portrait" }));
    expect(html).not.toContain('data-testid="filmstrip-overflow-badge"');
  });

  it("MUTATION (sceneForFormat ignore relayout) : si la bande cessait d'appeler relayoutToFormat, le premier test « § relayout » ci-dessus rougirait sur le cadre ATTENDU (1000, pas 1520) — vérifié manuellement (rapport de tâche), pas rejoué ici pour ne pas dupliquer le sabotage dans le fichier de production", () => {
    // Fixture témoin : re-affirme juste que la valeur non-relayoutée (1520, le cadre BRUT à
    // l'accueil) N'EST PAS ce que sceneForFormat renvoie pour "story" — la preuve directe de
    // sensibilité à la mutation vit dans le test ci-dessus (« RED->GREEN »), qui échouerait sur
    // `toBe(1000)` si `sceneForFormat` retombait sur un simple swap de canevas.
    const scene = fixtureBannerScene();
    const variant = sceneForFormat(scene, "story", "x_landscape");
    const banner = variant.layers.find((l) => l.id === "banner")!;
    expect(banner.frame.w).not.toBe(1520);
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
