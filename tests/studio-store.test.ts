import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { computeInputHash, storageKeyFor, MemoryRenderStore, R2RenderStore, findCachedRender, saveRender } from "@/lib/studio/store";
import { db, renders } from "@/db";
import { eq } from "drizzle-orm";

// Isolate R2 env vars for testing
const R2_KEYS = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_PUBLIC_BASE_URL"] as const;
const r2Saved: Record<string, string | undefined> = {};
for (const k of R2_KEYS) r2Saved[k] = process.env[k];

function setAllR2(v: string | undefined) {
  for (const k of R2_KEYS) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
}

const baseInput = {
  templateId: "11111111-1111-1111-1111-111111111111",
  templateVersion: 3,
  values: { "article.title": "Titre", "category.color": "#1B7F4A" } as const,
};

describe("computeInputHash", () => {
  it("est stable pour des entrées identiques", () => {
    expect(computeInputHash(baseInput)).toBe(computeInputHash(structuredClone(baseInput)));
  });

  it("est insensible à l'ordre des clés de valeurs", () => {
    const reordered = { ...baseInput, values: { "category.color": "#1B7F4A", "article.title": "Titre" } as const };
    expect(computeInputHash(reordered)).toBe(computeInputHash(baseInput));
  });

  it("change si la version du gabarit change", () => {
    expect(computeInputHash({ ...baseInput, templateVersion: 4 })).not.toBe(computeInputHash(baseInput));
  });

  it("change si une valeur change", () => {
    expect(computeInputHash({ ...baseInput, values: { ...baseInput.values, "article.title": "Autre" } }))
      .not.toBe(computeInputHash(baseInput));
  });

  // Chantier D, Tâche 6 — `format` (nouveau champ OPTIONNEL). Correctif de sécurité de cache : SANS
  // ce champ dans l'empreinte, deux canaux de formats différents partageant le même gabarit résolu
  // (lib/studio/index.ts#renderForArticle, chantier D T6) trouveraient le rendu l'un de l'autre en
  // cache et le SERVIRAIENT tel quel — mauvaises dimensions, mise en page pour un autre format. Voir
  // tests/studio-bindings.test.ts (« deux formats CIBLES différents ... ») pour la preuve bout en
  // bout, EN PIXELS ; ce fichier épingle juste l'empreinte elle-même, en isolation.
  it("change si `format` change (deux canaux de formats différents, même gabarit/version/valeurs, ne collisionnent JAMAIS en cache)", () => {
    expect(computeInputHash({ ...baseInput, format: "wa_square" }))
      .not.toBe(computeInputHash({ ...baseInput, format: "story" }));
  });

  it("`format` absent produit EXACTEMENT la même empreinte qu'avant cette tâche (rétrocompatibilité : AUCUNE invalidation de cache pour les appelants qui ne le fournissent pas encore, ex. lib/studio/manual-core.ts)", () => {
    // `format: undefined` explicite doit se comporter EXACTEMENT comme son absence — pas une
    // troisième valeur distincte (ex. sérialisée en "undefined" ou normalisée en `null`).
    expect(computeInputHash({ ...baseInput, format: undefined })).toBe(computeInputHash(baseInput));
  });

  it("`format` présent produit une empreinte DIFFÉRENTE de son absence, même valeur de gabarit/version/valeurs par ailleurs", () => {
    expect(computeInputHash({ ...baseInput, format: "story" })).not.toBe(computeInputHash(baseInput));
  });

  // Qualité, C — `encode` (nouveau champ OPTIONNEL), MÊME correctif de sécurité de cache que
  // `format` juste au-dessus : lib/wp/publish.ts demande désormais du WebP là où les canaux sociaux
  // restent en JPEG. Sans `encode` dans l'empreinte, le second appelant trouverait le rendu du
  // premier en cache et servirait un fichier au MAUVAIS format — avec l'extension et le
  // Content-Type de l'autre, puisque tous deux viennent de `out.mime`.
  it("change si `encode` change (JPEG et WebP ne collisionnent JAMAIS en cache)", () => {
    expect(computeInputHash({ ...baseInput, format: "website_featured", encode: "webp" }))
      .not.toBe(computeInputHash({ ...baseInput, format: "website_featured", encode: "jpeg" }));
  });

  it("`encode` absent produit EXACTEMENT l'empreinte d'avant ce chantier (aucune invalidation du cache existant)", () => {
    // Les DEUX canoniques historiques doivent être préservés : avec `format` et sans.
    expect(computeInputHash({ ...baseInput, encode: undefined })).toBe(computeInputHash(baseInput));
    expect(computeInputHash({ ...baseInput, format: "story", encode: undefined }))
      .toBe(computeInputHash({ ...baseInput, format: "story" }));
  });

  it("`encode` présent produit une empreinte DIFFÉRENTE de son absence", () => {
    expect(computeInputHash({ ...baseInput, encode: "jpeg" })).not.toBe(computeInputHash(baseInput));
  });
});

