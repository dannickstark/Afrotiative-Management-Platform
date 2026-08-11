// tests/dom-harness.test.ts — U0 Tâche 1 : le harnais lui-même.
//
// Ce fichier OPTE IN pour toute sa durée (beforeAll/afterAll) — c'est le seul endroit où on peut se
// permettre d'installer un DOM sans risquer de faire bifurquer un `typeof window === "undefined"`
// ailleurs dans la suite (voir §1 de docs/superpowers/plans/2026-08-11-afrotiative-u0-harnais-dom.md).
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { installDom, mount, click, pressKey, flush, DOM_GLOBAL_KEYS, REACT_ACT_ENV_KEY } from "./dom-harness";
import * as React from "react";

let teardown: () => void;
beforeAll(() => { teardown = installDom(); });
afterAll(() => { teardown(); });

describe("the harness itself", () => {
  it("gives a document and cleans up after itself", () => {
    expect(typeof globalThis.document).toBe("object");
  });

  it("mounts a component and runs its effects", async () => {
    const seen: string[] = [];
    function Probe() {
      React.useEffect(() => { seen.push("effect"); }, []);
      return React.createElement("p", null, "bonjour");
    }
    const { container, unmount } = await mount(React.createElement(Probe));
    expect(container.textContent).toBe("bonjour");
    expect(seen).toEqual(["effect"]); // le point : les effets tournent vraiment, pas juste le rendu
    unmount();
  });

  // Renforcé par rapport au gabarit du brief (qui posait onClick directement sur l'élément cliqué) :
  // ici le gestionnaire vit sur un ANCÊTRE du bouton cliqué. Un click() qui appellerait la prop
  // onClick directement (au lieu de dispatcher un vrai événement DOM qui remonte) trouverait le
  // bouton lui-même sans onClick et ne pourrait PAS atteindre le gestionnaire du parent — seule une
  // vraie remontée d'événement le peut. On vérifie en plus que l'événement REÇU est un vrai
  // MouseEvent qui bubble, pas un objet de substitution inventé par le harnais.
  it("fires a REAL click that bubbles from the clicked element up to an ancestor's onClick", async () => {
    let received: MouseEvent | null = null;
    function Probe() {
      return React.createElement(
        "div",
        { onClick: (e: React.MouseEvent) => { received = e.nativeEvent; } },
        React.createElement("button", null, "ok"),
      );
    }
    const { container, unmount } = await mount(React.createElement(Probe));
    await click(container.querySelector("button")!);
    // aurait échoué si click() avait dispatché sur le mauvais nœud, un événement non-bubbling, ou
    // simplement invoqué une prop onClick trouvée par introspection au lieu de traverser le DOM.
    expect(received).not.toBeNull();
    expect(received).toBeInstanceOf(MouseEvent);
    expect(received!.bubbles).toBe(true);
    unmount();
  });

  it("fires a keydown with modifiers that reaches a document listener", async () => {
    const hits: string[] = [];
    function Probe() {
      React.useEffect(() => {
        const h = (e: KeyboardEvent) => { if (e.key === "/" && e.metaKey) hits.push("shortcut"); };
        document.addEventListener("keydown", h);
        return () => document.removeEventListener("keydown", h);
      }, []);
      return null;
    }
    const { unmount } = await mount(React.createElement(Probe));
    await pressKey({ key: "/", metaKey: true });
    expect(hits).toEqual(["shortcut"]);
    unmount();
  });

  it("flush() lets a pending effect-driven state update settle without a real event", async () => {
    function Probe({ onReady }: { onReady: () => void }) {
      React.useEffect(() => {
        Promise.resolve().then(onReady);
      }, [onReady]);
      return null;
    }
    let ready = false;
    const { unmount } = await mount(React.createElement(Probe, { onReady: () => { ready = true; } }));
    await flush();
    expect(ready).toBe(true);
    unmount();
  });

  it("stubs IntersectionObserver — render-mode.tsx's filmstrip only needs it to exist and record its callback", () => {
    expect(typeof globalThis.IntersectionObserver).toBe("function");
    const seenEntries: unknown[] = [];
    const observer = new IntersectionObserver((entries) => { seenEntries.push(entries); });
    const el = document.createElement("div");
    observer.observe(el); // no-op, must not throw
    // le callback est CONSERVÉ (pas juste accepté puis jeté) — une tâche future doit pouvoir le
    // déclencher à la main pour simuler une entrée dans le viewport.
    const Ctor = globalThis.IntersectionObserver as unknown as { instances: Array<{ callback: IntersectionObserverCallback }> };
    expect(Ctor.instances.length).toBeGreaterThan(0);
    Ctor.instances[Ctor.instances.length - 1].callback([{ isIntersecting: true } as IntersectionObserverEntry], observer);
    expect(seenEntries).toEqual([[{ isIntersecting: true }]]);
    observer.disconnect(); // no-op, must not throw
  });

  // RÉÉCRITURE du dernier test du brief (« does NOT leak globals to a file that never opted in »).
  //
  // Pourquoi l'original était bancal : ce fichier a un DOM installé pour TOUTE sa durée via le
  // beforeAll/afterAll ci-dessus, donc à l'intérieur d'un `it()` de ce fichier `globalThis.document`
  // est TOUJOURS un objet — que le teardown fonctionne ou pas. `t()` puis vérifier
  // `typeof globalThis.document === "object"` est donc vrai QUOI QU'IL ARRIVE (même si `t()` ne
  // faisait absolument rien) : le test passe à vide (vacuously), il ne peut jamais échouer.
  //
  // La propriété RÉELLE que l'interface promet est « installDom() suivi de son teardown restaure
  // globalThis EXACTEMENT à ce qu'il était avant — RESTAURE, ne supprime pas à l'aveugle ». On la
  // prouve ici en installant un DEUXIÈME DOM (empilé par-dessus celui du beforeAll), en vérifiant
  // qu'il a bien remplacé les références en place, puis en démontant CE DEUXIÈME DOM et en comparant
  // par IDENTITÉ (`toBe`, pas `typeof`) que chaque global DOM retrouve exactement sa référence
  // d'avant — ainsi que l'ensemble des clés de `globalThis`, pour détecter toute fuite. Une
  // implémentation qui fait `delete globalThis.document` au lieu de restaurer la valeur précédente
  // échouerait ici : après le teardown imbriqué, `document` serait `undefined`, pas la référence du
  // DOM extérieur (celui du beforeAll) — alors que le fichier n'a JAMAIS cessé d'avoir un DOM.
  it("installDom() followed by its teardown restores globalThis to exactly the keys/values it had before — not blind deletion", () => {
    // `DOM_GLOBAL_KEYS` est IMPORTÉE du harnais (revue finale U0+U2), plus recopiée à la main ici : une
    // copie faisait de ce test un garde-fou sur sa propre copie, et ajouter un global au harnais sans
    // toucher la copie le laissait vert. Même correction que le garde-fou de galerie de formes de U1
    // (SHAPE_KINDS exportée, consommée par le code ET par le test).
    const g = globalThis as Record<string, unknown>;

    const before = new Map(DOM_GLOBAL_KEYS.map((k) => [k, g[k]]));
    const keysBefore = Object.keys(g).sort();

    const innerTeardown = installDom(); // empilé sur le DOM du beforeAll : une SECONDE instance jsdom
    // preuve que l'installation imbriquée a bien REMPLACÉ les références (sinon la comparaison
    // d'identité plus bas serait vraie même si installDom() ne faisait rien).
    expect(g.window).not.toBe(before.get("window"));
    expect(g.document).not.toBe(before.get("document"));

    innerTeardown();

    for (const k of DOM_GLOBAL_KEYS) {
      expect(g[k]).toBe(before.get(k)); // référence EXACTE restaurée, pas juste "un objet"
    }
    expect(Object.keys(g).sort()).toEqual(keysBefore); // aucune clé nouvelle n'a survécu au teardown
  });

  // LA complétude, mesurée plutôt que déclarée (revue finale U0+U2). Le test ci-dessus prouve que TOUT
  // CE QUI EST DANS `DOM_GLOBAL_KEYS` est restauré ; il ne dit rien de ce qui n'y serait PAS. Or c'est
  // là qu'est le vrai risque : `installDom()` pose ses globals par dix affectations écrites à la main
  // (`g.window = …`, `g.document = …`, …) et non par une boucle sur la liste. Une onzième affectation
  // ajoutée sans étendre la liste ne serait JAMAIS restaurée — le harnais fuirait dans les fichiers
  // suivants, précisément ce que son commentaire d'en-tête promet d'éviter.
  //
  // On ne compare donc pas à une liste écrite ailleurs : on OBSERVE ce que `installDom()` change
  // réellement sur `globalThis` et on confronte l'observation à la liste exportée.
  it("DOM_GLOBAL_KEYS est COMPLÈTE : installDom() ne touche aucune clé qui n'y figure pas, et n'en laisse aucune inutilisée", () => {
    const g = globalThis as Record<string, unknown>;
    const avant = new Map(Object.keys(g).map((k) => [k, g[k]] as const));

    const teardown = installDom();
    const touchées = new Set(
      Object.keys(g).filter((k) => !avant.has(k) || !Object.is(avant.get(k), g[k])),
    );
    teardown();

    // (a) rien hors de la liste — le commutateur de React est nommé, pas deviné, et il est exporté par
    //     le harnais pour la même raison que la liste elle-même.
    const connues = new Set<string>([...DOM_GLOBAL_KEYS, REACT_ACT_ENV_KEY]);
    expect([...touchées].filter((k) => !connues.has(k)).sort()).toEqual([]);
    // (b) et aucune entrée MORTE dans la liste : chacune est bel et bien installée. Sans cette moitié,
    //     la liste pourrait grossir de clés fantômes que le teardown « restaurerait » à vide.
    expect([...DOM_GLOBAL_KEYS].filter((k) => !touchées.has(k)).sort()).toEqual([]);
    // (c) garde anti-vacuité : l'observation a bien vu quelque chose (une mesure qui ne mesure rien
    //     satisferait (a) et (b) d'un coup).
    expect(touchées.size).toBeGreaterThanOrEqual(DOM_GLOBAL_KEYS.length);
  });
});
