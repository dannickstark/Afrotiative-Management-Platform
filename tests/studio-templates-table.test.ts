import { describe, it, expect, mock, beforeAll, afterAll } from "bun:test";
import { db, renderTemplates, user } from "@/db";
import { and, eq } from "drizzle-orm";
import { deleteTemplateScope } from "./studio-fixtures";

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

const [seededEditor] = await db.select({ id: user.id, role: user.role })
  .from(user).where(eq(user.email, "editor@afrotiative.com"));
if (!seededEditor) throw new Error("Seed manquant : editor@afrotiative.com introuvable (bun run db:seed).");
const FAKE_EDITOR = {
  id: seededEditor.id, name: "Test Éditeur", email: "editor@afrotiative.com",
  role: seededEditor.role, banned: false, image: null,
};

mock.module("@/lib/session", () => ({ getSession: realGetSession, requireUser: async () => FAKE_EDITOR }));
mock.module("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: realRevalidateTag }));

const { createTemplate, archiveTemplate } = await import("@/lib/actions/studio-actions");
const { buildCreateTemplateInput, nextArchivedState } = await import("@/components/studio/templates-table");

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
