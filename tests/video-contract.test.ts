import { describe, it, expect } from "bun:test";
import {
  SCHEMA_VERSION, payloadSchema, contractJsonSchema, EXAMPLE_PAYLOAD, BEAT_KINDS,
} from "@/lib/video/schema";

const valid = () => structuredClone(EXAMPLE_PAYLOAD);

describe("contrat vidéo", () => {
  it("l'exemple embarqué est valide au regard du schéma", () => {
    // Le point : c'est ce qui empêche l'exemple montré au chat de dériver du validateur.
    expect(payloadSchema.safeParse(EXAMPLE_PAYLOAD).success).toBe(true);
  });

  it("expose la version courante", () => {
    expect(SCHEMA_VERSION).toBe("1.0");
    expect(EXAMPLE_PAYLOAD.schema_version).toBe(SCHEMA_VERSION);
  });

  it("refuse un type de beat inconnu", () => {
    const p = valid();
    p.variantes[0].beats[0].type = "bviroll" as never;
    expect(payloadSchema.safeParse(p).success).toBe(false);
  });

  it("refuse un identifiant de beat mal formé", () => {
    const p = valid();
    p.variantes[0].beats[0].id = "B 01 Accroche" as never;
    expect(payloadSchema.safeParse(p).success).toBe(false);
  });

  it("refuse une clé inventée (objets stricts)", () => {
    const p = valid() as Record<string, unknown>;
    (p.variantes as Record<string, unknown>[])[0].duree_totale = 720;
    expect(payloadSchema.safeParse(p).success).toBe(false);
  });

  it("refuse un timecode mal formé", () => {
    const p = valid();
    p.variantes[0].beats[0].inserts![0].tc_in = "3:12" as never;
    expect(payloadSchema.safeParse(p).success).toBe(false);
  });

  it("accepte indifféremment null et l'absence sur les champs optionnels", () => {
    const withNull = valid();
    withNull.variantes[0].beats[0].note_realisation = null;
    expect(payloadSchema.safeParse(withNull).success).toBe(true);

    const without = valid();
    delete (without.variantes[0].beats[0] as Record<string, unknown>).note_realisation;
    expect(payloadSchema.safeParse(without).success).toBe(true);
  });

  it("exige au moins une variante et au moins un beat", () => {
    const p = valid();
    p.variantes = [];
    expect(payloadSchema.safeParse(p).success).toBe(false);
  });

  // Round de correction final, I3 — spec §2.2 : « `url` : http/https uniquement ». `z.string().url()`
  // nu laissait passer `javascript:`, `data:` et `ftp:` sur les DEUX champs d'URL du contrat, alors
  // que le chemin d'édition manuelle (lib/validation.ts#updateInsertSchema) contraignait déjà le
  // protocole. L'import est le chemin par lequel les URLs arrivent réellement dans le produit.
  describe("URLs : http/https uniquement (I3)", () => {
    const REFUSEES = ["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "ftp://exemple.com/a.jpg"];

    for (const mauvaise of REFUSEES) {
      it(`refuse « ${mauvaise} » comme url d'insert`, () => {
        const p = valid();
        p.variantes[0].beats[0].inserts![0].url = mauvaise;
        expect(payloadSchema.safeParse(p).success).toBe(false);
      });

      it(`refuse « ${mauvaise} » dans sources`, () => {
        const p = valid();
        p.variantes[0].beats[0].sources = [mauvaise];
        expect(payloadSchema.safeParse(p).success).toBe(false);
      });
    }

    it("accepte http et https sur les deux champs", () => {
      const p = valid();
      p.variantes[0].beats[0].inserts![0].url = "http://exemple.com/a.jpg";
      p.variantes[0].beats[0].sources = ["https://exemple.com/article"];
      expect(payloadSchema.safeParse(p).success).toBe(true);
    });
  });

  // Round de correction final, I1 — le point aveugle qui a rendu l'asymétrie de forme des inserts
  // invisible : tant que tous les beats de l'exemple portaient un insert, rien ne comparait la liste
  // vide produite par un payload à celle produite par les colonnes.
  it("l'exemple embarqué contient un beat sans aucun insert", () => {
    expect(EXAMPLE_PAYLOAD.variantes[0].beats.some((b) => (b.inserts ?? []).length === 0)).toBe(true);
  });

  it("produit un JSON-Schema fermé, utilisable dans le brief", () => {
    const js = contractJsonSchema() as Record<string, unknown>;
    expect(js.type).toBe("object");
    expect(JSON.stringify(js)).toContain("schema_version");
    expect(JSON.stringify(js)).toContain("additionalProperties\":false");
    for (const kind of BEAT_KINDS) expect(JSON.stringify(js)).toContain(kind);
  });
});
