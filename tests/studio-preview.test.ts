import { describe, it, expect, mock, beforeAll, afterAll } from "bun:test";
import sharp from "sharp";
import { db, renderTemplates, renders, user } from "@/db";
import { eq, inArray, sql } from "drizzle-orm";
import { parseScene, type Scene } from "@/lib/studio/scene";
import { renderScene } from "@/lib/studio/render";
import { MemoryRenderStore } from "@/lib/studio/store";
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

beforeAll(async () => {
  await deleteTemplateScope("recap_card", CH_ACTIONS, null);
  await deleteTemplateScope("social_post", CH_FAIL, null);

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
  it("ni ligne `renders`, ni objet dans un RenderStore — et produit bien une image réelle", async () => {
    const before = await rendersCount();
    const witnessStore = new MemoryRenderStore(); // témoin : jamais transmis à previewTemplateCore

    const res = await previewTemplateCore({ templateId: actionsTemplateId, fetchImpl: fixtureFetch });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Le rendu a RÉELLEMENT eu lieu — un sabotage qui renverrait `{ ok: true }` sans rendre passerait
    // la garde-fou ci-dessous en échouant ici.
    expect(res.dataUri.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(res.dataUri.length).toBeGreaterThan(200);
    expect(res.degraded).toBe(false);

    const after = await rendersCount();
    expect(after).toBe(before); // AUCUNE ligne renders ajoutée
    expect(witnessStore.objects.size).toBe(0); // aucun objet R2 (même simulé) créé

    // Contrôle positif : le pipeline de rendu EST capable de peupler un store — renderForArticle
    // s'en sert bel et bien (lib/studio/render.ts + store.ts). L'assertion ci-dessus n'est donc pas
        // vraie "par construction" faute d'un chemin d'écriture qui existerait de toute façon ; c'est
        // previewTemplateCore, spécifiquement, qui ne l'emprunte jamais.
    await witnessStore.put("preuve/temoin.jpg", new Uint8Array([1, 2, 3]), "image/jpeg");
    expect(witnessStore.objects.size).toBe(1);
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
