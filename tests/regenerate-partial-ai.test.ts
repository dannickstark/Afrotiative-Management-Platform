import { describe, it, expect } from "bun:test";
import { buildArticleSchema, ALL_DRAFT_FIELDS, type DraftFields } from "@/lib/ai/schema";
import { buildArticlePrompt, partialDraftIsFlaky } from "@/lib/ai/generate-article";

// Régénération PARTIELLE : quand l'éditeur décoche « Corps » dans « Renvoyer à l'IA », faire
// rédiger l'article entier pour n'en garder que le titre est du pur gaspillage (le corps pèse
// >90 % des tokens de sortie). Ces tests verrouillent les trois pièces qui rendent la génération
// consciente de la sélection : le schéma, le prompt, et le prédicat de rotation OpenRouter.
const only = (over: Partial<DraftFields>): DraftFields =>
  ({ title: false, body: false, excerpt: false, category: false, tags: false, image: false, ...over });

const CONF = { categoryUncertain: false, imageMissing: false, clusterUncertain: false };

describe("buildArticleSchema — sélection de champs", () => {
  it("n'exige plus bodyHtml quand le corps n'est pas coché", () => {
    const s = buildArticleSchema(["Économie"], only({ title: true }));
    expect(s.safeParse({ title: "Un titre suffisamment long", confidence: CONF }).success).toBe(true);
  });

  it("rejette encore un objet auquel manque un champ COCHÉ", () => {
    const s = buildArticleSchema(["Économie"], only({ title: true, excerpt: true }));
    expect(s.safeParse({ title: "Un titre suffisamment long", confidence: CONF }).success).toBe(false);
  });

  it("garde toujours `confidence` — applyRegeneration fusionne les flags champ par champ", () => {
    const s = buildArticleSchema(["Économie"], only({ tags: true }));
    expect(s.safeParse({ tags: ["BRVM"] }).success).toBe(false);
    expect(s.safeParse({ tags: ["BRVM"], confidence: CONF }).success).toBe(true);
  });

  it("contraint toujours la catégorie à la liste fournie, même en sélection partielle", () => {
    const s = buildArticleSchema(["Économie", "Finance"], only({ category: true }));
    expect(s.safeParse({ category: "Sport", confidence: CONF }).success).toBe(false);
    expect(s.safeParse({ category: "Finance", confidence: CONF }).success).toBe(true);
  });

  // Non-régression : l'ingestion (lib/pipeline/stages.ts) appelle buildArticleSchema SANS `fields`.
  it("exige tous les champs par défaut (aucun `fields` passé = comportement d'ingestion)", () => {
    const s = buildArticleSchema(["Économie"]);
    expect(s.safeParse({ title: "Un titre suffisamment long", confidence: CONF }).success).toBe(false);
  });
});

describe("buildArticlePrompt — corps NON coché", () => {
  const base = {
    sources: [{ mediaName: "Ecofin", url: "https://ecofin.example/a", text: "x".repeat(9000) }],
    candidateImages: [] as string[],
    categories: ["Économie", "Marchés"],
    current: { title: "Titre actuel de l'article", bodyHtml: "<p>Corps déjà rédigé et validé.</p>" },
  };

  it("ne demande PLUS de rédiger un article et fournit le corps existant comme référence", () => {
    const p = buildArticlePrompt({ ...base, fields: only({ title: true }) });
    expect(p).not.toContain("rédige UN article original");
    expect(p).toContain("<p>Corps déjà rédigé et validé.</p>");
    expect(p).toContain("Titre actuel de l'article");
  });

  it("ne demande que les champs cochés", () => {
    const p = buildArticlePrompt({ ...base, fields: only({ title: true }) }).toLowerCase();
    expect(p).toContain("titre");
    expect(p).not.toContain("tags courts");
    expect(p).not.toMatch(/extrait/);
  });

  it("tronque le texte des sources (contexte secondaire seulement)", () => {
    const p = buildArticlePrompt({ ...base, fields: only({ title: true }) });
    expect(p).toContain("Ecofin");
    expect(p.length).toBeLessThan(4000); // 9000 car. de source ne peuvent plus passer entiers
  });

  it("n'envoie PAS le corps existant quand seule l'image est cochée (inutile pour choisir une image)", () => {
    const p = buildArticlePrompt({ ...base, fields: only({ image: true }), candidateImages: ["https://cdn.example/i.jpg"] });
    expect(p).not.toContain("<p>Corps déjà rédigé et validé.</p>");
    expect(p).toContain("https://cdn.example/i.jpg");
  });

  // Non-régression : corps coché ⇒ prompt d'origine mot pour mot.
  it("garde le prompt de rédaction complet dès que le corps est coché", () => {
    const p = buildArticlePrompt({ ...base, fields: ALL_DRAFT_FIELDS });
    expect(p).toContain("rédige UN article original");
    expect(p).toContain("<h2>");
    expect(p).toContain("x".repeat(6000)); // troncature d'origine à 6000 caractères
  });

  it("garde le prompt de rédaction complet quand aucun `fields` n'est passé (ingestion)", () => {
    const p = buildArticlePrompt({ sources: base.sources, candidateImages: [], categories: base.categories });
    expect(p).toContain("rédige UN article original");
  });
});

describe("partialDraftIsFlaky", () => {
  it("qualifie de bancal un brouillon dont un champ texte coché est vide", () => {
    expect(partialDraftIsFlaky({ title: "", confidence: CONF }, only({ title: true }))).toBe(true);
    expect(partialDraftIsFlaky({ excerpt: "   ", confidence: CONF }, only({ excerpt: true }))).toBe(true);
    expect(partialDraftIsFlaky({ confidence: CONF }, only({ category: true }))).toBe(true);
  });

  it("accepte un brouillon dont tous les champs cochés sont renseignés", () => {
    expect(partialDraftIsFlaky({ title: "Un titre", confidence: CONF }, only({ title: true }))).toBe(false);
  });

  // Une image absente est un résultat LÉGITIME (confidence.imageMissing), pas une réponse bancale :
  // faire tourner le jeton OpenRouter suivant ne changerait rien si aucune image ne convient.
  it("n'est jamais bancal sur une sélection image seule, même sans image retenue", () => {
    expect(partialDraftIsFlaky({ featuredImageUrl: null, confidence: CONF }, only({ image: true }))).toBe(false);
  });

  // Idem pour les tags : une liste vide est permise par le schéma, pas un signal de panne.
  it("n'est pas bancal sur des tags vides", () => {
    expect(partialDraftIsFlaky({ tags: [], confidence: CONF }, only({ tags: true }))).toBe(false);
  });
});
