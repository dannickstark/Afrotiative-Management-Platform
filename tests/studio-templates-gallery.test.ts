import { describe, it, expect, mock, beforeAll, beforeEach, afterAll } from "bun:test";
import React from "react";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { db, renderTemplates, user } from "@/db";
import { eq, inArray } from "drizzle-orm";
import { deleteTemplateScope } from "./studio-fixtures";
import { installDom, mount, flush, click } from "./dom-harness";
import type { StubIntersectionObserverInstance } from "./dom-harness";
import type { Scene } from "@/lib/studio/scene";
import type { TemplateRow } from "@/lib/queries/studio";

// tests/studio-templates-gallery.test.ts — Chantier A, Tâche 5 (spec §4) : la galerie de vignettes
// rendues qui remplace le tableau-texte comme vue PAR DÉFAUT de /studio (coque admin, PAS
// l'éditeur), et sa bascule grille⇄tableau persistée. Quatre sujets, quatre describes :
//   1. renderTemplateThumbnailCore (lib/studio/thumbnail-core.ts) — le cache PROCESS, réel (base de
//      données réelle, VRAI rendu satori/resvg/sharp — même recette que tests/studio-preview.test.ts).
//   2. renderTemplateThumbnail (lib/actions/studio-thumbnail-actions.ts) — RBAC, même recette que
//      tests/studio-preview.test.ts.
//   3. TemplatesGallery (components/studio/templates-gallery.tsx) — une carte par gabarit,
//      renderToStaticMarkup (bun:test n'a pas de DOM par défaut), littéraux TemplateRow, comme
//      tests/studio-templates-table.test.ts.
//   4. GalleryThumb (la vignette PARESSEUSE de la galerie) et la bascule grille/tableau — toutes deux
//      ont besoin d'un VRAI DOM (IntersectionObserver, localStorage) : tests/dom-harness.ts.

// ─────────────────────────────────────────────────────────────────────────────
// Mock GLOBAL pour tout le fichier (jamais retoggled) : RoleGate (components/role-gate.tsx) lit
// useSession() — sans ce mock, aucun menu d'actions ni carte n'afficherait « Actions pour … » sous
// renderToStaticMarkup (pas de Provider, pas de réseau). Même recette que
// tests/studio-templates-table.test.ts.
const realAuthClient = await import("@/lib/auth-client");
mock.module("@/lib/auth-client", () => ({
  ...realAuthClient,
  useSession: () => ({ data: { user: { role: "editor" } } }),
}));

// Capturée AVANT toute autre importation qui la chargerait transitivement (templates-gallery.tsx
// importe GalleryThumb, qui importe cette action) — c'est la référence RÉELLE que le describe
// "GalleryThumb" ci-dessous restaure après avoir mocké ce module pour compter ses appels.
const realThumbnailActions = await import("@/lib/actions/studio-thumbnail-actions");

const { TemplatesGallery } = await import("@/components/studio/templates-gallery");
const { groupTemplatesByContext, CONTEXT_LABEL, formatLabel } = await import("@/components/studio/templates-shared");
const { useTemplatesView } = await import("@/hooks/use-templates-view");
const { DEFAULT_TEMPLATES_VIEW, parseTemplatesView, serializeTemplatesView } =
  await import("@/lib/studio/templates-view-pref");
const { renderTemplateThumbnailCore, clearThumbnailCache } = await import("@/lib/studio/thumbnail-core");
const { previewTemplateCore } = await import("@/lib/studio/preview-core");
const { requireUser: realRequireUser, getSession: realGetSession } = await import("@/lib/session");

afterAll(() => {
  mock.module("@/lib/auth-client", () => realAuthClient);
  mock.module("@/lib/session", () => ({ getSession: realGetSession, requireUser: realRequireUser }));
});

