import { describe, it, expect, mock, beforeAll, afterAll } from "bun:test";
import { db, renderTemplates, renderTemplateVersions, user } from "@/db";
import { and, eq, inArray } from "drizzle-orm";
import { parseScene, validateScene } from "@/lib/studio";
import { deleteTemplateScope } from "./studio-fixtures";

// ─────────────────────────────────────────────────────────────────────────────
// lib/actions/studio-actions.ts — comme bulkApprove/bulkReject (tests/queue-actions.test.ts) —
// commence par requireUser() → next/headers() et se termine par revalidatePath() → next/cache,
// deux appels qui exigent une vraie portée de requête Next.js absente d'un simple `bun test`. On
// mocke donc @/lib/session et next/cache avec la même recette : capturer les vraies exports AVANT
// de les mocker (mock.module() mute les exports en place — une référence de namespace vivante
// deviendrait périmée), enregistrer les mocks, IMPORTER DYNAMIQUEMENT studio-actions.ts pour que
// ses propres imports statiques résolvent contre les mocks, puis restaurer les vraies
// implémentations dans l'afterAll pour ne rien laisser fuiter vers les fichiers suivants du même
// process `bun test`.
const { requireUser: realRequireUser, getSession: realGetSession } = await import("@/lib/session");
const { revalidatePath: realRevalidatePath, revalidateTag: realRevalidateTag } = await import("next/cache");

const [seededEditor] = await db.select({ id: user.id, role: user.role })
  .from(user).where(eq(user.email, "editor@afrotiative.com"));
if (!seededEditor) throw new Error("Seed manquant : editor@afrotiative.com introuvable (bun run db:seed).");
const FAKE_EDITOR = {
  id: seededEditor.id, name: "Test Éditeur", email: "editor@afrotiative.com",
  role: seededEditor.role, banned: false, image: null,
};

// Utilisé uniquement par le describe RBAC ci-dessous : requirePermission lève avant toute écriture,
// mais on réutilise le compte journaliste seedé (README) par cohérence avec FAKE_EDITOR.
const [seededJournalist] = await db.select({ id: user.id, role: user.role })
  .from(user).where(eq(user.email, "journaliste@afrotiative.com"));
if (!seededJournalist) throw new Error("Seed manquant : journaliste@afrotiative.com introuvable (bun run db:seed).");
const FAKE_JOURNALIST = {
  id: seededJournalist.id, name: "Test Journaliste", email: "journaliste@afrotiative.com",
  role: seededJournalist.role, banned: false, image: null,
};

