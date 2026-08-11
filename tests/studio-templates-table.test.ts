import { describe, it, expect, mock, beforeAll, afterAll } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { db, renderTemplates, user } from "@/db";
import { and, eq } from "drizzle-orm";
import { deleteTemplateScope } from "./studio-fixtures";
import type { TemplateRow, CategoryOption } from "@/lib/queries/studio";

// tests/studio-templates-table.test.ts — Correctif Critique 1 de la revue finale V2 : /studio
// n'avait AUCUNE UI de création/duplication/renommage/archivage (components/studio/templates-table.tsx
// n'était qu'un tableau de lecture). Le correctif ajoute un dialogue « Nouveau gabarit » et un menu
// par ligne (dupliquer/renommer/archiver), tous deux appelant les VRAIES actions déjà couvertes par
// tests/studio-template-actions.test.ts.
//
// bun:test n'a pas de DOM (voir la même remarque dans tests/studio-manual.test.ts) : on ne simule
// donc PAS de clic sur un élément rendu côté serveur. À la place, templates-table.tsx exporte deux
// helpers PURS — buildCreateTemplateInput (l'entrée EXACTE que handleSubmit envoie à createTemplate)
// et nextArchivedState (l'inversion EXACTE que handleArchiveToggle envoie à archiveTemplate) — et ce
// fichier les COMPOSE avec les vraies actions (session RBAC mockée, même recette que
// tests/studio-template-actions.test.ts) pour prouver le contrat de bout en bout : format/portée
// choisis → ligne créée ; conflit de portée → message français NON modifié en chemin ; archiver puis
// désarchiver → round-trip réel en base.
const { requireUser: realRequireUser, getSession: realGetSession } = await import("@/lib/session");
const { revalidatePath: realRevalidatePath, revalidateTag: realRevalidateTag } = await import("next/cache");
const realNavigation = await import("next/navigation");
const realAuthClient = await import("@/lib/auth-client");

const [seededEditor] = await db.select({ id: user.id, role: user.role })
  .from(user).where(eq(user.email, "editor@afrotiative.com"));
if (!seededEditor) throw new Error("Seed manquant : editor@afrotiative.com introuvable (bun run db:seed).");
const FAKE_EDITOR = {
  id: seededEditor.id, name: "Test Éditeur", email: "editor@afrotiative.com",
  role: seededEditor.role, banned: false, image: null,
};