// ─────────────────────────────────────────────────────────────────────────────
// Portées STATIQUES possédées par ce fichier (registre tests/studio-fixtures.ts, tenu à jour) :
//   (recap_card, "test-templates-gallery-thumb-a", null)
//   (recap_card, "test-templates-gallery-thumb-b", null)
const CH_A = "test-templates-gallery-thumb-a";
const CH_B = "test-templates-gallery-thumb-b";

// Scène volontairement SANS jeton ({{…}}) et SANS calque image : aucune valeur ni aucun accès
// réseau requis pour un rendu réussi (contrairement à recapScene()/overflowScene(), tests/studio-
// preview.test.ts, qui ont besoin de SAMPLE_VALUES ou d'un serveur fixture) — un canevas volontairement
// petit (600×400) pour que chaque VRAI rendu satori/resvg/sharp de ce fichier reste rapide.
function galleryScene(text: string): Scene {
  return {
    schemaVersion: 1,
    canvas: { width: 600, height: 400, background: "#101010" },
    layers: [{
      id: "t", name: "Texte", visible: true, locked: false,
      frame: { x: 10, y: 10, w: 500, h: 100 },
      type: "text", content: text,
      font: { family: "Noto Sans", size: 32, weight: 400 },
      color: "#FFFFFF", align: "left", vAlign: "top", lineHeight: 1.2,
    }],
  } as Scene;
}

const templateIds: string[] = [];
let templateA: { id: string; name: string };
let templateB: { id: string; name: string };

beforeAll(async () => {
  await deleteTemplateScope("recap_card", CH_A, null);
  await deleteTemplateScope("recap_card", CH_B, null);

  const [rowA] = await db.insert(renderTemplates).values({
    name: "Gabarit Galerie A", context: "recap_card", channel: CH_A, categoryId: null,
    format: "ig_square", width: 600, height: 400, scene: galleryScene("Alpha"),
  }).returning({ id: renderTemplates.id, name: renderTemplates.name });
  templateA = rowA;
  templateIds.push(rowA.id);

  const [rowB] = await db.insert(renderTemplates).values({
    name: "Gabarit Galerie B", context: "recap_card", channel: CH_B, categoryId: null,
    format: "ig_square", width: 600, height: 400, scene: galleryScene("Beta"),
  }).returning({ id: renderTemplates.id, name: renderTemplates.name });
  templateB = rowB;
  templateIds.push(rowB.id);
});

afterAll(async () => {
  if (templateIds.length) await db.delete(renderTemplates).where(inArray(renderTemplates.id, templateIds));
});

