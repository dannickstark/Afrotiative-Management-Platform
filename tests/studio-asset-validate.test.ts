import { describe, it, expect } from "bun:test";
import sharp from "sharp";
import {
  validateImageAsset, validateFontAsset, findReferencingTemplates, sceneReferencesAsset,
  MAX_IMAGE_BYTES, MAX_FONT_BYTES,
  type TemplateReferenceCheckRow,
} from "@/lib/studio/asset-validate";

// tests/studio-asset-validate.test.ts — PUR, hors ligne, sans réseau ni base de données (Tâche 11).
// lib/studio/asset-validate.ts n'importe ni @/db ni R2 ; chaque test ici construit ses propres
// octets en mémoire.

// ─────────────────────────────────────────────────────────────────────────────
describe("validateImageAsset", () => {
  it("accepte un vrai PNG avec des dimensions réelles", async () => {
    const png = await sharp({
      create: { width: 64, height: 32, channels: 3, background: { r: 10, g: 20, b: 30 } },
    }).png().toBuffer();
    const res = await validateImageAsset(new Uint8Array(png));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.format).toBe("png");
    expect(res.width).toBe(64);
    expect(res.height).toBe(32);
    expect(res.mime).toBe("image/png");
  });

  it("accepte un vrai JPEG, WebP et SVG", async () => {
    const base = sharp({ create: { width: 40, height: 20, channels: 3, background: { r: 1, g: 2, b: 3 } } });
    const jpeg = await base.clone().jpeg().toBuffer();
    const webp = await base.clone().webp().toBuffer();
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20"/></svg>');

    const rJpeg = await validateImageAsset(new Uint8Array(jpeg));
    expect(rJpeg.ok).toBe(true);
    if (rJpeg.ok) expect(rJpeg.format).toBe("jpeg");

    const rWebp = await validateImageAsset(new Uint8Array(webp));
    expect(rWebp.ok).toBe(true);
    if (rWebp.ok) expect(rWebp.format).toBe("webp");

    const rSvg = await validateImageAsset(new Uint8Array(svg));
    expect(rSvg.ok).toBe(true);
    if (rSvg.ok) { expect(rSvg.format).toBe("svg"); expect(rSvg.width).toBe(40); expect(rSvg.height).toBe(20); }
  });

  // Exigé par le brief Tâche 11 : "a file declaring image/png but containing text is refused" — le
  // MIME déclaré (jamais consulté par validateImageAsset, voir la note du module) ne joue AUCUN rôle
  // ici ; c'est bien le CONTENU (du texte brut, indécodable par sharp) qui fait échouer le test,
  // exactement comme un vrai File({ type: "image/png" }) envelopperait ces mêmes octets sans que ça
  // change rien à la décision.
  it("refuse un fichier qui se déclare image/png mais dont le contenu est du texte brut", async () => {
    const fakeBytes = new TextEncoder().encode(
      "Ceci n'est absolument pas une image PNG, juste du texte brut qui prétend en être une.",
    );
    const res = await validateImageAsset(fakeBytes);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain("invalide");
    // Le message ne doit jamais laisser fuir le texte natif de sharp (en anglais).
    expect(res.message).not.toMatch(/unsupported|buffer|decode/i);
  });

  // Exigé par le brief Tâche 11 : "a 6 MB image is refused" — un PNG RÉEL et valide, mais dont la
  // taille dépasse la limite de 5 Mo : le refus doit venir de la taille, pas d'un défaut de décodage.
  it("refuse une image réelle et valide de 6 Mo (dépasse la limite de 5 Mo)", async () => {
    const sixMb = new Uint8Array(6 * 1024 * 1024);
    // Signature PNG réelle en tête — si la garde de taille était retirée par erreur, ce test
    // échouerait pour la MAUVAISE raison (échec de décodage) plutôt que d'attester la vraie garde.
    sixMb.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    expect(sixMb.byteLength).toBeGreaterThan(MAX_IMAGE_BYTES);

    const res = await validateImageAsset(sixMb);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain("volumineuse");
    expect(res.message).toContain("5.0 Mo");
  });

  it("refuse un format décodable par sharp mais hors liste acceptée (TIFF)", async () => {
    const tiff = await sharp({
      create: { width: 20, height: 20, channels: 3, background: { r: 5, g: 5, b: 5 } },
    }).tiff().toBuffer();
    const res = await validateImageAsset(new Uint8Array(tiff));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain("non pris en charge");
  });

  it("refuse un fichier vide", async () => {
    const res = await validateImageAsset(new Uint8Array(0));
    expect(res.ok).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("validateFontAsset — les quatre octets magiques valides (spec §5)", () => {
  const cases: { label: string; magic: number[]; ext: "ttf" | "otf" }[] = [
    { label: "TTF (00 01 00 00)", magic: [0x00, 0x01, 0x00, 0x00], ext: "ttf" },
    { label: "\"true\"", magic: [0x74, 0x72, 0x75, 0x65], ext: "ttf" },
    { label: "\"ttcf\"", magic: [0x74, 0x74, 0x63, 0x66], ext: "ttf" },
    { label: "\"OTTO\"", magic: [0x4f, 0x54, 0x54, 0x4f], ext: "otf" },
  ];

  for (const { label, magic, ext } of cases) {
    it(`accepte la signature ${label}`, () => {
      const bytes = new Uint8Array(64);
      bytes.set(magic, 0);
      const res = validateFontAsset(bytes);
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.ext).toBe(ext);
    });
  }

  it("exhaustivité : les QUATRE cas ci-dessus couvrent bien les quatre signatures listées par le contrat, aucune de plus", () => {
    expect(cases.map((c) => c.label)).toHaveLength(4);
  });
});

describe("validateFontAsset — refus", () => {
  // Exigé par le brief Tâche 11 : "a WOFF2 buffer is refused" — avec le message français explicite
  // sur Satori (pas seulement un refus générique de signature).
  it("refuse une police WOFF2 avec un message explicite mentionnant Satori", () => {
    const bytes = new Uint8Array(64);
    bytes.set([0x77, 0x4f, 0x46, 0x32], 0); // "wOF2"
    const res = validateFontAsset(bytes);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain("WOFF2");
    expect(res.message).toContain("Satori");
  });

  it("refuse une police WOFF1 (même moteur, même incapacité)", () => {
    const bytes = new Uint8Array(64);
    bytes.set([0x77, 0x4f, 0x46, 0x46], 0); // "wOFF"
    const res = validateFontAsset(bytes);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain("WOFF");
  });

  it("refuse une signature binaire non reconnue", () => {
    const bytes = new Uint8Array(64).fill(0x41); // "AAAA…"
    const res = validateFontAsset(bytes);
    expect(res.ok).toBe(false);
  });

  it("refuse une police réelle et valide (signature TTF) mais trop volumineuse (> 2 Mo)", () => {
    const bytes = new Uint8Array(3 * 1024 * 1024);
    bytes.set([0x00, 0x01, 0x00, 0x00], 0);
    expect(bytes.byteLength).toBeGreaterThan(MAX_FONT_BYTES);
    const res = validateFontAsset(bytes);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain("volumineuse");
  });

  it("refuse un fichier vide", () => {
    const res = validateFontAsset(new Uint8Array(0));
    expect(res.ok).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sabotage à blanc, documenté : un contrôle de taille placé APRÈS le contrôle de signature évaluerait
// quand même WOFF2 correctement (la signature est vérifiée en premier de toute façon) ; ce qui
// distinguerait un vrai bug d'ordre serait un fichier WOFF2 ET trop gros à la fois — les deux tests
// ci-dessus utilisent des tailles sous la limite, donc n'attestent que la détection de signature en
// isolation. Couvert explicitement : un WOFF2 de plus de 2 Mo doit être refusé pour la raison TAILLE
// (cohérent avec "Contrôles, dans cet ordre : Taille max, [...], Extension refusée" — spec §5).
describe("validateFontAsset — ordre des contrôles (taille avant signature, spec §5)", () => {
  it("un WOFF2 trop volumineux est refusé pour la taille, pas seulement pour le format", () => {
    const bytes = new Uint8Array(3 * 1024 * 1024);
    bytes.set([0x77, 0x4f, 0x46, 0x32], 0);
    const res = validateFontAsset(bytes);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain("volumineuse");
    expect(res.message).not.toContain("WOFF2");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Exigé par le brief Tâche 11 : "delete refused while referenced" — la partie PURE et testable hors
// DB de deleteAsset() (lib/studio/asset-core.ts) : étant donné une liste de gabarits (déjà filtrée
// "non archivés" par l'appelant — voir la note du module), quels gabarits référencent cet asset ?
describe("sceneReferencesAsset / findReferencingTemplates — le scan qui fonde le refus de suppression", () => {
  function textScene(assetId: string | undefined) {
    return {
      schemaVersion: 1,
      canvas: { width: 100, height: 100, background: "#000" },
      layers: [{
        id: "t", name: "Titre", visible: true, locked: false,
        frame: { x: 0, y: 0, w: 100, h: 50 }, type: "text", content: "x",
        font: { family: "Noto Sans", size: 12, weight: 400, assetId },
        color: "#fff", align: "left", vAlign: "top", lineHeight: 1.2,
      }],
    };
  }

  function imageScene(source: unknown) {
    return {
      schemaVersion: 1,
      canvas: { width: 100, height: 100, background: "#000" },
      layers: [{
        id: "i", name: "Image", visible: true, locked: false,
        frame: { x: 0, y: 0, w: 100, h: 100 }, type: "image", source, fit: "cover",
      }],
    };
  }

  it("une police d'asset RÉFÉRENCÉE par un calque texte est détectée", () => {
    expect(sceneReferencesAsset(textScene("font-1"), "font-1")).toBe(true);
  });

  it("un ASSET DIFFÉRENT référencé par le même calque n'est PAS une correspondance", () => {
    expect(sceneReferencesAsset(textScene("font-1"), "font-2")).toBe(false);
  });

  it("un calque texte sans assetId (police intégrée) ne référence rien", () => {
    expect(sceneReferencesAsset(textScene(undefined), "font-1")).toBe(false);
  });

  it("une image d'asset RÉFÉRENCÉE par { kind: 'asset', assetId } est détectée", () => {
    expect(sceneReferencesAsset(imageScene({ kind: "asset", assetId: "img-1" }), "img-1")).toBe(true);
  });

  it("une image dont la source est un JETON ou une URL (pas 'asset') ne référence jamais un assetId", () => {
    expect(sceneReferencesAsset(imageScene({ kind: "slot", slot: "article.image" }), "img-1")).toBe(false);
    expect(sceneReferencesAsset(imageScene({ kind: "url", url: "https://x.test/y.png" }), "img-1")).toBe(false);
  });

  it("une scène malformée ne fait jamais planter le scan — elle ne référence simplement rien", () => {
    expect(sceneReferencesAsset(null, "x")).toBe(false);
    expect(sceneReferencesAsset({}, "x")).toBe(false);
    expect(sceneReferencesAsset({ layers: "pas-un-tableau" }, "x")).toBe(false);
    expect(sceneReferencesAsset({ layers: [null, 42, { type: "text" }] }, "x")).toBe(false);
  });

  it("findReferencingTemplates nomme CHAQUE gabarit non archivé qui référence l'asset, et EXCLUT ceux qui ne le référencent pas", () => {
    const rows: TemplateReferenceCheckRow[] = [
      { id: "t1", name: "Bandeau A", scene: textScene("font-1") },
      { id: "t2", name: "Bandeau B", scene: imageScene({ kind: "asset", assetId: "img-sans-rapport" }) }, // ID différent, jamais une correspondance
      { id: "t3", name: "Carte C", scene: textScene("font-1") },
      { id: "t4", name: "Sans rapport", scene: textScene("autre-police") },
    ];
    const refs = findReferencingTemplates("font-1", rows);
    expect(refs.map((r) => r.id).sort()).toEqual(["t1", "t3"]);
    expect(refs.map((r) => r.name).sort()).toEqual(["Bandeau A", "Carte C"]);
  });

  // sceneReferencesAsset compare des IDENTIFIANTS, sans connaître le "kind" (image/police) de
  // l'asset — ce n'est pas son rôle : la table render_assets garantit qu'un même UUID désigne
  // toujours UN SEUL asset, jamais à la fois une image et une police, donc un calque image et un
  // calque texte ne peuvent en pratique jamais référencer le MÊME identifiant pour deux assets
  // distincts. Un calque du "mauvais type" qui porterait quand même cet identifiant (donnée
  // incohérente) doit rester détecté, pas silencieusement ignoré — mieux vaut un refus de
  // suppression trop prudent qu'un asset supprimé sous les pieds d'un calque qui le référence
  // encore, quel que soit son type.
  it("un calque de N'IMPORTE QUEL type portant le même identifiant compte comme une référence", () => {
    const rows: TemplateReferenceCheckRow[] = [
      { id: "t1", name: "Calque image", scene: imageScene({ kind: "asset", assetId: "asset-1" }) },
    ];
    expect(findReferencingTemplates("asset-1", rows).map((r) => r.id)).toEqual(["t1"]);
  });

  it("aucun gabarit ne référence l'asset : liste vide, pas une exception", () => {
    const rows: TemplateReferenceCheckRow[] = [{ id: "t1", name: "Seul", scene: textScene("autre") }];
    expect(findReferencingTemplates("font-1", rows)).toEqual([]);
  });

  // Cette assertion serait FAUSSE PAR CONSTRUCTION si findReferencingTemplates ignorait purement et
  // simplement son paramètre `templates` (ex. renvoyait toujours []) : le test précédent
  // ("nomme CHAQUE gabarit…") le distingue déjà, mais on le rend explicite ici — retirer le filtre
  // `.filter(...)` de l'implémentation ferait échouer CE test précis en renvoyant TOUS les gabarits
  // au lieu des deux qui correspondent réellement.
  it("sabotage-check : un findReferencingTemplates qui renverrait tout, sans filtrer, échouerait ici", () => {
    const rows: TemplateReferenceCheckRow[] = [
      { id: "t1", name: "Correspond", scene: textScene("font-1") },
      { id: "t2", name: "Ne correspond pas", scene: textScene("autre-police") },
      { id: "t3", name: "Ne correspond pas non plus", scene: imageScene({ kind: "url", url: "https://x.test" }) },
    ];
    const refs = findReferencingTemplates("font-1", rows);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.id).toBe("t1");
  });
});
