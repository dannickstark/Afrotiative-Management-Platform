import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { db, renderTemplates, renderTemplateVersions, wpCategories } from "@/db";
import { inArray, eq } from "drizzle-orm";
import { can } from "@/lib/rbac";
import { listTemplates } from "@/lib/queries/studio";
import { deleteTemplateScope } from "./studio-fixtures";

// Portées STATIQUES possédées par ce fichier (voir tests/studio-fixtures.ts pour la règle et le
// registre à tenir à jour). "recap_card" n'a aucun gabarit de départ semé (db/studio-templates.ts)
// et n'est utilisé ailleurs QUE comme portée (recap_card, null, null) — absente par construction
// dans tests/studio-resolve.test.ts et tests/studio-bindings.test.ts. Les canaux ci-dessous sont
// tous non-null et synthétiques : aucun risque de percuter cette portée-là ni un canal réel.
//   (recap_card, "test-studio-fondations-identique", null)
//   (recap_card, "test-studio-fondations-modifie", <categoryId frais>)
//   (recap_card, "test-studio-fondations-jamais-publie", null)
//   (recap_card, "test-studio-fondations-cles-reordonnees", null)
const CHANNEL_UNCHANGED = "test-studio-fondations-identique";
const CHANNEL_CHANGED = "test-studio-fondations-modifie";
const CHANNEL_NEVER_PUBLISHED = "test-studio-fondations-jamais-publie";
const CHANNEL_REORDERED_KEYS = "test-studio-fondations-cles-reordonnees";

const templateIds: string[] = [];
let categoryId: string;
let categoryName: string;

function scene(title: string) {
  return {
    schemaVersion: 1,
    canvas: { width: 1080, height: 1080, background: "#000000" },
    layers: [{
      id: "t", name: "Titre", visible: true, locked: false, frame: { x: 0, y: 0, w: 10, h: 10 },
      type: "text", content: title, font: { family: "Noto Sans", size: 10, weight: 400 },
      color: "#FFFFFF", align: "left", vAlign: "top", lineHeight: 1.2,
    }],
  };
}

// Même contenu que scene(title), mais chaque objet imbriqué est reconstruit avec ses clés dans un
// ordre différent. PostgreSQL jsonb ne garantit PAS de préserver l'ordre d'insertion des clés d'un
// objet (voir la doc PostgreSQL sur jsonb) : une comparaison par JSON.stringify brut, sans tri
// préalable des clés, pourrait donc rapporter un faux "modifié" sur deux scènes structurellement
// identiques. Ce fixture exerce précisément ce cas.
function sceneKeysReordered(title: string) {
  const base = scene(title);
  const layer = base.layers[0];
  return {
    layers: [{
      lineHeight: layer.lineHeight, vAlign: layer.vAlign, align: layer.align, color: layer.color,
      font: layer.font, content: layer.content, type: layer.type, frame: layer.frame,
      locked: layer.locked, visible: layer.visible, name: layer.name, id: layer.id,
    }],
    canvas: { background: base.canvas.background, height: base.canvas.height, width: base.canvas.width },
    schemaVersion: base.schemaVersion,
  };
}

async function makeTemplate(o: {
  channel: string; categoryId?: string | null; draft: string;
  // `published`: construit l'instantané via scene(published). `publishedScene`: instantané fourni
  // tel quel (contourne scene()) — utilisé par le test des clés réordonnées ci-dessous, où le
  // brouillon et l'instantané doivent être structurellement égaux mais textuellement différents.
  published?: string | null; publishedScene?: unknown;
}): Promise<string> {
  const [t] = await db.insert(renderTemplates).values({
    name: `Gabarit ${o.channel}`, context: "recap_card", channel: o.channel,
    categoryId: o.categoryId ?? null, format: "ig_square", width: 1080, height: 1080,
    scene: scene(o.draft),
  }).returning();
  templateIds.push(t.id);
  if (o.published || o.publishedScene) {
    const snapshot = o.publishedScene ?? scene(o.published!);
    await db.insert(renderTemplateVersions).values({ templateId: t.id, version: 1, scene: snapshot });
    await db.update(renderTemplates).set({ publishedVersion: 1 }).where(eq(renderTemplates.id, t.id));
  }
  return t.id;
}

beforeAll(async () => {
  // Delete-then-insert des portées STATIQUES (voir tests/studio-fixtures.ts) : répare une
  // exécution précédente interrompue au lieu de laisser une ligne poison casser SQLSTATE 23505.
  await deleteTemplateScope("recap_card", CHANNEL_UNCHANGED, null);
  await deleteTemplateScope("recap_card", CHANNEL_NEVER_PUBLISHED, null);
  await deleteTemplateScope("recap_card", CHANNEL_REORDERED_KEYS, null);

  const [c] = await db.insert(wpCategories).values({
    name: `Studio fondations ${Date.now()}`, slug: `studio-fondations-${Date.now()}`,
  }).returning();
  categoryId = c.id;
  categoryName = c.name;
});

