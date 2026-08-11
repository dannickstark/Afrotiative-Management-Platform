import { describe, it, expect } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ModeSwitch } from "@/components/studio/mode-switch";
import type { StudioMode } from "@/lib/studio/studio-mode";

// tests/studio-mode-switch.test.ts — Tâche 5 (U1, spec §5), correctif Important 3 (revue) : le
// contrôle segmenté flottant est un composant à part entière dont le rendu dépend de l'état
// (`aria-selected`, classes swap — mode-switch.tsx:51,64 et 56,69), donc CHECKABLE avec la même
// technique `renderToStaticMarkup` déjà utilisée pour RenderMode (tests/studio-render-mode.test.ts)
// — contrairement au raccourci ⌘/ de la Tâche 1, qui n'avait pas de composant dont l'AFFICHAGE
// dépend de l'état (juste un écouteur inline). Cette suite ne teste QUE le rendu piloté par la prop
// `mode` — le raccourci clavier lui-même (l'écouteur `window`) reste hors de portée sans DOM ; sa
// DÉCISION (isModeToggleShortcut) est déjà entièrement testée dans tests/studio-mode.test.ts.

function render(mode: StudioMode): string {
  return renderToStaticMarkup(React.createElement(ModeSwitch, { mode, onChange: () => {} }));
}

// Extrait le fragment `<button ...>…</button>` d'UN SEUL bouton, repéré par son `data-action` —
// jamais une recherche de sous-chaîne naïve sur le HTML entier (leçon de la Tâche 4 : une classe
// utilitaire comme "aria-selected" pourrait apparaître ailleurs, ou une classe partagée entre les
// deux boutons ferait un faux positif si on ne scope pas au bon élément).
function buttonFragment(html: string, action: "mode-montage" | "mode-rendu"): string {
  const re = new RegExp(`<button[^>]*data-action="${action}"[^>]*>[^<]*</button>`);
  const m = re.exec(html);
  if (!m) throw new Error(`bouton data-action="${action}" introuvable dans le HTML rendu`);
  return m[0];
}

describe("ModeSwitch — le rendu suit RÉELLEMENT la prop `mode` (Important 3, revue Tâche 5)", () => {
  // Correctif revue finale (Minor) : `role="tablist"`/`role="tab"`/`aria-selected` remplacés par
  // `role="radiogroup"` + `aria-pressed` — ce contrôle ne pilote aucun `tabpanel` et n'a jamais géré
  // les flèches clavier, une sémantique de tabs qu'il ne tenait donc pas (voir mode-switch.tsx).
  it('data-testid="mode-switch" et role="radiogroup" présents, quel que soit le mode', () => {
    for (const mode of ["montage", "rendu"] as StudioMode[]) {
      const html = render(mode);
      expect(html).toContain('data-testid="mode-switch"');
      expect(html).toContain('role="radiogroup"');
    }
  });

  it('mode="montage" : le bouton Montage est aria-pressed="true" et porte le style actif ; Rendu réel ne l\'est pas', () => {
    const html = render("montage");
    const montage = buttonFragment(html, "mode-montage");
    const rendu = buttonFragment(html, "mode-rendu");

    expect(montage).toContain('aria-pressed="true"');
    expect(montage).toContain("bg-primary");
    expect(montage).toContain(">Montage<");

    expect(rendu).toContain('aria-pressed="false"');
    expect(rendu).not.toContain("bg-primary");
    expect(rendu).toContain(">Rendu réel<");
  });

  it('mode="rendu" : c\'est l\'INVERSE — le bouton Rendu réel devient aria-pressed="true" et porte le style actif', () => {
    const html = render("rendu");
    const montage = buttonFragment(html, "mode-montage");
    const rendu = buttonFragment(html, "mode-rendu");

    expect(rendu).toContain('aria-pressed="true"');
    expect(rendu).toContain("bg-primary");

    expect(montage).toContain('aria-pressed="false"');
    expect(montage).not.toContain("bg-primary");
  });

  it("témoin de sabotage : les deux boutons ne sont JAMAIS aria-pressed=\"true\" en même temps, dans aucun des deux modes", () => {
    for (const mode of ["montage", "rendu"] as StudioMode[]) {
      const html = render(mode);
      const selectedCount = [...html.matchAll(/aria-pressed="true"/g)].length;
      expect(selectedCount).toBe(1);
    }
  });

  it("la prop className est fusionnée sur le conteneur, sans remplacer les classes de base", () => {
    const html = renderToStaticMarkup(
      React.createElement(ModeSwitch, { mode: "montage", onChange: () => {}, className: "ma-classe-de-test" }),
    );
    const container = /<div[^>]*data-testid="mode-switch"[^>]*>/.exec(html)?.[0] ?? "";
    expect(container).toContain("ma-classe-de-test");
    expect(container).toContain("rounded-full"); // classe de base toujours présente, pas écrasée
  });
});
