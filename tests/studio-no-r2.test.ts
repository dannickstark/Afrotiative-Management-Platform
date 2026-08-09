import { describe, it, expect, afterAll } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { renderManualCore } from "@/lib/studio/manual-core";
import { uploadAssetCore } from "@/lib/studio/asset-core";
import { StorageBanner } from "@/components/studio/storage-banner";

// tests/studio-no-r2.test.ts — Tâche 15 (spec §8) : avec les cinq variables R2_* absentes,
// getStudioConfig() renvoie null et les actions d'écriture du studio renvoient le message français
// « … non configuré » plutôt que de lever une exception (« fail-soft », même politique que
// getWpConfig()/WordPress). Même motif de sauvegarde/restauration que tests/studio-config.test.ts —
// nécessaire ici aussi : une variable R2_* laissée effacée après ce fichier casserait tout fichier
// suivant du même process `bun test` qui suppose ces variables intactes (ex. un test qui, lui,
// s'attend à un stockage RÉELLEMENT configuré).
const R2_KEYS = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_PUBLIC_BASE_URL"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of R2_KEYS) saved[k] = process.env[k];
for (const k of R2_KEYS) delete process.env[k];

// Restauration dans un afterAll (exécuté même si un test échoue en cours de route, contrairement à
// un simple nettoyage en fin de fichier).
afterAll(() => {
  for (const k of R2_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!; }
});

// ─────────────────────────────────────────────────────────────────────────────
describe("renderManualCore — sans R2, message français plutôt qu'une exception (Tâche 14/15)", () => {
  it("renvoie { ok:false, message:\"Stockage R2 non configuré.\" } SANS lever, avant même de résoudre un gabarit", async () => {
    // Aucun fixture DB nécessaire : le contrôle getStudioConfig() est la TOUTE PREMIÈRE chose que
    // renderManualCore fait (lib/studio/manual-core.ts), avant la moindre requête resolveTemplate —
    // ce test passerait donc même si "quote_card" n'avait littéralement aucun gabarit en base.
    let threw = false;
    let res: Awaited<ReturnType<typeof renderManualCore>>;
    try {
      res = await renderManualCore({ context: "quote_card", values: {} });
    } catch {
      threw = true;
      res = { ok: false, message: "" };
    }
    expect(threw).toBe(false);
    expect(res!.ok).toBe(false);
    if (res!.ok) return;
    expect(res!.message).toBe("Stockage R2 non configuré.");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("uploadAssetCore — sans R2, même message français, sans lever (non-régression Tâche 11)", () => {
  it("renvoie { ok:false, message:\"Stockage R2 non configuré.\" } avant toute tentative de PUT R2", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "x.png", { type: "image/png" });
    let threw = false;
    let res: Awaited<ReturnType<typeof uploadAssetCore>>;
    try {
      res = await uploadAssetCore({ kind: "image", name: "x", file, userId: "00000000-0000-0000-0000-000000000000" });
    } catch {
      threw = true;
      res = { ok: false, message: "" };
    }
    expect(threw).toBe(false);
    expect(res!.ok).toBe(false);
    if (res!.ok) return;
    expect(res!.message).toBe("Stockage R2 non configuré.");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bannière de lecture seule (Tâche 15) — composant PARTAGÉ par /studio, /studio/[id],
// /studio/assets et /studio/generer. Rendu structurel réel (react-dom/server), pas seulement un
// test de la fonction qui la déclenche : components/studio/asset-library.tsx et editor-shell.tsx ne
// peuvent PAS être rendus sous `bun test` (ils appellent useRouter(), qui exige un arbre App Router
// monté — vérifié empiriquement : "invariant expected app router to be mounted" — react-dom/server
// seul ne le fournit pas), donc leur intégration de la bannière/désactivation est vérifiée
// manuellement en navigateur (voir le rapport de tâche), PAS ici. components/studio/manual-generate.tsx
// n'a PAS ce problème (aucun useRouter) — sa propre bannière + désactivation de *Générer* sont
// couvertes dans tests/studio-manual.test.ts.
describe("StorageBanner — composant partagé, message français explicite", () => {
  it("rend un texte explicite mentionnant R2 et le mode lecture seule", () => {
    const html = renderToStaticMarkup(React.createElement(StorageBanner));
    expect(html).toContain('data-testid="storage-banner"');
    expect(html).toContain("non configuré");
    expect(html).toContain("lecture seule");
  });
});
