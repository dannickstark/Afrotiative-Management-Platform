import { describe, it, expect } from "bun:test";
import { toSnapshot, computeMerge, applyMerge, type BeatRow } from "@/lib/video/import";
import type { BeatPayload } from "@/lib/video/schema";

function beat(id: string, over: Partial<BeatPayload> = {}): BeatPayload {
  return {
    id, type: "narration", texte: `texte de ${id}`, note_realisation: null, texte_ecran: null,
    transition_entree: null, transition_sortie: null, sources: [], inserts: [], ...over,
  } as BeatPayload;
}

// Une ligne « propre » : ce que l'import précédent a posé, jamais retouché par l'humain.
function row(id: string, position: number, over: Partial<BeatPayload> = {}): BeatRow {
  const snap = toSnapshot(beat(id, over));
  return { externalId: id, position, snapshot: snap, importedSnapshot: snap };
}

describe("computeMerge", () => {
  it("classe un beat inconnu en ajout", () => {
    const d = computeMerge([row("b-01", 0)], [beat("b-01"), beat("b-02")]);
    expect(d.added.map((a) => a.externalId)).toEqual(["b-02"]);
  });

  it("classe en modification un beat que seul Claude a changé", () => {
    const d = computeMerge([row("b-01", 0)], [beat("b-01", { texte: "nouveau texte" })]);
    expect(d.modified.map((m) => m.externalId)).toEqual(["b-01"]);
    expect(d.modified[0].fields).toContain("spokenText");
  });

  it("ne signale pas un beat inchangé", () => {
    const d = computeMerge([row("b-01", 0)], [beat("b-01")]);
    expect(d.modified).toEqual([]);
    expect(d.added).toEqual([]);
    expect(d.conflicts).toEqual([]);
  });

  it("fusionne des champs disjoints sans conflit", () => {
    const r = row("b-01", 0);
    r.snapshot = { ...r.snapshot, screenText: "posé à la main" }; // édition locale
    const d = computeMerge([r], [beat("b-01", { texte: "réécrit par Claude" })]);
    expect(d.conflicts).toEqual([]);
    expect(d.modified[0].next.screenText).toBe("posé à la main");
    expect(d.modified[0].next.spokenText).toBe("réécrit par Claude");
  });

  it("signale un conflit quand les deux ont touché le MÊME champ", () => {
    const r = row("b-01", 0);
    r.snapshot = { ...r.snapshot, spokenText: "ma version" };
    const d = computeMerge([r], [beat("b-01", { texte: "sa version" })]);
    expect(d.modified).toEqual([]);
    expect(d.conflicts).toHaveLength(1);
    expect(d.conflicts[0].fields).toEqual(["spokenText"]);
    expect(d.conflicts[0].ours.spokenText).toBe("ma version");
    expect(d.conflicts[0].theirs.spokenText).toBe("sa version");
  });

  it("classe en suppression un beat absent du payload", () => {
    const d = computeMerge([row("b-01", 0), row("b-02", 1)], [beat("b-01")]);
    expect(d.removed).toEqual([{ externalId: "b-02" }]);
  });

  it("l'ordre suit le payload", () => {
    const d = computeMerge([row("b-01", 0), row("b-02", 1)], [beat("b-02"), beat("b-01")]);
    expect(d.order).toEqual(["b-02", "b-01"]);
  });

  it("un beat jamais importé (créé à la main) sans base n'est pas écrasé en silence", () => {
    const r: BeatRow = { externalId: "b-99", position: 0, snapshot: toSnapshot(beat("b-99", { texte: "à moi" })), importedSnapshot: null };
    const d = computeMerge([r], [beat("b-99", { texte: "à lui" })]);
    expect(d.conflicts).toHaveLength(1);
  });

  it("un beat sans importedSnapshot dont le payload est identique au snapshot courant n'apparaît nulle part", () => {
    const r: BeatRow = { externalId: "b-99", position: 0, snapshot: toSnapshot(beat("b-99")), importedSnapshot: null };
    const d = computeMerge([r], [beat("b-99")]);
    expect(d.added).toEqual([]);
    expect(d.modified).toEqual([]);
    expect(d.conflicts).toEqual([]);
  });

  it("un beat sans importedSnapshot dont un seul champ diffère est en conflit sur ce seul champ", () => {
    const r: BeatRow = { externalId: "b-99", position: 0, snapshot: toSnapshot(beat("b-99")), importedSnapshot: null };
    const d = computeMerge([r], [beat("b-99", { texte: "réécrit par Claude" })]);
    expect(d.conflicts).toHaveLength(1);
    expect(d.conflicts[0].fields).toEqual(["spokenText"]);
  });
});

