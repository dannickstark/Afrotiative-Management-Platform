import { afterAll, beforeAll, describe, it, expect } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ModeSwitch } from "@/components/studio/mode-switch";
import type { StudioMode } from "@/lib/studio/studio-mode";
import { installDom, mount, click, pressKey } from "./dom-harness";

// tests/studio-mode-switch.test.ts — Tâche 5 (U1, spec §5), correctif Important 3 (revue) : le
// contrôle segmenté flottant est un composant à part entière dont le rendu dépend de l'état
// (`aria-pressed`, classes swap), donc CHECKABLE avec la même technique `renderToStaticMarkup` déjà
// utilisée pour RenderMode (tests/studio-render-mode.test.ts).
//
// U3 Tâche 5 — LE DÉFAUT D'ACCESSIBILITÉ QUE U2 AVAIT REPORTÉ, et pourquoi ce fichier a désormais
// DEUX moitiés :
//
// Le conteneur portait `role="radiogroup"` au-dessus d'enfants qui ne sont PAS des `radio` (ils
// portent `aria-pressed`, le motif du bouton-bascule) : un lecteur d'écran annonçait « groupe de
// boutons radio » puis trouvait des boutons — aucun des deux contrats n'était tenu. Le rôle retenu
// est `role="group"` (l'option que la feuille de route nommait la première), donc :
//   - la moitié STATIQUE ci-dessous affirme le couple rôle/état sur l'ÉLÉMENT concerné (jamais une
//     sous-chaîne cherchée dans tout le HTML : `role="group"` est un préfixe de `role="grouped-…"`
//     comme de n'importe quelle valeur future, et la leçon de la Tâche 3 de U3 est qu'une chaîne
//     cherchée trop large passe pour de mauvaises raisons) ;
//   - la moitié DOM affirme le COMPORTEMENT CLAVIER que ce rôle oblige, avec de VRAIS événements
//     (harnais U0, tests/dom-harness.ts) : `role="group"` ne promet AUCUNE navigation par flèches ni
//     point d'arrêt de tabulation unique — il promet deux boutons ordinaires, chacun atteignable par
//     Tab. Un `radiogroup`, lui, aurait obligé un `tabindex` mobile et des flèches qui déplacent la
//     sélection ; réclamer ce rôle sans ce comportement aurait été le MÊME défaut sous un autre
//     habit. Une affirmation de balisage seule ne peut pas établir cela : d'où la seconde moitié.
// Cette moitié DOM couvre aussi deux coutures qui n'avaient AUCUN test : le clic réel (quel bouton
// demande quel mode) et le câblage du raccourci « R » (l'écouteur `window` de ce composant — sa
// DÉCISION, isModeToggleShortcut, est testée à part dans tests/studio-mode.test.ts, mais rien ne
// prouvait que ce composant la consulte vraiment ni qu'il lui passe le VRAI événement).

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

/** La balise ouvrante du conteneur, et RIEN d'autre — pour que les affirmations de rôle portent sur
 * l'élément qui le porte, pas sur le document entier. */
function containerTag(html: string): string {
  const m = /<div[^>]*data-testid="mode-switch"[^>]*>/.exec(html);
  if (!m) throw new Error('conteneur data-testid="mode-switch" introuvable dans le HTML rendu');
  return m[0];
}

