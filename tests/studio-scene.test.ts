import { describe, it, expect } from "bun:test";
import { FORMAT_PRESETS } from "@/lib/studio/formats";
import { formatRadius, isCssRadius, parseRadiusInput, parseScene, SceneError, type Scene } from "@/lib/studio/scene";

const valid: Scene = {
  schemaVersion: 1,
  canvas: { width: 1200, height: 675, background: "#000000" },
  layers: [
    { id: "l1", name: "Fond", visible: true, locked: false, frame: { x: 0, y: 0, w: 1200, h: 675 },
      type: "image", source: { kind: "slot", slot: "article.image" }, fit: "cover", blur: 24, overlay: "#000000A6" },
    { id: "l2", name: "Titre", visible: true, locked: false, frame: { x: 80, y: 400, w: 1040, h: 200 },
      type: "text", content: "{{article.title}}", font: { family: "Noto Sans", size: 64, weight: 700 },
      color: "#FFFFFF", align: "left", vAlign: "bottom", lineHeight: 1.1, maxLines: 3 },
  ],
};

describe("parseScene", () => {
  it("accepte une scène valide et la renvoie typée", () => {
    expect(parseScene(structuredClone(valid)).layers).toHaveLength(2);
  });

  it("refuse une version de schéma inconnue", () => {
    expect(() => parseScene({ ...structuredClone(valid), schemaVersion: 2 })).toThrow(/Scène invalide.*attendu/i);
  });

  it("refuse un type de calque inconnu", () => {
    const bad = structuredClone(valid);
    (bad.layers[0] as unknown as { type: string }).type = "video";
    expect(() => parseScene(bad)).toThrow(/Entrée invalide/i);
  });

  it("refuse deux calques partageant le même identifiant", () => {
    const bad = structuredClone(valid);
    bad.layers[1].id = "l1";
    expect(() => parseScene(bad)).toThrow(/identifiant.*double/i);
  });

  it("refuse une couleur hexadécimale malformée", () => {
    const bad = structuredClone(valid);
    bad.canvas.background = "rouge";
    expect(() => parseScene(bad)).toThrow(/Couleur invalide/i);
  });

  it("refuse un fit value invalide", () => {
    const bad = structuredClone(valid);
    (bad.layers[0] as unknown as { fit: string }).fit = "stretch";
    expect(() => parseScene(bad)).toThrow(/Scène invalide.*valeur parmi/i);
  });

  // U4 Tâche 4 — parseScene ne s'arrête plus à la PREMIÈRE anomalie : un gabarit qui porte
  // plusieurs erreurs à la fois (type de calque inconnu, dimension négative, identifiant en
  // double) doit toutes les remonter en une seule levée, pour qu'un rédacteur les corrige toutes
  // sans relancer l'aperçu à chaque fois.
  it("parseScene rapporte TOUTES les erreurs, pas seulement la première", () => {
    const bad = structuredClone(valid);
    (bad.layers[0] as unknown as { type: string }).type = "video"; // issue 1 : layers.0.type
    bad.layers[1].frame.w = -10; // issue 2 : layers.1.frame.w
    bad.layers[1].id = "l1"; // issue 3 : identifiant de calque en double
    try {
      parseScene(bad);
      throw new Error("devrait lever");
    } catch (e) {
      expect(e).toBeInstanceOf(SceneError);
      const msg = (e as SceneError).message;
      expect(msg).toContain("layers.0.type");
      expect(msg).toContain("layers.1.frame.w");
      expect(msg).toContain("identifiant de calque en double");
    }
  });

  it("une scène à une seule erreur ne laisse pas de séparateur qui traîne", () => {
    const bad = structuredClone(valid);
    (bad.layers[0] as unknown as { type: string }).type = "video";
    try {
      parseScene(bad);
      throw new Error("devrait lever");
    } catch (e) {
      const msg = (e as SceneError).message;
      expect(msg).not.toContain("\n");
      expect(msg.startsWith("Scène invalide : ")).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Migration de `radius` sur un calque FORME (U3 Tâche 2, arbitrage C / défaut de plan #12).
// La sonde a mesuré, à travers renderScene(), qu'un rayon NUMÉRIQUE ne peut pas exprimer une
// ellipse : sur 800×400, `radius: 200` donne un STADE. Le champ accepte donc désormais AUSSI une
// chaîne CSS — sans qu'aucune scène déjà écrite (rayon en pixels) ne se relise différemment.
// ─────────────────────────────────────────────────────────────────────────────
describe("parseScene — le rayon d'un calque forme", () => {
  function sceneWithRadius(radius: unknown) {
    return {
      schemaVersion: 1,
      canvas: { width: 800, height: 400, background: "#000000" },
      layers: [{
        id: "s", name: "Forme", visible: true, locked: false,
        frame: { x: 0, y: 0, w: 800, h: 400 },
        type: "shape", shape: "rect", fill: "#FF0000",
        ...(radius === undefined ? {} : { radius }),
      }],
    };
  }
  function radiusOf(radius: unknown) {
    const layer = parseScene(sceneWithRadius(radius)).layers[0];
    if (layer.type !== "shape") throw new Error("calque inattendu");
    return layer.radius;
  }

  it("relit un rayon en PIXELS exactement comme avant la migration", () => {
    for (const value of [0, 1, 8.5, 60, 200, 2593]) {
      expect(radiusOf(value)).toBe(value);
    }
    expect(radiusOf(undefined)).toBeUndefined();
  });

  it("accepte désormais une chaîne CSS — c'est ce qui rend l'ellipse exprimable", () => {
    for (const value of ["50%", "0.5%", "8px", "100%", "8px 24px", "8px 24px 8px 24px"]) {
      expect(radiusOf(value)).toBe(value);
    }
  });

  it("refuse ce qui n'est ni un rayon en pixels ni une longueur CSS, en français", () => {
    for (const value of [-1, "banane", "50", "50 %", "8px 24px 8px 24px 8px", "50%;", true, {}]) {
      expect(() => parseScene(sceneWithRadius(value))).toThrow(SceneError);
      expect(() => parseScene(sceneWithRadius(value))).toThrow(/Rayon invalide/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// U3 Tâche 3 — LA GRAMMAIRE DU RAYON, ET LES DEUX CONVERSIONS QUE L'INTERFACE DEMANDE.
//
// Dette 1 du « PIÈGE POUR LA TÂCHE 3 » (tests/studio-shapes.test.ts) : le champ « Rayon des coins »
// du panneau de propriétés était NUMÉRIQUE. Il affichait donc `0` pour un rayon en CHAÎNE (« 50% »)
// et l'ÉCRASAIT au premier commit — inatteignable tant qu'aucune forme n'utilisait de pourcentage,
// vivant à l'instant où l'ellipse est livrée. Le correctif demande deux conversions (stocké ->
// affiché, saisi -> stocké) ; elles vivent ICI, à côté de la seule expression régulière qui définit
// ce qu'est un rayon, plutôt que dans le composant qui en aurait fait une SECONDE grammaire libre de
// dériver de celle du schéma (le défaut de famille que SHAPE_KINDS existe déjà pour tuer).
// ─────────────────────────────────────────────────────────────────────────────
describe("le rayon vu par l'interface — formatRadius / parseRadiusInput", () => {
  it("affiche la valeur STOCKÉE telle qu'elle est — jamais « 0 » pour une chaîne", () => {
    expect(formatRadius("50%")).toBe("50%");
    expect(formatRadius("8px 24px")).toBe("8px 24px");
    expect(formatRadius(12)).toBe("12");
    expect(formatRadius(12.5)).toBe("12.5");
    expect(formatRadius(0)).toBe("0");
    expect(formatRadius(undefined)).toBe("");
    // LE défaut, dit en une assertion : l'ancien champ affichait « 0 » ici.
    expect(formatRadius("50%")).not.toBe("0");
  });

  it("un texte de chiffres nus reste la forme HISTORIQUE : un nombre de pixels", () => {
    // Le schéma REFUSE la chaîne « 50 » (voir le test « refuse ce qui n'est ni… » plus haut) : la
    // saisie doit donc devenir un NOMBRE, pas être stockée telle quelle.
    expect(parseRadiusInput("12")).toBe(12);
    expect(parseRadiusInput("12.5")).toBe(12.5);
    expect(parseRadiusInput(" 60 ")).toBe(60);
  });

  it("une longueur CSS est conservée TELLE QUELLE", () => {
    for (const text of ["50%", "0.5%", "8px", "100%", "8px 24px", "8px 24px 8px 24px"]) {
      expect(parseRadiusInput(text)).toBe(text);
    }
  });

  it("« rien » et « 0 » signifient tous deux AUCUN rayon (les deux chemins de rendu n'émettent rien)", () => {
    expect(parseRadiusInput("")).toBeUndefined();
    expect(parseRadiusInput("   ")).toBeUndefined();
    expect(parseRadiusInput("0")).toBeUndefined();
  });

  it("un texte qui n'est PAS un rayon est REFUSÉ (null) — pas silencieusement converti en 0", () => {
    // C'est la moitié « ne rien écraser » du correctif : le champ revient à la valeur stockée quand
    // la saisie est refusée. Un repli sur 0 détruirait un « 50% » à la première frappe malheureuse.
    for (const text of ["banane", "-1", "50 %", "8px 24px 8px 24px 8px", "50%;", "1e3", "50px%", "%"]) {
      expect(parseRadiusInput(text)).toBeNull();
    }
  });

  it("tout ce que parseRadiusInput ACCEPTE, parseScene l'accepte aussi — la grammaire est UNE", () => {
    // LE garde-fou anti-dérive : desserrer parseRadiusInput sans desserrer le schéma ferait écrire
    // par l'interface une scène que sa propre relecture refuserait. Mutation qui rougit : accepter
    // « 50 » comme chaîne, ou « 8px 24px 8px 24px 8px ».
    const inputs = ["", "0", "12", "12.5", "0.5%", "50%", "100%", "8px", "8px 24px", "8px 24px 8px 24px"];
    for (const text of inputs) {
      const value = parseRadiusInput(text);
      expect(value).not.toBeNull();
      const scene = {
        schemaVersion: 1,
        canvas: { width: 800, height: 400, background: "#000000" },
        layers: [{
          id: "s", name: "Forme", visible: true, locked: false,
          frame: { x: 0, y: 0, w: 800, h: 400 },
          type: "shape", shape: "rect", fill: "#FF0000",
          ...(value === undefined ? {} : { radius: value }),
        }],
      };
      const layer = parseScene(scene).layers[0];
      if (layer.type !== "shape") throw new Error("calque inattendu");
      expect(layer.radius).toBe(value as number | string | undefined);
    }
  });

  it("isCssRadius EST le prédicat que le schéma applique — pas une seconde copie", () => {
    // Vérifié des deux côtés : ce que le prédicat accepte, parseScene l'accepte ; ce qu'il refuse,
    // parseScene le refuse. Sans ces deux sens, exporter le prédicat pourrait le laisser dériver.
    function schemaAccepts(radius: unknown): boolean {
      try {
        parseScene({
          schemaVersion: 1,
          canvas: { width: 800, height: 400, background: "#000000" },
          layers: [{
            id: "s", name: "Forme", visible: true, locked: false,
            frame: { x: 0, y: 0, w: 800, h: 400 },
            type: "shape", shape: "rect", fill: "#FF0000", radius,
          }],
        });
        return true;
      } catch {
        return false;
      }
    }
    for (const value of [0, 12, 12.5, 2593, "50%", "8px", "8px 24px", -1, "50", "banane", true, {}, null]) {
      expect(`${JSON.stringify(value)} -> ${isCssRadius(value)}`).toBe(`${JSON.stringify(value)} -> ${schemaAccepts(value)}`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// U3 Tâche 4 — L'OMBRE D'UNE FORME, DANS LE SCHÉMA.
//
// MIGRATION, énoncée explicitement : `shapeLayer.shadow` est un champ NOUVEAU et OPTIONNEL, de la
// MÊME forme que `textLayer.shadow` (x, y, blur ≥ 0, color) — les deux partagent désormais UNE seule
// définition zod, pour qu'aucune des deux ne puisse dériver de l'autre. Aucune scène déjà écrite ne
// change : sans le champ, la relecture est identique octet pour octet (le test « une scène de forme
// SANS ombre se relit inchangée » ci-dessous l'épingle).
// ─────────────────────────────────────────────────────────────────────────────
describe("l'ombre d'une forme — le schéma (U3 Tâche 4)", () => {
  function sceneWithShadow(shadow: unknown) {
    return {
      schemaVersion: 1,
      canvas: { width: 800, height: 400, background: "#000000" },
      layers: [{
        id: "s", name: "Forme", visible: true, locked: false,
        frame: { x: 0, y: 0, w: 800, h: 400 },
        type: "shape", shape: "rect", fill: "#FF0000",
        ...(shadow === undefined ? {} : { shadow }),
      }],
    };
  }
  function shadowOf(shadow: unknown) {
    const layer = parseScene(sceneWithShadow(shadow)).layers[0];
    if (layer.type !== "shape") throw new Error("calque inattendu");
    return layer.shadow;
  }

  it("une ombre de forme fait l'aller-retour par parseScene, intacte", () => {
    expect(shadowOf({ x: 4, y: 8, blur: 12, color: "#00FF0080" }))
      .toEqual({ x: 4, y: 8, blur: 12, color: "#00FF0080" });
    // Décalages NÉGATIFS (une ombre en haut à gauche) et flou NUL : deux valeurs légales qu'un
    // schéma trop serré refuserait, et que le panneau doit pouvoir écrire.
    expect(shadowOf({ x: -6, y: -3, blur: 0, color: "#000000" }))
      .toEqual({ x: -6, y: -3, blur: 0, color: "#000000" });
  });

  it("une scène de forme SANS ombre se relit inchangée — la migration est purement additive", () => {
    expect(shadowOf(undefined)).toBeUndefined();
    // Et l'objet relu ne fabrique PAS la clé : une scène sans ombre ne doit pas se mettre à porter
    // « shadow: undefined » (ce que l'autosave sérialiserait, changeant les octets stockés).
    const layer = parseScene(sceneWithShadow(undefined)).layers[0];
    expect("shadow" in layer).toBe(false);
  });

  it("un jeton de couleur est accepté comme dans toute autre couleur", () => {
    expect(shadowOf({ x: 0, y: 2, blur: 4, color: "{{category.color}}" }))
      .toEqual({ x: 0, y: 2, blur: 4, color: "{{category.color}}" });
  });

  it("refuse une ombre malformée, en français", () => {
    for (const bad of [
      { x: 0, y: 2, blur: -1, color: "#000000" },   // flou négatif
      { x: 0, y: 2, blur: 4, color: "rouge" },      // couleur invalide
      { x: 0, y: 2, color: "#000000" },             // flou absent
      { y: 2, blur: 4, color: "#000000" },          // décalage absent
      "0 2 4 #000000",                              // pas un objet
    ]) {
      expect(() => parseScene(sceneWithShadow(bad))).toThrow(SceneError);
      expect(() => parseScene(sceneWithShadow(bad))).toThrow(/Scène invalide/);
    }
  });

  it("l'ombre d'un TEXTE et celle d'une FORME sont la MÊME définition — mêmes acceptations, mêmes refus", () => {
    // Les deux champs partagent un seul objet zod : un durcissement de l'un doit valoir pour l'autre.
    // Sans cette garde, deux définitions jumelles pourraient dériver (le défaut de famille que
    // SHAPE_KINDS existe déjà pour tuer).
    function textAccepts(shadow: unknown): boolean {
      try {
        parseScene({
          schemaVersion: 1,
          canvas: { width: 800, height: 400, background: "#000000" },
          layers: [{
            id: "t", name: "T", visible: true, locked: false,
            frame: { x: 0, y: 0, w: 800, h: 400 },
            type: "text", content: "x", font: { family: "Noto Sans", size: 20, weight: 400 },
            color: "#FFFFFF", align: "left", vAlign: "top", lineHeight: 1.2, shadow,
          }],
        });
        return true;
      } catch { return false; }
    }
    function shapeAccepts(shadow: unknown): boolean {
      try { parseScene(sceneWithShadow(shadow)); return true; } catch { return false; }
    }
    const cases: unknown[] = [
      { x: 0, y: 2, blur: 4, color: "#000000" },
      { x: -6, y: -3, blur: 0, color: "{{category.color}}" },
      { x: 0, y: 2, blur: -1, color: "#000000" },
      { x: 0, y: 2, blur: 4, color: "rouge" },
      { x: 0, y: 2, color: "#000000" },
      { x: 0, y: 2, blur: 4, color: "transparent" },
      "0 2 4 #000000",
      null,
    ];
    for (const c of cases) {
      expect(`${JSON.stringify(c)} texte=${textAccepts(c)}`).toBe(`${JSON.stringify(c)} texte=${shapeAccepts(c)}`);
    }
    // ANTI-VACUITÉ : sans au moins un accepté ET un refusé, l'égalité ci-dessus serait triviale.
    expect(cases.filter(shapeAccepts).length).toBeGreaterThan(0);
    expect(cases.filter((c) => !shapeAccepts(c)).length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Chantier B, Tâche 5 — `groupId`, NOUVEAU et OPTIONNEL sur CHAQUE type de calque (`layerBase`, sur le
// modèle EXACT de `constraints` : voir tests/studio-constraints.test.ts pour le même trio d'épreuves
// sur ce champ-là). MIGRATION NO-OP : une scène déjà écrite (aucun calque n'a cette clé) se relit
// EXACTEMENT comme avant — aucun designer qui n'a jamais groupé quoi que ce soit ne voit sa scène
// changer d'un octet.
// ─────────────────────────────────────────────────────────────────────────────
describe("parseScene — groupId (chantier B, Tâche 5)", () => {
  it("accepte un calque SANS groupId — l'absence est le comportement d'aujourd'hui, pas une régression", () => {
    expect(() => parseScene(structuredClone(valid))).not.toThrow();
    const parsed = parseScene(structuredClone(valid));
    // ANTI-VACUITÉ : ne pas juste vérifier « ça ne lève pas » — prouver que zod n'a RIEN inventé.
    expect("groupId" in parsed.layers[0]).toBe(false);
    expect("groupId" in parsed.layers[1]).toBe(false);
  });

  it("accepte un calque avec un groupId", () => {
    const withGroup = structuredClone(valid);
    (withGroup.layers[0] as { groupId?: string }).groupId = "g1";
    (withGroup.layers[1] as { groupId?: string }).groupId = "g1";
    const parsed = parseScene(withGroup);
    expect(parsed.layers[0].groupId).toBe("g1");
    expect(parsed.layers[1].groupId).toBe("g1");
  });

  it("refuse un groupId qui n'est pas une chaîne — preuve que le champ EST validé, pas juste toléré", () => {
    const bad = structuredClone(valid);
    (bad.layers[0] as unknown as { groupId: number }).groupId = 42;
    expect(() => parseScene(bad)).toThrow(/Scène invalide/);
  });

  // MIGRATION NO-OP (load-bearing, même épreuve que constraints/formatOverrides) : une scène stockée
  // SANS groupId fait un aller-retour par parseScene strictement inchangée (deep-equal), preuve que
  // l'ajout du champ est purement additif.
  it("migration no-op : une scène sans groupId round-trip inchangée", () => {
    const stored = structuredClone(valid);
    const roundTripped = parseScene(structuredClone(stored));
    expect(roundTripped).toEqual(stored);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Properties Pro P1, Tâche 2 — CADRAGE avancé d'une image : `sizing`/`focal`/`tile`/`customSize`,
// tous NOUVEAUX et OPTIONNELS (adjudiqué à la Tâche 1 (spike) : PAS de `blend`, Satori ne sait pas
// le peindre). MIGRATION NO-OP, même épreuve que `constraints`/`groupId` plus haut : une scène déjà
// écrite (qui ne connaît que `fit`) fait un aller-retour par parseScene strictement inchangée.
// ─────────────────────────────────────────────────────────────────────────────
describe("parseScene — le cadrage avancé d'une image (Properties Pro P1, Tâche 2)", () => {
  function imageWith(extra: Record<string, unknown>) {
    return {
      schemaVersion: 1,
      canvas: { width: 800, height: 400, background: "#000000" },
      layers: [{
        id: "img", name: "Image", visible: true, locked: false,
        frame: { x: 0, y: 0, w: 800, h: 400 },
        type: "image", source: { kind: "slot", slot: "article.image" }, fit: "cover",
        ...extra,
      }],
    };
  }

  it("migration no-op : une image sans sizing/focal/tile/customSize round-trip inchangée", () => {
    const stored = imageWith({});
    const parsed = parseScene(structuredClone(stored));
    expect(parsed.layers[0]).not.toHaveProperty("sizing");
    expect(parsed.layers[0]).not.toHaveProperty("focal");
    expect(parsed.layers[0]).not.toHaveProperty("tile");
    expect(parsed.layers[0]).not.toHaveProperty("customSize");
    // Aller-retour JSON deep-equal : la migration ne fait apparaître AUCUNE clé.
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(stored);
  });

  it("sizing accepte les cinq modes, refuse l'inconnu", () => {
    for (const s of ["cover", "contain", "stretch", "tile", "custom"]) {
      expect(() => parseScene(imageWith({ sizing: s }))).not.toThrow();
    }
    expect(() => parseScene(imageWith({ sizing: "bogus" }))).toThrow(SceneError);
  });

  it("tile.axis accepte both/x/y, refuse space/round", () => {
    for (const axis of ["both", "x", "y"]) {
      expect(() => parseScene(imageWith({ tile: { scale: 0.5, axis } }))).not.toThrow();
    }
    for (const axis of ["space", "round"]) {
      expect(() => parseScene(imageWith({ tile: { scale: 0.5, axis } }))).toThrow(SceneError);
    }
  });

  it("tile.scale doit être strictement positif", () => {
    expect(() => parseScene(imageWith({ tile: { scale: 0, axis: "both" } }))).toThrow(SceneError);
    expect(() => parseScene(imageWith({ tile: { scale: -1, axis: "both" } }))).toThrow(SceneError);
  });

  it("focal se clampe au refus : hors [0,1] est REJETÉ, pas silencieusement clampé", () => {
    expect(() => parseScene(imageWith({ focal: { x: 0.5, y: 0.5 } }))).not.toThrow();
    expect(() => parseScene(imageWith({ focal: { x: 0, y: 1 } }))).not.toThrow();
    expect(() => parseScene(imageWith({ focal: { x: 1.5, y: 0.5 } }))).toThrow(SceneError);
    expect(() => parseScene(imageWith({ focal: { x: 0.5, y: -0.2 } }))).toThrow(SceneError);
  });

  it("customSize exige des dimensions strictement positives", () => {
    expect(() => parseScene(imageWith({ customSize: { w: 100, h: 50 } }))).not.toThrow();
    expect(() => parseScene(imageWith({ customSize: { w: 0, h: 50 } }))).toThrow(SceneError);
    expect(() => parseScene(imageWith({ customSize: { w: 100, h: -10 } }))).toThrow(SceneError);
  });

  it("aucun champ `blend` — adjudiqué à la Tâche 1 (spike), Satori ne le peint pas", () => {
    const parsed = parseScene(imageWith({ blend: "multiply" }));
    // zod refuse par défaut les clés inconnues sur un z.object non-strict ? Non : elles sont
    // simplement IGNORÉES (comportement par défaut de zod). Le test épingle donc l'ABSENCE de la
    // clé en sortie, preuve qu'aucun schéma ne la reconnaît.
    expect(parsed.layers[0]).not.toHaveProperty("blend");
  });
});

describe("FORMAT_PRESETS", () => {
  it("expose les huit préréglages avec des dimensions positives", () => {
    const keys = Object.keys(FORMAT_PRESETS);
    expect(keys).toHaveLength(8);
    for (const k of keys) {
      const p = FORMAT_PRESETS[k as keyof typeof FORMAT_PRESETS];
      expect(p.width).toBeGreaterThan(0);
      expect(p.height).toBeGreaterThan(0);
    }
  });
});
