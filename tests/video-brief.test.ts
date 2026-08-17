import { describe, it, expect } from "bun:test";
import { renderTemplate, contractBlock, buildBrief, DEFAULT_BRIEF_TEMPLATE, categoryBlock, type BriefVars, type BriefCategory } from "@/lib/video/brief";
import { payloadSchema, SCHEMA_VERSION } from "@/lib/video/schema";

const VARS: BriefVars = {
  titre: "La success story de Babadampulu",
  sujet: "PME agroalimentaire devenue exportatrice",
  plateforme: "YouTube long",
  duree_cible: "12 min",
  ratio: "16:9",
  article_titre: "", article_url: "", article_extrait: "",
};

describe("renderTemplate", () => {
  it("interpole les variables connues", () => {
    const r = renderTemplate("Sujet : {{titre}}", VARS);
    expect(r.text).toBe("Sujet : La success story de Babadampulu");
    expect(r.unknown).toEqual([]);
  });

  it("laisse une variable inconnue telle quelle et la signale", () => {
    // La remplacer par du vide ferait disparaître une faute de frappe dans un prompt qu'on colle
    // sans le relire.
    const r = renderTemplate("Ton : {{tonalite}}", VARS);
    expect(r.text).toBe("Ton : {{tonalite}}");
    expect(r.unknown).toEqual(["tonalite"]);
  });

  it("ne signale qu'une fois une variable inconnue répétée", () => {
    expect(renderTemplate("{{x}} et {{x}}", VARS).unknown).toEqual(["x"]);
  });
});

describe("contractBlock", () => {
  it("contient le JSON-Schema, l'exemple et la version", () => {
    const block = contractBlock();
    expect(block).toContain("schema_version");
    expect(block).toContain(SCHEMA_VERSION);
    expect(block).toContain("b-01-accroche");
  });

  it("énonce les règles dures, y compris la stabilité des identifiants", () => {
    const block = contractBlock();
    expect(block).toContain("uniquement");   // « réponds uniquement par un objet JSON »
    expect(block).toContain("identiques");   // « conserve les id à l'identique »
  });

  it("énonce les règles inter-champs absentes du JSON-Schema", () => {
    const block = contractBlock();
    expect(block).toContain("tc_out");
    expect(block).toContain("unique");
  });

  it("l'exemple inclus est valide au regard du schéma", () => {
    // Le point : le brief ne peut pas montrer au chat un exemple que l'import refuserait.
    const start = contractBlock().indexOf("{\n  \"schema_version\"");
    const example = contractBlock().slice(start, contractBlock().lastIndexOf("}") + 1);
    expect(payloadSchema.safeParse(JSON.parse(example)).success).toBe(true);
  });
});

describe("buildBrief", () => {
  it("concatène style maison, recherche et contrat, dans cet ordre", () => {
    const r = buildBrief(DEFAULT_BRIEF_TEMPLATE, VARS);
    const styleAt = r.text.indexOf("Babadampulu");
    const contractAt = r.text.indexOf("schema_version");
    expect(styleAt).toBeGreaterThan(-1);
    expect(contractAt).toBeGreaterThan(styleAt);
  });

  it("remonte les variables inconnues du modèle", () => {
    expect(buildBrief("Ton : {{inexistante}}", VARS).unknown).toEqual(["inexistante"]);
  });

  it("le modèle par défaut n'a aucune variable inconnue", () => {
    expect(buildBrief(DEFAULT_BRIEF_TEMPLATE, VARS).unknown).toEqual([]);
  });
});

const CATEGORIE: BriefCategory = {
  name: "Investigation",
  instructions: "Chaque affirmation doit citer deux sources indépendantes.",
};

describe("bloc catégorie", () => {
  it("titre la section avec le nom et reprend les instructions telles quelles", () => {
    const b = categoryBlock(CATEGORIE);
    expect(b).toContain("## Instructions de la catégorie — Investigation");
    expect(b).toContain("Chaque affirmation doit citer deux sources indépendantes.");
  });

  it("sans catégorie, le brief est identique à celui d'avant", () => {
    // Garantie de non-régression : c'est le brief que reçoivent tous les projets existants.
    expect(buildBrief(DEFAULT_BRIEF_TEMPLATE, VARS, null).text)
      .toBe(buildBrief(DEFAULT_BRIEF_TEMPLATE, VARS).text);
  });

  it("place les instructions APRÈS le style maison et AVANT le bloc Recherche", () => {
    const t = buildBrief(DEFAULT_BRIEF_TEMPLATE, VARS, CATEGORIE).text;
    const style = t.indexOf("Ligne éditoriale");
    const categorie = t.indexOf("## Instructions de la catégorie");
    const recherche = t.indexOf("## Recherche attendue");
    expect(style).toBeGreaterThan(-1);
    expect(categorie).toBeGreaterThan(style);
    expect(recherche).toBeGreaterThan(categorie);
  });

  it("laisse le contrat en dernier mot du brief", () => {
    // Le contrat garantit que l'import fonctionne : aucune instruction d'expert ne doit pouvoir le
    // contredire par simple position dans le texte.
    const t = buildBrief(DEFAULT_BRIEF_TEMPLATE, VARS, CATEGORIE).text;
    expect(t.indexOf("## Format de réponse")).toBeGreaterThan(t.indexOf("## Instructions de la catégorie"));
  });

  it("des instructions blanches ne produisent aucun bloc", () => {
    // Un titre de section suivi du vide est un signal parasite pour le modèle.
    const t = buildBrief(DEFAULT_BRIEF_TEMPLATE, VARS, { name: "Vide", instructions: "   \n " }).text;
    expect(t).not.toContain("## Instructions de la catégorie");
    expect(t).toBe(buildBrief(DEFAULT_BRIEF_TEMPLATE, VARS).text);
  });

  it("ne perturbe pas la détection des variables inconnues", () => {
    expect(buildBrief("Ton : {{inexistante}}", VARS, CATEGORIE).unknown).toEqual(["inexistante"]);
  });
});