mock.module("@/lib/session", () => ({ getSession: realGetSession, requireUser: async () => FAKE_EDITOR }));
mock.module("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: realRevalidateTag }));
// Tâche 2 (U1, spec §3) : ModelesPanel héberge CreateTemplateDialog ET TemplatesTable, tous deux
// useRouter() (next/navigation) — sans ce mock, renderToStaticMarkup planterait avec "invariant
// expected app router to be mounted" (vérifié empiriquement ; même diagnostic déjà documenté par
// tests/studio-no-r2.test.ts pour asset-library.tsx/editor-shell.tsx). Posé AVANT le premier import
// de templates-table.tsx juste en dessous — les imports dynamiques (`await import`, pas des imports
// statiques hissés) s'exécutent dans l'ordre du fichier, donc l'ordre ICI est ce qui garantit que le
// module se charge avec le mock déjà actif plutôt qu'avec le vrai next/navigation figé dedans.
mock.module("next/navigation", () => ({
  ...realNavigation,
  useRouter: () => ({
    push: () => {}, refresh: () => {}, replace: () => {}, back: () => {}, forward: () => {}, prefetch: () => {},
  }),
}));
// Revue Tâche 2, Important 2 : ModelesPanel enveloppe désormais CreateTemplateDialog dans
// <RoleGate allow={["admin","editor"]}> (symétrie avec templates-table.tsx) — RoleGate lit
// useSession() (@/lib/auth-client.ts), qui n'a pas de session à lire sous `renderToStaticMarkup`
// (pas de Provider, pas de réseau) et masquerait donc le déclencheur même en test. Mocké AVANT le
// premier import de modeles-panel.tsx, même recette que next/navigation ci-dessus — la session
// simulée porte le rôle "editor", cohérent avec FAKE_EDITOR utilisé plus bas pour les tests DB.
mock.module("@/lib/auth-client", () => ({
  ...realAuthClient,
  useSession: () => ({ data: { user: { role: "editor" } } }),
}));

const { createTemplate, archiveTemplate } = await import("@/lib/actions/studio-actions");
const { buildCreateTemplateInput, nextArchivedState } = await import("@/components/studio/templates-table");
const { ModelesPanel, filterTemplatesBySearch } = await import("@/components/studio/panels/modeles-panel");

// ─────────────────────────────────────────────────────────────────────────────
// Portées STATIQUES possédées par ce fichier (registre tests/studio-fixtures.ts, à tenir à jour) :
//   (recap_card, "test-templates-table-create-happy", null)
//   (recap_card, "test-templates-table-create-conflict", null)
//   (recap_card, "test-templates-table-archive-toggle", null)
const CH_CREATE_HAPPY = "test-templates-table-create-happy";
const CH_CREATE_CONFLICT = "test-templates-table-create-conflict";
const CH_ARCHIVE_TOGGLE = "test-templates-table-archive-toggle";

function buildScene() {
  return {
    schemaVersion: 1,
    canvas: { width: 1080, height: 1080, background: "#111111" },
    layers: [{
      id: "t", name: "Texte", visible: true, locked: false,
      frame: { x: 10, y: 10, w: 200, h: 80 },
      type: "text", content: "Contenu",
      font: { family: "Noto Sans", size: 24, weight: 400 },
      color: "#FFFFFF", align: "left", vAlign: "top", lineHeight: 1.2,
    }],
  };
}

const templateIds: string[] = [];
let conflictTemplate: { id: string; name: string };
let archiveRow: { id: string; name: string; archived: boolean };

beforeAll(async () => {
  for (const ch of [CH_CREATE_HAPPY, CH_CREATE_CONFLICT, CH_ARCHIVE_TOGGLE]) {
    await deleteTemplateScope("recap_card", ch, null);
  }

  const [conflict] = await db.insert(renderTemplates).values({
    name: "Gabarit Existant (table)", context: "recap_card", channel: CH_CREATE_CONFLICT, categoryId: null,
    format: "ig_square", width: 1080, height: 1080, scene: buildScene(),
  }).returning({ id: renderTemplates.id, name: renderTemplates.name });
  conflictTemplate = conflict;
  templateIds.push(conflict.id);

  const [archive] = await db.insert(renderTemplates).values({
    name: "Gabarit À Archiver (table)", context: "recap_card", channel: CH_ARCHIVE_TOGGLE, categoryId: null,
    format: "ig_square", width: 1080, height: 1080, scene: buildScene(), archived: false,
  }).returning({ id: renderTemplates.id, name: renderTemplates.name, archived: renderTemplates.archived });
  archiveRow = archive;
  templateIds.push(archive.id);
});

afterAll(async () => {
  mock.module("@/lib/session", () => ({ getSession: realGetSession, requireUser: realRequireUser }));
  mock.module("next/cache", () => ({ revalidatePath: realRevalidatePath, revalidateTag: realRevalidateTag }));
  mock.module("next/navigation", () => realNavigation);
  mock.module("@/lib/auth-client", () => realAuthClient);
  const { inArray } = await import("drizzle-orm");
  if (templateIds.length) await db.delete(renderTemplates).where(inArray(renderTemplates.id, templateIds));
});

// ─────────────────────────────────────────────────────────────────────────────
describe("buildCreateTemplateInput composé avec createTemplate : le format et la portée choisis dans le dialogue atteignent bien la ligne créée", () => {
  it("crée avec le format et la portée choisis — largeur/hauteur figées depuis FORMAT_PRESETS[format]", async () => {
    const input = buildCreateTemplateInput({
      name: "Nouveau Gabarit (table)", context: "recap_card", channel: CH_CREATE_HAPPY, categoryId: null, format: "story",
    });
    const res = await createTemplate(input);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    templateIds.push(res.id);

    const [row] = await db.select().from(renderTemplates).where(eq(renderTemplates.id, res.id));
    expect(row.context).toBe("recap_card");
    expect(row.channel).toBe(CH_CREATE_HAPPY);
    expect(row.format).toBe("story");
    expect(row.width).toBe(1080);
    expect(row.height).toBe(1920); // FORMAT_PRESETS.story — pas la valeur d'un autre format
  });

  it("un conflit de portée renvoie le message français EXACT de l'action, nommant le gabarit existant — rien ne l'altère en chemin", async () => {
    const input = buildCreateTemplateInput({
      name: "Second essai (table)", context: "recap_card", channel: CH_CREATE_CONFLICT, categoryId: null, format: "ig_square",
    });
    const res = await createTemplate(input);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    // C'est le message que le dialogue affiche tel quel (setError + toast.error) — la garantie
    // que la revue a demandé de « surfacer plutôt que d'avaler ».
    expect(res.message).toContain(conflictTemplate.name);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("nextArchivedState composé avec archiveTemplate : archiver puis désarchiver depuis le menu par ligne round-trip réellement en base", () => {
  it("archive() envoie l'INVERSE de l'état courant, jamais une valeur figée — round-trip complet", async () => {
    expect(archiveRow.archived).toBe(false);

    // Étape 1 : la ligne n'est pas archivée → handleArchiveToggle doit envoyer `true`.
    const toArchived = nextArchivedState(archiveRow);
    expect(toArchived).toBe(true);
    const archiveRes = await archiveTemplate(archiveRow.id, toArchived);
    expect(archiveRes.ok).toBe(true);

    const [afterArchive] = await db.select({ archived: renderTemplates.archived }).from(renderTemplates)
      .where(eq(renderTemplates.id, archiveRow.id));
    expect(afterArchive.archived).toBe(true);

    // Étape 2 : relit l'état réel (comme le ferait un re-rendu de la ligne après router.refresh()),
    // pas l'ancien objet en mémoire — nextArchivedState doit alors envoyer `false`.
    const toUnarchived = nextArchivedState(afterArchive);
    expect(toUnarchived).toBe(false);
    const unarchiveRes = await archiveTemplate(archiveRow.id, toUnarchived);
    expect(unarchiveRes.ok).toBe(true);

    const [afterUnarchive] = await db.select({ archived: renderTemplates.archived }).from(renderTemplates)
      .where(eq(renderTemplates.id, archiveRow.id));
    expect(afterUnarchive.archived).toBe(false);
  });
});

// Sanity : aucune ligne active ne fuit hors de la portée dédiée de ce fichier (garde-fou, comme
// tests/studio-template-actions.test.ts).
describe("portées dédiées à ce fichier", () => {
  it("n'entrent en collision avec aucune autre ligne active", async () => {
    const rows = await db.select({ id: renderTemplates.id }).from(renderTemplates)
      .where(and(eq(renderTemplates.context, "recap_card"), eq(renderTemplates.channel, CH_CREATE_CONFLICT)));
    expect(rows.length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tâche 2 (U1, spec §3) : le panneau « Modèles » du rail HÉBERGE cette même table plutôt que d'en
// réimplémenter une version réduite pour le panneau étroit — pas de requête DB nécessaire ici, la
// preuve est purement structurelle (react-dom/server, même convention que
// tests/studio-layer-panel.test.ts). Le testid affirmé n'existe QUE dans templates-table.tsx
// (data-testid="templates-table", posé Tâche 2) : une réimplémentation qui reconstruirait sa propre
// grille échouerait ce test même si elle affichait visuellement la même chose — c'est exactement le
// sabotage-check demandé par le brief.
function fixtureTemplate(overrides: Partial<TemplateRow> = {}): TemplateRow {
  return {
    id: "fixture-modeles-panel",
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

// Synchrone à dessein (PAS de `await import(...)` à l'intérieur) : ModelesPanel est déjà résolu par
// le top-level await de ce fichier (voir plus haut), donc cette aide reste un simple appel direct à
// renderToStaticMarkup — un helper `async` renverrait une Promise, et `expect(promise).toContain(...)`
// échouerait toujours puisqu'une Promise n'a pas cette méthode.
function renderModelesPanel({ templates, categories = [] }: { templates: TemplateRow[]; categories?: CategoryOption[] }): string {
  return renderToStaticMarkup(React.createElement(ModelesPanel, { templates, categories }));
}

describe("ModelesPanel — héberge templates-table.tsx, ne le réimplémente pas (Tâche 2)", () => {
  it("the Modèles panel renders the existing templates table, not a copy", async () => {
    // assert the panel's rendered output contains the table's own testid,
    // which only components/studio/templates-table.tsx sets
    const html = renderModelesPanel({ templates: [fixtureTemplate()] });
    expect(html).toContain('data-testid="templates-table"');
  });

  it("the Modèles panel offers « Nouveau gabarit vierge » as its primary action", async () => {
    const html = renderModelesPanel({ templates: [] });
    expect(html).toContain("Nouveau gabarit vierge");
  });

  // Correctif revue finale — Important 2 : les deux slots de panel-host.tsx (`search`,
  // `primaryAction`) étaient morts — chaque panneau rendait son action dans son propre corps. Ce
  // bloc vérifie STRUCTURELLEMENT que les deux atterrissent bien dans la zone dédiée du skeleton
  // commun, pas seulement « le texte apparaît quelque part dans le panneau ».
  it("le champ de recherche apparaît dans le slot `search` DÉDIÉ de PanelHost, pas ailleurs", async () => {
    const html = renderModelesPanel({ templates: [fixtureTemplate()] });
    const searchIdx = html.indexOf('data-testid="panel-search"');
    const inputIdx = html.indexOf('data-testid="modeles-search"');
    expect(searchIdx).toBeGreaterThan(-1);
    expect(inputIdx).toBeGreaterThan(searchIdx);
  });

  it("« Nouveau gabarit vierge » apparaît dans le slot `primaryAction` DÉDIÉ de PanelHost, AVANT le corps du panneau", async () => {
    const html = renderModelesPanel({ templates: [] });
    const actionIdx = html.indexOf('data-testid="panel-primary-action"');
    const bodyIdx = html.indexOf('data-testid="modeles-panel"');
    expect(actionIdx).toBeGreaterThan(-1);
    expect(actionIdx).toBeLessThan(bodyIdx);
  });
});

// Correctif revue finale — Important 2, amendement de spec §3 : Modèles a désormais un champ de
// recherche (la liste des gabarits est potentiellement longue) — filtrage CÔTÉ CLIENT sur `templates`,
// déjà reçu en prop.
describe("filterTemplatesBySearch — pure, client-side (Modèles a une recherche, spec révisée)", () => {
  it("requête vide : renvoie la liste complète", () => {
    const list = [fixtureTemplate({ id: "1", name: "Carte Alpha" }), fixtureTemplate({ id: "2", name: "Bandeau Beta" })];
    expect(filterTemplatesBySearch(list, "")).toEqual(list);
  });

  it("filtre insensible à la casse sur le nom", () => {
    const list = [fixtureTemplate({ id: "1", name: "Carte Alpha" }), fixtureTemplate({ id: "2", name: "Bandeau Beta" })];
    expect(filterTemplatesBySearch(list, "alpha").map((t) => t.id)).toEqual(["1"]);
  });

  it("aucune correspondance : liste vide", () => {
    expect(filterTemplatesBySearch([fixtureTemplate({ name: "Alpha" })], "zzz")).toEqual([]);
  });
});