afterAll(async () => {
  if (templateIds.length) await db.delete(renderTemplates).where(inArray(renderTemplates.id, templateIds));
  await db.delete(wpCategories).where(eq(wpCategories.id, categoryId));
});

describe("can() — ressource template", () => {
  it("le journaliste n'a aucun des trois droits", () => {
    expect(can("journalist", "template", "read")).toBe(false);
    expect(can("journalist", "template", "manage")).toBe(false);
    expect(can("journalist", "template", "publish")).toBe(false);
  });

  it("éditeur et admin ont les trois droits", () => {
    for (const role of ["editor", "admin"] as const) {
      expect(can(role, "template", "read")).toBe(true);
      expect(can(role, "template", "manage")).toBe(true);
      expect(can(role, "template", "publish")).toBe(true);
    }
  });
});

describe("listTemplates() — hasUnpublishedChanges (dérivé, pas stocké)", () => {
  // Construit DEUX cas — brouillon identique à l'instantané publié, puis brouillon différent —
  // pour qu'une implémentation qui renverrait toujours true ou toujours false échoue forcément
  // sur l'un des deux tests.
  it("false quand le brouillon est structurellement identique à l'instantané publié", async () => {
    const id = await makeTemplate({
      channel: CHANNEL_UNCHANGED, draft: "Même contenu", published: "Même contenu",
    });
    const row = (await listTemplates()).find((r) => r.id === id);
    if (!row) throw new Error("gabarit introuvable dans listTemplates()");
    expect(row.publishedVersion).toBe(1);
    expect(row.hasUnpublishedChanges).toBe(false);
  });

  it("true quand le brouillon diffère de l'instantané publié", async () => {
    const id = await makeTemplate({
      channel: CHANNEL_CHANGED, categoryId, draft: "Brouillon modifié", published: "Contenu publié",
    });
    const row = (await listTemplates()).find((r) => r.id === id);
    if (!row) throw new Error("gabarit introuvable dans listTemplates()");
    expect(row.publishedVersion).toBe(1);
    expect(row.hasUnpublishedChanges).toBe(true);
    // Vérifie au passage la jointure catégorie, exercée par ce même gabarit.
    expect(row.categoryId).toBe(categoryId);
    expect(row.categoryName).toBe(categoryName);
  });

  // Ceinture-et-bretelles : dans ce dépôt, PostgreSQL canonicalise déjà l'ordre des clés jsonb au
  // stockage (vérifié empiriquement — les deux valeurs relues ont le même ordre quel que soit
  // l'ordre d'écriture), donc ce test ne distingue PAS empiriquement listTemplates() AVEC et SANS
  // le tri récursif de lib/queries/studio.ts:sortKeysDeep(). Il verrouille en revanche une garantie
  // système qui n'est vraie QUE parce que scene/publishedScene sont des colonnes `jsonb` (pas
  // `json`, qui préserverait l'ordre textuel d'origine) — une régression de type de colonne casserait
  // ce test avant de casser silencieusement l'indicateur en production.
  it("false quand seul l'ordre des clés diffère entre le brouillon et l'instantané publié", async () => {
    const id = await makeTemplate({
      channel: CHANNEL_REORDERED_KEYS, draft: "Contenu stable",
      publishedScene: sceneKeysReordered("Contenu stable"),
    });
    const row = (await listTemplates()).find((r) => r.id === id);
    if (!row) throw new Error("gabarit introuvable dans listTemplates()");
    expect(row.publishedVersion).toBe(1);
    expect(row.hasUnpublishedChanges).toBe(false);
  });

  // Décision documentée (voir lib/queries/studio.ts) : un gabarit jamais publié n'a pas
  // d'instantané à comparer. Son brouillon tout entier n'a encore jamais atteint le public — donc
  // hasUnpublishedChanges vaut true, pas false ni indéfini.
  it("true pour un gabarit jamais publié (publishedVersion null)", async () => {
    const id = await makeTemplate({ channel: CHANNEL_NEVER_PUBLISHED, draft: "Jamais publié" });
    const row = (await listTemplates()).find((r) => r.id === id);
    if (!row) throw new Error("gabarit introuvable dans listTemplates()");
    expect(row.publishedVersion).toBeNull();
    expect(row.hasUnpublishedChanges).toBe(true);
  });
});