// ─────────────────────────────────────────────────────────────────────────────
describe("renderTemplateThumbnailCore — cache PROCESS (Chantier A, Tâche 5)", () => {
  beforeEach(() => clearThumbnailCache());

  it("deux appels pour le MÊME gabarit : un seul rendu sous-jacent, deux résultats corrects", async () => {
    let calls = 0;
    const counting: typeof previewTemplateCore = async (input) => {
      calls++;
      return previewTemplateCore(input);
    };

    const first = await renderTemplateThumbnailCore({ templateId: templateA.id, previewImpl: counting });
    const second = await renderTemplateThumbnailCore({ templateId: templateA.id, previewImpl: counting });

    expect(calls).toBe(1); // LE cache hit : le second appel n'a PAS redéclenché previewTemplateCore.
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.dataUri.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(second.dataUri).toBe(first.dataUri); // même image, pas juste un même statut ok.
  });

  it("anti-vacuité — deux gabarits DIFFÉRENTS ne partagent PAS leur entrée de cache (pas un court-circuit global)", async () => {
    let calls = 0;
    const counting: typeof previewTemplateCore = async (input) => {
      calls++;
      return previewTemplateCore(input);
    };

    const a = await renderTemplateThumbnailCore({ templateId: templateA.id, previewImpl: counting });
    const b = await renderTemplateThumbnailCore({ templateId: templateB.id, previewImpl: counting });

    expect(calls).toBe(2); // un sabotage qui court-circuiterait sur une clé fixe échouerait ici.
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.dataUri).not.toBe(b.dataUri); // "Alpha" et "Beta" ne rendent pas la même image.
  });

  it("anti-vacuité — une scène ÉDITÉE invalide le cache du MÊME templateId (clé sur le CONTENU, pas seulement l'id)", async () => {
    let calls = 0;
    const counting: typeof previewTemplateCore = async (input) => {
      calls++;
      return previewTemplateCore(input);
    };

    const before = await renderTemplateThumbnailCore({ templateId: templateB.id, previewImpl: counting });
    expect(calls).toBe(1);

    // Édition du brouillon EN BASE, comme le ferait l'éditeur — même templateId, contenu différent.
    await db.update(renderTemplates).set({ scene: galleryScene("Beta modifié") })
      .where(eq(renderTemplates.id, templateB.id));

    const after = await renderTemplateThumbnailCore({ templateId: templateB.id, previewImpl: counting });
    expect(calls).toBe(2); // un sabotage qui ne clé que sur templateId resterait à 1 ici.
    expect(before.ok && after.ok).toBe(true);
    if (!before.ok || !after.ok) return;
    expect(after.dataUri).not.toBe(before.dataUri);

    // Restaure — un test ultérieur du même fichier réutilise templateB avec la scène d'origine.
    await db.update(renderTemplates).set({ scene: galleryScene("Beta") })
      .where(eq(renderTemplates.id, templateB.id));
  });

  it("gabarit introuvable : { ok:false } propre, ne lève JAMAIS", async () => {
    const res = await renderTemplateThumbnailCore({ templateId: "00000000-0000-0000-0000-000000000000" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toBe("Gabarit introuvable.");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("renderTemplateThumbnail — action gardée (RBAC, même recette que previewTemplate)", () => {
  let FAKE_EDITOR: { id: string; name: string; email: string; role: string; banned: boolean; image: null };
  let FAKE_JOURNALIST: typeof FAKE_EDITOR;

  beforeAll(async () => {
    const [seededEditor] = await db.select({ id: user.id, role: user.role })
      .from(user).where(eq(user.email, "editor@afrotiative.com"));
    if (!seededEditor) throw new Error("Seed manquant : editor@afrotiative.com introuvable (bun run db:seed).");
    FAKE_EDITOR = {
      id: seededEditor.id, name: "Test Éditeur", email: "editor@afrotiative.com",
      role: seededEditor.role, banned: false, image: null,
    };

    const [seededJournalist] = await db.select({ id: user.id, role: user.role })
      .from(user).where(eq(user.email, "journaliste@afrotiative.com"));
    if (!seededJournalist) throw new Error("Seed manquant : journaliste@afrotiative.com introuvable (bun run db:seed).");
    FAKE_JOURNALIST = {
      id: seededJournalist.id, name: "Test Journaliste", email: "journaliste@afrotiative.com",
      role: seededJournalist.role, banned: false, image: null,
    };
  });

  afterAll(() => {
    mock.module("@/lib/session", () => ({ getSession: realGetSession, requireUser: realRequireUser }));
  });

  it("refuse un journaliste (rejette, aucun résultat renvoyé)", async () => {
    mock.module("@/lib/session", () => ({ getSession: realGetSession, requireUser: async () => FAKE_JOURNALIST }));
    const { renderTemplateThumbnail } = await import("@/lib/actions/studio-thumbnail-actions");
    await expect(renderTemplateThumbnail(templateA.id)).rejects.toThrow();
  });

  it("autorise un éditeur et délègue bien à renderTemplateThumbnailCore", async () => {
    mock.module("@/lib/session", () => ({ getSession: realGetSession, requireUser: async () => FAKE_EDITOR }));
    const { renderTemplateThumbnail } = await import("@/lib/actions/studio-thumbnail-actions");
    const res = await renderTemplateThumbnail(templateA.id);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.dataUri.startsWith("data:image/jpeg;base64,")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Littéraux TemplateRow — AUCUNE base de données ici, même discipline que
// tests/studio-templates-table.test.ts#fixtureTemplate. renderToStaticMarkup n'exécute aucun effet
// (pas de DOM) : GalleryThumb (l'appel réseau paresseux) reste donc à l'état "idle" — ce describe ne
// teste QUE la structure de la carte, pas le rendu de la vignette (couvert plus bas, describe DOM).
function fixtureTemplate(overrides: Partial<TemplateRow> = {}): TemplateRow {
  return {
    id: "fixture-gallery-1",
    name: "Gabarit fixture",
    context: "recap_card",
    channel: null,
    categoryId: null,
    categoryName: null,
    format: "ig_square",
    width: 1080,
    height: 1080,
    archived: false,
    publishedVersion: null,
    hasUnpublishedChanges: true,
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function renderGallery(templates: TemplateRow[]): string {
  return renderToStaticMarkup(React.createElement(TemplatesGallery, {
    templates, isPending: false, onDuplicate: () => {}, onArchiveToggle: () => {}, onRequestRename: () => {},
  }));
}

describe("TemplatesGallery — une carte par gabarit, nom + format + état + lien + actions (spec §4)", () => {
  it("une carte porte le nom, le badge de format, le lien /studio/[id] et le menu d'actions du gabarit", () => {
    const row = fixtureTemplate({ id: "carte-1", name: "Carte Alpha" });
    const html = renderGallery([row]);

    expect((html.match(/data-testid="template-card"/g) ?? []).length).toBe(1); // UNE seule carte.
    expect(html).toContain("Carte Alpha");
    expect(html).toContain(formatLabel(row));
    expect(html).toContain('href="/studio/carte-1"');
    expect(html).toContain("Actions pour Carte Alpha"); // le MÊME menu que la ligne de tableau (TemplateRowMenu).
    expect(html).toContain('data-testid="gallery-thumb"');
  });

  it("un gabarit ARCHIVÉ affiche « Archivé », pas « Publié » — anti-vacuité (deux états DIFFÉRENTS, pas juste \"un texte quelconque apparaît\")", () => {
    const published = fixtureTemplate({
      id: "carte-publie", name: "Carte Publiée", publishedVersion: 1, hasUnpublishedChanges: false, archived: false,
    });
    const archived = fixtureTemplate({ id: "carte-archive", name: "Carte Archivée", archived: true });

    const htmlPublished = renderGallery([published]);
    const htmlArchived = renderGallery([archived]);

    expect(htmlPublished).toContain("Publié");
    expect(htmlPublished).not.toContain("Archivé");
    expect(htmlArchived).toContain("Archivé");
    expect(htmlArchived).not.toContain(">Publié<");
  });

  it("regroupe par contexte dans l'ordre CANONIQUE (article_image avant social_post avant … avant recap_card), pas l'ordre d'arrivée de `templates`", () => {
    // `recap` est passé EN PREMIER, `social` en second — si la galerie rendait les groupes dans
    // l'ordre d'ARRIVÉE plutôt que l'ordre canonique de groupTemplatesByContext (celui que la vue
    // tableau utilise aussi), « Publication sociale » apparaîtrait APRÈS « Carte récap » à l'écran.
    // C'est l'inverse de l'ordre canonique (voir CONTEXT_LABEL, templates-shared.tsx :
    // article_image, social_post, quote_card, newsletter_header, recap_card).
    const recap = fixtureTemplate({ id: "recap-1", name: "Gabarit Récap", context: "recap_card" });
    const social = fixtureTemplate({ id: "social-1", name: "Gabarit Social", context: "social_post" });
    const html = renderGallery([recap, social]);

    const socialPos = html.indexOf(CONTEXT_LABEL.social_post);
    const recapPos = html.indexOf(CONTEXT_LABEL.recap_card);
    expect(socialPos).toBeGreaterThan(-1);
    expect(recapPos).toBeGreaterThan(-1);
    expect(socialPos).toBeLessThan(recapPos); // ordre CANONIQUE, malgré l'ordre d'entrée inversé.

    // Corollaire direct (spec §4 : « the SAME grouping rule as the table view ») : c'est bien
    // groupTemplatesByContext (components/studio/templates-shared.tsx), pas une seconde
    // implémentation, qui produit CET ordre.
    expect(groupTemplatesByContext([recap, social]).map((g) => g.context)).toEqual(["social_post", "recap_card"]);
  });

  it("liste vide : ne rend aucune carte (l'état vide est géré par l'appelant, templates-table.tsx)", () => {
    const html = renderGallery([]);
    expect(html).not.toContain('data-testid="template-card"');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GalleryThumb — la vignette PARESSEUSE (IntersectionObserver, comme FilmstripThumb, render-mode.tsx)
// — a besoin d'un VRAI DOM pour que ses effets tournent (renderToStaticMarkup, utilisé ci-dessus,
// n'exécute AUCUN effet). tests/dom-harness.ts fournit un stub IntersectionObserver dont le callback
// est CONSERVÉ (jamais jeté) — exactement ce qu'il faut pour simuler une entrée dans le viewport à
// la main.
describe("GalleryThumb — paresseuse : AUCUN appel réseau avant l'entrée dans le viewport (spec §4, brief : « lazy thumbnails via IntersectionObserver, like FilmstripThumb »)", () => {
  let teardownDom: () => void;

  beforeAll(() => {
    teardownDom = installDom();
  });
  afterAll(() => {
    mock.module("@/lib/actions/studio-thumbnail-actions", () => realThumbnailActions);
    teardownDom();
  });

  it("ne rend rien avant intersection ; une fois le stub d'intersection déclenché, appelle renderTemplateThumbnail UNE fois et affiche l'image", async () => {
    const calls: string[] = [];
    mock.module("@/lib/actions/studio-thumbnail-actions", () => ({
      renderTemplateThumbnail: async (templateId: string) => {
        calls.push(templateId);
        return { ok: true, dataUri: "data:image/jpeg;base64,QUFB", degraded: false, overflowingLayerIds: [] };
      },
    }));

    const row = fixtureTemplate({ id: "lazy-1", name: "Carte Paresseuse" });
    const { container, unmount } = await mount(React.createElement(TemplatesGallery, {
      templates: [row], isPending: false, onDuplicate: () => {}, onArchiveToggle: () => {}, onRequestRename: () => {},
    }));

    // AVANT intersection : aucun appel réseau, pas d'image — même correctif que FilmstripThumb
    // (render-mode.tsx : « ne PAS re-rendre les vignettes hors champ »).
    expect(calls).toEqual([]);
    expect(container.querySelector('[data-testid="gallery-thumb"] img')).toBeNull();

    const Ctor = globalThis.IntersectionObserver as unknown as {
      instances: StubIntersectionObserverInstance[];
    };
    expect(Ctor.instances.length).toBeGreaterThan(0);
    const observer = Ctor.instances[Ctor.instances.length - 1]!;
    await flush(); // laisse le premier effet (l'abonnement) se stabiliser avant de déclencher.
    // Enveloppé dans `act` (comme `click`/`pressKey`, tests/dom-harness.ts) : le callback déclenche
    // `setVisible(true)`, une VRAIE mise à jour d'état React, pas juste un appel de fonction inerte.
    await act(async () => {
      observer.callback([{ isIntersecting: true } as IntersectionObserverEntry], observer);
    });
    await flush(); // laisse l'effet déclenché par `visible` (l'appel réseau) se résoudre.

    expect(calls).toEqual(["lazy-1"]); // UN seul appel — pas re-déclenché à chaque re-rendu.
    expect(container.querySelector('[data-testid="gallery-thumb"] img')).not.toBeNull();

    unmount();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bascule grille⇄tableau — teste le HOOK RÉEL (hooks/use-templates-view.ts), pas une réimplémentation :
// une régression qui « oublierait » l'écriture localStorage dans le hook ferait rougir CE test
// (mutation « drop the persist »), pas seulement un test des fonctions pures parseTemplatesView/
// serializeTemplatesView (qui, elles, ne touchent jamais au hook).
function ViewHarness() {
  const [view, setView] = useTemplatesView();
  return React.createElement(
    "div", null,
    React.createElement("span", { "data-testid": "view-value" }, view),
    React.createElement("button", { "data-testid": "set-table", onClick: () => setView("table") }),
    React.createElement("button", { "data-testid": "set-grid", onClick: () => setView("grid") }),
  );
}

describe("useTemplatesView — la bascule persiste réellement (hooks/use-templates-view.ts)", () => {
  let teardownDom: () => void;

  beforeAll(() => {
    teardownDom = installDom();
  });
  afterAll(() => teardownDom());

  beforeEach(() => {
    window.localStorage.clear();
  });

  it("défaut GRILLE quand rien n'est encore persisté (brief : « defaulting to grid »)", async () => {
    const { container, unmount } = await mount(React.createElement(ViewHarness));
    expect(container.querySelector('[data-testid="view-value"]')?.textContent).toBe("grid");
    unmount();
  });

  it("cliquer « tableau » bascule l'affichage ET écrit dans localStorage — puis un REMONTAGE (nouvelle navigation vers /studio) restaure « table », pas le défaut", async () => {
    const first = await mount(React.createElement(ViewHarness));
    const button = first.container.querySelector('[data-testid="set-table"]') as HTMLButtonElement;
    expect(button).not.toBeNull();

    await click(button);

    expect(first.container.querySelector('[data-testid="view-value"]')?.textContent).toBe("table");
    expect(window.localStorage.getItem("studio.templates-view")).toBe(serializeTemplatesView("table"));
    first.unmount();

    // PREUVE DE PERSISTANCE : un DEUXIÈME montage, dans le MÊME localStorage (même fenêtre jsdom),
    // simule une nouvelle navigation vers /studio — un hook qui n'écrirait jamais dans localStorage
    // (la mutation visée) laisserait CE montage retomber sur "grid" (DEFAULT_TEMPLATES_VIEW), pas
    // "table".
    const second = await mount(React.createElement(ViewHarness));
    expect(second.container.querySelector('[data-testid="view-value"]')?.textContent).toBe("table");
    second.unmount();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("lib/studio/templates-view-pref — pure, ne lève jamais (Chantier A, Tâche 5)", () => {
  it("défaut GRILLE pour null/vide/JSON corrompu/valeur ni \"grid\" ni \"table\"", () => {
    for (const raw of [null, "", "{", '"colonne"', "42", "null"]) {
      expect(parseTemplatesView(raw)).toBe(DEFAULT_TEMPLATES_VIEW);
    }
    expect(DEFAULT_TEMPLATES_VIEW).toBe("grid");
  });

  it("round-trip : parseTemplatesView(serializeTemplatesView(v)) === v, pour les DEUX valeurs", () => {
    expect(parseTemplatesView(serializeTemplatesView("grid"))).toBe("grid");
    expect(parseTemplatesView(serializeTemplatesView("table"))).toBe("table");
  });
});

// Sanity : aucune ligne active ne fuit hors de la portée dédiée de ce fichier.
describe("portées dédiées à ce fichier", () => {
  it("n'entrent en collision avec aucune autre ligne active", async () => {
    const rows = await db.select({ id: renderTemplates.id }).from(renderTemplates)
      .where(inArray(renderTemplates.channel, [CH_A, CH_B]));
    expect(rows.length).toBe(2);
  });
});
