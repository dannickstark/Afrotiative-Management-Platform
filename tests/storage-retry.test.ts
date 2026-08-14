import { describe, it, expect } from "bun:test";
import { retryTransient } from "@/lib/storage/retry";

// tests/storage-retry.test.ts — le correctif du bug « Téléversement impossible : le stockage R2 est
// momentanément indisponible » (asset-core.ts). aws4fetch RÉESSAIE les statuts HTTP 5xx/429 mais PAS
// une erreur RÉSEAU levée (socket reset/timeout, `fetch` qui rejette) ; putObject n'ajoutait aucun
// réessai. `retryTransient` comble ce trou : réessai borné avec backoff, injecté d'un `sleep` no-op
// pour rester déterministe et instantané en test. La classification transitoire/permanente vit dans
// isTransientR2Error (tests/storage-r2-retry.test.ts) — ici on teste UNIQUEMENT la mécanique de boucle.

const noSleep = async () => {};

describe("retryTransient — réessai borné avec backoff (sleep injecté)", () => {
  it("réussit au 1er coup : n'appelle fn qu'une fois, renvoie la valeur", async () => {
    let calls = 0;
    const out = await retryTransient(async () => { calls++; return "ok"; }, { sleep: noSleep });
    expect(out).toBe("ok");
    expect(calls).toBe(1);
  });

  it("réessaie après un échec TRANSITOIRE puis réussit", async () => {
    let calls = 0;
    const out = await retryTransient(async () => {
      calls++;
      if (calls < 2) throw new Error("ECONNRESET");
      return "ok";
    }, { attempts: 3, sleep: noSleep });
    expect(out).toBe("ok");
    expect(calls).toBe(2);
  });

  it("abandonne après `attempts` échecs et relance la DERNIÈRE erreur", async () => {
    let calls = 0;
    const err = new Error("socket hang up");
    await expect(retryTransient(async () => { calls++; throw err; }, { attempts: 3, sleep: noSleep }))
      .rejects.toThrow("socket hang up");
    expect(calls).toBe(3);
  });

  it("NE réessaie PAS une erreur jugée permanente par shouldRetry (échec immédiat)", async () => {
    let calls = 0;
    const permanent = new Error("403");
    await expect(retryTransient(async () => { calls++; throw permanent; }, {
      attempts: 5, sleep: noSleep, shouldRetry: () => false,
    })).rejects.toThrow("403");
    expect(calls).toBe(1);
  });

  it("attempts=1 ne réessaie jamais (une seule tentative)", async () => {
    let calls = 0;
    await expect(retryTransient(async () => { calls++; throw new Error("x"); }, { attempts: 1, sleep: noSleep }))
      .rejects.toThrow("x");
    expect(calls).toBe(1);
  });
});