describe("ModeSwitch — le rendu suit RÉELLEMENT la prop `mode` (Important 3, revue Tâche 5)", () => {
  // U3 Tâche 5 : remplace l'ancienne affirmation `expect(html).toContain('role="radiogroup"')`, qui
  // affirmait le rôle FAUX et le cherchait dans tout le HTML. Le remplacement est plus fort sur trois
  // points : il porte sur l'élément conteneur (pas sur le document), il exige un nom accessible (rien
  // ne l'exigeait), et il interdit explicitement toute sémantique de radio — c'est cette dernière
  // clause qui rougirait si quelqu'un remettait `radiogroup` sans le comportement clavier associé.
  it("le conteneur est un `group` NOMMÉ, et rien dans ce contrôle ne réclame la sémantique radio", () => {
    for (const mode of ["montage", "rendu"] as StudioMode[]) {
      const html = render(mode);
      const container = containerTag(html);

      expect(container).toContain('data-testid="mode-switch"');
      expect(container).toContain('role="group"');
      // Nom accessible OBLIGATOIRE : sans lui, `role="group"` est une frontière anonyme. La valeur
      // exacte est affirmée sur le DOM réel (`getAttribute`) plus bas — `renderToStaticMarkup` échappe
      // l'apostrophe de « Mode d'édition » (`&#x27;`), donc le HTML n'est pas le bon endroit pour la
      // comparer caractère par caractère.
      expect(container).toMatch(/aria-label="[^"]+"/);

      expect(container).not.toContain('role="radiogroup"');
      expect(html).not.toContain('role="radio"');
      expect(html).not.toContain("aria-checked");
    }
  });

  it('mode="montage" : le bouton Montage est aria-pressed="true" et porte le style actif ; Rendu réel ne l\'est pas', () => {
    const html = render("montage");
    const montage = buttonFragment(html, "mode-montage");
    const rendu = buttonFragment(html, "mode-rendu");

    expect(montage).toContain('aria-pressed="true"');
    // Chantier E Tâche 5, correctif revue : le style actif est désormais l'accent de marque
    // (`--accent-brand`, terracotta) plutôt que `bg-primary` — MÊME changement que rail.tsx, pour
    // que les deux pastilles actives restent visuellement identiques (voir son en-tête).
    expect(montage).toContain("bg-accent-brand");
    expect(montage).toContain(">Montage<");

    expect(rendu).toContain('aria-pressed="false"');
    expect(rendu).not.toContain("bg-accent-brand");
    expect(rendu).toContain(">Rendu réel<");
  });

  it('mode="rendu" : c\'est l\'INVERSE — le bouton Rendu réel devient aria-pressed="true" et porte le style actif', () => {
    const html = render("rendu");
    const montage = buttonFragment(html, "mode-montage");
    const rendu = buttonFragment(html, "mode-rendu");

    expect(rendu).toContain('aria-pressed="true"');
    expect(rendu).toContain("bg-accent-brand");

    expect(montage).toContain('aria-pressed="false"');
    expect(montage).not.toContain("bg-accent-brand");
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
    const container = containerTag(html);
    expect(container).toContain("ma-classe-de-test");
    expect(container).toContain("rounded-full"); // classe de base toujours présente, pas écrasée
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// U3 Tâche 5 — le contrat CLAVIER, sur un VRAI DOM et avec de VRAIS événements.
describe("ModeSwitch — le comportement que `role=\"group\"` oblige, prouvé par de vrais événements (U3 Tâche 5)", () => {
  let teardownDom: () => void;

  beforeAll(() => {
    teardownDom = installDom();
  });

  afterAll(() => {
    teardownDom();
  });

  interface Harness {
    calls: StudioMode[];
    group: HTMLElement;
    montage: HTMLButtonElement;
    rendu: HTMLButtonElement;
    cleanup: () => void;
  }

  /** Monte le VRAI composant et RATTACHE son conteneur à `document.body`. Le rattachement n'est pas
   * cosmétique : (a) `element.focus()` ne déplace `document.activeElement` que pour un élément dans le
   * document — sans quoi toute affirmation de focus passerait pour de mauvaises raisons ; (b) un
   * événement dispatché dans un arbre DÉTACHÉ n'atteint jamais `window`, où vit l'écouteur du
   * raccourci « R » de ce composant. */
  async function mountAttached(mode: StudioMode): Promise<Harness> {
    const calls: StudioMode[] = [];
    const mounted = await mount(
      React.createElement(ModeSwitch, { mode, onChange: (next: StudioMode) => calls.push(next) }),
    );
    document.body.appendChild(mounted.container);

    const group = mounted.container.querySelector<HTMLElement>('[data-testid="mode-switch"]');
    if (!group) throw new Error("conteneur mode-switch absent du DOM monté");
    const montage = group.querySelector<HTMLButtonElement>('[data-action="mode-montage"]');
    const rendu = group.querySelector<HTMLButtonElement>('[data-action="mode-rendu"]');
    if (!montage || !rendu) throw new Error("boutons de mode absents du DOM monté");

    return {
      calls,
      group,
      montage,
      rendu,
      cleanup: () => {
        mounted.unmount();
        mounted.container.remove();
      },
    };
  }

  it("le rôle et l'état vont ensemble sur le DOM réel : un `group` nommé, deux boutons `aria-pressed`, aucun radio", async () => {
    const h = await mountAttached("montage");
    try {
      expect(h.group.getAttribute("role")).toBe("group");
      expect(h.group.getAttribute("aria-label")).toBe("Mode d'édition");

      // Le couple rôle/état : la bascule, pas le radio — et exactement une enfoncée.
      expect(h.montage.getAttribute("aria-pressed")).toBe("true");
      expect(h.rendu.getAttribute("aria-pressed")).toBe("false");
      expect(h.group.querySelectorAll('[aria-pressed]').length).toBe(2);

      // Aucune promesse de radio nulle part dans le sous-arbre — conteneur inclus.
      expect(h.group.querySelectorAll('[role="radio"], [role="radiogroup"], [aria-checked]').length).toBe(0);
      expect(h.group.matches('[role="radiogroup"]')).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  it("DEUX points d'arrêt de tabulation indépendants — aucun `tabindex` mobile (le piège du demi-radiogroup)", async () => {
    const h = await mountAttached("rendu");
    try {
      // Un `radiogroup` exigerait un tabindex MOBILE (l'enfant non sélectionné à -1) et un seul point
      // d'arrêt. `role="group"` exige l'inverse : deux boutons ordinaires, chacun dans l'ordre de
      // tabulation naturel. C'est cette affirmation qui rougit si quelqu'un pose un tabindex mobile
      // sans convertir réellement le contrôle en radiogroup.
      for (const b of [h.montage, h.rendu]) {
        expect(b.hasAttribute("tabindex")).toBe(false);
        expect(b.tabIndex).toBe(0);
        expect(b.disabled).toBe(false);
      }
      expect(h.group.querySelectorAll('[tabindex="-1"]').length).toBe(0);

      // Focus RÉEL, pour les deux : « atteignable par Tab » ne se déduit pas du seul balisage.
      h.montage.focus();
      expect(document.activeElement).toBe(h.montage);
      h.rendu.focus();
      expect(document.activeElement).toBe(h.rendu);
    } finally {
      h.cleanup();
    }
  });

  it("les flèches (et Home/End) ne changent NI la sélection NI le focus — ce contrôle ne promet pas de navigation directionnelle", async () => {
    const h = await mountAttached("montage");
    try {
      h.montage.focus();
      for (const key of ["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"]) {
        const event = await pressKey({ key }, h.montage);
        expect(h.calls).toEqual([]); // aucun changement de mode demandé
        expect(document.activeElement).toBe(h.montage); // aucun focus déplacé
        expect(h.montage.getAttribute("aria-pressed")).toBe("true");
        expect(h.rendu.getAttribute("aria-pressed")).toBe("false");
        expect(event.defaultPrevented).toBe(false); // la touche est laissée au navigateur
      }
      // SI un jour ce contrôle gagne la navigation par flèches, ce test DOIT rougir : il faudra alors
      // en faire un vrai `radiogroup` (role="radio" + aria-checked + tabindex mobile) et remplacer ce
      // test par le contrat de ce rôle. C'est précisément le couplage que le défaut d'origine avait
      // rompu — le rôle d'un côté, le comportement de l'autre.
    } finally {
      h.cleanup();
    }
  });

  it("clic RÉEL : chaque bouton demande SON mode, et le mode courant n'y change rien", async () => {
    const h = await mountAttached("montage");
    try {
      await click(h.rendu);
      expect(h.calls).toEqual(["rendu"]);
      await click(h.montage);
      expect(h.calls).toEqual(["rendu", "montage"]);
    } finally {
      h.cleanup();
    }

    const h2 = await mountAttached("rendu");
    try {
      await click(h2.montage);
      expect(h2.calls).toEqual(["montage"]);
      await click(h2.rendu);
      expect(h2.calls).toEqual(["montage", "rendu"]);
    } finally {
      h2.cleanup();
    }
  });

  it("le raccourci « R » reste câblé sur de VRAIS événements, et bascule DEPUIS le mode courant", async () => {
    const h = await mountAttached("montage");
    try {
      const event = await pressKey({ key: "r" });
      expect(h.calls).toEqual(["rendu"]);
      expect(event.defaultPrevented).toBe(true); // le raccourci est bien intercepté
    } finally {
      h.cleanup();
    }

    const h2 = await mountAttached("rendu");
    try {
      await pressKey({ key: "R" }); // la casse du Shift ne change pas le sens du raccourci
      expect(h2.calls).toEqual(["montage"]);
    } finally {
      h2.cleanup();
    }
  });

  it("« R » n'est volé NI à la frappe dans un champ NI au Cmd+R du navigateur", async () => {
    const h = await mountAttached("montage");
    const input = document.createElement("input");
    document.body.appendChild(input);
    try {
      // Cible RÉELLE = un <input> : c'est la garde de frappe d'isModeToggleShortcut, et elle lit
      // `event.target.tagName` — seul un vrai élément peut l'exercer.
      input.focus();
      const typed = await pressKey({ key: "r" }, input);
      expect(h.calls).toEqual([]);
      expect(typed.defaultPrevented).toBe(false); // la lettre doit arriver dans le champ

      const reload = await pressKey({ key: "r", metaKey: true });
      expect(h.calls).toEqual([]);
      expect(reload.defaultPrevented).toBe(false); // Cmd+R = recharger, jamais intercepté
    } finally {
      input.remove();
      h.cleanup();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tâche 8 — `montageDisabled` : additive, et ne touche JAMAIS le côté Rendu réel. C'est ce qui
// garde la planche atteignable sous 768px une fois que editor-shell.tsx ne monte plus `TooSmallState`
// pour ce mode-là (voir tests/studio-editor-shell.test.ts pour la preuve DOM correspondante).
describe("ModeSwitch — Montage indisponible sous 768px", () => {
  it("désactive le côté Montage et dit pourquoi", () => {
    const html = renderToStaticMarkup(
      React.createElement(ModeSwitch, { mode: "rendu" as const, onChange: () => {}, montageDisabled: true }),
    );
    const montage = html.match(/<button[^>]*data-action="mode-montage"[^>]*>/)![0];
    expect(montage).toContain("disabled");
    expect(montage).toMatch(/écran plus large/);
  });

  it("laisse le côté Montage actif par défaut — la prop est additive", () => {
    const html = renderToStaticMarkup(
      React.createElement(ModeSwitch, { mode: "montage" as const, onChange: () => {} }),
    );
    const montage = html.match(/<button[^>]*data-action="mode-montage"[^>]*>/)![0];
    expect(montage).not.toContain("disabled");
  });

  it("le côté « Rendu réel » n'est JAMAIS désactivé — c'est précisément lui qui doit rester atteignable", () => {
    const html = renderToStaticMarkup(
      React.createElement(ModeSwitch, { mode: "montage" as const, onChange: () => {}, montageDisabled: true }),
    );
    const rendu = html.match(/<button[^>]*data-action="mode-rendu"[^>]*>/)![0];
    expect(rendu).not.toContain("disabled");
  });
});
