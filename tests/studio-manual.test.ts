import { describe, it, expect, mock, beforeAll, afterAll } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { db, renderTemplates, renderTemplateVersions, renders, wpCategories, user } from "@/db";
import { eq, inArray, sql } from "drizzle-orm";
import { parseScene, type Scene } from "@/lib/studio/scene";
import { CONTEXT_TOKENS, TOKEN_KINDS } from "@/lib/studio/tokens";
import { MissingTokensError } from "@/lib/studio/values";
import { MemoryRenderStore } from "@/lib/studio/store";
import { fieldsForContext, MANUAL_CONTEXTS } from "@/lib/studio/manual-form";
import { renderManualCore } from "@/lib/studio/manual-core";
import { ManualGenerate } from "@/components/studio/manual-generate";
import { deleteTemplateScope } from "./studio-fixtures";

// tests/studio-manual.test.ts — Tâche 14 (spec §7) : /studio/generer et renderManualCore.
//
// ─────────────────────────────────────────────────────────────────────────────
// A. fieldsForContext — dérivation PURE, jamais une liste à part (brief : « assert derivation, not a
// hard-coded list »). Comparée DIRECTEMENT à CONTEXT_TOKENS[context] (le catalogue V1 lui-même), pas
// à une copie maintenue ici : un hard-coding de la liste de champs dans lib/studio/manual-form.ts ne
// pourrait PAS passer les trois itérations de la boucle ci-dessous en même temps, puisque les trois
// contextes manuels ont des ensembles de jetons structurellement DIFFÉRENTS (second test, le
// « témoin de sabotage »).
describe("fieldsForContext — dérivé de CONTEXT_TOKENS pour CHACUN des trois contextes manuels", () => {
  it("l'ensemble des champs == CONTEXT_TOKENS[context], chaque champ typé par TOKEN_KINDS", () => {
    for (const context of MANUAL_CONTEXTS) {
      const fields = fieldsForContext(context);
      expect(fields.map((f) => f.token).sort()).toEqual([...CONTEXT_TOKENS[context]].sort());
      for (const f of fields) expect(f.kind).toBe(TOKEN_KINDS[f.token]);
    }
  });

  it("témoin de sabotage : les trois contextes manuels ont des ensembles de jetons DISTINCTS deux à deux", () => {
    // Si ce n'était pas vrai, une implémentation qui renverrait TOUJOURS la même liste fixe pourrait
    // passer le test ci-dessus pour les trois contextes à la fois — ce test prouve que ce n'est
    // structurellement pas possible ici.
    const sets = MANUAL_CONTEXTS.map((c) => [...CONTEXT_TOKENS[c]].sort());
    for (let i = 0; i < sets.length; i++) {
      for (let j = i + 1; j < sets.length; j++) expect(sets[i]).not.toEqual(sets[j]);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. Le VRAI composant (react-dom/server, comme tests/studio-property-panel.test.ts et
// tests/studio-token-picker.test.ts — pas de DOM sous `bun test`) : preuve que le formulaire RENDU
// affiche exactement l'ensemble attendu de data-field, pas seulement que la fonction pure sous-jacente
// le calcule correctement. `initialContext` (amorce de test, voir components/studio/manual-generate.tsx)
// permet d'exercer les TROIS contextes depuis un rendu statique.
describe("ManualGenerate — le formulaire RENDU affiche un data-field par jeton de CONTEXT_TOKENS[context], et AUCUN autre", () => {
  const ALL_MANUAL_TOKENS = new Set(MANUAL_CONTEXTS.flatMap((c) => CONTEXT_TOKENS[c]));

  for (const context of MANUAL_CONTEXTS) {
    it(`contexte « ${context} »`, () => {
      const html = renderToStaticMarkup(
        React.createElement(ManualGenerate, { assets: [], categories: [], storageConfigured: true, initialContext: context }),
      );
      const expected = new Set(CONTEXT_TOKENS[context]);
      for (const token of expected) {
        expect(html).toContain(`data-field="${token}"`);
      }
      // Négatif : aucun jeton EXCLUSIF d'un AUTRE contexte manuel ne doit apparaître — c'est ce qui
      // ferait échouer un composant qui afficherait toujours les champs du PREMIER contexte
      // (MANUAL_CONTEXTS[0]) quel que soit `initialContext`.
      for (const token of ALL_MANUAL_TOKENS) {
        if (!expected.has(token)) expect(html).not.toContain(`data-field="${token}"`);
      }
    });
  }

  it("bannière de lecture seule visible et le bouton *Générer* désactivé quand storageConfigured=false (Tâche 15)", () => {
    const html = renderToStaticMarkup(
      React.createElement(ManualGenerate, { assets: [], categories: [], storageConfigured: false }),
    );
    expect(html).toContain('data-testid="storage-banner"');
    const btn = /<button[^>]*data-action="generate"[^>]*>/.exec(html);
    expect(btn).not.toBeNull();
    expect(btn![0]).toContain("disabled");
  });

  it("le bouton *Générer* n'est PAS désactivé par storageConfigured quand le stockage est configuré (mais reste désactivé tant que les champs sont vides — comportement séparé)", () => {
    const html = renderToStaticMarkup(
      React.createElement(ManualGenerate, { assets: [], categories: [], storageConfigured: true }),
    );
    // Toujours désactivé ICI (aucun champ rempli), mais la RAISON ne doit pas être storageConfigured
    // — vérifié en confirmant l'absence de la bannière, seul signal visible de cette cause-là.
    expect(html).not.toContain('data-testid="storage-banner"');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C. renderManualCore — comportement réel (base + rendu), MemoryRenderStore (jamais R2 réel — voir
// plus bas pourquoi c'est aussi vrai pour le test RBAC de la section D).
function recapScene(): Scene {
  // Un SEUL calque texte, un SEUL jeton (recap.title) — délibéré : ni image ni réseau requis pour
  // exercer le chemin heureux ET le chemin « valeurs manquantes », comme
  // tests/studio-preview.test.ts:recapScene().
  return parseScene({
    schemaVersion: 1,
    canvas: { width: 600, height: 300, background: "#101010" },
    layers: [{
      id: "title", name: "Titre", visible: true, locked: false, frame: { x: 20, y: 20, w: 560, h: 100 },
      type: "text", content: "{{recap.title}}",
      font: { family: "Noto Sans", size: 32, weight: 700 }, color: "#FFFFFF",
      align: "left", vAlign: "top", lineHeight: 1.2,
    }],
  });
}

const templateIds: string[] = [];
const renderIds: string[] = [];
let categoryId: string;
let fixtureTemplateId: string;

async function rendersCount(): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)` }).from(renders);
  return Number(row.n);
}

beforeAll(async () => {
  // Portée finale par construction (resolve.ts) de tout appel (recap_card, *, *) sans correspondance
  // plus précise — supprimée défensivement AVANT usage, même motif que
  // tests/studio-template-actions.test.ts pour cette même portée (voir tests/studio-fixtures.ts).
  // Rien n'est inséré ici : ce test ne fait que VÉRIFIER son absence.
  await deleteTemplateScope("recap_card", null, null);

  const [c] = await db.insert(wpCategories).values({
    name: `Studio manuel ${Date.now()}`, slug: `studio-manuel-${Date.now()}`,
  }).returning();
  categoryId = c.id;

  // Gabarit PUBLIÉ à une portée (recap_card, null, <categoryId frais>) — resolveTemplate() la
  // trouve au PREMIER niveau (« !channel && categoryId »), donc jamais besoin de dépendre de l'état
  // de (recap_card, null, null) pour ce chemin-là.
  const scene = recapScene();
  const [t] = await db.insert(renderTemplates).values({
    name: "Manuel — récap", context: "recap_card", channel: null, categoryId,
    format: "ig_square", width: 600, height: 300, scene,
  }).returning();
  fixtureTemplateId = t.id;
  templateIds.push(fixtureTemplateId);
  await db.insert(renderTemplateVersions).values({ templateId: fixtureTemplateId, version: 1, scene });
  await db.update(renderTemplates).set({ publishedVersion: 1 }).where(eq(renderTemplates.id, fixtureTemplateId));
});

afterAll(async () => {
  if (renderIds.length) await db.delete(renders).where(inArray(renders.id, renderIds));
  if (templateIds.length) await db.delete(renderTemplates).where(inArray(renderTemplates.id, templateIds));
  if (categoryId) await db.delete(wpCategories).where(eq(wpCategories.id, categoryId));
});

describe("renderManualCore — écrit exactement une ligne `renders` (subjectType: \"manual\", subjectId: null)", () => {
  it("chemin heureux : R2 (MemoryRenderStore) + une ligne `renders`", async () => {
    const before = await rendersCount();
    const store = new MemoryRenderStore();

    const res = await renderManualCore({
      context: "recap_card", channel: null, categoryId, values: { "recap.title": "Cette semaine en Afrique" }, store,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.degraded).toBe(false);
    expect(res.url).toContain("memory://");
    expect(store.objects.size).toBe(1); // l'objet R2 (ici en mémoire) a bien été écrit — pas un faux succès.
    renderIds.push(res.renderId);

    const after = await rendersCount();
    expect(after).toBe(before + 1); // EXACTEMENT une ligne de plus, pas zéro, pas deux.

    const [row] = await db.select().from(renders).where(eq(renders.id, res.renderId));
    expect(row).toBeDefined();
    expect(row!.subjectType).toBe("manual");
    expect(row!.subjectId).toBeNull();
    expect(row!.context).toBe("recap_card");
    expect(row!.templateId).toBe(fixtureTemplateId);
  });

  it("un second appel IDENTIQUE ne réécrit pas — court-circuit par inputHash, la ligne reste unique", async () => {
    const store = new MemoryRenderStore();
    const first = await renderManualCore({
      context: "recap_card", channel: null, categoryId, values: { "recap.title": "Valeur stable" }, store,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    renderIds.push(first.renderId);

    const before = await rendersCount();
    const second = await renderManualCore({
      context: "recap_card", channel: null, categoryId, values: { "recap.title": "Valeur stable" }, store: new MemoryRenderStore(),
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.renderId).toBe(first.renderId); // même ligne, pas une nouvelle.
    const after = await rendersCount();
    expect(after).toBe(before);
  });
});

describe("renderManualCore — valeurs manquantes : le message FRANÇAIS du moteur (MissingTokensError), tel quel", () => {
  it("aucune valeur fournie pour recap.title → message EXACT de MissingTokensError, aucune écriture", async () => {
    const before = await rendersCount();
    const res = await renderManualCore({
      context: "recap_card", channel: null, categoryId, values: {}, store: new MemoryRenderStore(),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    // Comparaison EXACTE (pas juste .toContain) : c'est littéralement le message que
    // lib/studio/values.ts:MissingTokensError construit pour ce jeton précis — la garantie que le
    // brief Tâche 14 demande (« missing values produce the engine's French message »).
    expect(res.message).toBe(new MissingTokensError(["recap.title"]).message);
    expect(res.message).toBe("Valeurs manquantes pour : recap.title.");
    const after = await rendersCount();
    expect(after).toBe(before); // un échec de rendu n'écrit RIEN.
  });
});

describe("renderManualCore — aucun gabarit publié pour ce contexte : message explicite pointant vers l'éditeur, pas un état vide silencieux", () => {
  it("(recap_card, null, null) — le repli final de resolveTemplate — est bien vide, et le message le dit", async () => {
    const res = await renderManualCore({
      context: "recap_card", channel: null, categoryId: null,
      values: { "recap.title": "Peu importe" }, store: new MemoryRenderStore(),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain("Aucun gabarit publié");
    expect(res.message).toContain("Studio"); // pointe explicitement vers l'éditeur, pas un simple "échec".
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D. renderManual — action gardée (RBAC). Utilise DÉLIBÉRÉMENT la portée « aucun gabarit publié »
// ci-dessus (recap_card, null, null) : renderManualCore s'arrête AVANT tout accès à
// R2RenderStore.put() dans ce cas précis (aucun gabarit trouvé), donc ce test reste sûr même si des
// identifiants R2 RÉELS sont présents dans l'environnement ambiant du développeur (contrairement à
// tests/studio-config.test.ts, cette action n'accepte PAS de `store` de test — c'est
// STRUCTURELLEMENT la seule scène où l'appeler pour de vrai, sans risque réseau). La couverture du
// rendu RÉUSSI (écriture R2 + `renders`) est déjà assurée ci-dessus, via renderManualCore directement
// avec un MemoryRenderStore injecté — même partition que tests/studio-preview.test.ts entre les
// tests de COMPORTEMENT (Core, en direct) et le test RBAC (l'action gardée, guard seulement).
const { requireUser: realRequireUser, getSession: realGetSession } = await import("@/lib/session");

const [seededEditor] = await db.select({ id: user.id, role: user.role })
  .from(user).where(eq(user.email, "editor@afrotiative.com"));
if (!seededEditor) throw new Error("Seed manquant : editor@afrotiative.com introuvable (bun run db:seed).");
const FAKE_EDITOR = {
  id: seededEditor.id, name: "Test Éditeur", email: "editor@afrotiative.com",
  role: seededEditor.role, banned: false, image: null,
};

const [seededJournalist] = await db.select({ id: user.id, role: user.role })
  .from(user).where(eq(user.email, "journaliste@afrotiative.com"));
if (!seededJournalist) throw new Error("Seed manquant : journaliste@afrotiative.com introuvable (bun run db:seed).");
const FAKE_JOURNALIST = {
  id: seededJournalist.id, name: "Test Journaliste", email: "journaliste@afrotiative.com",
  role: seededJournalist.role, banned: false, image: null,
};

describe("renderManual — action gardée (RBAC, template:manage)", () => {
  afterAll(() => {
    mock.module("@/lib/session", () => ({ getSession: realGetSession, requireUser: realRequireUser }));
  });

  it("refuse un journaliste (rejette AVANT toute logique de rendu, aucun résultat renvoyé)", async () => {
    mock.module("@/lib/session", () => ({ getSession: realGetSession, requireUser: async () => FAKE_JOURNALIST }));
    const { renderManual } = await import("@/lib/actions/studio-manual-actions");
    await expect(renderManual({
      context: "recap_card", channel: null, categoryId: null, values: { "recap.title": "x" },
    })).rejects.toThrow();
  });

  it("autorise un éditeur et délègue bien à renderManualCore (jamais le message d'une garde RBAC bloquée)", async () => {
    mock.module("@/lib/session", () => ({ getSession: realGetSession, requireUser: async () => FAKE_EDITOR }));
    const { renderManual } = await import("@/lib/actions/studio-manual-actions");
    const res = await renderManual({
      context: "recap_card", channel: null, categoryId: null, values: { "recap.title": "x" },
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    // Deux issues sont légitimes ici selon que l'environnement AMBIANT a ou non de vraies variables
    // R2_* exportées (ce fichier ne les touche jamais, exprès — voir la note plus haut sur le risque
    // réseau réel) : « Stockage R2 non configuré. » (le premier contrôle de renderManualCore, si R2
    // est absent — le cas de CET environnement de développement, vérifié empiriquement) ou « Aucun
    // gabarit publié… » (si R2 EST configuré ambiante, le contrôle suivant : cette portée est vide
    // par construction, section C ci-dessus). Les DEUX prouvent la même chose — l'éditeur a bien
    // atteint renderManualCore, la garde RBAC ne l'a PAS bloqué — ce que le test suivant (journaliste)
    // prouve par contraste (rejet AVANT même ce premier contrôle). Le seul résultat qui ferait
    // échouer ce test est un message de PermissionError (lib/rbac.ts), qui n'apparaît ni dans l'un ni
    // dans l'autre.
    expect(["Stockage R2 non configuré.", "Aucun gabarit publié pour ce contexte. Créez-en un et publiez-le depuis Studio → Gabarits avant de générer."]).toContain(res.message);
  });
});
