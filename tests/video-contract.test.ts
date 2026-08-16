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

  it("produit un JSON-Schema fermé, utilisable dans le brief", () => {
    const js = contractJsonSchema() as Record<string, unknown>;
    expect(js.type).toBe("object");
    expect(JSON.stringify(js)).toContain("schema_version");
    expect(JSON.stringify(js)).toContain("additionalProperties\":false");
    for (const kind of BEAT_KINDS) expect(JSON.stringify(js)).toContain(kind);
  });
});