mock.module("@/lib/session", () => ({ getSession: realGetSession, requireUser: async () => FAKE_EDITOR }));
mock.module("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: realRevalidateTag }));

const {
  createTemplate, renameTemplate, duplicateTemplate, archiveTemplate,
  saveTemplateScene, publishTemplate, restoreVersion,
} = await import("@/lib/actions/studio-actions");

// ─────────────────────────────────────────────────────────────────────────────
// Portées STATIQUES possédées par ce fichier (voir tests/studio-fixtures.ts pour la règle et le
// registre à tenir à jour, mis à jour pour ce fichier). Toutes sous "recap_card" : ce contexte n'a
// aucun gabarit de départ semé (db/studio-templates.ts), donc (recap_card, null, null) — la portée
// d'atterrissage du repli "portée libre" de duplicateTemplate — est libre par construction, comme
// le documentent déjà tests/studio-rbac.test.ts et tests/studio-resolve.test.ts pour ce même
// contexte.
const CH_CREATE_HAPPY = "test-template-actions-create-happy";
const CH_CREATE_CONFLICT = "test-template-actions-create-conflict";
const CH_RENAME = "test-template-actions-rename";
const CH_ARCHIVE = "test-template-actions-archive";
const CH_DUP_SOURCE = "test-template-actions-duplicate-source";
const CH_DUP_ARCHIVED = "test-template-actions-duplicate-archived";
const CH_SAVE = "test-template-actions-save";
const CH_PUBLISH_INVALID = "test-template-actions-publish-invalid";
const CH_PUBLISH_FLOW = "test-template-actions-publish-flow";
const CH_PUBLISH_SNAPSHOT = "test-template-actions-publish-snapshot";

function buildScene(content: string) {
  return {
    schemaVersion: 1,
    canvas: { width: 1080, height: 1080, background: "#111111" },
    layers: [{
      id: "t", name: "Texte", visible: true, locked: false,
      frame: { x: 10, y: 10, w: 200, h: 80 },
      type: "text", content,
      font: { family: "Noto Sans", size: 24, weight: 400 },
      color: "#FFFFFF", align: "left", vAlign: "top", lineHeight: 1.2,
    }],
  };
}

const templateIds: string[] = [];

async function insertTemplate(o: {
  name: string; channel: string | null; sceneContent?: string; sceneOverride?: unknown; archived?: boolean;
}): Promise<{ id: string; name: string }> {
  const [row] = await db.insert(renderTemplates).values({
    name: o.name, context: "recap_card", channel: o.channel, categoryId: null,
    format: "ig_square", width: 1080, height: 1080,
    scene: o.sceneOverride ?? buildScene(o.sceneContent ?? "Contenu"),
    archived: o.archived ?? false,
  }).returning({ id: renderTemplates.id, name: renderTemplates.name });
  templateIds.push(row.id);
  return row;
}

async function draftContentOf(id: string): Promise<string> {
  const [row] = await db.select({ scene: renderTemplates.scene }).from(renderTemplates)
    .where(eq(renderTemplates.id, id));
  return (row.scene as { layers: { content: string }[] }).layers[0].content;
}

let conflictTemplate: { id: string; name: string };
let renameRow: { id: string; name: string };
let archiveRow: { id: string; name: string };
let dupSourceRow: { id: string; name: string };
let dupArchivedRow: { id: string; name: string };
let saveRow: { id: string; name: string };
let publishInvalidRow: { id: string; name: string };
let publishFlowRow: { id: string; name: string };
let publishSnapshotRow: { id: string; name: string };

beforeAll(async () => {
  // DELETE-THEN-INSERT (tests/studio-fixtures.ts, règle 1) : répare une exécution précédente
  // interrompue avant d'avoir capturé les ids créés, plutôt que de laisser une ligne poison casser
  // SQLSTATE 23505 pour toutes les exécutions suivantes.
  for (const ch of [
    CH_CREATE_HAPPY, CH_CREATE_CONFLICT, CH_RENAME, CH_ARCHIVE,
    CH_DUP_SOURCE, CH_DUP_ARCHIVED, CH_SAVE, CH_PUBLISH_INVALID, CH_PUBLISH_FLOW, CH_PUBLISH_SNAPSHOT,
  ]) {
    await deleteTemplateScope("recap_card", ch, null);
  }
  await deleteTemplateScope("recap_card", null, null);

  conflictTemplate = await insertTemplate({ name: "Gabarit Existant Recap", channel: CH_CREATE_CONFLICT });
  renameRow = await insertTemplate({ name: "Gabarit À Renommer", channel: CH_RENAME });
  archiveRow = await insertTemplate({ name: "Gabarit À Archiver", channel: CH_ARCHIVE });
  dupSourceRow = await insertTemplate({ name: "Gabarit Source", channel: CH_DUP_SOURCE });
  dupArchivedRow = await insertTemplate({ name: "Gabarit Source Archivé", channel: CH_DUP_ARCHIVED, archived: true });
  saveRow = await insertTemplate({ name: "Gabarit Save", channel: CH_SAVE });
  publishInvalidRow = await insertTemplate({
    name: "Gabarit Publication Invalide", channel: CH_PUBLISH_INVALID,
    // article.url n'est PAS dans CONTEXT_TOKENS.recap_card (lib/studio/tokens.ts) : validateScene
    // doit refuser cette scène malgré sa validité STRUCTURELLE (parseScene la laisse passer).
    sceneOverride: buildScene("{{article.url}}"),
  });
  publishFlowRow = await insertTemplate({ name: "Gabarit Flux Publication", channel: CH_PUBLISH_FLOW, sceneContent: "Contenu v1" });
  publishSnapshotRow = await insertTemplate({ name: "Gabarit Instantané Publication", channel: CH_PUBLISH_SNAPSHOT, sceneContent: "Avant modification" });
});

afterAll(async () => {
  mock.module("@/lib/session", () => ({ getSession: realGetSession, requireUser: realRequireUser }));
  mock.module("next/cache", () => ({ revalidatePath: realRevalidatePath, revalidateTag: realRevalidateTag }));
  if (templateIds.length) await db.delete(renderTemplates).where(inArray(renderTemplates.id, templateIds));
  // render_template_versions cascade avec son template_id (db/schema.ts) : pas de nettoyage séparé
  // nécessaire pour les instantanés publiés par le cycle publishTemplate ci-dessous.
});

// ─────────────────────────────────────────────────────────────────────────────
describe("RBAC : chaque action refuse un journaliste, sans écriture", () => {
  beforeAll(() => {
    mock.module("@/lib/session", () => ({ getSession: realGetSession, requireUser: async () => FAKE_JOURNALIST }));
  });
  afterAll(() => {
    mock.module("@/lib/session", () => ({ getSession: realGetSession, requireUser: async () => FAKE_EDITOR }));
  });

  it("createTemplate refuse un journaliste, sans créer de ligne", async () => {
    await expect(createTemplate({
      name: "Ne doit pas exister", context: "recap_card", channel: CH_CREATE_HAPPY, categoryId: null, format: "ig_square",
    })).rejects.toThrow();
    const rows = await db.select().from(renderTemplates)
      .where(and(eq(renderTemplates.context, "recap_card"), eq(renderTemplates.channel, CH_CREATE_HAPPY)));
    expect(rows).toHaveLength(0);
  });

  it("renameTemplate refuse un journaliste, sans renommer", async () => {
    await expect(renameTemplate(renameRow.id, "Nouveau nom")).rejects.toThrow();
    const [row] = await db.select({ name: renderTemplates.name }).from(renderTemplates).where(eq(renderTemplates.id, renameRow.id));
    expect(row.name).toBe("Gabarit À Renommer");
  });

  it("duplicateTemplate refuse un journaliste, sans dupliquer", async () => {
    await expect(duplicateTemplate(dupSourceRow.id)).rejects.toThrow();
    const rows = await db.select().from(renderTemplates).where(eq(renderTemplates.name, "Gabarit Source (copie)"));
    expect(rows).toHaveLength(0);
  });

  it("archiveTemplate refuse un journaliste, sans archiver", async () => {
    await expect(archiveTemplate(archiveRow.id, true)).rejects.toThrow();
    const [row] = await db.select({ archived: renderTemplates.archived }).from(renderTemplates).where(eq(renderTemplates.id, archiveRow.id));
    expect(row.archived).toBe(false);
  });

  it("saveTemplateScene refuse un journaliste, sans modifier le brouillon", async () => {
    await expect(saveTemplateScene(saveRow.id, buildScene("Tentative journaliste"))).rejects.toThrow();
    expect(await draftContentOf(saveRow.id)).toBe("Contenu");
  });

  it("publishTemplate refuse un journaliste, sans publier", async () => {
    await expect(publishTemplate(publishFlowRow.id)).rejects.toThrow();
    const [row] = await db.select({ publishedVersion: renderTemplates.publishedVersion }).from(renderTemplates).where(eq(renderTemplates.id, publishFlowRow.id));
    expect(row.publishedVersion).toBeNull();
  });

  it("restoreVersion refuse un journaliste", async () => {
    await expect(restoreVersion(publishFlowRow.id, 1)).rejects.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("createTemplate", () => {
  it("fige largeur/hauteur depuis FORMAT_PRESETS et sème une scène valide", async () => {
    const res = await createTemplate({
      name: "Nouveau Gabarit Recap", context: "recap_card", channel: CH_CREATE_HAPPY, categoryId: null, format: "story",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    templateIds.push(res.id);

    const [row] = await db.select().from(renderTemplates).where(eq(renderTemplates.id, res.id));
    expect(row.width).toBe(1080);
    expect(row.height).toBe(1920); // FORMAT_PRESETS.story — pas la valeur de n'importe quel autre format
    expect(row.publishedVersion).toBeNull();
    expect(row.archived).toBe(false);

    const parsed = parseScene(row.scene);
    expect(validateScene(parsed, "recap_card")).toEqual([]);
  });

  it("refuse un conflit de portée et nomme le gabarit existant", async () => {
    const res = await createTemplate({
      name: "Second essai", context: "recap_card", channel: CH_CREATE_CONFLICT, categoryId: null, format: "ig_square",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain(conflictTemplate.name);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("renameTemplate", () => {
  it("renomme le gabarit (nom nettoyé des espaces superflus)", async () => {
    const res = await renameTemplate(renameRow.id, "  Nom Modifié  ");
    expect(res.ok).toBe(true);
    const [row] = await db.select({ name: renderTemplates.name }).from(renderTemplates).where(eq(renderTemplates.id, renameRow.id));
    expect(row.name).toBe("Nom Modifié");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("archiveTemplate", () => {
  it("archive puis désarchive un gabarit dont la portée reste libre entre-temps", async () => {
    const archiveRes = await archiveTemplate(archiveRow.id, true);
    expect(archiveRes.ok).toBe(true);
    let [row] = await db.select({ archived: renderTemplates.archived }).from(renderTemplates).where(eq(renderTemplates.id, archiveRow.id));
    expect(row.archived).toBe(true);

    const unarchiveRes = await archiveTemplate(archiveRow.id, false);
    expect(unarchiveRes.ok).toBe(true);
    [row] = await db.select({ archived: renderTemplates.archived }).from(renderTemplates).where(eq(renderTemplates.id, archiveRow.id));
    expect(row.archived).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("duplicateTemplate", () => {
  // Revue lot 1, Important 1 : quand la SOURCE occupe déjà (recap_card, null, null) — la portée par
  // défaut du contexte — le repli habituel retomberait sur cette portée EXACTE, donc sur la source
  // elle-même : c'est le cas précis qui produisait l'ancien message auto-contradictoire (le gabarit
  // nommé trois fois) et qui refusait la duplication entièrement. db/studio-templates.ts:63 sème un
  // gabarit exactement dans ce cas (channel: null, categoryId: null) ; ce test le reproduit sans
  // toucher aux données semées.
  //
  // S'exécute EN PREMIER dans ce describe et libère explicitement (recap_card, null, null) en
  // sortie (delete direct dans le `finally`, pas seulement templateIds côté afterAll global) : le
  // test suivant dépend de cette même portée étant libre pour son propre repli.
  it("duplique une source déjà à la portée par défaut du contexte — la copie est créée archivée", async () => {
    const defaultScopedRow = await insertTemplate({ name: "Gabarit Défaut Recap", channel: null });
    try {
      const res = await duplicateTemplate(defaultScopedRow.id);
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      // Le message ne doit nommer le gabarit source qu'UNE fois, jamais trois (bug corrigé).
      expect(res.message).toBeDefined();
      const occurrences = res.message!.split(defaultScopedRow.name).length - 1;
      expect(occurrences).toBe(1);

      const [row] = await db.select().from(renderTemplates).where(eq(renderTemplates.id, res.id));
      expect(row.name).toBe("Gabarit Défaut Recap (copie)");
      expect(row.channel).toBeNull();
      expect(row.categoryId).toBeNull();
      // Faute de portée libre (la portée par défaut EST déjà celle de la source), la copie est
      // créée archivée plutôt que refusée — render_templates_scope (db/schema.ts) ignore les
      // lignes archivées, donc aucun conflit n'est possible ici.
      expect(row.archived).toBe(true);

      await db.delete(renderTemplates).where(eq(renderTemplates.id, res.id));
    } finally {
      await db.delete(renderTemplates).where(eq(renderTemplates.id, defaultScopedRow.id));
    }
  });

  it("repli sur une portée libre quand la portée de la source est prise — par la source elle-même", async () => {
    const res = await duplicateTemplate(dupSourceRow.id);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    templateIds.push(res.id);
    // Le message doit NOMMER le gabarit qui occupe la portée d'origine.
    expect(res.message).toBeDefined();
    expect(res.message).toContain("Gabarit Source");

    const [row] = await db.select().from(renderTemplates).where(eq(renderTemplates.id, res.id));
    expect(row.name).toBe("Gabarit Source (copie)");
    expect(row.channel).toBeNull();
    expect(row.categoryId).toBeNull();
    expect(row.publishedVersion).toBeNull();
    expect(row.context).toBe("recap_card");
  });

  it("conserve la portée de la source quand elle est libre (source archivée)", async () => {
    const res = await duplicateTemplate(dupArchivedRow.id);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    templateIds.push(res.id);
    expect(res.message).toBeUndefined();

    const [row] = await db.select().from(renderTemplates).where(eq(renderTemplates.id, res.id));
    expect(row.channel).toBe(CH_DUP_ARCHIVED);
    expect(row.archived).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("saveTemplateScene", () => {
  it("refuse une scène structurellement invalide (parseScene)", async () => {
    const res = await saveTemplateScene(saveRow.id, {
      schemaVersion: 1, canvas: { width: -5, height: 100, background: "#fff" }, layers: [],
    });
    expect(res.ok).toBe(false);
    expect(await draftContentOf(saveRow.id)).toBe("Contenu");
  });

  it("refuse un jeton hors contexte (validateScene)", async () => {
    const res = await saveTemplateScene(saveRow.id, buildScene("{{article.url}}"));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain("article.url");
    expect(await draftContentOf(saveRow.id)).toBe("Contenu");
  });

  it("accepte une scène valide et l'enregistre comme brouillon", async () => {
    const res = await saveTemplateScene(saveRow.id, buildScene("Contenu Sauvegardé"));
    expect(res.ok).toBe(true);
    expect(await draftContentOf(saveRow.id)).toBe("Contenu Sauvegardé");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("publishTemplate — refuse sur scène invalide", () => {
  it("refuse de publier et n'écrit ni instantané ni publishedVersion", async () => {
    const res = await publishTemplate(publishInvalidRow.id);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain("article.url");

    const versions = await db.select().from(renderTemplateVersions).where(eq(renderTemplateVersions.templateId, publishInvalidRow.id));
    expect(versions).toHaveLength(0);
    const [row] = await db.select({ publishedVersion: renderTemplates.publishedVersion }).from(renderTemplates).where(eq(renderTemplates.id, publishInvalidRow.id));
    expect(row.publishedVersion).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Revue lot 1, Important 2 : publishTemplateCore doit lire la scène à instantané À L'INTÉRIEUR de
// la transaction (verrouillée avec .for("update")), pas avant — sinon un saveTemplateScene qui
// committe entre une lecture PRÉALABLE et l'ouverture de la transaction publierait silencieusement
// un instantané périmé. Une vraie course (deux publications concurrentes) n'est pas testée ici :
// bun:test n'offre pas de primitive pour garantir qu'une deuxième transaction commence pendant
// qu'une première tient encore son verrou FOR UPDATE, et une tentative avec deux promesses non
// attendues serait non déterministe (dépendante de l'ordonnanceur du pool de connexions) — donc pas
// un test fiable. Ce test vérifie plutôt la propriété observable qui aurait été violée par le bug :
// l'instantané publié correspond au brouillon TEL QU'IL EST au moment de l'appel, pas tel qu'il
// était à la création du gabarit.
describe("publishTemplate — l'instantané reflète la scène au moment de la transaction", () => {
  it("publie le contenu du brouillon actuel, pas celui de la création du gabarit", async () => {
    expect(await draftContentOf(publishSnapshotRow.id)).toBe("Avant modification");

    const saveRes = await saveTemplateScene(publishSnapshotRow.id, buildScene("Juste avant publication"));
    expect(saveRes.ok).toBe(true);

    const res = await publishTemplate(publishSnapshotRow.id);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.version).toBe(1);

    const [snap] = await db.select().from(renderTemplateVersions)
      .where(and(eq(renderTemplateVersions.templateId, publishSnapshotRow.id), eq(renderTemplateVersions.version, 1)));
    expect((snap.scene as { layers: { content: string }[] }).layers[0].content).toBe("Juste avant publication");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cycle complet, sur UN SEUL gabarit, dans l'ordre : publier v1 → modifier le brouillon (contenu
// MATÉRIELLEMENT différent) → vérifier que l'instantané v1 n'a pas bougé → republier (v2) →
// restaurer v1 dans le brouillon en vérifiant que publishedVersion reste à 2.
describe("publishTemplate → saveTemplateScene → restoreVersion : cycle complet", () => {
  it("publie une première version (version = 1)", async () => {
    const res = await publishTemplate(publishFlowRow.id);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.version).toBe(1);

    const [row] = await db.select({ publishedVersion: renderTemplates.publishedVersion }).from(renderTemplates).where(eq(renderTemplates.id, publishFlowRow.id));
    expect(row.publishedVersion).toBe(1);

    const [snap] = await db.select().from(renderTemplateVersions)
      .where(and(eq(renderTemplateVersions.templateId, publishFlowRow.id), eq(renderTemplateVersions.version, 1)));
    expect((snap.scene as { layers: { content: string }[] }).layers[0].content).toBe("Contenu v1");
  });

  it("un brouillon modifié après publication ne mute pas l'instantané v1", async () => {
    const saveRes = await saveTemplateScene(publishFlowRow.id, buildScene("Contenu v2 modifié"));
    expect(saveRes.ok).toBe(true);
    expect(await draftContentOf(publishFlowRow.id)).toBe("Contenu v2 modifié");

    // L'instantané v1, lu depuis render_template_versions (PAS depuis le brouillon), doit encore
    // porter le contenu D'ORIGINE — la preuve que saveTemplateScene n'a touché QUE le brouillon.
    const [snap] = await db.select().from(renderTemplateVersions)
      .where(and(eq(renderTemplateVersions.templateId, publishFlowRow.id), eq(renderTemplateVersions.version, 1)));
    expect((snap.scene as { layers: { content: string }[] }).layers[0].content).toBe("Contenu v1");
  });

  it("republier incrémente la version à 2", async () => {
    const res = await publishTemplate(publishFlowRow.id);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.version).toBe(2);

    const [row] = await db.select({ publishedVersion: renderTemplates.publishedVersion }).from(renderTemplates).where(eq(renderTemplates.id, publishFlowRow.id));
    expect(row.publishedVersion).toBe(2);

    const [snap2] = await db.select().from(renderTemplateVersions)
      .where(and(eq(renderTemplateVersions.templateId, publishFlowRow.id), eq(renderTemplateVersions.version, 2)));
    expect((snap2.scene as { layers: { content: string }[] }).layers[0].content).toBe("Contenu v2 modifié");
  });

  it("restoreVersion copie l'instantané v1 dans le brouillon SANS toucher publishedVersion", async () => {
    const res = await restoreVersion(publishFlowRow.id, 1);
    expect(res.ok).toBe(true);

    // La scène a RÉELLEMENT changé (retour à v1) — sans cette assertion, une implémentation qui ne
    // fait rien passerait quand même le test « publishedVersion inchangé » ci-dessous.
    expect(await draftContentOf(publishFlowRow.id)).toBe("Contenu v1");

    const [row] = await db.select({ publishedVersion: renderTemplates.publishedVersion }).from(renderTemplates).where(eq(renderTemplates.id, publishFlowRow.id));
    expect(row.publishedVersion).toBe(2); // toujours 2 : republier reste un geste explicite (spec §3)
  });

  it("refuse de restaurer une version inexistante", async () => {
    const res = await restoreVersion(publishFlowRow.id, 999);
    expect(res.ok).toBe(false);
  });
});
