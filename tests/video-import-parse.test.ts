import { describe, it, expect } from "bun:test";
import { stripEnvelope, parseIncoming } from "@/lib/video/import";
import { EXAMPLE_PAYLOAD } from "@/lib/video/schema";

const json = () => JSON.stringify(EXAMPLE_PAYLOAD);

describe("stripEnvelope", () => {
  it("retire les balises de code", () => {
    expect(stripEnvelope("```json\n{\"a\":1}\n```")).toBe("{\"a\":1}");
  });

  it("retire des balises sans langage", () => {
    expect(stripEnvelope("```\n{\"a\":1}\n```")).toBe("{\"a\":1}");
  });

  it("retire le BOM", () => {
    expect(stripEnvelope("﻿{\"a\":1}")).toBe("{\"a\":1}");
  });

  it("retire le bavardage avant et après l'objet", () => {
    expect(stripEnvelope("Voici le script :\n{\"a\":1}\nJ'espère que ça convient !")).toBe("{\"a\":1}");
  });

  it("laisse intact un JSON déjà propre", () => {
    expect(stripEnvelope("{\"a\":1}")).toBe("{\"a\":1}");
  });
});

describe("parseIncoming", () => {
  it("accepte un payload de référence", () => {
    const r = parseIncoming(json());
    expect(r.ok).toBe(true);
  });

  it("accepte un objet déjà désérialisé (chemin MCP)", () => {
    const r = parseIncoming(EXAMPLE_PAYLOAD);
    expect(r.ok).toBe(true);
  });

  it("accepte un payload enveloppé de balises et de bavardage", () => {
    expect(parseIncoming("Bien sûr !\n```json\n" + json() + "\n```").ok).toBe(true);
  });

  it("refuse un JSON syntaxiquement invalide, en français", () => {
    const r = parseIncoming("{ pas du json");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0].message).toContain("JSON");
  });

  it("refuse une majeure de schéma inconnue", () => {
    const p = structuredClone(EXAMPLE_PAYLOAD);
    p.schema_version = "2.0";
    const r = parseIncoming(JSON.stringify(p));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0].path).toBe("schema_version");
  });

  it("accepte une mineure inconnue de la même majeure", () => {
    const p = structuredClone(EXAMPLE_PAYLOAD);
    p.schema_version = "1.7";
    expect(parseIncoming(JSON.stringify(p)).ok).toBe(true);
  });

  it("rapporte le chemin exact d'une erreur de champ", () => {
    const p = structuredClone(EXAMPLE_PAYLOAD);
    p.variantes[0].beats[0].type = "bviroll" as never;
    const r = parseIncoming(JSON.stringify(p));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues.some((i) => i.path === "variantes[0].beats[0].type")).toBe(true);
      expect(r.issues.some((i) => i.received === "bviroll")).toBe(true);
    }
  });

  it("refuse des identifiants de beat dupliqués dans une variante", () => {
    const p = structuredClone(EXAMPLE_PAYLOAD);
    p.variantes[0].beats[1].id = p.variantes[0].beats[0].id;
    const r = parseIncoming(JSON.stringify(p));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0].message).toContain("dupliqué");
  });

  it("refuse un tc_out antérieur ou égal au tc_in", () => {
    const p = structuredClone(EXAMPLE_PAYLOAD);
    p.variantes[0].beats[0].inserts![0].tc_out = "00:03:12";
    const r = parseIncoming(JSON.stringify(p));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0].path).toContain("tc_out");
  });

  it("n'accepte aucun payload partiellement valide", () => {
    const p = structuredClone(EXAMPLE_PAYLOAD);
    p.variantes[0].beats[1].id = "ID INVALIDE" as never;
    const r = parseIncoming(JSON.stringify(p));
    expect(r.ok).toBe(false); // le beat 0 est bon, ça ne suffit pas
  });
});