describe("storageKeyFor", () => {
  it("range par année et mois avec la bonne extension", () => {
    expect(storageKeyFor("abc123", "image/jpeg", new Date("2026-08-09T10:00:00Z")))
      .toBe("renders/2026/08/abc123.jpg");
    expect(storageKeyFor("abc123", "image/webp", new Date("2026-01-02T10:00:00Z")))
      .toBe("renders/2026/01/abc123.webp");
  });

  it("utilise UTC et ne bascule pas au fuseau local à la limite des mois", () => {
    // 2026-01-31T23:30:00Z is late in January UTC.
    // This would roll to February in some local timezones; the test ensures we use UTC.
    expect(storageKeyFor("abc123", "image/jpeg", new Date("2026-01-31T23:30:00Z")))
      .toBe("renders/2026/01/abc123.jpg");
  });
});

describe("MemoryRenderStore", () => {
  it("conserve les octets et renvoie une URL utilisable", async () => {
    const store = new MemoryRenderStore();
    const url = await store.put("renders/2026/08/x.jpg", new Uint8Array([1, 2, 3]), "image/jpeg");
    expect(url).toContain("renders/2026/08/x.jpg");
    expect(store.objects.get("renders/2026/08/x.jpg")).toEqual(new Uint8Array([1, 2, 3]));
  });
});

describe("R2RenderStore", () => {
  beforeEach(() => setAllR2(undefined));
  afterAll(() => { for (const k of R2_KEYS) { if (r2Saved[k] === undefined) delete process.env[k]; else process.env[k] = r2Saved[k]!; } });

  it("lève une erreur si R2 n'est pas configuré", async () => {
    const store = new R2RenderStore();
    try {
      await store.put("test/key", new Uint8Array([1, 2, 3]), "image/jpeg");
      expect.unreachable("R2RenderStore.put should have thrown");
    } catch (err) {
      expect((err as Error).message).toContain("Stockage R2 non configuré");
    }
  });
});

