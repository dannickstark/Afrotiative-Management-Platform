import { describe, it, expect, mock, beforeAll, afterAll } from "bun:test";
import sharp from "sharp";
import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { db, renderTemplates, renders, user } from "@/db";
import { eq, inArray, sql } from "drizzle-orm";
import { parseScene, type Scene } from "@/lib/studio/scene";
import { renderScene } from "@/lib/studio/render";
import { previewTemplateCore } from "@/lib/studio/preview-core";
import { SAMPLE_VALUES } from "@/lib/studio/sample-values";
import { ARTICLE_IMAGE_TEMPLATE, FB_TEMPLATE, IG_TEMPLATE } from "@/db/studio-templates";
import { deleteTemplateScope } from "./studio-fixtures";

// ─────────────────────────────────────────────────────────────────────────────
// Serveur fixture LOCAL pour tout jeton "image" — même recette que tests/studio-render.test.ts,
// pour que ce fichier n'ait besoin d'AUCUN accès réseau réel malgré des URL d'échantillon publiques
// (SAMPLE_VALUES pointe vers picsum.photos, mais fetchImpl l'ignore complètement sous test — voir
// lib/studio/images.ts:prepareImage, la garde SSRF n'est levée que sous NODE_ENV==="test" ET avec
// fetchImpl fourni).
let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(async () => {
  const png = await sharp({
    create: { width: 400, height: 400, channels: 3, background: { r: 40, g: 90, b: 160 } },
  }).png().toBuffer();
  server = Bun.serve({ port: 0, fetch: () => new Response(png, { headers: { "content-type": "image/png" } }) });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

const fixtureFetch: typeof fetch = (() => fetch(`${base}/x.png`)) as unknown as typeof fetch;

// ─────────────────────────────────────────────────────────────────────────────
// Portées STATIQUES possédées par ce fichier (tests/studio-fixtures.ts, registre) :
//   (recap_card, "test-preview-actions", null)
//   (social_post, "test-preview-fail", null)
const CH_ACTIONS = "test-preview-actions";
const CH_FAIL = "test-preview-fail";
const CH_OVERFLOW = "test-preview-overflow";

// Chantier D, Tâche 6 (handoff H1) — MÊME fixture que tests/studio-relayout.test.ts (« constrainedTextOverflows
// — un texte contraint qui déborde maxLines dans un format, MESURÉ AU RENDU ») : titre choisi
// empiriquement pour rendre EXACTEMENT 1 ligne à 1520px (le format d'accueil "x_landscape",
// 1600×900, moins 40px de marge de chaque côté) et EXACTEMENT 2 lignes à 1000px (la largeur qu'il
// obtient une fois relayouté vers "story" — leftRight : 1520 + (1080-1600) = 1000). Reprise ICI plutôt
// que réimportée : ce fichier construit ses gabarits en BASE (render_templates), pas en mémoire —
// previewTemplateCore doit résoudre un VRAI templateId, previewTemplateCore + overflowingLayerIds ne
// se contentent donc pas de rejouer constrainedTextOverflows en mémoire (Tâche 3), mais l'exercent à
// travers le chemin complet Server-Action-like (previewTemplateCore, sans le RBAC).
const OVERFLOW_TITLE = "Le cacao camerounais bat un record d'exportation";
function overflowScene(): Scene {
  return parseScene({
    schemaVersion: 1,
    canvas: { width: 1600, height: 900, background: "#101010" },
    layers: [
      {
        id: "title", name: "Titre", visible: true, locked: false,
        frame: { x: 40, y: 40, w: 1520, h: 300 },
        constraints: { h: "leftRight", v: "top" },
        type: "text", content: OVERFLOW_TITLE,
        font: { family: "Noto Sans", size: 48, weight: 700 },
        color: "#FFFFFF", align: "left", vAlign: "top", lineHeight: 1.2,
        maxLines: 1,
      },
    ],
  });
}

function recapScene(): Scene {
  // AUCUN calque image — délibéré : ce gabarit sert à prouver l'absence d'écriture ET le chemin
  // RBAC de bout en bout, tous deux sans dépendre du réseau (ni même du serveur fixture ci-dessus).
  return parseScene({
    schemaVersion: 1,
    canvas: { width: 1080, height: 1080, background: "#101010" },
    layers: [
      { id: "title", name: "Titre", visible: true, locked: false, frame: { x: 40, y: 40, w: 1000, h: 100 },
        type: "text", content: "{{recap.title}}",
        font: { family: "Noto Sans", size: 48, weight: 700 }, color: "#FFFFFF",
        align: "left", vAlign: "top", lineHeight: 1.2 },
      { id: "item1", name: "Item 1", visible: true, locked: false, frame: { x: 40, y: 200, w: 1000, h: 60 },
        type: "text", content: "{{recap.item1}}",
        font: { family: "Noto Sans", size: 28, weight: 400 }, color: "#FFFFFF",
        align: "left", vAlign: "top", lineHeight: 1.2 },
    ],
  });
}

function qrOverflowScene(): Scene {
  return parseScene({
    schemaVersion: 1,
    canvas: { width: 1200, height: 630, background: "#101010" },
    layers: [
      { id: "qr", name: "QR", visible: true, locked: false, frame: { x: 40, y: 40, w: 200, h: 200 },
        type: "qr", slot: "article.url", fg: "#000000", bg: "#FFFFFF", margin: 4 },
    ],
  });
}

const templateIds: string[] = [];
let actionsTemplateId: string;
let failTemplateId: string;

let overflowTemplateId: string;

beforeAll(async () => {
  await deleteTemplateScope("recap_card", CH_ACTIONS, null);
  await deleteTemplateScope("social_post", CH_FAIL, null);
  await deleteTemplateScope("social_post", CH_OVERFLOW, null);

  const [actionsRow] = await db.insert(renderTemplates).values({
    name: "Gabarit Aperçu — écriture", context: "recap_card", channel: CH_ACTIONS, categoryId: null,
    format: "ig_square", width: 1080, height: 1080, scene: recapScene(),
  }).returning({ id: renderTemplates.id });
  actionsTemplateId = actionsRow.id;
  templateIds.push(actionsTemplateId);

  const [failRow] = await db.insert(renderTemplates).values({
    name: "Gabarit Aperçu — échec", context: "social_post", channel: CH_FAIL, categoryId: null,
    format: "fb_link", width: 1200, height: 630, scene: qrOverflowScene(),
  }).returning({ id: renderTemplates.id });
  failTemplateId = failRow.id;
  templateIds.push(failTemplateId);

  const [overflowRow] = await db.insert(renderTemplates).values({
    name: "Gabarit Aperçu — débordement filmstrip", context: "social_post", channel: CH_OVERFLOW, categoryId: null,
    format: "x_landscape", width: 1600, height: 900, scene: overflowScene(),
  }).returning({ id: renderTemplates.id });
  overflowTemplateId = overflowRow.id;
  templateIds.push(overflowTemplateId);
});

afterAll(async () => {
  if (templateIds.length) await db.delete(renderTemplates).where(inArray(renderTemplates.id, templateIds));
});

async function rendersCount(): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)` }).from(renders);
  return Number(row.n);
}

// ─────────────────────────────────────────────────────────────────────────────
describe("previewTemplateCore — n'écrit RIEN (spec §4)", () => {
  it("aucune ligne `renders` — et produit bien une image réelle", async () => {
    const before = await rendersCount();

    const res = await previewTemplateCore({ templateId: actionsTemplateId, fetchImpl: fixtureFetch });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Le rendu a RÉELLEMENT eu lieu — un sabotage qui renverrait `{ ok: true }` sans rendre passerait
    // la garde-fou ci-dessous en échouant ici.
    expect(res.dataUri.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(res.dataUri.length).toBeGreaterThan(200);
    expect(res.degraded).toBe(false);

    const after = await rendersCount();
    expect(after).toBe(before); // AUCUNE ligne renders ajoutée — assertion GENUINE : toute écriture
    // réelle de ce dépôt passe par saveRender(), qui insère systématiquement une ligne `renders`.
    // La garantie « aucun objet R2 » n'est PAS revérifiée ici avec un RenderStore témoin : un tel
    // témoin, jamais transmis à previewTemplateCore (qui n'a d'ailleurs aucun paramètre `store`),
    // rendait l'ancienne assertion `expect(witnessStore.objects.size).toBe(0)` vraie PAR
    // CONSTRUCTION — elle serait restée au vert même si ce code appelait `new R2RenderStore().put(...)`
    // à chaque invocation (revue Lot 2, Important 2). Cette garantie R2 est désormais vérifiée
    // STRUCTURELLEMENT ci-dessous (describe suivant), sur le graphe d'imports réel du module, pas
    // simulée avec un objet jamais branché.
  });

  it("un aperçu répété n'accumule pas de lignes `renders` (à la différence du cache de renderForArticle)", async () => {
    const before = await rendersCount();
    await previewTemplateCore({ templateId: actionsTemplateId, fetchImpl: fixtureFetch });
    await previewTemplateCore({ templateId: actionsTemplateId, fetchImpl: fixtureFetch });
    await previewTemplateCore({ templateId: actionsTemplateId, fetchImpl: fixtureFetch });
    const after = await rendersCount();
    expect(after).toBe(before);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Chantier D, Tâche 6 (handoff H1) — la note « texte tronqué » du filmstrip (components/studio/
// render-mode.tsx#FilmstripThumb) EST previewTemplateCore's `overflowingLayerIds`, mesuré ici à
// travers un VRAI rendu (satori + loadFallbackFonts), pas rejoué en mémoire (déjà fait par
// tests/studio-relayout.test.ts, qui teste constrainedTextOverflows directement). Anti-vacuité par
// construction : le MÊME templateId, dans DEUX formats — un où il tient, un où il déborde.
describe("previewTemplateCore — overflowingLayerIds (chantier D, Tâche 6, handoff H1)", () => {
  it("format d'accueil (« x_landscape ») : identité (relayoutToFormat ne change rien) — le titre tient en 1 ligne, AUCUN calque signalé", async () => {
    const res = await previewTemplateCore({ templateId: overflowTemplateId, format: "x_landscape" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.overflowingLayerIds).toEqual([]);
  });

  it("format « story » (plus étroit — leftRight rétrécit le titre à 1000px) : le titre déborde à 2 lignes > maxLines:1 — SIGNALÉ", async () => {
    const res = await previewTemplateCore({ templateId: overflowTemplateId, format: "story" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.overflowingLayerIds).toEqual(["title"]);
  });

  it("SANS `format` (aucun appelant qui le fournit avant cette tâche) : `overflowingLayerIds` reste `[]` — comportement inchangé, rien n'est mesuré sans savoir POUR QUEL format", async () => {
    const res = await previewTemplateCore({ templateId: overflowTemplateId });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.overflowingLayerIds).toEqual([]);
  });

  it("MUTATION témoin : le rendu (dataUri) reste produit normalement dans les DEUX formats — la mesure de débordement ne fait jamais échouer ni dégrader le rendu lui-même", async () => {
    const home = await previewTemplateCore({ templateId: overflowTemplateId, format: "x_landscape" });
    const story = await previewTemplateCore({ templateId: overflowTemplateId, format: "story" });
    expect(home.ok && home.dataUri.length).toBeGreaterThan(200);
    expect(story.ok && story.dataUri.length).toBeGreaterThan(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Garantie R2 — STRUCTURELLE, pas simulée (revue Lot 2, Important 2). previewTemplateCore n'a
// aucun paramètre `store` : c'est un fait sur sa SIGNATURE, pas quelque chose qu'un test à
// l'exécution peut espionner via un faux magasin jamais branché (voir le commentaire ci-dessus).
// Ce qu'on PEUT vérifier honnêtement, et qui échouerait RÉELLEMENT sur une régression : que
// lib/studio/store.ts (R2RenderStore/saveRender) n'est atteignable, PAR AUCUN CHEMIN d'import
// statique, ni depuis preview-core.ts ni depuis renderScene() lui-même — exactement les deux faits
// que le relecteur avait vérifiés à la main (« renderScene n'importe ni @/db ni de module R2 » et
// « store.ts/saveRender ne sont atteignables que depuis renderForArticle, jamais importé par
// preview-core.ts »). Un sabotage qui ajouterait `import { saveRender } from "./store"` (direct ou
// via n'importe quel intermédiaire) dans preview-core.ts ou render.ts ferait apparaître store.ts
// dans l'ensemble ci-dessous et casserait ce test — la garantie précédente, elle, n'aurait rien vu.
describe("previewTemplateCore — garantie structurelle : store.ts (R2/saveRender) hors d'atteinte (Important 2, revue Lot 2)", () => {
  const REPO_ROOT = path.resolve(import.meta.dir, "..");
  const FROM_RE = /from\s*["']([^"']+)["']/g;
  const BARE_IMPORT_RE = /import\s*["']([^"']+)["']/g;
  const DYNAMIC_IMPORT_RE = /import\(\s*["']([^"']+)["']\s*\)/g;

  // Résout un spécificateur d'import (relatif ou alias `@/…`) vers un fichier .ts/.tsx réel sur
  // disque — ignore délibérément tout paquet externe (aucun des deux points de départ, "..." ou
  // "@/", n'y mène jamais), donc le graphe tracé reste borné au code du dépôt.
  function resolveModule(specifier: string, fromFile: string): string | null {
    let base: string;
    if (specifier.startsWith(".")) base = path.resolve(path.dirname(fromFile), specifier);
    else if (specifier.startsWith("@/")) base = path.resolve(REPO_ROOT, specifier.slice(2));
    else return null;
    const candidates = [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")];
    for (const c of candidates) {
      if (existsSync(c) && statSync(c).isFile()) return c;
    }
    return null;
  }

  function importsOf(file: string): string[] {
    const src = readFileSync(file, "utf8");
    const specs: string[] = [];
    for (const re of [FROM_RE, BARE_IMPORT_RE, DYNAMIC_IMPORT_RE]) {
      re.lastIndex = 0;
      for (const m of src.matchAll(re)) specs.push(m[1]!);
    }
    return specs;
  }

  // Fermeture transitive des imports LOCAUX (relatifs / `@/…`) atteignables depuis `entry`, par
  // parcours en profondeur — un cycle est simplement ignoré une seconde fois grâce à `visited`.
  function transitiveClosure(entry: string): Set<string> {
    const visited = new Set<string>();
    const stack = [entry];
    while (stack.length) {
      const file = stack.pop()!;
      if (visited.has(file)) continue;
      visited.add(file);
      for (const spec of importsOf(file)) {
        const resolved = resolveModule(spec, file);
        if (resolved && !visited.has(resolved)) stack.push(resolved);
      }
    }
    return visited;
  }

  const storeModule = path.join(REPO_ROOT, "lib/studio/store.ts");
  const renderForArticleModule = path.join(REPO_ROOT, "lib/studio/index.ts");
  const dbModule = path.join(REPO_ROOT, "db/index.ts");

  it("store.ts n'est importé, directement ou transitivement, par AUCUN fichier du graphe de preview-core.ts", () => {
    const graph = transitiveClosure(path.join(REPO_ROOT, "lib/studio/preview-core.ts"));
    expect(graph.has(storeModule)).toBe(false);
    // Corollaire : renderForArticle (lib/studio/index.ts), seul appelant réel de saveRender, n'est
    // lui-même jamais importé — previewTemplateCore ne délègue jamais à lui.
    expect(graph.has(renderForArticleModule)).toBe(false);
  });

  it("renderScene() lui-même (lib/studio/render.ts) n'importe ni store.ts ni @/db", () => {
    const graph = transitiveClosure(path.join(REPO_ROOT, "lib/studio/render.ts"));
    expect(graph.has(storeModule)).toBe(false);
    expect(graph.has(dbModule)).toBe(false);
  });

  // Refonte « Rendu réel » : le cœur réseau de l'aperçu vit désormais dans hooks/use-preview.ts, que
  // preview-pane.tsx ET la planche consomment tous les deux. La garantie « l'aperçu n'écrit rien »
  // doit donc partir AUSSI de ce fichier, sinon l'extraction l'aurait silencieusement contournée.
  //
  // Subtilité : on ne peut PAS simplement fermer transitivement depuis use-preview.ts. Il importe
  // une Server Action ("use server"), dont le graphe atteint légitimement @/db — c'est le rôle
  // MÊME de ce module frontière (requireUser/requirePermission). Le graphe client s'arrête donc aux
  // modules "use server" : ce qui est vérifié, c'est que le CLIENT ne peut atteindre le moteur que
  // PAR cette frontière-là, et par aucune autre. La propreté de ce qu'il y a derrière la frontière
  // reste couverte par les deux tests ci-dessus, qui partent de preview-core.ts.
  function isServerModule(file: string): boolean {
    const head = readFileSync(file, "utf8").slice(0, 200);
    return /^\s*["']use server["']/m.test(head);
  }

  function clientClosure(entry: string): { files: Set<string>; serverEntrypoints: Set<string> } {
    const files = new Set<string>();
    const serverEntrypoints = new Set<string>();
    const stack = [entry];
    while (stack.length) {
      const file = stack.pop()!;
      if (files.has(file)) continue;
      files.add(file);
      for (const spec of importsOf(file)) {
        const resolved = resolveModule(spec, file);
        if (!resolved || files.has(resolved)) continue;
        if (isServerModule(resolved)) { serverEntrypoints.add(resolved); continue; }
        stack.push(resolved);
      }
    }
    return { files, serverEntrypoints };
  }

  it("hooks/use-preview.ts n'atteint le moteur QUE par la Server Action gardée previewTemplate", () => {
    const { files, serverEntrypoints } = clientClosure(path.join(REPO_ROOT, "hooks/use-preview.ts"));
    // Une seule frontière serveur, et c'est la bonne.
    expect([...serverEntrypoints]).toEqual([path.join(REPO_ROOT, "lib/actions/studio-preview-actions.ts")]);
    // Et côté client, aucun chemin vers l'écriture ni vers le moteur en direct.
    expect(files.has(storeModule)).toBe(false);
    expect(files.has(renderForArticleModule)).toBe(false);
    expect(files.has(dbModule)).toBe(false);
    expect(files.has(path.join(REPO_ROOT, "lib/studio/render.ts"))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Critique 1 (revue Lot 2) : l'aperçu réel doit refléter la scène COURANTE de l'éditeur — celle
// encore en mémoire côté client — pas le dernier brouillon écrit en base. Avant ce correctif,
// previewTemplateCore lisait TOUJOURS `row.scene` : le panneau d'aperçu (composants/studio/
// preview-pane.tsx) se déclenche 800 ms après stabilisation de la scène, l'autosauvegarde
// (components/studio/editor-shell.tsx) 1500 ms après — donc la requête d'aperçu part ~700 ms AVANT
// que l'édition n'atteigne la base, et l'effet ne redéclenche sur aucun signal de sauvegarde
// réussie : l'aperçu affichait la scène PRÉ-édition, en retard d'un cran, de façon arbitrairement
// cumulative sur des éditions consécutives. Ce test prouve que `previewTemplateCore`, appelée avec
// une scène cliente qui diffère du brouillon en base, rend CETTE scène-là — sans jamais l'écrire.
describe("previewTemplateCore — reflète la scène COURANTE fournie par l'appelant, pas le brouillon en base (Critique 1, revue Lot 2)", () => {
  it("une scène cliente différente du brouillon en base l'emporte, et n'est jamais écrite", async () => {
    const before = await rendersCount();

    // recapScene() (brouillon réellement stocké pour actionsTemplateId) fait 1080×1080. La scène
    // cliente ci-dessous ne diffère QUE par les dimensions du canevas — un marqueur vérifiable sans
    // inspecter les pixels : les dimensions de l'image RENDUE trahissent sans ambiguïté laquelle des
    // deux scènes a réellement été utilisée.
    const clientScene = recapScene();
    clientScene.canvas = { ...clientScene.canvas, width: 700, height: 500 };

    const res = await previewTemplateCore({ templateId: actionsTemplateId, scene: clientScene, fetchImpl: fixtureFetch });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const bytes = Buffer.from(res.dataUri.split(",")[1]!, "base64");
    const meta = await sharp(bytes).metadata();
    expect(meta.width).toBe(700); // scène CLIENTE — échouerait ici si le code relisait la base
    expect(meta.height).toBe(500);

    // Le brouillon en base n'a pas bougé (toujours 1080×1080, recapScene() inchangée) : la scène
    // cliente n'a écrasé RIEN côté serveur, exactement comme la garantie « n'écrit rien » ci-dessus.
    const [row] = await db.select({ scene: renderTemplates.scene })
      .from(renderTemplates).where(eq(renderTemplates.id, actionsTemplateId));
    expect((row!.scene as Scene).canvas.width).toBe(1080);
    expect((row!.scene as Scene).canvas.height).toBe(1080);

    const after = await rendersCount();
    expect(after).toBe(before);
  });

  it("sans scène cliente fournie, le comportement historique persiste : le brouillon en base sert de repli", async () => {
    const res = await previewTemplateCore({ templateId: actionsTemplateId, fetchImpl: fixtureFetch });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const bytes = Buffer.from(res.dataUri.split(",")[1]!, "base64");
    const meta = await sharp(bytes).metadata();
    expect(meta.width).toBe(1080); // recapScene(), la scène en base
    expect(meta.height).toBe(1080);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("previewTemplateCore — priorité des valeurs et échec propre (spec §4)", () => {
  it("un échec de rendu renvoie { ok: false, message } — ne lève JAMAIS", async () => {
    // Un contenu de jeton URL démesurément long fait échouer l'encodage QR (lib/studio/render.ts —
    // « Génération du QR code impossible »). Fourni en `values` explicites (priorité la plus
    // haute, spec §4) pour écraser délibérément le repli SAMPLE_VALUES court.
    let threw = false;
    let res: Awaited<ReturnType<typeof previewTemplateCore>>;
    try {
      res = await previewTemplateCore({
        templateId: failTemplateId,
        values: { "article.url": `https://example.test/${"x".repeat(6000)}` },
      });
    } catch {
      threw = true;
      res = { ok: false, message: "" };
    }
    expect(threw).toBe(false); // le contrat REQUIS : surface le message plutôt que de lever
    expect(res!.ok).toBe(false);
    if (res!.ok) return;
    expect(res!.message.length).toBeGreaterThan(0);
    expect(res!.message).not.toContain("Error:"); // pas de fuite de la pile/du message natif anglais
  });

  it("gabarit introuvable — refus propre, pas d'exception", async () => {
    const res = await previewTemplateCore({ templateId: "00000000-0000-0000-0000-000000000000" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toBe("Gabarit introuvable.");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("SAMPLE_VALUES seul suffit à rendre chacun des TROIS gabarits de démarrage (db/studio-templates.ts)", () => {
  const starters: { name: string; scene: unknown }[] = [
    { name: "Image à la une (article_image)", scene: ARTICLE_IMAGE_TEMPLATE },
    { name: "Facebook (social_post)", scene: FB_TEMPLATE },
    { name: "Instagram (social_post)", scene: IG_TEMPLATE },
  ];

  for (const { name, scene } of starters) {
    it(`rend "${name}" avec SAMPLE_VALUES, sans aucune autre valeur`, async () => {
      const out = await renderScene({ scene: parseScene(scene), values: SAMPLE_VALUES, fetchImpl: fixtureFetch });
      expect(out.bytes.byteLength).toBeGreaterThan(0);
      expect(out.mime).toBe("image/jpeg");
      expect(out.degraded).toBe(false);
    });
  }

  it("un sabotage qui viderait SAMPLE_VALUES ferait échouer les trois rendus ci-dessus (MissingTokensError)", async () => {
    // Ne teste pas un sabotage réel du fichier (bun test ne permet pas ça proprement), mais prouve
    // que la garantie n'est pas vide : SANS aucune valeur, le même rendu échoue bel et bien.
    await expect(renderScene({ scene: parseScene(ARTICLE_IMAGE_TEMPLATE), values: {}, fetchImpl: fixtureFetch }))
      .rejects.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// previewTemplate (Server Action gardée) — RBAC de bout en bout, spec §1 contrainte non négociable.
// Même recette de mock que tests/studio-template-actions.test.ts.
const { requireUser: realRequireUser, getSession: realGetSession } = await import("@/lib/session");

const [seededEditor] = await db.select({ id: user.id, role: user.role })
  .from(user).where(eq(user.email, "editor@afrotiative.com"));
if (!seededEditor) throw new Error("Seed manquant : editor@afrotiative.com introuvable (bun run db:seed).");
const FAKE_EDITOR = {
  id: seededEditor.id, name: "Test Éditeur", email: "editor@afrotiative.com",
  role: seededEditor.role, banned: false, image: null,
};

const [seededJournalist] = await db.select({ id: user.id, role: user.role })
  .from(user).where(eq(user.email, "journaliste@afrotiative.com"));
if (!seededJournalist) throw new Error("Seed manquant : journaliste@afrotiative.com introuvable (bun run db:seed).");
const FAKE_JOURNALIST = {
  id: seededJournalist.id, name: "Test Journaliste", email: "journaliste@afrotiative.com",
  role: seededJournalist.role, banned: false, image: null,
};

describe("previewTemplate — action gardée (RBAC)", () => {
  afterAll(() => {
    mock.module("@/lib/session", () => ({ getSession: realGetSession, requireUser: realRequireUser }));
  });

  it("refuse un journaliste (rejette, aucun résultat renvoyé)", async () => {
    mock.module("@/lib/session", () => ({ getSession: realGetSession, requireUser: async () => FAKE_JOURNALIST }));
    const { previewTemplate } = await import("@/lib/actions/studio-preview-actions");
    await expect(previewTemplate({ templateId: actionsTemplateId })).rejects.toThrow();
  });

  it("autorise un éditeur et délègue bien à previewTemplateCore (résultat cohérent, sans réseau requis pour ce gabarit sans image)", async () => {
    mock.module("@/lib/session", () => ({ getSession: realGetSession, requireUser: async () => FAKE_EDITOR }));
    const { previewTemplate } = await import("@/lib/actions/studio-preview-actions");
    const res = await previewTemplate({ templateId: actionsTemplateId });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.dataUri.startsWith("data:image/jpeg;base64,")).toBe(true);
  });
});
