import { describe, it, expect, mock, beforeAll, afterAll } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  handleTabOpen, PreviewTabContent, type PreviewState, type PreviewStatus,
} from "@/components/article/image-panel";
import type { RenderForArticleResult } from "@/lib/studio";
import type { Role } from "@/lib/auth";

// setTimeout(0), pas un décompte de `await Promise.resolve()` : la macro-tâche garantit que TOUTE
// la chaîne de micro-tâches (résolution de promesse + .then() + réassignation de `state`) s'est
// déjà écoulée, sans dépendre d'un nombre de ticks fragile face à l'implémentation (fonction async
// vs. Promise nue, moteur JS, etc.).
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// Boîte mutable plutôt qu'un `let state` réassigné directement : TypeScript n'invalide PAS le
// rétrécissement de type d'une variable `let` à travers un appel de fonction qui la réassigne
// seulement via une fermeture capturée ailleurs (limitation connue du contrôle de flux — vérifié
// empiriquement : `state.status` reste figé au type littéral de l'initialisation même après un
// appel qui la fait réellement changer). Rétrécir une PROPRIÉTÉ d'objet (`box.state.status`) après
// un appel de fonction n'a pas ce problème.
function makeBox(): { state: PreviewState } {
  return { state: { status: "idle" } };
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 1 — handleTabOpen (composants/article/image-panel.tsx) : la garantie « exactement un
// rendu à l'ouverture, aucun à la réouverture » (spec V3 §1, exigée explicitement par la brief de
// Tâche 2). Fonction PURE testée directement, sans DOM ni simulation de clic — `bun test` n'a pas
// de DOM (même convention que tests/studio-layer-panel.test.ts) ; le composant réel appelle CETTE
// MÊME fonction depuis Tabs.onValueChange (voir image-panel.tsx), donc ce test exerce le code
// réellement exécuté au clic, pas une réimplémentation parallèle.
// ─────────────────────────────────────────────────────────────────────────────
describe("handleTabOpen — chargement à la demande de l'onglet « Aperçu final »", () => {
  it("l'ouverture de l'onglet « Aperçu final » déclenche EXACTEMENT un appel ; une réouverture n'en déclenche aucun", async () => {
    const box = makeBox();
    const setState = (s: PreviewState) => { box.state = s; };
    let calls = 0;
    const fetchPreview = async (_articleId: string): Promise<RenderForArticleResult> => {
      calls++;
      return { ok: true, url: "https://cdn.example.test/preview.png", renderId: "render-1", degraded: false };
    };

    // Ouvrir l'onglet "original" (le premier affiché par défaut) : jamais de rendu déclenché,
    // quel que soit son propre statut — seul "final" doit importer.
    handleTabOpen("original", box.state.status, setState, "article-1", fetchPreview);
    expect(calls).toBe(0);
    expect(box.state.status).toBe("idle");

    // Premier passage sur "final" : déclenche l'appel. `status` bascule sur "loading" AVANT même
    // que la promesse ne se résolve — c'est cette bascule synchrone qui empêche une réouverture
    // immédiate de repasser la garde pendant que le premier appel est encore en vol.
    handleTabOpen("final", box.state.status, setState, "article-1", fetchPreview);
    expect(calls).toBe(1);
    expect(box.state.status).toBe("loading");

    await flushMicrotasks();
    expect(box.state.status).toBe("done");
    if (box.state.status !== "done") throw new Error("état inattendu");
    expect(box.state.result).toEqual({ ok: true, url: "https://cdn.example.test/preview.png", renderId: "render-1", degraded: false });

    // Réouverture (retour sur "original" puis re-clic sur "final", comme un vrai utilisateur) :
    // AUCUN second appel — c'est le coeur de l'exigence, et un simple test « le contenu s'affiche »
    // ne le prouverait pas : seul un compteur d'appels comme celui-ci peut le faire.
    handleTabOpen("original", box.state.status, setState, "article-1", fetchPreview);
    handleTabOpen("final", box.state.status, setState, "article-1", fetchPreview);
    expect(calls).toBe(1);
  });

  it("un second appel PENDANT que le premier est encore en vol ne repasse pas la garde", async () => {
    const box = makeBox();
    const setState = (s: PreviewState) => { box.state = s; };
    let calls = 0;
    let resolveFirst!: (r: RenderForArticleResult) => void;
    const fetchPreview = async (_articleId: string): Promise<RenderForArticleResult> => {
      calls++;
      return new Promise<RenderForArticleResult>((resolve) => { resolveFirst = resolve; });
    };

    handleTabOpen("final", box.state.status, setState, "article-1", fetchPreview);
    // Le composant relit `preview.status` (désormais "loading") à chaque nouveau rendu — on
    // simule ici un second déclenchement avant résolution, avec le statut à jour.
    handleTabOpen("final", box.state.status, setState, "article-1", fetchPreview);
    expect(calls).toBe(1);

    resolveFirst({ ok: true, url: null, renderId: null, degraded: false });
    await flushMicrotasks();
    expect(box.state.status).toBe("done");
  });

  it("un échec de transport (promesse rejetée) affiche un message français, sans lever", async () => {
    const box = makeBox();
    const setState = (s: PreviewState) => { box.state = s; };
    const fetchPreview = async (): Promise<RenderForArticleResult> => { throw new Error("network down"); };

    handleTabOpen("final", box.state.status, setState, "article-1", fetchPreview);
    await flushMicrotasks();
    expect(box.state.status).toBe("done");
    if (box.state.status !== "done") throw new Error("état inattendu");
    expect(box.state.result.ok).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 2 — PreviewTabContent : les quatre états explicites du tableau spec V3 §1, rendus en
// HTML statique (react-dom/server) — même convention que tests/studio-token-picker.test.ts et
// tests/studio-layer-panel.test.ts (pas de DOM sous `bun test`).
// ─────────────────────────────────────────────────────────────────────────────
function renderPreview(state: PreviewState): string {
  return renderToStaticMarkup(React.createElement(PreviewTabContent, { state }));
}

describe("PreviewTabContent — les quatre états explicites", () => {
  it("aucun gabarit résolu (ok:true, url:null) affiche le texte explicatif, PAS une erreur", () => {
    const html = renderPreview({
      status: "done", result: { ok: true, url: null, renderId: null, degraded: false },
    });
    expect(html).toContain("Aucun gabarit configuré");
    expect(html).toContain("l&#x27;image originale sera publiée telle quelle");
    // Ne doit JAMAIS emprunter la mise en forme "erreur" (icône ImageOff, texte pending) réservée
    // au cas ok:false — un test qui se contenterait de vérifier un texte de bienvenue générique ne
    // distinguerait pas ce cas d'un rendu cassé qui afficherait malgré tout un message quelconque.
    expect(html).not.toContain("échouée");
    expect(html).not.toContain("R2 non configuré");
  });

  it("rendu disponible affiche l'image ET la mention du gabarit", () => {
    const html = renderPreview({
      status: "done",
      result: { ok: true, url: "https://cdn.example.test/x.png", renderId: "r1", degraded: false },
    });
    expect(html).toContain('src="https://cdn.example.test/x.png"');
    expect(html).toContain("gabarit");
  });

  // Tâche 4 (V1 §3 dette assignée à V3) a remplacé l'affichage "tel quel" du message technique par
  // une traduction en champs reconnaissables (friendlyPreviewMessage, image-panel.tsx) — voir
  // tests/article-preview-incomplete.test.ts pour la couverture dédiée de cette traduction. Ce test
  // vérifie ici seulement que PreviewTabContent y fait bien appel (pas les jetons bruts à l'écran).
  it("informations manquantes (ok:false) affiche les champs reconnaissables, pas les jetons techniques", () => {
    const html = renderPreview({
      status: "done",
      result: { ok: false, message: "Génération de l'image échouée — Valeurs manquantes pour : article.image, category.name." },
    });
    expect(html).toContain("Informations manquantes");
    expect(html.toLowerCase()).toContain("image à la une");
    expect(html).toContain("Catégorie");
    expect(html).not.toContain("article.image");
    expect(html).not.toContain("category.name");
  });

  it("stockage R2 non configuré (ok:false) affiche EXACTEMENT le message du moteur", () => {
    const html = renderPreview({ status: "done", result: { ok: false, message: "Stockage R2 non configuré." } });
    expect(html).toContain("Stockage R2 non configuré.");
  });

  it("idle et loading affichent un état d'attente, aucun des quatre états finaux", () => {
    for (const status of ["idle", "loading"] as PreviewStatus[]) {
      const html = renderPreview({ status } as PreviewState);
      expect(html).toContain("Génération de l&#x27;aperçu");
      expect(html).not.toContain("Aucun gabarit configuré");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 3 — previewArticleImage (lib/actions/article-preview-actions.ts) : garde RBAC. Même
// recette mock.module() qu'ailleurs dans cette suite (tests/queue-actions.test.ts,
// tests/studio-template-actions.test.ts) : capturer les vrais exports de @/lib/session AVANT de
// les mocker, importer dynamiquement l'action APRÈS le mock pour que ses imports statiques
// résolvent contre lui, restaurer en afterAll pour ne rien laisser fuir vers les fichiers suivants
// du même process `bun test`.
//
// previewArticleImage n'écrit RIEN et ne référence jamais user.id (contrairement à bulkReject qui
// insère une révision avec un actorId réel) — un utilisateur FABRIQUÉ, sans ligne en base, suffit
// donc ici ; aucun des trois rôles RÉELS (journalist/editor/admin) ne manque article:edit (voir
// tests/rbac.test.ts : "journalist can create/edit"), donc le rôle "sans permission" ci-dessous est
// nécessairement synthétique — il exerce isolément le chemin requirePermission(), qui doit lever
// AVANT tout appel à renderForArticle (donc avant tout accès DB).
// ─────────────────────────────────────────────────────────────────────────────
const { requireUser: realRequireUser, getSession: realGetSession } = await import("@/lib/session");

function fakeUser(role: Role) {
  return { id: "fake-user-id", name: "Test", email: "test@afrotiative.test", role, banned: false, image: null };
}

mock.module("@/lib/session", () => ({ getSession: realGetSession, requireUser: async () => fakeUser("editor") }));
const { previewArticleImage } = await import("@/lib/actions/article-preview-actions");

describe("previewArticleImage — RBAC", () => {
  afterAll(() => {
    mock.module("@/lib/session", () => ({ getSession: realGetSession, requireUser: realRequireUser }));
  });

  it("refuse un rôle sans article:edit, sans jamais atteindre renderForArticle", async () => {
    mock.module("@/lib/session", () => ({
      getSession: realGetSession,
      // Rôle synthétique ("guest") : absent de la matrice RBAC (lib/rbac.ts), donc can() renvoie
      // false et requirePermission lève — exactement le comportement d'un rôle sans la permission,
      // qu'aucun des trois rôles réellement seedés ne peut reproduire (les trois ont article:edit).
      requireUser: async () => fakeUser("guest" as unknown as Role),
    }));
    // Un identifiant manifestement invalide : si le refus n'avait PAS lieu avant l'accès DB, cet
    // appel échouerait de toute façon, mais pour la MAUVAISE raison (erreur SQL, pas PermissionError)
    // — .rejects.toThrow() seul ne distinguerait pas les deux, d'où l'assertion de message ci-dessous.
    await expect(previewArticleImage("id-invalide-non-uuid")).rejects.toThrow(/autorisée/);
  });

  it("un éditeur (qui a article:edit) n'est pas refusé par la garde RBAC", async () => {
    mock.module("@/lib/session", () => ({ getSession: realGetSession, requireUser: async () => fakeUser("editor") }));
    // Ne vérifie PAS le résultat (dépend de l'état réel de la base / de R2) — seulement que la
    // garde elle-même ne lève pas pour ce rôle. Un article inexistant renvoie proprement
    // { ok: false, message: "Article introuvable." }, jamais une exception RBAC.
    const result = await previewArticleImage("00000000-0000-0000-0000-000000000000");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("résultat inattendu");
    expect(result.message).not.toMatch(/autorisée/);
  });
});
