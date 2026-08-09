import { describe, it, expect, mock, beforeAll, afterAll } from "bun:test";
import { db, renderTemplates, renderTemplateVersions, user } from "@/db";
import { eq, inArray } from "drizzle-orm";
import { validateScene, type Scene } from "@/lib/studio";
import { createAutosaveController, type SaveResult } from "@/lib/studio/autosave";
import { scenesEqual, shouldShowUnpublishedBadge } from "@/lib/studio/scene-diff";
import { deleteTemplateScope } from "./studio-fixtures";

// ─────────────────────────────────────────────────────────────────────────────
// Petite temporisation réelle (les timers de createAutosaveController sont de VRAIS setTimeout,
// pas une horloge simulée — voir la note du module) : `delayMs` est réduit ici à quelques
// millisecondes pour que ce fichier reste rapide sans réimplémenter d'horloge factice.
const DELAY = 20;
function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
describe("createAutosaveController — différé (spec §3)", () => {
  it("N modifications rapprochées ne produisent qu'UN SEUL appel à save, avec la DERNIÈRE valeur", async () => {
    const calls: number[] = [];
    const save = mock(async (v: number): Promise<SaveResult> => {
      calls.push(v);
      return { ok: true };
    });
    const states: string[] = [];
    const controller = createAutosaveController<number>({
      save, delayMs: DELAY, onChange: (s) => states.push(s.status),
    });

    // Cinq modifications SYNCHRONES rapprochées, comme cinq frappes rapides dans l'éditeur.
    controller.notifyChange(1);
    controller.notifyChange(2);
    controller.notifyChange(3);
    controller.notifyChange(4);
    controller.notifyChange(5);

    // Un sabotage qui appellerait `save` à chaque notifyChange (au lieu de différer) ferait déjà
    // échouer cette assertion AVANT même d'attendre le différé.
    expect(save.mock.calls.length).toBe(0);

    await wait(DELAY + 60);

    expect(save.mock.calls.length).toBe(1);
    expect(calls).toEqual([5]); // la DERNIÈRE valeur, pas la première ni une moyenne
    expect(controller.getState().status).toBe("saved");
    expect(controller.getState().dirty).toBe(false);
    expect(states).toContain("saving");
    expect(states).toContain("saved");

    controller.destroy();
  });

  it("un enregistrement en échec affiche le message ET N'EFFACE PAS l'état sale (dirty)", async () => {
    const save = mock(async (): Promise<SaveResult> => ({ ok: false, message: "Échec réseau simulé." }));
    const controller = createAutosaveController<string>({ save, delayMs: DELAY });

    controller.notifyChange("brouillon modifié");
    expect(controller.getState().dirty).toBe(true); // sale dès la notification, avant même le différé

    await wait(DELAY + 60);

    expect(save.mock.calls.length).toBe(1);
    expect(controller.getState().status).toBe("error");
    expect(controller.getState().message).toBe("Échec réseau simulé.");
    // La garantie testée : un échec ne doit PAS faire retomber `dirty` à false — une implémentation
    // qui effacerait `dirty` inconditionnellement après l'appel à `save` (qu'il ait réussi ou non)
    // ferait échouer CETTE assertion précise, alors que l'assertion `status === "error"` seule
    // aurait pu passer avec un bug pareil.
    expect(controller.getState().dirty).toBe(true);

    controller.destroy();
  });

  it("une exception levée par save() est traitée comme un échec (message capturé, pas de rejet non géré)", async () => {
    const save = mock(async (): Promise<SaveResult> => { throw new Error("Boom réseau"); });
    const controller = createAutosaveController<string>({ save, delayMs: DELAY });

    controller.notifyChange("x");
    await wait(DELAY + 60);

    expect(controller.getState().status).toBe("error");
    expect(controller.getState().message).toBe("Boom réseau");
    expect(controller.getState().dirty).toBe(true);
    controller.destroy();
  });

  it("flush() enregistre immédiatement SANS attendre le différé, et n'entraîne pas un second appel plus tard", async () => {
    const save = mock(async (): Promise<SaveResult> => ({ ok: true }));
    // Délai DÉLIBÉRÉMENT plus long que le temps qu'on attend APRÈS flush() ci-dessous (voir
    // l'assertion finale) : c'est ce qui rend la preuve d'annulation réelle, pas tautologique. Un
    // premier jet de ce test attendait 60 ms après flush() avec un délai de 5000 ms — bien
    // INFÉRIEUR au délai, cette attente n'aurait rien prouvé : le timer d'origine, même NON annulé,
    // n'aurait de toute façon pas eu le temps de se déclencher. Ici on attend DEUX FOIS le délai
    // configuré, ce qui aurait largement laissé le temps à un timer non annulé de se déclencher.
    const controller = createAutosaveController<string>({ save, delayMs: DELAY });

    controller.notifyChange("valeur à publier");
    const res = await controller.flush();

    expect(res).toEqual({ ok: true });
    expect(save.mock.calls.length).toBe(1);
    expect(controller.getState().status).toBe("saved");
    expect(controller.getState().dirty).toBe(false);

    // Le différé a été annulé par flush() — attendre AU-DELÀ du délai d'origine confirme qu'aucun
    // second appel ne survient (un sabotage qui oublierait d'annuler le timer déclencherait un
    // second `save` pendant cette attente, puisqu'elle dépasse largement `delayMs`).
    await wait(DELAY * 2 + 60);
    expect(save.mock.calls.length).toBe(1);

    controller.destroy();
  });

  it("flush() sans modification en attente ne fait rien et renvoie null", async () => {
    const save = mock(async (): Promise<SaveResult> => ({ ok: true }));
    const controller = createAutosaveController<string>({ save, delayMs: DELAY });

    const res = await controller.flush();
    expect(res).toBeNull();
    expect(save.mock.calls.length).toBe(0);
    controller.destroy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("scenesEqual / shouldShowUnpublishedBadge (Tâche 9 — badge « modifications non publiées »)", () => {
  function makeScene(content: string): Scene {
    return {
      schemaVersion: 1,
      canvas: { width: 800, height: 600, background: "#000000" },
      layers: [{
        id: "t", name: "Texte", visible: true, locked: false,
        frame: { x: 10, y: 10, w: 200, h: 80 },
        type: "text", content,
        font: { family: "Noto Sans", size: 24, weight: 400 },
        color: "#FFFFFF", align: "left", vAlign: "top", lineHeight: 1.2,
      }],
    };
  }

  it("deux scènes structurellement identiques sont égales même avec des clés reconstruites dans un ordre différent", () => {
    const a = makeScene("Bonjour");
    // Reconstruit l'objet layer avec les clés dans un ORDRE DIFFÉRENT (comme le ferait un spread
    // `{...layer, ...patch}` du réducteur) — une comparaison JSON.stringify brute échouerait ici.
    const reordered: Scene = {
      ...a,
      layers: [{ ...a.layers[0], color: a.layers[0].type === "text" ? a.layers[0].color : "#FFFFFF" } as typeof a.layers[0]],
    };
    const b: Scene = JSON.parse(JSON.stringify({
      layers: [Object.fromEntries(Object.entries(reordered.layers[0]).reverse())],
      canvas: reordered.canvas,
      schemaVersion: reordered.schemaVersion,
    }));
    expect(scenesEqual(a, b)).toBe(true);
  });

  it("deux scènes de contenu différent ne sont PAS égales", () => {
    expect(scenesEqual(makeScene("A"), makeScene("B"))).toBe(false);
  });

  it("pas de badge sur un gabarit JAMAIS publié, même si le brouillon diffère de toute autre scène (revue Lot 1)", () => {
    const draft = makeScene("Brouillon jamais publié");
    // publishedVersion === null : même si on lui fournissait par erreur une scène "publiée" à
    // comparer, le badge ne doit PAS s'afficher — c'est exactement le bug de la revue Lot 1 (un
    // gabarit neuf affichant À LA FOIS « Brouillon » et « modifications non publiées »).
    expect(shouldShowUnpublishedBadge(null, draft, makeScene("Autre chose"))).toBe(false);
  });

  it("pas de badge quand le brouillon est identique à l'instantané publié", () => {
    const scene = makeScene("Identique");
    expect(shouldShowUnpublishedBadge(1, scene, scene)).toBe(false);
  });

  it("badge affiché quand le gabarit est publié ET que le brouillon diverge", () => {
    expect(shouldShowUnpublishedBadge(1, makeScene("Modifié depuis"), makeScene("Version publiée"))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// publishTemplate — refus liste les erreurs de validateScene (spec §8 : « liste des erreurs de
// validateScene affichée champ par champ »). Même recette de mock que
// tests/studio-template-actions.test.ts (capturer les vrais exports AVANT de les mocker, importer
// studio-actions.ts DYNAMIQUEMENT pour que ses imports statiques résolvent contre les mocks).
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

const { publishTemplate } = await import("@/lib/actions/studio-actions");

// Portée STATIQUE possédée par ce fichier (voir tests/studio-fixtures.ts pour la règle et le
// registre) : (recap_card, "test-autosave-publish-refuse", null). "recap_card" n'a aucun gabarit de
// départ semé (db/studio-templates.ts), comme les autres fichiers qui l'utilisent déjà.
const CH_PUBLISH_REFUSE = "test-autosave-publish-refuse";

const templateIds: string[] = [];

describe("publishTemplate — le refus liste les erreurs de validateScene (spec §8)", () => {
  let row: { id: string };

  beforeAll(async () => {
    await deleteTemplateScope("recap_card", CH_PUBLISH_REFUSE, null);
    // Deux violations DISTINCTES dans la même scène : un jeton hors contexte (article.url n'est
    // pas dans CONTEXT_TOKENS.recap_card) ET un jeton de mauvais type (category.color, une couleur,
    // utilisé là où le contenu texte attend un jeton "text"). validateScene doit relever les DEUX.
    const scene = {
      schemaVersion: 1,
      canvas: { width: 1080, height: 1080, background: "#111111" },
      layers: [
        { id: "a", name: "A", visible: true, locked: false, frame: { x: 0, y: 0, w: 100, h: 40 },
          type: "text", content: "{{article.url}}",
          font: { family: "Noto Sans", size: 24, weight: 400 },
          color: "#FFFFFF", align: "left", vAlign: "top", lineHeight: 1.2 },
        { id: "b", name: "B", visible: true, locked: false, frame: { x: 0, y: 50, w: 100, h: 40 },
          type: "text", content: "{{category.color}}",
          font: { family: "Noto Sans", size: 24, weight: 400 },
          color: "#FFFFFF", align: "left", vAlign: "top", lineHeight: 1.2 },
      ],
    };
    const [r] = await db.insert(renderTemplates).values({
      name: "Gabarit Refus Publication", context: "recap_card", channel: CH_PUBLISH_REFUSE, categoryId: null,
      format: "ig_square", width: 1080, height: 1080, scene,
    }).returning({ id: renderTemplates.id });
    row = r;
    templateIds.push(r.id);
  });

  afterAll(async () => {
    mock.module("@/lib/session", () => ({ getSession: realGetSession, requireUser: realRequireUser }));
    mock.module("next/cache", () => ({ revalidatePath: realRevalidatePath, revalidateTag: realRevalidateTag }));
    if (templateIds.length) await db.delete(renderTemplates).where(inArray(renderTemplates.id, templateIds));
  });

  it("le message de refus est EXACTEMENT les erreurs de validateScene, jointes — donc affichable champ par champ", async () => {
    const [tpl] = await db.select({ scene: renderTemplates.scene, context: renderTemplates.context })
      .from(renderTemplates).where(eq(renderTemplates.id, row.id));
    const expectedErrors = validateScene(tpl.scene as Scene, tpl.context as never);
    // Le sabotage évident (« oublie un des deux jetons fautifs ») ferait échouer CETTE assertion :
    // au moins deux erreurs distinctes, une par calque fautif.
    expect(expectedErrors.length).toBeGreaterThanOrEqual(2);

    const res = await publishTemplate(row.id);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    // L'éditeur (Tâche 9) affiche cette liste champ par champ en la reproduisant lui-même via
    // validateScene(scene, context) côté client (voir components/studio/editor-shell.tsx) — cette
    // assertion vérifie que le message renvoyé par l'action correspond EXACTEMENT à cette même
        // liste, pas une approximation, pour que les deux restent en accord.
    expect(res.message).toBe(expectedErrors.join(" "));
    for (const err of expectedErrors) expect(res.message).toContain(err);

    // Aucune version ni publishedVersion posée — le refus n'a rien écrit.
    const versions = await db.select().from(renderTemplateVersions).where(eq(renderTemplateVersions.templateId, row.id));
    expect(versions).toHaveLength(0);
  });
});
