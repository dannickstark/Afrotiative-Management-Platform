import { describe, it, expect } from "bun:test";
import {
  readStored, writeStored, shouldRestore, QUEUE_FILTERS_KEY,
} from "@/hooks/use-persisted-filters";

// Faux localStorage — le hook lui-même n'est pas monté ici (pas de DOM dans bun test) ; ce sont
// ses trois décisions pures qui portent toute la logique et qui sont testées.
function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
    dump: () => Object.fromEntries(map),
  };
}

const throwingStorage = {
  getItem: () => { throw new Error("SecurityError"); },
  setItem: () => { throw new Error("QuotaExceededError"); },
};

describe("shouldRestore", () => {
  it("restaure sur une URL nue avec une valeur mémorisée", () => {
    expect(shouldRestore("", "status=approved&cat=abc")).toBe(true);
  });

  it("ne restaure pas quand l'URL porte déjà des paramètres", () => {
    expect(shouldRestore("status=pending", "status=approved")).toBe(false);
  });

  it("ne restaure pas sans valeur mémorisée", () => {
    expect(shouldRestore("", null)).toBe(false);
    expect(shouldRestore("", "")).toBe(false);
  });
});

describe("readStored / writeStored", () => {
  it("relit ce qui a été écrit", () => {
    const s = fakeStorage();
    writeStored(QUEUE_FILTERS_KEY, "status=approved", s);
    expect(readStored(QUEUE_FILTERS_KEY, s)).toBe("status=approved");
  });

  it("une valeur absente ou vide se lit comme null", () => {
    expect(readStored(QUEUE_FILTERS_KEY, fakeStorage())).toBeNull();
    expect(readStored(QUEUE_FILTERS_KEY, fakeStorage({ [QUEUE_FILTERS_KEY]: "" }))).toBeNull();
  });

  it("tolère un stockage indisponible (navigation privée, quota)", () => {
    expect(readStored(QUEUE_FILTERS_KEY, throwingStorage)).toBeNull();
    expect(() => writeStored(QUEUE_FILTERS_KEY, "status=all", throwingStorage)).not.toThrow();
  });

  it("tolère l'absence totale de stockage (rendu serveur)", () => {
    expect(readStored(QUEUE_FILTERS_KEY, null)).toBeNull();
    expect(() => writeStored(QUEUE_FILTERS_KEY, "status=all", null)).not.toThrow();
  });
});