describe("applyMerge", () => {
  it("n'applique que ce qui est retenu", () => {
    const d = computeMerge([row("b-01", 0)], [beat("b-01", { texte: "nouveau" }), beat("b-02")]);
    const m = applyMerge(d, { accept: ["b-02"] });
    expect(m.create.map((c) => c.externalId)).toEqual(["b-02"]);
    expect(m.update).toEqual([]);
  });

  it("une suppression non retenue n'efface rien", () => {
    const d = computeMerge([row("b-01", 0), row("b-02", 1)], [beat("b-01")]);
    const m = applyMerge(d, { accept: [] });
    expect(m.remove).toEqual([]);
  });

  it("une suppression retenue efface", () => {
    const d = computeMerge([row("b-01", 0), row("b-02", 1)], [beat("b-01")]);
    const m = applyMerge(d, { accept: ["b-02"] });
    expect(m.remove).toEqual(["b-02"]);
  });

  it("un conflit retenu applique la version de Claude", () => {
    const r = row("b-01", 0);
    r.snapshot = { ...r.snapshot, spokenText: "ma version" };
    const d = computeMerge([r], [beat("b-01", { texte: "sa version" })]);
    const m = applyMerge(d, { accept: ["b-01"] });
    expect(m.update[0].snapshot.spokenText).toBe("sa version");
  });

  // Round de correction final, C1 — le défaut le plus grave de la branche. `c.fields` ne liste que
  // les champs CONTESTÉS ; l'ancienne version appliquait `c.theirs`, l'instantané COMPLET de Claude,
  // ce qui ramenait à leur valeur de base tous les champs que Claude n'avait jamais touchés — y
  // compris ceux que seul l'humain avait édités. Scénario exact du constat de revue.
  it("accepter un conflit n'applique QUE les champs contestés, jamais l'instantané complet", () => {
    const r = row("b-01", 0);
    // L'humain édite screenText ET sources.
    r.snapshot = { ...r.snapshot, screenText: "posé à la main", sources: ["https://exemple.com/a-moi"] };
    // Claude change spokenText ET screenText — seul screenText est contesté.
    const d = computeMerge([r], [beat("b-01", { texte: "sa version", texte_ecran: "son texte à l'écran" })]);
    expect(d.conflicts).toHaveLength(1);
    expect(d.conflicts[0].fields).toEqual(["screenText"]);

    const m = applyMerge(d, { accept: ["b-01"] });
    // Le champ contesté est tranché en faveur de Claude…
    expect(m.update[0].snapshot.screenText).toBe("son texte à l'écran");
    // …et `sources`, que Claude n'a jamais touché, reste l'édition humaine — pas la valeur de base.
    expect(m.update[0].snapshot.sources).toEqual(["https://exemple.com/a-moi"]);
  });

  it("un conflit refusé n'écrit rien du tout", () => {
    const r = row("b-01", 0);
    r.snapshot = { ...r.snapshot, spokenText: "ma version" };
    const d = computeMerge([r], [beat("b-01", { texte: "sa version" })]);
    expect(applyMerge(d, { accept: [] }).update).toEqual([]);
  });
});

// Round de correction final, I1 — la forme des inserts doit être identique quelle que soit sa
// source. `toSnapshot` est le producteur commun ; c'est lui qui pose les sept clés, dans l'ordre du
// schéma, les absentes valant `null`.
describe("forme des inserts (I1)", () => {
  const CLES = ["type", "url", "tc_in", "tc_out", "duree_affichage_sec", "credit", "droits"];

  it("un insert aux clés optionnelles omises porte les sept clés, dans l'ordre du schéma", () => {
    const partiel = beat("b-01", {
      inserts: [{ type: "image", url: "https://exemple.com/a.jpg" }] as never,
    });
    const snap = toSnapshot(partiel);
    expect(Object.keys(snap.inserts[0])).toEqual(CLES);
    expect(snap.inserts[0].credit).toBeNull();
    expect(snap.inserts[0].tc_in).toBeNull();
  });

  it("un insert complet et le même insert aux clés nulles omises se sérialisent à l'identique", () => {
    const omis = toSnapshot(beat("b-01", {
      inserts: [{ type: "image", url: "https://exemple.com/a.jpg" }] as never,
    }));
    const explicites = toSnapshot(beat("b-01", {
      inserts: [{
        type: "image", url: "https://exemple.com/a.jpg", tc_in: null, tc_out: null,
        duree_affichage_sec: null, credit: null, droits: null,
      }] as never,
    }));
    expect(JSON.stringify(omis.inserts)).toBe(JSON.stringify(explicites.inserts));
  });

  // Le vrai dommage de l'I1 : `differs(ours.inserts, base.inserts)` restant vrai à jamais, tout
  // changement d'insert venu de Claude arrivait en CONFLIT au lieu d'une modification
  // auto-fusionnable — et c'est précisément le conflit que l'UI n'affichait pas (C1).
  it("un changement d'insert venu de Claude est une modification, pas un conflit, même sur un beat dont l'instantané d'origine omettait les clés nulles", () => {
    // `base` tel que le posait un payload aux clés optionnelles omises…
    const base = toSnapshot(beat("b-01", {
      inserts: [{ type: "image", url: "https://exemple.com/a.jpg" }] as never,
    }));
    // …et `ours` tel que le reconstruisent les colonnes de beat_inserts (les sept clés, toujours).
    const ours = toSnapshot(beat("b-01", {
      inserts: [{
        type: "image", url: "https://exemple.com/a.jpg", tc_in: null, tc_out: null,
        duree_affichage_sec: null, credit: null, droits: null,
      }] as never,
    }));
    const r: BeatRow = { externalId: "b-01", position: 0, snapshot: ours, importedSnapshot: base };

    const d = computeMerge([r], [beat("b-01", {
      inserts: [{ type: "image", url: "https://exemple.com/b.jpg", credit: "AFP" }] as never,
    })]);
    expect(d.conflicts).toEqual([]);
    expect(d.modified.map((m) => m.externalId)).toEqual(["b-01"]);
    expect(d.modified[0].next.inserts[0].url).toBe("https://exemple.com/b.jpg");
  });

  it("l'ordre final ne contient que les beats qui survivent", () => {
    const d = computeMerge([row("b-01", 0), row("b-02", 1)], [beat("b-02"), beat("b-03")]);
    const m = applyMerge(d, { accept: ["b-03", "b-02"] }); // b-01 supprimé mais NON retenu
    expect(m.order).toEqual(["b-02", "b-03", "b-01"]);
  });
});
