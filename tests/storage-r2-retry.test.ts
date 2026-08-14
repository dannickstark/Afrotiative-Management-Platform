import { describe, it, expect } from "bun:test";
import { putObject, isTransientR2Error, R2HttpError } from "@/lib/storage/r2";
import type { StudioConfig } from "@/lib/studio/config";

// tests/storage-r2-retry.test.ts — le correctif du « stockage R2 momentanément indisponible » qui
// apparaissait PARFOIS au téléversement. Cause : aws4fetch réessaie les statuts 5xx/429 mais PAS une
// erreur réseau LEVÉE (socket reset/timeout) ; putObject n'ajoutait aucun réessai → une panne réseau
// transitoire remontait telle quelle à l'utilisateur. putObject enveloppe désormais l'appel dans
// retryTransient (lib/storage/retry.ts) + un timeout par tentative, et réessaie les erreurs
// TRANSITOIRES (réseau + 5xx/429/408) sans réessayer les erreurs PERMANENTES (4xx). Les tests
// injectent `sendRequest` (le VRAI appel signé aws4fetch en prod) et un `sleep` no-op.

const cfg: StudioConfig = {
  accountId: "acct", accessKeyId: "ak", secretAccessKey: "sk",
  bucket: "b", publicBaseUrl: "https://cdn.example",
};
const bytes = new Uint8Array([1, 2, 3]);
const noSleep = async () => {};

describe("putObject — réessai des pannes R2 transitoires", () => {
  it("succès direct : renvoie l'URL publique, un seul appel réseau", async () => {
    let calls = 0;
    const url = await putObject(cfg, "assets/x.png", bytes, "image/png", {
      sleep: noSleep,
      sendRequest: async () => { calls++; return { ok: true, status: 200 }; },
    });
    expect(url).toBe("https://cdn.example/assets/x.png");
    expect(calls).toBe(1);
  });

  it("réessaie une ERREUR RÉSEAU levée (socket reset) puis réussit — le cas du bug", async () => {
    let calls = 0;
    const url = await putObject(cfg, "assets/x.png", bytes, "image/png", {
      sleep: noSleep,
      sendRequest: async () => {
        calls++;
        if (calls < 2) throw new TypeError("fetch failed"); // undici socket error
        return { ok: true, status: 200 };
      },
    });
    expect(url).toBe("https://cdn.example/assets/x.png");
    expect(calls).toBe(2);
  });

  it("réessaie un statut 503 transitoire puis réussit", async () => {
    let calls = 0;
    const url = await putObject(cfg, "assets/x.png", bytes, "image/png", {
      sleep: noSleep,
      sendRequest: async () => {
        calls++;
        return calls < 2 ? { ok: false, status: 503 } : { ok: true, status: 200 };
      },
    });
    expect(url).toBe("https://cdn.example/assets/x.png");
    expect(calls).toBe(2);
  });

  it("ÉCHOUE VITE sur un 4xx permanent (403) — aucun réessai", async () => {
    let calls = 0;
    await expect(putObject(cfg, "assets/x.png", bytes, "image/png", {
      sleep: noSleep,
      sendRequest: async () => { calls++; return { ok: false, status: 403 }; },
    })).rejects.toBeInstanceOf(R2HttpError);
    expect(calls).toBe(1);
  });

  it("abandonne après le plafond de tentatives si la panne réseau persiste", async () => {
    let calls = 0;
    await expect(putObject(cfg, "assets/x.png", bytes, "image/png", {
      sleep: noSleep,
      sendRequest: async () => { calls++; throw new Error("ETIMEDOUT"); },
    })).rejects.toThrow();
    expect(calls).toBeGreaterThan(1);
  });
});

describe("isTransientR2Error — classification transitoire vs permanente", () => {
  it("5xx / 429 / 408 sont TRANSITOIRES", () => {
    for (const s of [500, 502, 503, 504, 429, 408]) {
      expect(isTransientR2Error(new R2HttpError(s))).toBe(true);
    }
  });
  it("les autres 4xx sont PERMANENTS (403, 400, 404)", () => {
    for (const s of [400, 403, 404]) {
      expect(isTransientR2Error(new R2HttpError(s))).toBe(false);
    }
  });
  it("une erreur réseau levée (non-HTTP) est TRANSITOIRE", () => {
    expect(isTransientR2Error(new TypeError("fetch failed"))).toBe(true);
    expect(isTransientR2Error(new Error("socket hang up"))).toBe(true);
  });
});
