import { describe, expect, it } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SaveIndicator, saveIndicatorLabel, saveIndicatorOffersRetry } from "@/components/studio/save-indicator";
import { createAutosaveController, type SaveResult, type SaveStatus } from "@/lib/studio/autosave";

// tests/studio-save-indicator.test.ts — Tâche 7 (U1, spec §8) : l'indicateur d'enregistrement quitte
// l'en-tête pour se poser à côté de ModeSwitch (voir components/studio/editor-shell.tsx), avec un
// TROISIÈME état qui n'existait pas avant cette tâche : « Échec — réessayer ». `saveIndicatorLabel`
// et `saveIndicatorOffersRetry` sont des exports PURS (aucun DOM, aucun import React nécessaire pour
// les appeler) — cette suite n'a ni jsdom ni React Testing Library, donc c'est ce qui les rend
// vérifiables ici sans harnais.
//
// Défaut du brief corrigé (voir le rapport de la Tâche 7) : le premier jet de
// `saveIndicatorLabel("idle")` renvoyait la MÊME chaîne que "saved" (« Enregistré »), ce qui aurait
// fait échouer « has a distinct French label for each status » (Set.size === 4) — un piège du brief
// lui-même, laissé pour ce test. "idle" possède désormais son propre libellé (« En attente ») : c'est
// l'état RÉEL emprunté par le contrôleur (lib/studio/autosave.ts#runPendingSave) quand un enregistrement
// vient de RÉUSSIR mais qu'une modification plus récente est déjà en attente (`hasPending` remis à
// true) — ni « en cours » (aucun enregistrement en vol à cet instant précis) ni « enregistré » (le
// serveur ne détient pas encore cette dernière valeur), donc un troisième mot est le bon choix, pas
// une réutilisation d'un des trois libellés déjà pris.
function render(status: SaveStatus, onRetry: () => void = () => {}) {
  return renderToStaticMarkup(React.createElement(SaveIndicator, { status, onRetry }));
}

// fixtureAutosave — scaffolding de test LOCAL (voir le plan : « la forme dépend de la façon dont
// l'implémenteur rend », donc pas donné par le brief). Construit un VRAI createAutosaveController
// (jamais une doublure ad hoc du contrôleur — la propriété testée porte justement sur son
// comportement réel) et arme UN SEUL changement en attente au départ, pour que `flush()` ait quelque
// chose à enregistrer sans que le test lui-même n'ait besoin d'appeler `notifyChange` deux fois.
function fixtureAutosave(opts: { onSave: () => SaveResult | Promise<SaveResult> }) {
  return createAutosaveController<{ seq: number }>({
    save: async () => opts.onSave(),
    delayMs: 20,
  });
}

describe("save indicator — libellés et affordance de réessai (purs, spec §8)", () => {
  it("has a distinct French label for each status", () => {
    const labels = (["idle", "saving", "saved", "error"] as const).map(saveIndicatorLabel);
    expect(new Set(labels).size).toBe(4);
    expect(saveIndicatorLabel("saving")).toMatch(/Enregistrement/);
    expect(saveIndicatorLabel("saved")).toMatch(/Enregistré/);
    expect(saveIndicatorLabel("error")).toMatch(/Échec/);
  });

  it("offers retry ONLY on error — this is the affordance that does not exist today", () => {
    expect(saveIndicatorOffersRetry("error")).toBe(true);
    for (const s of ["idle", "saving", "saved"] as const) {
      expect(saveIndicatorOffersRetry(s)).toBe(false);
    }
  });

  it("retry re-attempts the same scene without requiring an edit first", async () => {
    const attempts: number[] = [];
    const ctl = fixtureAutosave({
      onSave: () => {
        attempts.push(1);
        return { ok: false, message: "réseau" };
      },
    });

    // UNE seule notification, jamais répétée : la propriété testée est justement que `retry()` n'a
    // besoin d'AUCUNE seconde notification pour redéclencher un enregistrement.
    ctl.notifyChange({ seq: 1 });

    await ctl.flush();
    expect(attempts).toHaveLength(1);
    expect(ctl.getState().status).toBe("error");

    await ctl.retry(); // aucune mutation de scène entre les deux lignes ci-dessus et celle-ci
    expect(attempts).toHaveLength(2);

    ctl.destroy();
  });

  it("retry ne fait rien si le dernier enregistrement n'a PAS échoué — rien à réessayer", async () => {
    const attempts: number[] = [];
    const ctl = fixtureAutosave({
      onSave: () => {
        attempts.push(1);
        return { ok: true };
      },
    });
    ctl.notifyChange({ seq: 1 });
    await ctl.flush();
    expect(attempts).toHaveLength(1);
    expect(ctl.getState().status).toBe("saved");

    const res = await ctl.retry();
    expect(res).toBeNull();
    expect(attempts).toHaveLength(1); // toujours un seul appel : retry() n'a rien rejoué

    ctl.destroy();
  });
});

describe("SaveIndicator — rendu (précédent tests/studio-mode-switch.test.ts)", () => {
  it("affiche, pour chaque statut, EXACTEMENT le libellé importé — pas une chaîne re-dérivée dans ce fichier", () => {
    for (const status of ["idle", "saving", "saved", "error"] as const) {
      expect(render(status)).toContain(saveIndicatorLabel(status));
    }
  });

  it('porte data-status="<statut>" et data-testid="save-indicator" quel que soit le statut', () => {
    for (const status of ["idle", "saving", "saved", "error"] as const) {
      const html = render(status);
      expect(html).toContain('data-testid="save-indicator"');
      expect(html).toContain(`data-status="${status}"`);
    }
  });

  it('le bouton data-action="retry-save" n\'apparaît QUE pour "error"', () => {
    for (const status of ["idle", "saving", "saved"] as const) {
      expect(render(status)).not.toContain('data-action="retry-save"');
    }
    expect(render("error")).toContain('data-action="retry-save"');
  });
});
