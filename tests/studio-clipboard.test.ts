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

// ── Chantier B, Tâche 5 (revue, Critique 2) — spec §3 verbatim : « Un calque groupé collé reçoit un
// groupId neuf partagé (le groupe est dupliqué, pas fusionné) ». Sans ce remappage, ⌘D sur un groupe
// `[a,b]` (groupId `g1`) produirait quatre calques partageant TOUS `g1` — cliquer n'importe lequel
// des quatre sélectionnerait les quatre, et dégrouper le clone dégrouperait la source au passage.
function groupedLayer(id: string, groupId: string, x = 40, y = 40): Layer {
  return { ...makeLayer(id, x, y), groupId };
}

describe("cloneLayersWithNewIds — remappage de groupId (chantier B, Tâche 5, revue Critique 2)", () => {
  it("les clones d'un groupe partagent un groupId NEUF, distinct du groupId source", () => {
    const source = [groupedLayer("a", "g1"), groupedLayer("b", "g1")];
    const clones = cloneLayersWithNewIds(source, { dx: 16, dy: 16 });
    expect(clones[0].groupId).toBeDefined();
    expect(clones[0].groupId).not.toBe("g1");
    // Les DEUX clones partagent LE MÊME groupId neuf entre eux — le groupe reste un groupe.
    expect(clones[1].groupId).toBe(clones[0].groupId);
  });

  it("le groupe SOURCE est inchangé — cloner ne mute ni ne réassigne son groupId", () => {
    const source = [groupedLayer("a", "g1"), groupedLayer("b", "g1")];
    cloneLayersWithNewIds(source, { dx: 16, dy: 16 });
    expect(source[0].groupId).toBe("g1");
    expect(source[1].groupId).toBe("g1");
  });

  it("DEUX groupes sources DIFFÉRENTS dans le même lot reçoivent chacun leur PROPRE groupId neuf — jamais fusionnés", () => {
    const source = [
      groupedLayer("a", "g1"), groupedLayer("b", "g1"),
      groupedLayer("c", "g2"), groupedLayer("d", "g2"),
    ];
    const clones = cloneLayersWithNewIds(source, { dx: 16, dy: 16 });
    const [ca, cb, cc, cd] = clones;
    expect(ca.groupId).toBe(cb.groupId);
    expect(cc.groupId).toBe(cd.groupId);
    expect(ca.groupId).not.toBe(cc.groupId); // les deux groupes clonés restent DISTINCTS entre eux
    expect(ca.groupId).not.toBe("g1");
    expect(cc.groupId).not.toBe("g2");
  });

  it("un calque SANS groupId clone SANS groupId — la clé reste ABSENTE, jamais `groupId: undefined`", () => {
    const source = [makeLayer("a")];
    const [clone] = cloneLayersWithNewIds(source, { dx: 16, dy: 16 });
    expect("groupId" in clone).toBe(false);
  });

  it("un lot MÉLANGÉ (groupé + non groupé) ne fait pas fuir le groupId sur le calque non groupé", () => {
    const source = [groupedLayer("a", "g1"), groupedLayer("b", "g1"), makeLayer("c")];
    const clones = cloneLayersWithNewIds(source, { dx: 16, dy: 16 });
    expect(clones[0].groupId).toBe(clones[1].groupId);
    expect("groupId" in clones[2]).toBe(false);
  });

  // Anti-vacuité (brief, Step 4 du T5 original, réappliqué ici) : une régression qui recopierait
  // simplement `layer.groupId` tel quel (comme avant ce correctif) laisserait les clones partager
  // "g1" — CE test rougirait, contrairement à un test qui ne vérifierait que « les clones ont un
  // groupId défini » (vrai aussi dans la version bogue).
  it("anti-vacuité : le groupId d'un clone n'est PAS la chaîne source « g1 »", () => {
    const source = [groupedLayer("a", "g1")];
    const [clone] = cloneLayersWithNewIds(source, { dx: 16, dy: 16 });
    expect(clone.groupId).not.toBe("g1");
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
