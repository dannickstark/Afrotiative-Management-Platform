import { describe, it, expect } from "bun:test";
import { planRegeneration } from "@/lib/pipeline/regen-plan";
import { startRegenJobSchema } from "@/lib/validation";
import type { RegenerateFieldsInput } from "@/lib/validation";

const NONE: RegenerateFieldsInput = { title: false, body: false, excerpt: false, category: false, tags: false, image: false };
const IMAGE_ONLY: RegenerateFieldsInput = { ...NONE, image: true };
const IMAGE_AND_TITLE: RegenerateFieldsInput = { ...NONE, image: true, title: true };
const TITLE_ONLY: RegenerateFieldsInput = { ...NONE, title: true };

describe("planRegeneration", () => {
  it("sans image cochée, génère et ignore l'image", () => {
    const p = planRegeneration({ fields: TITLE_ONLY, candidateCount: 0 });
    expect(p.runGeneration).toBe(true);
    expect(p.imageAction).toBe("skip");
    expect(p.abort).toBeNull();
    expect(p.warning).toBeNull();
    expect(p.effectiveFields).toEqual(TITLE_ONLY);
  });

  it("image seule sans candidat : abandonne sans rien écrire", () => {
    const p = planRegeneration({ fields: IMAGE_ONLY, candidateCount: 0 });
    expect(p.abort).toBe("Aucune image candidate trouvée — image inchangée.");
    expect(p.runGeneration).toBe(false);
  });

  it("image + autres champs sans candidat : applique les autres, épargne l'image, avertit", () => {
    const p = planRegeneration({ fields: IMAGE_AND_TITLE, candidateCount: 0 });
    expect(p.abort).toBeNull();
    expect(p.runGeneration).toBe(true);
    expect(p.imageAction).toBe("skip");
    expect(p.effectiveFields.image).toBe(false);
    expect(p.effectiveFields.title).toBe(true);
    expect(p.warning).toBe("Aucune image candidate trouvée — image inchangée.");
  });

  it("image cochée avec des candidats : prend l'image du brouillon", () => {
    const p = planRegeneration({ fields: IMAGE_ONLY, candidateCount: 3 });
    expect(p.runGeneration).toBe(true);
    expect(p.imageAction).toBe("from-draft");
    expect(p.abort).toBeNull();
    expect(p.warning).toBeNull();
  });
});

describe("startRegenJobSchema", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const fields = { title: true, body: false, excerpt: false, category: false, tags: false, image: false };
  it("plafonne à 10 articles", () => {
    expect(startRegenJobSchema.safeParse({ articleIds: Array(11).fill(id), fields }).success).toBe(false);
    expect(startRegenJobSchema.safeParse({ articleIds: Array(10).fill(id), fields }).success).toBe(true);
  });
  it("imageMode vaut auto par défaut", () => {
    const r = startRegenJobSchema.safeParse({ articleIds: [id], fields });
    expect(r.success && r.data.imageMode).toBe("auto");
  });
  it("refuse une liste vide", () => {
    expect(startRegenJobSchema.safeParse({ articleIds: [], fields }).success).toBe(false);
  });
});
