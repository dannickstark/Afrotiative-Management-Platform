import { describe, it, expect, beforeEach } from "bun:test";
import type { Layer } from "@/lib/studio/scene";
import {
  cloneLayersWithNewIds,
  copyToClipboard,
  readClipboard,
  clearClipboard,
} from "@/lib/studio/clipboard";

// tests/studio-clipboard.test.ts — Chantier B, Tâche 2 : le presse-papiers EN SESSION
// (copier/coller/dupliquer). Deux morceaux PURS testés ici directement, sans DOM :
//
//  1. `cloneLayersWithNewIds(layers, offset)` — la fonction de clonage. Chaque clone reçoit un id
//     NEUF (≠ source, unique parmi les clones), et son cadre est décalé de `offset`. AUCUNE autre
//     propriété ne change (le nom, le style, le contenu du calque source sont recopiés tels quels).
//
//  2. Le module clipboard lui-même — un stockage EN MÉMOIRE, au niveau du module, PAS le
//     presse-papiers du système d'exploitation, PAS localStorage. `copyToClipboard`/`readClipboard`/
//     `clearClipboard` sont les trois seules opérations qu'expose ce module : copier écrase le
//     contenu précédent, lire renvoie un instantané (jamais les objets de calque originaux par
//     référence — un mutateur de la scène source ne doit pas pouvoir empoisonner le presse-papiers
//     après coup), et le presse-papiers est vide au départ.
//
// Le câblage clavier (⌘C/⌘V/⌘D) et le réducteur (`addLayers`) sont couverts séparément par
// tests/studio-keymap.test.ts et tests/studio-editor-state.test.ts.

function makeLayer(id: string, x = 40, y = 40): Layer {
  return {
    id, name: "Calque", visible: true, locked: false,
    frame: { x, y, w: 100, h: 60 },
    type: "shape", shape: "rect", fill: "#CCCCCC",
  };
}

describe("cloneLayersWithNewIds — le clonage pur", () => {
  it("donne à CHAQUE clone un id NEUF, différent de la source", () => {
    const source = [makeLayer("a"), makeLayer("b")];
    const clones = cloneLayersWithNewIds(source, { dx: 16, dy: 16 });
    expect(clones).toHaveLength(2);
    for (const clone of clones) {
      expect(clone.id).not.toBe("a");
      expect(clone.id).not.toBe("b");
    }
  });

  it("les ids des clones sont UNIQUES entre eux (pas le même id généré deux fois)", () => {
    const source = [makeLayer("a"), makeLayer("b"), makeLayer("c")];
    const clones = cloneLayersWithNewIds(source, { dx: 16, dy: 16 });
    const ids = new Set(clones.map((c) => c.id));
    expect(ids.size).toBe(clones.length);
  });

  it("décale le cadre de {dx, dy} sans toucher la largeur/hauteur", () => {
    const source = [makeLayer("a", 40, 40)];
    const clones = cloneLayersWithNewIds(source, { dx: 16, dy: 16 });
    expect(clones[0].frame).toEqual({ x: 56, y: 56, w: 100, h: 60 });
  });

  it("recopie le reste du calque tel quel — nom, style, tout sauf id et frame", () => {
    const source = [makeLayer("a")];
    const [clone] = cloneLayersWithNewIds(source, { dx: 16, dy: 16 });
    expect(clone.name).toBe("Calque");
    expect(clone.type).toBe("shape");
    expect(clone.visible).toBe(true);
    expect(clone.locked).toBe(false);
  });

  it("un lot VIDE renvoie un tableau vide", () => {
    expect(cloneLayersWithNewIds([], { dx: 16, dy: 16 })).toEqual([]);
  });

  it("ne mute PAS les calques source", () => {
    const source = [makeLayer("a", 40, 40)];
    const snapshot = structuredClone(source);
    cloneLayersWithNewIds(source, { dx: 16, dy: 16 });
    expect(source).toEqual(snapshot);
  });

  // Anti-vacuité (brief) : une mutation qui réutiliserait l'id de la source dans le clone doit faire
  // rougir CE test précis, pas seulement un test générique de forme.
  it("mutation-témoin : réutiliser l'id source dans le clone rougirait ce test", () => {
    const source = [makeLayer("dup-id")];
    const [clone] = cloneLayersWithNewIds(source, { dx: 16, dy: 16 });
    expect(clone.id).not.toBe(source[0].id);
  });
});

describe("module clipboard — stockage EN SESSION, en mémoire", () => {
  beforeEach(() => {
    clearClipboard();
  });

  it("est vide au départ", () => {
    expect(readClipboard()).toEqual([]);
  });

  it("copyToClipboard puis readClipboard renvoie les calques copiés", () => {
    const layers = [makeLayer("a"), makeLayer("b")];
    copyToClipboard(layers);
    const read = readClipboard();
    expect(read).toHaveLength(2);
    expect(read.map((l) => l.id)).toEqual(["a", "b"]);
  });

  it("une NOUVELLE copie ÉCRASE le contenu précédent", () => {
    copyToClipboard([makeLayer("a")]);
    copyToClipboard([makeLayer("z")]);
    expect(readClipboard().map((l) => l.id)).toEqual(["z"]);
  });

  it("readClipboard renvoie un INSTANTANÉ — muter le résultat ne touche pas le presse-papiers", () => {
    copyToClipboard([makeLayer("a", 40, 40)]);
    const first = readClipboard();
    first[0].frame.x = 9999;
    const second = readClipboard();
    expect(second[0].frame.x).toBe(40);
  });

  it("muter le tableau/calque source APRÈS l'avoir copié ne touche pas le presse-papiers (copie défensive à l'écriture)", () => {
    const layers = [makeLayer("a", 40, 40)];
    copyToClipboard(layers);
    layers[0].frame.x = 9999;
    expect(readClipboard()[0].frame.x).toBe(40);
  });

  it("clearClipboard vide le presse-papiers", () => {
    copyToClipboard([makeLayer("a")]);
    clearClipboard();
    expect(readClipboard()).toEqual([]);
  });
});

// Anti-vacuité générale (brief) : deux appels distincts à cloneLayersWithNewIds sur la MÊME scène
// source ne collident jamais entre eux (deux paste consécutifs).
describe("anti-vacuité — deux clonages successifs ne collident jamais", () => {
  it("cloner deux fois la même source produit quatre ids tous différents", () => {
    const source = [makeLayer("a"), makeLayer("b")];
    const first = cloneLayersWithNewIds(source, { dx: 16, dy: 16 });
    const second = cloneLayersWithNewIds(source, { dx: 16, dy: 16 });
    const allIds = [...first, ...second].map((l) => l.id);
    expect(new Set(allIds).size).toBe(4);
  });
});