describe("Cache round-trip (DB-backed)", () => {
  let testHash: string;

  beforeAll(async () => {
    testHash = computeInputHash({
      templateId: "22222222-2222-2222-2222-222222222222",
      templateVersion: 1,
      values: { "article.title": "Test Article" },
    });
    // Delete-then-insert : testHash est un littéral FIXE (mêmes templateId/values à chaque
    // exécution), donc une exécution interrompue après l'insertion mais avant l'afterAll ci-dessous
    // laisserait une ligne à ce hash — poison pour la prochaine exécution. On la supprime
    // défensivement avant de commencer plutôt que de compter uniquement sur le nettoyage en fin de
    // suite. (saveRender est désormais idempotent sur un conflit d'inputHash — voir
    // lib/studio/store.ts — donc ce cas précis ne ferait plus planter le test, mais rien ne garantit
    // que la ligne poison porte encore les mêmes champs que ceux affirmés plus bas.)
    await db.delete(renders).where(eq(renders.inputHash, testHash));
  });

  afterAll(async () => {
    // Clean up test data
    await db.delete(renders).where(eq(renders.inputHash, testHash));
  });

  it("sauvegarde et retrouve un rendu en cache par son hash", async () => {
    const row = await saveRender({
      templateId: "22222222-2222-2222-2222-222222222222",
      templateVersion: 1,
      context: "article",
      subjectType: "article",
      subjectId: "33333333-3333-3333-3333-333333333333",
      inputHash: testHash,
      storageKey: "renders/2026/08/test.jpg",
      url: "https://example.com/renders/2026/08/test.jpg",
      width: 1200,
      height: 630,
      bytes: 12345,
      degraded: false,
    });
    expect(row.id).toBeDefined();
    expect(row.inputHash).toBe(testHash);

    const cached = await findCachedRender(testHash);
    expect(cached).toBeDefined();
    expect(cached?.inputHash).toBe(testHash);
    expect(cached?.url).toBe("https://example.com/renders/2026/08/test.jpg");
  });

  // Important 1 (revue de branche) : deux rendus concurrents et identiques (double clic, deux
  // onglets) peuvent tous les deux dépasser le court-circuit findCachedRender avant que l'un des
  // deux insère sa ligne — le second insert violerait alors renders_input_hash_unique. Ce test
  // simule le SECOND appel du gagnant (même inputHash, mais des champs différents — comme le
  // ferait un second rendu produisant des octets légèrement différents) : il doit renvoyer la ligne
  // EXISTANTE plutôt que de lever, et surtout ne PAS écraser les champs déjà en base.
  //
  // Hash DÉDIÉ à ce test (PAS `testHash`, partagé avec le test précédent de ce describe) : la
  // première version de ce test réutilisait `testHash` et échouait par ordre d'exécution — le test
  // précédent ("sauvegarde et retrouve…") avait déjà inséré une ligne à ce hash avant que celui-ci
  // ne s'exécute, donc le "premier" appel ci-dessous heurtait DÉJÀ un conflit (onConflictDoNothing)
  // et renvoyait CETTE ligne-là plutôt que d'insérer réellement — le test ne prouvait alors plus rien
  // sur la course qu'il prétendait couvrir. Un hash isolé rend ce test correct indépendamment de
  // l'ordre d'exécution des tests voisins.
  it("un second saveRender avec le même inputHash renvoie la ligne existante au lieu de lever (course de cache)", async () => {
    const raceHash = computeInputHash({
      templateId: "55555555-5555-5555-5555-555555555555",
      templateVersion: 1,
      values: { "article.title": "Course de cache" },
    });
    await db.delete(renders).where(eq(renders.inputHash, raceHash)); // delete-then-insert défensif

    try {
      const first = await saveRender({
        templateId: "55555555-5555-5555-5555-555555555555",
        templateVersion: 1,
        context: "article",
        subjectType: "article",
        subjectId: "33333333-3333-3333-3333-333333333333",
        inputHash: raceHash,
        storageKey: "renders/2026/08/premier.jpg",
        url: "https://example.com/renders/2026/08/premier.jpg",
        width: 1200,
        height: 630,
        bytes: 111,
        degraded: false,
      });

      const second = await saveRender({
        templateId: "55555555-5555-5555-5555-555555555555",
        templateVersion: 1,
        context: "article",
        subjectType: "article",
        subjectId: "44444444-4444-4444-4444-444444444444", // volontairement différent du premier
        inputHash: raceHash, // même hash : c'est CE qui déclenche le conflit
        storageKey: "renders/2026/08/second.jpg",
        url: "https://example.com/renders/2026/08/second.jpg",
        width: 999,
        height: 999,
        bytes: 222,
        degraded: true,
      });

      // Pas d'exception (le test lui-même échouerait autrement), et la ligne renvoyée par le
      // "second" appel est bien la PREMIÈRE — pas une seconde ligne, pas les champs du second appel.
      expect(second.id).toBe(first.id);
      expect(second.url).toBe("https://example.com/renders/2026/08/premier.jpg");
      expect(second.subjectId).toBe("33333333-3333-3333-3333-333333333333");
      expect(second.degraded).toBe(false);

      // Une seule ligne existe réellement en base pour ce hash — le conflit n'a pas produit de doublon.
      const rows = await db.select().from(renders).where(eq(renders.inputHash, raceHash));
      expect(rows).toHaveLength(1);
    } finally {
      await db.delete(renders).where(eq(renders.inputHash, raceHash));
    }
  });
});
