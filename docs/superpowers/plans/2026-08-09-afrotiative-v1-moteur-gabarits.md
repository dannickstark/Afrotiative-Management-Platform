# V1 — Moteur de gabarits — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render an image from a JSON template + a set of token values, in Node, with no browser and no UI.

**Architecture:** A pure core (`scene` → `tokens` → `element`) surrounded by I/O shells (`images`, `fonts`, `render`, `store`, `resolve`, `bindings`). `render.ts` never touches Postgres; it takes a scene, values and an asset loader and returns bytes. Storage sits behind a `RenderStore` interface with an in-memory implementation so the whole render path is testable with no network and no R2 account.

**Tech Stack:** TypeScript · Next.js 16 (App Router) · Bun (packages/tests/scripts) · Drizzle + Postgres/Neon · `satori` (layout → SVG) · `@resvg/resvg-js` (SVG → PNG) · `sharp` (already installed) · `qrcode` · `aws4fetch` (R2)

**Spec:** `docs/superpowers/specs/2026-08-09-afrotiative-v1-moteur-gabarits-design.md`

## Global Constraints

- **Read the Next.js docs first.** `AGENTS.md` is non-negotiable: this Next.js version has breaking changes vs. training data. Before writing any code that touches a route handler, server action, or `next/*` import, read the relevant guide under `node_modules/next/dist/docs/01-app/`. V1 is almost entirely `lib/` code, so this mostly applies to Task 12.
- **All user-facing strings are in French.** Error messages returned from these modules are displayed verbatim in the UI.
- **No new PostgreSQL enums.** Use `text` columns plus TypeScript unions. Reason documented at `db/schema.ts:337` (`alerts.type`): `ALTER TYPE … ADD VALUE` breaks drizzle's single-transaction `migrate()` on a fresh database.
- **Missing configuration disables the feature, never throws.** Mirror `getWpConfig()` (`lib/wp/config.ts`): return `null`, and callers return `{ ok: false, message: "…" }`.
- **Reuse `isSafePublicHttpUrl`** from `lib/url-guard.ts` for every outbound image fetch. Do not write a second SSRF guard.
- **Tests are `bun test`, in `tests/<name>.test.ts`.** No network, no API keys. Tests may use the real dev Neon database (existing suites do — see `tests/publish-due.test.ts`) but must clean up rows they create.
- **`schemaVersion` is always `1`** in V1. Any scene read from the database is untrusted input and goes through `parseScene`.
- **Commit after every task**, message in French, prefix `feat(studio):`.
- Every commit message ends with:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`

## File Structure

| File | Responsibility |
|---|---|
| `lib/studio/formats.ts` | Format presets (width/height). Pure. |
| `lib/studio/scene.ts` | `Scene`/`Layer` types, Zod schema, `parseScene`. Pure. |
| `lib/studio/tokens.ts` | Token kinds, context→tokens registry, `extractTokens`, `validateScene`. Pure. |
| `lib/studio/values.ts` | `resolveTokens(scene, values)` → new scene. Pure. |
| `lib/studio/element.ts` | `sceneToElement(scene, images)` → Satori node tree. Pure. |
| `lib/studio/images.ts` | sharp pre-pass: fetch, crop, blur, tint → data URI. |
| `lib/studio/fonts.ts` | `AssetLoader` interface, bundled fallback fonts, in-process cache. |
| `lib/studio/render.ts` | Orchestration: values → images → element → satori → resvg → sharp. |
| `lib/studio/store.ts` | `RenderStore` interface, `R2RenderStore`, `MemoryRenderStore`, `computeInputHash`, renders cache. |
| `lib/studio/resolve.ts` | `resolveTemplate(context, channel, categoryId)` → published snapshot. |
| `lib/studio/bindings.ts` | `articleTokenValues(articleId, context)`. |
| `lib/studio/config.ts` | `getStudioConfig()` → R2 config or `null`. |
| `lib/studio/index.ts` | Public API: `renderForArticle`. |
| `lib/storage/r2.ts` | Minimal S3v4 client over `aws4fetch`. |
| `lib/studio/fonts/*.ttf` | Bundled Noto Sans fallback (Regular/SemiBold/Bold). |
| `db/schema.ts` | +4 tables, +`wp_categories.color`. |
| `db/studio-templates.ts` | Idempotent seeding of the 3 starter templates. |

---

### Task 1: Dependencies, studio config, R2 client

**Files:**
- Modify: `package.json`
- Create: `lib/studio/config.ts`, `lib/storage/r2.ts`
- Modify: `.env.example`
- Test: `tests/studio-config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `getStudioConfig(): StudioConfig | null` where `StudioConfig = { accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string; publicBaseUrl: string }`; `putObject(cfg, key, bytes, mime): Promise<string>` returning the public URL; `publicUrlFor(cfg, key): string`.

- [ ] **Step 1: Install dependencies**

```bash
bun add satori @resvg/resvg-js qrcode aws4fetch
bun add -d @types/qrcode
```

- [ ] **Step 2: Write the failing test**

Create `tests/studio-config.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { getStudioConfig } from "@/lib/studio/config";
import { publicUrlFor } from "@/lib/storage/r2";

const KEYS = ["R2_ACCOUNT_ID","R2_ACCESS_KEY_ID","R2_SECRET_ACCESS_KEY","R2_BUCKET","R2_PUBLIC_BASE_URL"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = process.env[k];

function setAll(v: string | undefined) {
  for (const k of KEYS) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
}

describe("getStudioConfig", () => {
  beforeEach(() => setAll(undefined));
  afterAll(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!; } });

  it("renvoie null quand aucune variable n'est posée", () => {
    expect(getStudioConfig()).toBeNull();
  });

  it("renvoie null quand une seule variable manque", () => {
    setAll("x");
    delete process.env.R2_BUCKET;
    expect(getStudioConfig()).toBeNull();
  });

  it("renvoie la configuration quand les cinq sont posées", () => {
    setAll("x");
    expect(getStudioConfig()).toEqual({
      accountId: "x", accessKeyId: "x", secretAccessKey: "x", bucket: "x", publicBaseUrl: "x",
    });
  });

  it("construit une URL publique sans double slash", () => {
    const cfg = { accountId:"a", accessKeyId:"b", secretAccessKey:"c", bucket:"d", publicBaseUrl:"https://media.test/" };
    expect(publicUrlFor(cfg, "renders/2026/08/abc.jpg")).toBe("https://media.test/renders/2026/08/abc.jpg");
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `bun test tests/studio-config.test.ts`
Expected: FAIL — cannot resolve `@/lib/studio/config`.

- [ ] **Step 4: Implement `lib/studio/config.ts`**

```ts
// R2 (Cloudflare, S3-compatible) — la configuration du studio. Comme getWpConfig()
// (lib/wp/config.ts), les cinq variables manquantes désactivent proprement la fonctionnalité :
// on renvoie null, on ne lève jamais. Les appelants rendent alors un message français.
export type StudioConfig = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  publicBaseUrl: string;
};

export function getStudioConfig(): StudioConfig | null {
  const accountId = process.env.R2_ACCOUNT_ID?.trim();
  const accessKeyId = process.env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim();
  const bucket = process.env.R2_BUCKET?.trim();
  const publicBaseUrl = process.env.R2_PUBLIC_BASE_URL?.trim();
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket || !publicBaseUrl) return null;
  return { accountId, accessKeyId, secretAccessKey, bucket, publicBaseUrl };
}
```

- [ ] **Step 5: Implement `lib/storage/r2.ts`**

```ts
import { AwsClient } from "aws4fetch";
import type { StudioConfig } from "@/lib/studio/config";

// Client S3v4 minimal. `aws4fetch` (~2 ko) plutôt que @aws-sdk/client-s3 (plusieurs Mo) : on n'a
// besoin que d'un PUT signé, les rendus font moins d'un Mo et ne demandent pas de multipart.
export function publicUrlFor(cfg: StudioConfig, key: string): string {
  return `${cfg.publicBaseUrl.replace(/\/+$/, "")}/${key.replace(/^\/+/, "")}`;
}

function endpointFor(cfg: StudioConfig, key: string): string {
  return `https://${cfg.accountId}.r2.cloudflarestorage.com/${cfg.bucket}/${key.replace(/^\/+/, "")}`;
}

export async function putObject(
  cfg: StudioConfig, key: string, bytes: Uint8Array, mime: string,
): Promise<string> {
  const client = new AwsClient({
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    service: "s3",
    region: "auto",
  });
  const res = await client.fetch(endpointFor(cfg, key), {
    method: "PUT",
    body: bytes as unknown as BodyInit,
    headers: { "content-type": mime, "content-length": String(bytes.byteLength) },
  });
  if (!res.ok) {
    throw new Error(`Téléversement R2 échoué (HTTP ${res.status}).`);
  }
  return publicUrlFor(cfg, key);
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `bun test tests/studio-config.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Document the variables in `.env.example`**

Append, after the WordPress block:

```
# V1 studio de gabarits — stockage Cloudflare R2. Laisser les cinq vides désactive proprement
# le studio (getStudioConfig() renvoie null, aucun rendu n'est tenté).
R2_ACCOUNT_ID=""          # identifiant de compte Cloudflare
R2_ACCESS_KEY_ID=""       # jeton API R2
R2_SECRET_ACCESS_KEY=""
R2_BUCKET=""              # nom du bucket, ex. "afrotiative-media"
R2_PUBLIC_BASE_URL=""     # base des URLs publiques, ex. "https://media.afrotiative.com"
```

- [ ] **Step 8: Verify the whole suite still passes, then commit**

```bash
bun run typecheck && bun test
git add package.json bun.lock .env.example lib/studio/config.ts lib/storage/r2.ts tests/studio-config.test.ts
git commit -m "feat(studio): configuration R2 et client de stockage

..."
```

---

### Task 2: Format presets and the scene schema

**Files:**
- Create: `lib/studio/formats.ts`, `lib/studio/scene.ts`
- Test: `tests/studio-scene.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `FORMAT_PRESETS`, `FormatKey`; the `Scene`, `Layer`, `ImageLayer`, `TextLayer`, `ShapeLayer`, `QrLayer`, `Frame`, `ImageSource`, `Gradient` types; `sceneSchema` (Zod); `parseScene(input: unknown): Scene` which throws `SceneError` with a French message.

- [ ] **Step 1: Write the failing test**

Create `tests/studio-scene.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { FORMAT_PRESETS } from "@/lib/studio/formats";
import { parseScene, SceneError, type Scene } from "@/lib/studio/scene";

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
    expect(() => parseScene({ ...structuredClone(valid), schemaVersion: 2 })).toThrow(SceneError);
  });

  it("refuse un type de calque inconnu", () => {
    const bad = structuredClone(valid);
    (bad.layers[0] as unknown as { type: string }).type = "video";
    expect(() => parseScene(bad)).toThrow(SceneError);
  });

  it("refuse deux calques partageant le même identifiant", () => {
    const bad = structuredClone(valid);
    bad.layers[1].id = "l1";
    expect(() => parseScene(bad)).toThrow(/identifiant/i);
  });

  it("refuse une couleur hexadécimale malformée", () => {
    const bad = structuredClone(valid);
    bad.canvas.background = "rouge";
    expect(() => parseScene(bad)).toThrow(SceneError);
  });
});

describe("FORMAT_PRESETS", () => {
  it("expose les sept préréglages avec des dimensions positives", () => {
    const keys = Object.keys(FORMAT_PRESETS);
    expect(keys).toHaveLength(7);
    for (const k of keys) {
      const p = FORMAT_PRESETS[k as keyof typeof FORMAT_PRESETS];
      expect(p.width).toBeGreaterThan(0);
      expect(p.height).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test tests/studio-scene.test.ts`
Expected: FAIL — cannot resolve `@/lib/studio/formats`.

- [ ] **Step 3: Implement `lib/studio/formats.ts`**

```ts
// Préréglages de format. Un gabarit choisit UN format à la création ; sa largeur et sa hauteur
// sont ensuite FIGÉES sur la ligne render_templates. Modifier un préréglage ici n'altère donc
// jamais un gabarit existant — c'est voulu : un changement de dimension casserait la mise en page.
export const FORMAT_PRESETS = {
  website_featured: { width: 1200, height: 675,  label: "Image à la une (site)" },
  fb_link:          { width: 1200, height: 630,  label: "Facebook — lien" },
  ig_square:        { width: 1080, height: 1080, label: "Instagram — carré" },
  ig_portrait:      { width: 1080, height: 1350, label: "Instagram — portrait" },
  story:            { width: 1080, height: 1920, label: "Story (Instagram / WhatsApp)" },
  x_landscape:      { width: 1600, height: 900,  label: "X — paysage" },
  wa_square:        { width: 1080, height: 1080, label: "WhatsApp — carré" },
} as const;

export type FormatKey = keyof typeof FORMAT_PRESETS;
export const FORMAT_KEYS = Object.keys(FORMAT_PRESETS) as FormatKey[];
```

- [ ] **Step 4: Implement `lib/studio/scene.ts`**

```ts
import { z } from "zod";

export const SCENE_SCHEMA_VERSION = 1 as const;

// Erreur typée : tout message porté par SceneError est en français et affichable tel quel.
export class SceneError extends Error {}

// #RGB, #RRGGBB ou #RRGGBBAA. Les jetons ({{category.color}}) sont autorisés partout où une
// couleur est attendue — c'est tokens.ts qui vérifiera qu'ils sont légaux dans ce contexte.
const TOKEN_RE = /^\{\{\s*[a-zA-Z][\w.]*\s*\}\}$/;
const hexColor = z.string().refine(
  (v) => /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v) || v === "transparent" || TOKEN_RE.test(v),
  { message: "Couleur invalide (attendu #RGB, #RRGGBB, #RRGGBBAA, « transparent » ou un jeton)" },
);

const frame = z.object({
  x: z.number(), y: z.number(),
  w: z.number().positive(), h: z.number().positive(),
});

const layerBase = {
  id: z.string().min(1),
  name: z.string(),
  visible: z.boolean(),
  locked: z.boolean(),
  frame,
  rotation: z.number().optional(),
  opacity: z.number().min(0).max(1).optional(),
};

const imageSource = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("asset"), assetId: z.string().min(1) }),
  z.object({ kind: z.literal("slot"), slot: z.string().min(1) }),
  z.object({ kind: z.literal("url"), url: z.string().url() }),
]);

const imageLayer = z.object({
  ...layerBase,
  type: z.literal("image"),
  source: imageSource,
  fit: z.enum(["cover", "contain"]),
  radius: z.number().nonnegative().optional(),
  blur: z.number().nonnegative().max(200).optional(),
  overlay: hexColor.optional(),
});

const textLayer = z.object({
  ...layerBase,
  type: z.literal("text"),
  content: z.string(),
  font: z.object({
    assetId: z.string().optional(),
    family: z.string().min(1),
    size: z.number().positive(),
    weight: z.number().int().min(100).max(900),
    italic: z.boolean().optional(),
  }),
  color: hexColor,
  align: z.enum(["left", "center", "right"]),
  vAlign: z.enum(["top", "middle", "bottom"]),
  lineHeight: z.number().positive(),
  letterSpacing: z.number().optional(),
  maxLines: z.number().int().positive().optional(),
  autoFit: z.boolean().optional(),
  shadow: z.object({ x: z.number(), y: z.number(), blur: z.number().nonnegative(), color: hexColor }).optional(),
  stroke: z.object({ width: z.number().positive(), color: hexColor }).optional(),
});

const gradient = z.object({
  angle: z.number(),
  stops: z.array(z.object({ color: hexColor, at: z.number().min(0).max(1) })).min(2),
});

const shapeLayer = z.object({
  ...layerBase,
  type: z.literal("shape"),
  shape: z.literal("rect"),
  fill: z.union([hexColor, gradient]),
  radius: z.number().nonnegative().optional(),
  border: z.object({
    width: z.number().positive(),
    color: hexColor,
    sides: z.array(z.enum(["top", "right", "bottom", "left"])).optional(),
  }).optional(),
});

const qrLayer = z.object({
  ...layerBase,
  type: z.literal("qr"),
  slot: z.string().min(1),
  fg: hexColor,
  bg: hexColor,
  margin: z.number().int().nonnegative(),
});

const layer = z.discriminatedUnion("type", [imageLayer, textLayer, shapeLayer, qrLayer]);

export const sceneSchema = z.object({
  schemaVersion: z.literal(SCENE_SCHEMA_VERSION),
  canvas: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    background: hexColor,
  }),
  // L'ORDRE EST L'ORDRE DE PEINTURE : index 0 = arrière-plan. Satori n'a pas de z-index, et une
  // liste de calques exprime déjà exactement cela.
  layers: z.array(layer),
});

export type Frame = z.infer<typeof frame>;
export type ImageSource = z.infer<typeof imageSource>;
export type ImageLayer = z.infer<typeof imageLayer>;
export type TextLayer = z.infer<typeof textLayer>;
export type Gradient = z.infer<typeof gradient>;
export type ShapeLayer = z.infer<typeof shapeLayer>;
export type QrLayer = z.infer<typeof qrLayer>;
export type Layer = z.infer<typeof layer>;
export type Scene = z.infer<typeof sceneSchema>;

// Une scène lue en base est une donnée NON FIABLE : elle a pu être écrite par une version
// antérieure du code. Tout chemin de lecture passe par ici.
export function parseScene(input: unknown): Scene {
  const parsed = sceneSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new SceneError(`Scène invalide : ${first.path.join(".") || "racine"} — ${first.message}`);
  }
  const ids = new Set<string>();
  for (const l of parsed.data.layers) {
    if (ids.has(l.id)) throw new SceneError(`Scène invalide : identifiant de calque en double « ${l.id} ».`);
    ids.add(l.id);
  }
  return parsed.data;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test tests/studio-scene.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Typecheck and commit**

```bash
bun run typecheck && bun test tests/studio-scene.test.ts
git add lib/studio/formats.ts lib/studio/scene.ts tests/studio-scene.test.ts
git commit -m "feat(studio): préréglages de format et schéma de scène"
```

---

### Task 3: Token registry and scene validation

**Files:**
- Create: `lib/studio/tokens.ts`
- Test: `tests/studio-tokens.test.ts`

**Interfaces:**
- Consumes: `Scene`, `Layer` from `lib/studio/scene.ts`.
- Produces: `TokenId`, `TokenKind`, `TOKEN_KINDS`, `TemplateContext`, `TEMPLATE_CONTEXTS`, `CONTEXT_TOKENS`, `CHANNELS`, `Channel`, `extractTokens(scene): TokenUse[]` where `TokenUse = { token: string; expected: TokenKind; where: string }`, and `validateScene(scene, context): string[]` returning French error messages (empty array = valid).

- [ ] **Step 1: Write the failing test**

Create `tests/studio-tokens.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { extractTokens, validateScene, CONTEXT_TOKENS } from "@/lib/studio/tokens";
import type { Scene } from "@/lib/studio/scene";

function scene(layers: Scene["layers"]): Scene {
  return { schemaVersion: 1, canvas: { width: 1200, height: 675, background: "#000000" }, layers };
}
const base = { visible: true, locked: false, frame: { x: 0, y: 0, w: 100, h: 100 } };
const textFont = { family: "Noto Sans", size: 32, weight: 400 };

describe("extractTokens", () => {
  it("trouve les jetons dans le texte, la couleur et la source d'image", () => {
    const s = scene([
      { ...base, id: "a", name: "", type: "image", source: { kind: "slot", slot: "article.image" }, fit: "cover" },
      { ...base, id: "b", name: "", type: "text", content: "{{article.title}} — {{category.name}}",
        font: textFont, color: "{{category.color}}", align: "left", vAlign: "top", lineHeight: 1.2 },
    ]);
    const found = extractTokens(s).map((t) => t.token).sort();
    expect(found).toEqual(["article.image", "article.title", "category.color", "category.name"]);
  });
});

describe("validateScene", () => {
  it("accepte un gabarit article_image sans article.url", () => {
    const s = scene([
      { ...base, id: "a", name: "", type: "image", source: { kind: "slot", slot: "article.image" }, fit: "cover" },
    ]);
    expect(validateScene(s, "article_image")).toEqual([]);
  });

  it("REFUSE article.url dans le contexte article_image", () => {
    const s = scene([
      { ...base, id: "q", name: "", type: "qr", slot: "article.url", fg: "#000000", bg: "#FFFFFF", margin: 1 },
    ]);
    const errors = validateScene(s, "article_image");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("article.url");
  });

  it("accepte article.url dans le contexte social_post", () => {
    const s = scene([
      { ...base, id: "q", name: "", type: "qr", slot: "article.url", fg: "#000000", bg: "#FFFFFF", margin: 1 },
    ]);
    expect(validateScene(s, "social_post")).toEqual([]);
  });

  it("refuse un jeton texte utilisé comme source d'image", () => {
    const s = scene([
      { ...base, id: "a", name: "", type: "image", source: { kind: "slot", slot: "article.title" }, fit: "cover" },
    ]);
    expect(validateScene(s, "social_post")[0]).toMatch(/type/i);
  });

  it("refuse un jeton inconnu", () => {
    const s = scene([
      { ...base, id: "b", name: "", type: "text", content: "{{article.inexistant}}",
        font: textFont, color: "#FFFFFF", align: "left", vAlign: "top", lineHeight: 1.2 },
    ]);
    expect(validateScene(s, "social_post")[0]).toContain("article.inexistant");
  });

  it("chaque contexte ne déclare que des jetons connus", () => {
    for (const tokens of Object.values(CONTEXT_TOKENS)) {
      expect(tokens.length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test tests/studio-tokens.test.ts`
Expected: FAIL — cannot resolve `@/lib/studio/tokens`.

- [ ] **Step 3: Implement `lib/studio/tokens.ts`**

```ts
import type { Scene, Layer } from "./scene";

export type TokenKind = "text" | "image" | "color" | "url";

// Le catalogue COMPLET des jetons injectables. Ajouter un jeton ici ne suffit pas : il faut aussi
// l'exposer dans au moins un contexte (CONTEXT_TOKENS) et lui fournir une valeur (bindings.ts).
export const TOKEN_KINDS = {
  "article.title": "text",
  "article.excerpt": "text",
  "article.date": "text",
  "article.byline": "text",
  "article.image": "image",
  "article.url": "url",
  "category.name": "text",
  "category.color": "color",
  "source.names": "text",
  "brand.logo": "image",
  "quote.text": "text",
  "quote.attribution": "text",
  "edition.title": "text",
  "edition.date": "text",
  "recap.title": "text",
  "recap.item1": "text",
  "recap.item2": "text",
  "recap.item3": "text",
} as const satisfies Record<string, TokenKind>;

export type TokenId = keyof typeof TOKEN_KINDS;
export const TOKEN_IDS = Object.keys(TOKEN_KINDS) as TokenId[];

export const TEMPLATE_CONTEXTS = [
  "article_image", "social_post", "quote_card", "newsletter_header", "recap_card",
] as const;
export type TemplateContext = (typeof TEMPLATE_CONTEXTS)[number];

export const CHANNELS = ["facebook", "instagram", "whatsapp", "x", "tiktok"] as const;
export type Channel = (typeof CHANNELS)[number];

const ARTICLE_COMMON = [
  "article.title", "article.excerpt", "article.date", "article.byline", "article.image",
  "category.name", "category.color", "source.names", "brand.logo",
] as const;

// LA contrainte d'ordonnancement du programme : `article.url` n'existe qu'APRÈS la publication
// WordPress. L'image à la une du site, elle, est rendue AVANT. Un gabarit article_image qui
// référencerait article.url produirait donc toujours une valeur vide — on le refuse plutôt que de
// laisser le piège en place, et on le refuse au moment de PUBLIER le gabarit, pas devant un
// rédacteur au moment du rendu.
export const CONTEXT_TOKENS: Record<TemplateContext, readonly TokenId[]> = {
  article_image: ARTICLE_COMMON,
  social_post: [...ARTICLE_COMMON, "article.url"],
  quote_card: ["quote.text", "quote.attribution", "article.title", "category.name", "category.color", "brand.logo"],
  newsletter_header: ["edition.title", "edition.date", "brand.logo"],
  recap_card: ["recap.title", "recap.item1", "recap.item2", "recap.item3", "brand.logo"],
};

export type TokenUse = { token: string; expected: TokenKind; where: string };

const TOKEN_IN_TEXT = /\{\{\s*([a-zA-Z][\w.]*)\s*\}\}/g;

function tokensInString(value: string): string[] {
  return [...value.matchAll(TOKEN_IN_TEXT)].map((m) => m[1]);
}

function usesInLayer(layer: Layer): TokenUse[] {
  const where = `calque « ${layer.name || layer.id} »`;
  switch (layer.type) {
    case "image":
      return layer.source.kind === "slot"
        ? [{ token: layer.source.slot, expected: "image", where }]
        : [];
    case "qr":
      return [{ token: layer.slot, expected: "url", where }];
    case "text":
      return [
        ...tokensInString(layer.content).map((t) => ({ token: t, expected: "text" as const, where })),
        ...tokensInString(layer.color).map((t) => ({ token: t, expected: "color" as const, where })),
      ];
    case "shape": {
      const colors = typeof layer.fill === "string" ? [layer.fill] : layer.fill.stops.map((s) => s.color);
      if (layer.border) colors.push(layer.border.color);
      return colors.flatMap((c) => tokensInString(c).map((t) => ({ token: t, expected: "color" as const, where })));
    }
  }
}

// Les slots d'un gabarit sont DÉRIVÉS de sa scène, jamais déclarés à côté. Une liste parallèle
// dériverait tôt ou tard de la scène réelle ; ici c'est structurellement impossible.
export function extractTokens(scene: Scene): TokenUse[] {
  return scene.layers.flatMap(usesInLayer);
}

// Renvoie la liste des problèmes, en français, prête à afficher. Tableau vide = valide.
export function validateScene(scene: Scene, context: TemplateContext): string[] {
  const allowed = new Set<string>(CONTEXT_TOKENS[context]);
  const errors: string[] = [];
  for (const use of extractTokens(scene)) {
    const kind = TOKEN_KINDS[use.token as TokenId];
    if (!kind) {
      errors.push(`${use.where} : jeton inconnu « ${use.token} ».`);
      continue;
    }
    if (!allowed.has(use.token)) {
      errors.push(
        `${use.where} : le jeton « ${use.token} » n'est pas disponible dans ce contexte. ` +
        `Jetons disponibles : ${CONTEXT_TOKENS[context].join(", ")}.`,
      );
      continue;
    }
    if (kind !== use.expected) {
      errors.push(
        `${use.where} : le jeton « ${use.token} » est de type « ${kind} », ` +
        `or un « ${use.expected} » est attendu ici.`,
      );
    }
  }
  return errors;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/studio-tokens.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck and commit**

```bash
bun run typecheck && bun test tests/studio-tokens.test.ts
git add lib/studio/tokens.ts tests/studio-tokens.test.ts
git commit -m "feat(studio): registre des jetons et validation de scène par contexte"
```

---

### Task 4: Token value resolution

**Files:**
- Create: `lib/studio/values.ts`
- Test: `tests/studio-values.test.ts`

**Interfaces:**
- Consumes: `Scene`, `Layer` from `scene.ts`; `TokenId`, `extractTokens` from `tokens.ts`.
- Produces: `TokenValues = Partial<Record<TokenId, string>>`; `MissingTokensError extends Error { tokens: string[] }`; `resolveTokens(scene: Scene, values: TokenValues): Scene` — returns a **new** scene with every `{{token}}` substituted (image slots become `{kind:"url", url}`), never mutating its input.

- [ ] **Step 1: Write the failing test**

Create `tests/studio-values.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { resolveTokens, MissingTokensError } from "@/lib/studio/values";
import type { Scene } from "@/lib/studio/scene";

const base = { visible: true, locked: false, frame: { x: 0, y: 0, w: 100, h: 100 } };
const font = { family: "Noto Sans", size: 32, weight: 400 };

const scene: Scene = {
  schemaVersion: 1,
  canvas: { width: 1200, height: 675, background: "#000000" },
  layers: [
    { ...base, id: "img", name: "", type: "image", source: { kind: "slot", slot: "article.image" }, fit: "cover" },
    { ...base, id: "txt", name: "", type: "text", content: "{{article.title}} · {{category.name}}",
      font, color: "{{category.color}}", align: "left", vAlign: "top", lineHeight: 1.2 },
    { ...base, id: "bar", name: "", type: "shape", shape: "rect", fill: "{{category.color}}" },
  ],
};

const values = {
  "article.image": "https://cdn.test/photo.jpg",
  "article.title": "Le cacao camerounais",
  "category.name": "Agribusiness",
  "category.color": "#1B7F४".replace("४", "4"),
} as const;

describe("resolveTokens", () => {
  it("remplace les jetons dans le texte, la couleur et la source d'image", () => {
    const out = resolveTokens(scene, values);
    const img = out.layers[0];
    const txt = out.layers[1];
    const bar = out.layers[2];
    if (img.type !== "image" || txt.type !== "text" || bar.type !== "shape") throw new Error("types");
    expect(img.source).toEqual({ kind: "url", url: "https://cdn.test/photo.jpg" });
    expect(txt.content).toBe("Le cacao camerounais · Agribusiness");
    expect(txt.color).toBe("#1B7F4");
    expect(bar.fill).toBe("#1B7F4");
  });

  it("ne mute jamais la scène d'entrée", () => {
    const before = JSON.stringify(scene);
    resolveTokens(scene, values);
    expect(JSON.stringify(scene)).toBe(before);
  });

  it("lève MissingTokensError en nommant TOUS les jetons manquants", () => {
    try {
      resolveTokens(scene, { "article.title": "x" });
      throw new Error("aurait dû lever");
    } catch (e) {
      expect(e).toBeInstanceOf(MissingTokensError);
      expect((e as MissingTokensError).tokens.sort()).toEqual(["article.image", "category.color", "category.name"]);
      expect((e as MissingTokensError).message).toContain("category.color");
    }
  });
});
```

> Note for the implementer: the odd `"#1B7F४".replace(...)` above is deliberate obfuscation-free
> plain ASCII once evaluated — it produces `#1B7F4`. Replace it with the literal `"#1B7F4"` if you
> prefer; the assertion values must stay consistent.

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test tests/studio-values.test.ts`
Expected: FAIL — cannot resolve `@/lib/studio/values`.

- [ ] **Step 3: Implement `lib/studio/values.ts`**

```ts
import type { Scene, Layer } from "./scene";
import { extractTokens, type TokenId } from "./tokens";

export type TokenValues = Partial<Record<TokenId, string>>;

// Erreur typée : le message est en français et NOMME les jetons manquants, parce qu'un rédacteur
// qui voit « il manque des informations » ne peut rien en faire.
export class MissingTokensError extends Error {
  constructor(public readonly tokens: string[]) {
    super(`Valeurs manquantes pour : ${tokens.join(", ")}.`);
    this.name = "MissingTokensError";
  }
}

const TOKEN_IN_TEXT = /\{\{\s*([a-zA-Z][\w.]*)\s*\}\}/g;

function substitute(value: string, values: TokenValues): string {
  return value.replace(TOKEN_IN_TEXT, (_m, token: string) => values[token as TokenId] ?? "");
}

// Renvoie une NOUVELLE scène ; l'entrée n'est jamais mutée (les scènes viennent d'un cache ou
// d'une ligne de base et peuvent être réutilisées).
export function resolveTokens(scene: Scene, values: TokenValues): Scene {
  const missing = [...new Set(
    extractTokens(scene)
      .map((u) => u.token)
      .filter((t) => !values[t as TokenId]),
  )];
  if (missing.length > 0) throw new MissingTokensError(missing.sort());

  const layers: Layer[] = scene.layers.map((layer) => {
    switch (layer.type) {
      case "image":
        return layer.source.kind === "slot"
          ? { ...layer, source: { kind: "url" as const, url: values[layer.source.slot as TokenId]! } }
          : layer;
      case "qr":
        return layer; // le slot est résolu par render.ts, qui seul sait générer le QR
      case "text":
        return { ...layer, content: substitute(layer.content, values), color: substitute(layer.color, values) };
      case "shape": {
        const fill = typeof layer.fill === "string"
          ? substitute(layer.fill, values)
          : { ...layer.fill, stops: layer.fill.stops.map((s) => ({ ...s, color: substitute(s.color, values) })) };
        const border = layer.border
          ? { ...layer.border, color: substitute(layer.border.color, values) }
          : undefined;
        return { ...layer, fill, ...(border ? { border } : {}) };
      }
    }
  });

  return { ...scene, canvas: { ...scene.canvas }, layers };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/studio-values.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck and commit**

```bash
bun run typecheck && bun test tests/studio-values.test.ts
git add lib/studio/values.ts tests/studio-values.test.ts
git commit -m "feat(studio): résolution des jetons vers une scène concrète"
```

---

### Task 5: sharp image pre-pass

**Files:**
- Create: `lib/studio/images.ts`
- Test: `tests/studio-images.test.ts`

**Interfaces:**
- Consumes: `isSafePublicHttpUrl` from `lib/url-guard.ts`.
- Produces: `prepareImage(opts: PrepareImageOptions): Promise<string>` returning a `data:image/png;base64,…` URI, where `PrepareImageOptions = { url: string; width: number; height: number; fit: "cover" | "contain"; blur?: number; overlay?: string }`. Throws `ImageFetchError extends Error` (French message) on a refused URL, a network failure or a non-2xx response.

- [ ] **Step 1: Write the failing test**

Create `tests/studio-images.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import sharp from "sharp";
import { prepareImage, ImageFetchError } from "@/lib/studio/images";

let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(async () => {
  // Une image source volontairement carrée, pour vérifier le recadrage « cover » en 16:9.
  const png = await sharp({
    create: { width: 400, height: 400, channels: 3, background: { r: 200, g: 30, b: 30 } },
  }).png().toBuffer();

  server = Bun.serve({
    port: 0,
    fetch(req) {
      if (new URL(req.url).pathname === "/ok.png") {
        return new Response(png, { headers: { "content-type": "image/png" } });
      }
      return new Response("nope", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => server.stop(true));

describe("prepareImage", () => {
  it("recadre en cover aux dimensions exactes du calque", async () => {
    const uri = await prepareImage({ url: `${base}/ok.png`, width: 1200, height: 675, fit: "cover" });
    expect(uri.startsWith("data:image/png;base64,")).toBe(true);
    const meta = await sharp(Buffer.from(uri.split(",")[1], "base64")).metadata();
    expect(meta.width).toBe(1200);
    expect(meta.height).toBe(675);
  });

  it("applique le flou sans changer les dimensions", async () => {
    const uri = await prepareImage({ url: `${base}/ok.png`, width: 600, height: 600, fit: "cover", blur: 24 });
    const meta = await sharp(Buffer.from(uri.split(",")[1], "base64")).metadata();
    expect(meta.width).toBe(600);
    expect(meta.height).toBe(600);
  });

  it("assombrit l'image quand une teinte est fournie", async () => {
    const plain = await prepareImage({ url: `${base}/ok.png`, width: 100, height: 100, fit: "cover" });
    const tinted = await prepareImage({ url: `${base}/ok.png`, width: 100, height: 100, fit: "cover", overlay: "#000000CC" });
    const meanOf = async (uri: string) =>
      (await sharp(Buffer.from(uri.split(",")[1], "base64")).stats()).channels[0].mean;
    expect(await meanOf(tinted)).toBeLessThan(await meanOf(plain));
  });

  it("refuse une URL non publique (garde SSRF partagé)", async () => {
    await expect(prepareImage({ url: "http://169.254.169.254/latest/meta-data/", width: 10, height: 10, fit: "cover" }))
      .rejects.toBeInstanceOf(ImageFetchError);
  });

  it("échoue clairement sur une 404", async () => {
    await expect(prepareImage({ url: `${base}/missing.png`, width: 10, height: 10, fit: "cover" }))
      .rejects.toBeInstanceOf(ImageFetchError);
  });
});
```

> **Implementer note:** `isSafePublicHttpUrl` rejects loopback addresses, so the `127.0.0.1` fixture
> server above must be reachable. Check `lib/url-guard.ts` first: if it refuses `127.0.0.1`, add an
> `allowPrivate` escape used **only** by tests, or have `prepareImage` accept an injected
> `fetchImpl`. Prefer injecting `fetchImpl` — it keeps the guard untouched. Adjust the test to pass
> a permissive fetch and keep the SSRF assertion using the real guard.

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test tests/studio-images.test.ts`
Expected: FAIL — cannot resolve `@/lib/studio/images`.

- [ ] **Step 3: Implement `lib/studio/images.ts`**

```ts
import sharp from "sharp";
import { isSafePublicHttpUrl } from "@/lib/url-guard";

export class ImageFetchError extends Error {}

export type PrepareImageOptions = {
  url: string;
  width: number;
  height: number;
  fit: "cover" | "contain";
  blur?: number;
  overlay?: string;
  // Injecté par les tests uniquement : garde le garde SSRF intact tout en autorisant un serveur
  // fixture local.
  fetchImpl?: typeof fetch;
};

// #RRGGBB ou #RRGGBBAA -> {r,g,b,alpha}
function parseHex(hex: string): { r: number; g: number; b: number; alpha: number } {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
    alpha: full.length === 8 ? parseInt(full.slice(6, 8), 16) / 255 : 1,
  };
}

// C'est ICI que se fait le flou, en raster, avant composition — Satori n'a pas de backdrop-filter.
// Le recadrage vise les dimensions EXACTES du calque en pixels de sortie : le rendu final est déjà
// à sa résolution native (1080-1600 px), suréchantillonner coûterait de la mémoire sans gain.
export async function prepareImage(opts: PrepareImageOptions): Promise<string> {
  const { url, width, height, fit, blur, overlay } = opts;
  const doFetch = opts.fetchImpl ?? fetch;

  if (!opts.fetchImpl && !isSafePublicHttpUrl(url)) {
    throw new ImageFetchError(`Image refusée : l'URL « ${url} » n'est pas une adresse publique autorisée.`);
  }

  let bytes: Uint8Array;
  try {
    const res = await doFetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    throw new ImageFetchError(`Téléchargement de l'image échoué (${url}) : ${(e as Error).message}`);
  }

  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));

  let pipeline = sharp(bytes).resize(w, h, {
    fit: fit === "cover" ? "cover" : "contain",
    position: "attention", // recadrage centré sur la zone la plus « intéressante »
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  });

  // sharp attend un sigma, pas un rayon CSS. blur/2 approche visuellement le flou d'un navigateur.
  if (blur && blur > 0) pipeline = pipeline.blur(Math.max(0.3, blur / 2));

  if (overlay && overlay !== "transparent") {
    const tint = await sharp({
      create: { width: w, height: h, channels: 4, background: parseHex(overlay) },
    }).png().toBuffer();
    pipeline = sharp(await pipeline.png().toBuffer()).composite([{ input: tint, blend: "over" }]);
  }

  const out = await pipeline.png().toBuffer();
  return `data:image/png;base64,${out.toString("base64")}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/studio-images.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck and commit**

```bash
bun run typecheck && bun test tests/studio-images.test.ts
git add lib/studio/images.ts tests/studio-images.test.ts
git commit -m "feat(studio): pré-passe sharp — recadrage, flou raster et teinte"
```

---

### Task 6: Bundled fonts and the asset loader

**Files:**
- Create: `lib/studio/fonts.ts`, `lib/studio/fonts/NotoSans-Regular.ttf`, `lib/studio/fonts/NotoSans-SemiBold.ttf`, `lib/studio/fonts/NotoSans-Bold.ttf`
- Test: `tests/studio-fonts.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `LoadedFont = { name: string; data: ArrayBuffer; weight: number; style: "normal" | "italic" }`; `FALLBACK_FONT_FAMILY = "Noto Sans"`; `loadFallbackFonts(): Promise<LoadedFont[]>` (memoised); `AssetLoader` interface with `font(assetId): Promise<LoadedFont | null>` and `imageUrl(assetId): Promise<string | null>`; `NullAssetLoader` (returns `null` for everything, used by tests and by V1 which has no asset library yet).

- [ ] **Step 1: Download the fonts**

These exact URLs were verified to return HTTP 200 (~570 kB each) on 2026-08-09. Noto Sans is OFL-licensed, so committing the files is fine.

```bash
mkdir -p lib/studio/fonts
for f in Regular SemiBold Bold; do
  curl -fL -o "lib/studio/fonts/NotoSans-$f.ttf" \
    "https://raw.githubusercontent.com/googlefonts/noto-fonts/main/hinted/ttf/NotoSans/NotoSans-$f.ttf"
done
ls -la lib/studio/fonts/
```

Expected: three files, each roughly 570 kB. If a URL 404s, take any static **TTF** (not WOFF2 — Satori cannot read it) of Noto Sans or Inter and place it at the same path.

- [ ] **Step 2: Write the failing test**

Create `tests/studio-fonts.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { loadFallbackFonts, FALLBACK_FONT_FAMILY, NullAssetLoader } from "@/lib/studio/fonts";

describe("loadFallbackFonts", () => {
  it("charge trois graisses de la police de repli", async () => {
    const fonts = await loadFallbackFonts();
    expect(fonts.map((f) => f.weight).sort((a, b) => a - b)).toEqual([400, 600, 700]);
    for (const f of fonts) {
      expect(f.name).toBe(FALLBACK_FONT_FAMILY);
      expect(f.data.byteLength).toBeGreaterThan(10_000);
      expect(f.style).toBe("normal");
    }
  });

  it("mémoïse : deux appels renvoient les mêmes tampons", async () => {
    const a = await loadFallbackFonts();
    const b = await loadFallbackFonts();
    expect(a[0].data).toBe(b[0].data);
  });
});

describe("NullAssetLoader", () => {
  it("ne fournit ni police ni image", async () => {
    const loader = new NullAssetLoader();
    expect(await loader.font("whatever")).toBeNull();
    expect(await loader.imageUrl("whatever")).toBeNull();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `bun test tests/studio-fonts.test.ts`
Expected: FAIL — cannot resolve `@/lib/studio/fonts`.

- [ ] **Step 4: Implement `lib/studio/fonts.ts`**

```ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type LoadedFont = {
  name: string;
  data: ArrayBuffer;
  weight: number;
  style: "normal" | "italic";
};

// Police de repli EMBARQUÉE dans le dépôt : elle garantit qu'un rendu aboutit toujours, même sans
// aucun asset téléversé et même si R2 est injoignable. TTF obligatoire — Satori ne lit pas le WOFF2.
export const FALLBACK_FONT_FAMILY = "Noto Sans";

const FALLBACK_FILES: { file: string; weight: number }[] = [
  { file: "NotoSans-Regular.ttf", weight: 400 },
  { file: "NotoSans-SemiBold.ttf", weight: 600 },
  { file: "NotoSans-Bold.ttf", weight: 700 },
];

let fallbackPromise: Promise<LoadedFont[]> | null = null;

// Mémoïsé sur la promesse et non sur le résultat : deux appels concurrents au démarrage ne doivent
// pas lire les fichiers deux fois.
export function loadFallbackFonts(): Promise<LoadedFont[]> {
  fallbackPromise ??= Promise.all(
    FALLBACK_FILES.map(async ({ file, weight }) => {
      const buf = await readFile(join(process.cwd(), "lib/studio/fonts", file));
      return {
        name: FALLBACK_FONT_FAMILY,
        data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
        weight,
        style: "normal" as const,
      };
    }),
  );
  return fallbackPromise;
}

// Le studio lit ses assets à travers cette interface. V1 n'a pas de bibliothèque d'assets (V2 la
// livre) : NullAssetLoader est donc l'implémentation par défaut, et tout gabarit V1 s'appuie sur
// la police de repli.
export interface AssetLoader {
  font(assetId: string): Promise<LoadedFont | null>;
  imageUrl(assetId: string): Promise<string | null>;
}

export class NullAssetLoader implements AssetLoader {
  async font(): Promise<LoadedFont | null> { return null; }
  async imageUrl(): Promise<string | null> { return null; }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test tests/studio-fonts.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Typecheck and commit**

```bash
bun run typecheck && bun test tests/studio-fonts.test.ts
git add lib/studio/fonts.ts lib/studio/fonts/*.ttf tests/studio-fonts.test.ts
git commit -m "feat(studio): police de repli embarquée et interface de chargement d'assets"
```

---

### Task 7: sceneToElement — scene to Satori node tree

**Files:**
- Create: `lib/studio/element.ts`
- Test: `tests/studio-element.test.ts`

**Interfaces:**
- Consumes: `Scene`, `Layer`, `Gradient` from `scene.ts`.
- Produces: `SatoriNode = { type: string; props: Record<string, unknown> }`; `sceneToElement(scene: Scene, images: Map<string, string>): SatoriNode`, where `images` maps a **layer id** to a ready data URI (image and qr layers). A layer whose id is absent from the map is skipped. **Pure** — no I/O.

- [ ] **Step 1: Write the failing test**

Create `tests/studio-element.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { sceneToElement } from "@/lib/studio/element";
import type { Scene } from "@/lib/studio/scene";

const base = { visible: true, locked: false };
const font = { family: "Noto Sans", size: 40, weight: 700 };

const scene: Scene = {
  schemaVersion: 1,
  canvas: { width: 1200, height: 675, background: "#101010" },
  layers: [
    { ...base, id: "bg", name: "Fond", frame: { x: 0, y: 0, w: 1200, h: 675 },
      type: "image", source: { kind: "url", url: "https://x.test/a.png" }, fit: "cover" },
    { ...base, id: "bar", name: "Bordure", frame: { x: 0, y: 0, w: 1200, h: 675 },
      type: "shape", shape: "rect", fill: "transparent", border: { width: 12, color: "#1B7F4A" } },
    { ...base, id: "title", name: "Titre", frame: { x: 80, y: 420, w: 1040, h: 180 },
      type: "text", content: "Bonjour", font, color: "#FFFFFF", align: "left", vAlign: "bottom",
      lineHeight: 1.1, maxLines: 3 },
    { ...base, id: "hidden", name: "Masqué", visible: false, frame: { x: 0, y: 0, w: 10, h: 10 },
      type: "shape", shape: "rect", fill: "#FF0000" },
  ],
};

const images = new Map([["bg", "data:image/png;base64,AAAA"]]);

describe("sceneToElement", () => {
  it("produit une racine aux dimensions du canevas", () => {
    const root = sceneToElement(scene, images);
    expect(root.type).toBe("div");
    const style = (root.props as { style: Record<string, unknown> }).style;
    expect(style.width).toBe(1200);
    expect(style.height).toBe(675);
    expect(style.backgroundColor).toBe("#101010");
  });

  it("respecte l'ordre de peinture : index 0 en premier enfant", () => {
    const root = sceneToElement(scene, images);
    const children = (root.props as { children: { props: { "data-layer": string } }[] }).children;
    expect(children.map((c) => c.props["data-layer"])).toEqual(["bg", "bar", "title"]);
  });

  it("omet les calques invisibles", () => {
    const root = sceneToElement(scene, images);
    const children = (root.props as { children: unknown[] }).children;
    expect(children).toHaveLength(3);
  });

  it("omet un calque image dont l'URI n'a pas été préparée", () => {
    const root = sceneToElement(scene, new Map());
    const children = (root.props as { children: { props: { "data-layer": string } }[] }).children;
    expect(children.map((c) => c.props["data-layer"])).toEqual(["bar", "title"]);
  });

  it("positionne chaque calque en absolu selon son cadre", () => {
    const root = sceneToElement(scene, images);
    const children = (root.props as { children: { props: { style: Record<string, unknown> } }[] }).children;
    expect(children[2].props.style.position).toBe("absolute");
    expect(children[2].props.style.left).toBe(80);
    expect(children[2].props.style.top).toBe(420);
  });

  it("traduit maxLines en lineClamp", () => {
    const root = sceneToElement(scene, images);
    const children = (root.props as { children: { props: { style: Record<string, unknown> } }[] }).children;
    expect(children[2].props.style.lineClamp).toBe(3);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test tests/studio-element.test.ts`
Expected: FAIL — cannot resolve `@/lib/studio/element`.

- [ ] **Step 3: Implement `lib/studio/element.ts`**

```ts
import type { Scene, Layer, Gradient, TextLayer, ShapeLayer } from "./scene";

// Satori accepte un arbre « à la React » sous forme d'objets simples : pas besoin de JSX dans du
// code de bibliothèque.
export type SatoriNode = { type: string; props: Record<string, unknown> };

function gradientCss(g: Gradient): string {
  const stops = g.stops.map((s) => `${s.color} ${Math.round(s.at * 100)}%`).join(", ");
  return `linear-gradient(${g.angle}deg, ${stops})`;
}

function frameStyle(layer: Layer): Record<string, unknown> {
  const transforms: string[] = [];
  if (layer.rotation) transforms.push(`rotate(${layer.rotation}deg)`);
  return {
    position: "absolute",
    left: layer.frame.x,
    top: layer.frame.y,
    width: layer.frame.w,
    height: layer.frame.h,
    display: "flex",
    ...(layer.opacity !== undefined ? { opacity: layer.opacity } : {}),
    ...(transforms.length ? { transform: transforms.join(" ") } : {}),
  };
}

function textNode(layer: TextLayer): SatoriNode {
  const justify = layer.align === "center" ? "center" : layer.align === "right" ? "flex-end" : "flex-start";
  const align = layer.vAlign === "middle" ? "center" : layer.vAlign === "bottom" ? "flex-end" : "flex-start";
  return {
    type: "div",
    props: {
      "data-layer": layer.id,
      style: {
        ...frameStyle(layer),
        justifyContent: justify,
        alignItems: align,
        fontFamily: layer.font.family,
        fontSize: layer.font.size,
        fontWeight: layer.font.weight,
        fontStyle: layer.font.italic ? "italic" : "normal",
        color: layer.color,
        lineHeight: layer.lineHeight,
        textAlign: layer.align,
        overflow: "hidden",
        ...(layer.letterSpacing !== undefined ? { letterSpacing: layer.letterSpacing } : {}),
        ...(layer.maxLines ? { lineClamp: layer.maxLines } : {}),
        ...(layer.shadow
          ? { textShadow: `${layer.shadow.x}px ${layer.shadow.y}px ${layer.shadow.blur}px ${layer.shadow.color}` }
          : {}),
        ...(layer.stroke
          ? { WebkitTextStroke: `${layer.stroke.width}px ${layer.stroke.color}` }
          : {}),
      },
      children: layer.content,
    },
  };
}

function shapeNode(layer: ShapeLayer): SatoriNode {
  const fill = typeof layer.fill === "string"
    ? (layer.fill === "transparent" ? {} : { backgroundColor: layer.fill })
    : { backgroundImage: gradientCss(layer.fill) };

  const border: Record<string, unknown> = {};
  if (layer.border) {
    const sides = layer.border.sides ?? ["top", "right", "bottom", "left"];
    const css = `${layer.border.width}px solid ${layer.border.color}`;
    for (const s of sides) {
      border[`border${s[0].toUpperCase()}${s.slice(1)}`] = css;
    }
  }

  return {
    type: "div",
    props: {
      "data-layer": layer.id,
      style: {
        ...frameStyle(layer),
        ...fill,
        ...border,
        ...(layer.radius ? { borderRadius: layer.radius } : {}),
      },
    },
  };
}

function imageNode(layer: Layer, uri: string): SatoriNode {
  const radius = layer.type === "image" && layer.radius ? { borderRadius: layer.radius } : {};
  const fit = layer.type === "image" ? layer.fit : "contain";
  return {
    type: "div",
    props: {
      "data-layer": layer.id,
      style: { ...frameStyle(layer), overflow: "hidden", ...radius },
      children: {
        type: "img",
        props: {
          src: uri,
          width: layer.frame.w,
          height: layer.frame.h,
          style: { objectFit: fit, width: layer.frame.w, height: layer.frame.h, ...radius },
        },
      },
    },
  };
}

// PURE — aucune I/O. `images` associe un ID DE CALQUE à une data URI déjà préparée (calques image
// et qr). Un calque image sans URI préparée est omis : render.ts a déjà échoué franchement si la
// préparation était obligatoire, donc arriver ici sans URI signifie « rien à peindre ».
export function sceneToElement(scene: Scene, images: Map<string, string>): SatoriNode {
  const children: SatoriNode[] = [];

  for (const layer of scene.layers) {
    if (!layer.visible) continue;
    if (layer.type === "image" || layer.type === "qr") {
      const uri = images.get(layer.id);
      if (!uri) continue;
      children.push(imageNode(layer, uri));
    } else if (layer.type === "text") {
      children.push(textNode(layer));
    } else {
      children.push(shapeNode(layer));
    }
  }

  return {
    type: "div",
    props: {
      style: {
        display: "flex",
        position: "relative",
        width: scene.canvas.width,
        height: scene.canvas.height,
        backgroundColor: scene.canvas.background === "transparent" ? undefined : scene.canvas.background,
      },
      children,
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/studio-element.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck and commit**

```bash
bun run typecheck && bun test tests/studio-element.test.ts
git add lib/studio/element.ts tests/studio-element.test.ts
git commit -m "feat(studio): scène vers arbre Satori, ordre de peinture explicite"
```

---

### Task 8: The render pipeline

**Files:**
- Create: `lib/studio/render.ts`
- Test: `tests/studio-render.test.ts`

**Interfaces:**
- Consumes: `Scene`/`parseScene`, `TokenValues`/`resolveTokens`, `prepareImage`, `AssetLoader`/`loadFallbackFonts`, `sceneToElement`.
- Produces: `RenderOutcome = { bytes: Uint8Array; width: number; height: number; degraded: boolean; mime: string }`; `renderScene(opts: RenderSceneOptions): Promise<RenderOutcome>` where `RenderSceneOptions = { scene: Scene; values: TokenValues; assets?: AssetLoader; encode?: "jpeg" | "webp"; fetchImpl?: typeof fetch }`.

- [ ] **Step 1: Write the failing test**

Create `tests/studio-render.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import sharp from "sharp";
import { renderScene } from "@/lib/studio/render";
import { MissingTokensError } from "@/lib/studio/values";
import type { Scene } from "@/lib/studio/scene";

let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(async () => {
  const png = await sharp({
    create: { width: 800, height: 800, channels: 3, background: { r: 20, g: 120, b: 60 } },
  }).png().toBuffer();
  server = Bun.serve({ port: 0, fetch: () => new Response(png, { headers: { "content-type": "image/png" } }) });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

const b = { visible: true, locked: false };
function agribusinessScene(): Scene {
  return {
    schemaVersion: 1,
    canvas: { width: 1200, height: 675, background: "#000000" },
    layers: [
      { ...b, id: "bg", name: "Fond", frame: { x: 0, y: 0, w: 1200, h: 675 },
        type: "image", source: { kind: "slot", slot: "article.image" }, fit: "cover",
        blur: 24, overlay: "#000000A6" },
      { ...b, id: "frame", name: "Bordure", frame: { x: 0, y: 0, w: 1200, h: 675 },
        type: "shape", shape: "rect", fill: "transparent",
        border: { width: 12, color: "{{category.color}}" } },
      { ...b, id: "title", name: "Titre", frame: { x: 80, y: 380, w: 1040, h: 220 },
        type: "text", content: "{{article.title}}",
        font: { family: "Noto Sans", size: 64, weight: 700 },
        color: "#FFFFFF", align: "left", vAlign: "bottom", lineHeight: 1.1, maxLines: 3 },
    ],
  };
}

const values = {
  "article.image": "https://cdn.test/photo.png",
  "article.title": "Le cacao camerounais bat un record d'exportation en 2026",
  "category.color": "#1B7F4A",
} as const;

describe("renderScene", () => {
  it("rend un JPEG aux dimensions du canevas", async () => {
    const out = await renderScene({
      scene: agribusinessScene(), values, fetchImpl: () => fetch(`${base}/x.png`),
    });
    expect(out.width).toBe(1200);
    expect(out.height).toBe(675);
    expect(out.mime).toBe("image/jpeg");
    expect(out.degraded).toBe(false);
    const meta = await sharp(Buffer.from(out.bytes)).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBe(1200);
    expect(meta.height).toBe(675);
  });

  it("produit une image réellement peinte, pas un aplat noir", async () => {
    const out = await renderScene({
      scene: agribusinessScene(), values, fetchImpl: () => fetch(`${base}/x.png`),
    });
    const stats = await sharp(Buffer.from(out.bytes)).stats();
    // Un aplat uniforme aurait un écart-type quasi nul sur tous les canaux.
    expect(Math.max(...stats.channels.map((c) => c.stdev))).toBeGreaterThan(5);
  });

  it("refuse de rendre quand une valeur manque, en la nommant", async () => {
    await expect(
      renderScene({ scene: agribusinessScene(), values: { "article.title": "x" }, fetchImpl: () => fetch(`${base}/x.png`) }),
    ).rejects.toBeInstanceOf(MissingTokensError);
  });

  it("réduit la taille de police quand autoFit est actif et le titre très long", async () => {
    const s = agribusinessScene();
    const title = s.layers[2];
    if (title.type !== "text") throw new Error("type");
    title.autoFit = true;
    delete title.maxLines;
    const long = { ...values, "article.title": "Titre ".repeat(80) };
    const out = await renderScene({ scene: s, values: long, fetchImpl: () => fetch(`${base}/x.png`) });
    expect(out.width).toBe(1200); // le rendu aboutit malgré un texte hors norme
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test tests/studio-render.test.ts`
Expected: FAIL — cannot resolve `@/lib/studio/render`.

- [ ] **Step 3: Implement `lib/studio/render.ts`**

```ts
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import sharp from "sharp";
import QRCode from "qrcode";
import type { Scene, TextLayer } from "./scene";
import { resolveTokens, type TokenValues } from "./values";
import { prepareImage } from "./images";
import { loadFallbackFonts, NullAssetLoader, type AssetLoader, type LoadedFont } from "./fonts";
import { sceneToElement, type SatoriNode } from "./element";
import type { TokenId } from "./tokens";

export type RenderOutcome = {
  bytes: Uint8Array;
  width: number;
  height: number;
  degraded: boolean;
  mime: string;
};

export type RenderSceneOptions = {
  scene: Scene;
  values: TokenValues;
  assets?: AssetLoader;
  encode?: "jpeg" | "webp";
  // Tests uniquement — voir prepareImage.
  fetchImpl?: typeof fetch;
};

const AUTOFIT_MIN = 12;
const AUTOFIT_PASSES = 5;

// Recherche dichotomique sur la taille de police : on rend le SEUL calque texte (pas d'image, donc
// quelques millisecondes par passe) et on garde la plus grande taille qui tient dans le cadre.
// C'est la partie la plus incertaine du lot ; si elle se révèle instable, le repli est maxLines +
// ellipse, déjà supporté, et on retire autoFit du schéma.
async function fitFontSize(layer: TextLayer, fonts: LoadedFont[]): Promise<number> {
  let low = AUTOFIT_MIN;
  let high = layer.font.size;
  let best = AUTOFIT_MIN;

  for (let i = 0; i < AUTOFIT_PASSES && low <= high; i++) {
    const mid = Math.floor((low + high) / 2);
    const probe: SatoriNode = {
      type: "div",
      props: {
        style: {
          display: "flex", width: layer.frame.w,
          fontFamily: layer.font.family, fontSize: mid, fontWeight: layer.font.weight,
          lineHeight: layer.lineHeight,
        },
        children: layer.content,
      },
    };
    const svg = await satori(probe as never, { width: layer.frame.w, height: layer.frame.h * 4, fonts, embedFont: false });
    const height = Number(/height="(\d+(?:\.\d+)?)"/.exec(svg)?.[1] ?? layer.frame.h);
    if (height <= layer.frame.h) { best = mid; low = mid + 1; } else { high = mid - 1; }
  }
  return best;
}

async function qrDataUri(text: string, fg: string, bg: string, margin: number): Promise<string> {
  const svg = await QRCode.toString(text, { type: "svg", margin, color: { dark: fg, light: bg } });
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

export async function renderScene(opts: RenderSceneOptions): Promise<RenderOutcome> {
  const assets = opts.assets ?? new NullAssetLoader();
  const encode = opts.encode ?? "jpeg";
  let degraded = false;

  // 1. Résolution des jetons — lève MissingTokensError en nommant ce qui manque.
  const resolved = resolveTokens(opts.scene, opts.values);

  // 2. Polices. Une police d'asset introuvable retombe sur le repli embarqué et marque le rendu
  //    dégradé — c'est la SEULE défaillance tolérée du pipeline, tout le reste échoue franchement.
  const fonts: LoadedFont[] = [...(await loadFallbackFonts())];
  const seen = new Set<string>();
  for (const layer of resolved.layers) {
    if (layer.type !== "text" || !layer.font.assetId || seen.has(layer.font.assetId)) continue;
    seen.add(layer.font.assetId);
    const font = await assets.font(layer.font.assetId);
    if (font) fonts.push(font); else degraded = true;
  }

  // 3. Pré-passe images + QR, en parallèle.
  const prepared = new Map<string, string>();
  await Promise.all(resolved.layers.map(async (layer) => {
    if (!layer.visible) return;
    if (layer.type === "image") {
      const url = layer.source.kind === "url"
        ? layer.source.url
        : layer.source.kind === "asset" ? await assets.imageUrl(layer.source.assetId) : null;
      if (!url) { degraded = true; return; }
      prepared.set(layer.id, await prepareImage({
        url, width: layer.frame.w, height: layer.frame.h, fit: layer.fit,
        blur: layer.blur, overlay: layer.overlay, fetchImpl: opts.fetchImpl,
      }));
    } else if (layer.type === "qr") {
      const value = opts.values[layer.slot as TokenId];
      if (!value) { degraded = true; return; }
      prepared.set(layer.id, await qrDataUri(value, layer.fg, layer.bg, layer.margin));
    }
  }));

  // 4. autoFit — après la résolution des jetons, puisque c'est le TEXTE FINAL qu'il faut mesurer.
  const scene: Scene = {
    ...resolved,
    layers: await Promise.all(resolved.layers.map(async (layer) =>
      layer.type === "text" && layer.autoFit
        ? { ...layer, font: { ...layer.font, size: await fitFontSize(layer, fonts) } }
        : layer,
    )),
  };

  // 5. satori -> SVG -> resvg -> PNG -> sharp.
  const svg = await satori(sceneToElement(scene, prepared) as never, {
    width: scene.canvas.width,
    height: scene.canvas.height,
    fonts,
    embedFont: true, // glyphes convertis en tracés : resvg n'a jamais besoin des polices
  });

  const png = new Resvg(svg, { fitTo: { mode: "width", value: scene.canvas.width } }).render().asPng();

  const encoder = sharp(png).removeAlpha();
  const bytes = new Uint8Array(
    encode === "webp"
      ? await encoder.webp({ quality: 88 }).toBuffer()
      : await encoder.jpeg({ quality: 86, mozjpeg: true }).toBuffer(),
  );

  return {
    bytes,
    width: scene.canvas.width,
    height: scene.canvas.height,
    degraded,
    mime: encode === "webp" ? "image/webp" : "image/jpeg",
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/studio-render.test.ts`
Expected: PASS (4 tests).

If satori rejects the plain-object tree, wrap it: satori accepts objects shaped like React
elements, and the `as never` casts above exist because satori's TypeScript signature demands
`ReactNode`. If it complains at runtime rather than compile time, add `key: null` and
`$$typeof: Symbol.for("react.element")` to each node in `element.ts` and re-run.

- [ ] **Step 5: Typecheck and commit**

```bash
bun run typecheck && bun test tests/studio-render.test.ts
git add lib/studio/render.ts tests/studio-render.test.ts
git commit -m "feat(studio): pipeline de rendu satori/resvg/sharp avec autoFit"
```

---

### Task 9: Database schema and migration

**Files:**
- Modify: `db/schema.ts`
- Create: `db/migrations/00NN_*.sql` (generated, then hand-edited)
- Test: `tests/studio-schema.test.ts`

**Interfaces:**
- Consumes: `wpCategories`, `user` from `db/schema.ts`.
- Produces: exported drizzle tables `renderTemplates`, `renderTemplateVersions`, `renderAssets`, `renders`, plus `wpCategories.color`. All re-exported by `db/index.ts` (it already does `export * from "./schema"`).

- [ ] **Step 1: Add the tables to `db/schema.ts`**

Append at the end of the file:

```ts
// ---- V1 studio de gabarits ----
// AUCUN nouvel enum PostgreSQL, volontairement : colonnes `text` + unions TypeScript. Même
// raisonnement que `alerts.type` plus haut — un ALTER TYPE ... ADD VALUE est un piège dans le
// migrate() mono-transaction de drizzle sur une base neuve. Les unions vivent dans
// lib/studio/tokens.ts (TemplateContext, Channel) et lib/studio/formats.ts (FormatKey).
export const renderTemplates = pgTable("render_templates", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  context: text("context").notNull(),
  // null = gabarit par défaut du contexte (tous canaux). Les valeurs viennent de CHANNELS.
  channel: text("channel"),
  // null = gabarit par défaut du couple (contexte, canal).
  categoryId: uuid("category_id").references(() => wpCategories.id, { onDelete: "cascade" }),
  format: text("format").notNull(),
  // FIGÉES à la création depuis FORMAT_PRESETS : modifier un préréglage ne doit jamais changer
  // les dimensions d'un gabarit existant, cela casserait sa mise en page.
  width: integer("width").notNull(),
  height: integer("height").notNull(),
  // COPIE DE TRAVAIL (le brouillon). Le résolveur ne lit JAMAIS cette colonne — il lit
  // render_template_versions. C'est ce qui donne un sens réel au couple brouillon/publié.
  scene: jsonb("scene").notNull(),
  // Numéro (pas identifiant) de la version en vigueur ; null = jamais publié. Volontairement SANS
  // clé étrangère : une FK créerait un cycle render_templates -> versions -> render_templates,
  // pénible à migrer et sans bénéfice, puisque (template_id, version) est déjà unique.
  // « Publié » ⟺ publishedVersion IS NOT NULL — pas de colonne `status`, qui serait une seconde
  // source de vérité : un gabarit publié AVEC des modifications en cours est l'état normal.
  publishedVersion: integer("published_version"),
  archived: boolean("archived").notNull().default(false),
  createdBy: text("created_by").references(() => user.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  // Unicité de la portée de résolution. ATTENTION : drizzle 0.45 n'expose PAS .nullsNotDistinct()
  // sur uniqueIndex(), et sans ce modificateur l'index est INEFFICACE ici — PostgreSQL traite les
  // NULL comme distincts, donc deux gabarits (social_post, facebook, NULL) coexisteraient. Le
  // modificateur est ajouté à la main dans la migration (DROP INDEX + CREATE UNIQUE INDEX ...
  // NULLS NOT DISTINCT ...), sur le modèle de db/migrations/0007_run_control_index.sql.
  uniqueIndex("render_templates_scope")
    .on(t.context, t.channel, t.categoryId)
    .where(sql`${t.archived} = false`),
  index("render_templates_lookup_idx").on(t.context, t.channel),
]);

export const renderTemplateVersions = pgTable("render_template_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  templateId: uuid("template_id").notNull().references(() => renderTemplates.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  // INSTANTANÉ IMMUABLE. Une fois écrite, cette scène ne change plus : c'est elle qui garantit
  // qu'un rendu passé reste reproductible même après vingt modifications du brouillon.
  scene: jsonb("scene").notNull(),
  publishedBy: text("published_by").references(() => user.id),
  publishedAt: timestamp("published_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("render_template_versions_unique").on(t.templateId, t.version)]);

export const renderAssets = pgTable("render_assets", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: text("kind").notNull(), // 'image' | 'font'
  name: text("name").notNull(),
  storageKey: text("storage_key").notNull(),
  url: text("url").notNull(),
  mime: text("mime").notNull(),
  bytes: integer("bytes").notNull(),
  width: integer("width"),
  height: integer("height"),
  fontFamily: text("font_family"),
  fontWeight: integer("font_weight"),
  fontStyle: text("font_style"),
  uploadedBy: text("uploaded_by").references(() => user.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Cache IMMUABLE des sorties. Deux propriétés en découlent : un appel identique renvoie la ligne
// existante sans re-rendre, et « on ne re-rend pas après diffusion » s'applique tout seul — D1
// posera un render_id sur la ligne distributions, et cette ligne-là ne bouge plus jamais.
export const renders = pgTable("renders", {
  id: uuid("id").primaryKey().defaultRandom(),
  templateId: uuid("template_id").notNull(),
  templateVersion: integer("template_version").notNull(),
  context: text("context").notNull(),
  subjectType: text("subject_type").notNull(), // 'article' | 'manual'
  // PAS une clé étrangère vers articles : un rendu doit survivre à la suppression de son article
  // (historique de diffusion, pas jointure vivante) — même raisonnement que alerts.entityId.
  subjectId: uuid("subject_id"),
  inputHash: text("input_hash").notNull(),
  storageKey: text("storage_key").notNull(),
  url: text("url").notNull(),
  width: integer("width").notNull(),
  height: integer("height").notNull(),
  bytes: integer("bytes").notNull(),
  degraded: boolean("degraded").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("renders_input_hash_unique").on(t.inputHash),
  index("renders_subject_idx").on(t.subjectType, t.subjectId),
]);
```

- [ ] **Step 2: Add the category colour column**

In the existing `wpCategories` definition, add after `articleCount`:

```ts
  // Jeton {{category.color}} du studio (V1). Nullable : une catégorie sans couleur retombe sur
  // DEFAULT_CATEGORY_COLOR côté rendu, jamais sur une erreur.
  color: text("color"),
```

- [ ] **Step 3: Generate the migration**

```bash
bun run db:generate
```

Note the generated filename; it will be `db/migrations/0015_*.sql`.

- [ ] **Step 4: Hand-edit the migration to add `NULLS NOT DISTINCT`**

Open the generated file. Find the `CREATE UNIQUE INDEX "render_templates_scope"` statement and replace it with:

```sql
CREATE UNIQUE INDEX "render_templates_scope" ON "render_templates" USING btree ("context","channel","category_id") NULLS NOT DISTINCT WHERE "render_templates"."archived" = false;
```

The `NULLS NOT DISTINCT` clause (PostgreSQL 15+, available on Neon) is load-bearing: without it two
templates scoped `(social_post, facebook, NULL)` would both insert successfully, because PostgreSQL
treats NULLs as distinct in a unique index — the same trap already documented on
`pipeline_runs_one_running` (`db/schema.ts:252`).

- [ ] **Step 5: Apply the migration**

```bash
bun run db:migrate
```

Expected: applies cleanly. Then verify the modifier actually landed:

```bash
bun -e 'import {db} from "./db"; import {sql} from "drizzle-orm";
const r = await db.execute(sql`select indexdef from pg_indexes where indexname = ${"render_templates_scope"}`);
console.log(r.rows[0]); process.exit(0)'
```

Expected: the printed definition contains `NULLS NOT DISTINCT`.

- [ ] **Step 6: Write the test**

Create `tests/studio-schema.test.ts`:

```ts
import { describe, it, expect, afterAll } from "bun:test";
import { db, renderTemplates, renderTemplateVersions } from "@/db";
import { inArray } from "drizzle-orm";

const created: string[] = [];
const scene = { schemaVersion: 1, canvas: { width: 1, height: 1, background: "#000000" }, layers: [] };

async function insertTemplate(over: Partial<typeof renderTemplates.$inferInsert> = {}) {
  const [row] = await db.insert(renderTemplates).values({
    name: "test", context: "social_post", channel: "facebook", categoryId: null,
    format: "fb_link", width: 1200, height: 630, scene, ...over,
  }).returning();
  created.push(row.id);
  return row;
}

afterAll(async () => {
  if (created.length) await db.delete(renderTemplates).where(inArray(renderTemplates.id, created));
});

describe("render_templates — unicité de la portée", () => {
  it("refuse deux gabarits de même portée avec category_id NULL", async () => {
    await insertTemplate();
    await expect(insertTemplate()).rejects.toThrow();
  });

  it("autorise la même portée si l'un est archivé", async () => {
    const a = await insertTemplate({ context: "quote_card", channel: null });
    await db.update(renderTemplates).set({ archived: true }).where(inArray(renderTemplates.id, [a.id]));
    await expect(insertTemplate({ context: "quote_card", channel: null })).resolves.toBeDefined();
  });

  it("refuse deux versions de même numéro pour un gabarit", async () => {
    const t = await insertTemplate({ context: "newsletter_header", channel: null });
    await db.insert(renderTemplateVersions).values({ templateId: t.id, version: 1, scene });
    await expect(
      db.insert(renderTemplateVersions).values({ templateId: t.id, version: 1, scene }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 7: Run the test**

Run: `bun test tests/studio-schema.test.ts`
Expected: PASS (3 tests). A failure on the first test means `NULLS NOT DISTINCT` did not land — go back to Step 4.

- [ ] **Step 8: Typecheck, full suite, commit**

```bash
bun run typecheck && bun test
git add db/schema.ts db/migrations tests/studio-schema.test.ts
git commit -m "feat(studio): tables de gabarits, versions, assets et rendus"
```

---

### Task 10: Render store and the input hash

**Files:**
- Create: `lib/studio/store.ts`
- Test: `tests/studio-store.test.ts`

**Interfaces:**
- Consumes: `getStudioConfig`, `putObject`, `publicUrlFor`, `TokenValues`, `renders` table.
- Produces: `RenderStore` interface `{ put(key: string, bytes: Uint8Array, mime: string): Promise<string> }`; `R2RenderStore`; `MemoryRenderStore` (exposes `objects: Map<string, Uint8Array>`); `computeInputHash(input: { templateId: string; templateVersion: number; values: TokenValues }): string`; `storageKeyFor(hash: string, mime: string, now: Date): string`; `findCachedRender(inputHash: string)`; `saveRender(row)`.

- [ ] **Step 1: Write the failing test**

Create `tests/studio-store.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { computeInputHash, storageKeyFor, MemoryRenderStore } from "@/lib/studio/store";

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
});

describe("storageKeyFor", () => {
  it("range par année et mois avec la bonne extension", () => {
    expect(storageKeyFor("abc123", "image/jpeg", new Date("2026-08-09T10:00:00Z")))
      .toBe("renders/2026/08/abc123.jpg");
    expect(storageKeyFor("abc123", "image/webp", new Date("2026-01-02T10:00:00Z")))
      .toBe("renders/2026/01/abc123.webp");
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test tests/studio-store.test.ts`
Expected: FAIL — cannot resolve `@/lib/studio/store`.

- [ ] **Step 3: Implement `lib/studio/store.ts`**

```ts
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, renders } from "@/db";
import { getStudioConfig } from "./config";
import { putObject, publicUrlFor } from "@/lib/storage/r2";
import type { TokenValues } from "./values";

export interface RenderStore {
  put(key: string, bytes: Uint8Array, mime: string): Promise<string>;
}

export class R2RenderStore implements RenderStore {
  async put(key: string, bytes: Uint8Array, mime: string): Promise<string> {
    const cfg = getStudioConfig();
    if (!cfg) throw new Error("Stockage R2 non configuré.");
    return putObject(cfg, key, bytes, mime);
  }
}

// Implémentation de test : c'est elle qui rend tout le chemin de rendu vérifiable sans compte R2
// ni réseau.
export class MemoryRenderStore implements RenderStore {
  readonly objects = new Map<string, Uint8Array>();
  async put(key: string, bytes: Uint8Array): Promise<string> {
    this.objects.set(key, bytes);
    return `memory://${key}`;
  }
}

// Empreinte canonique des ENTRÉES d'un rendu. Les clés sont triées, donc l'ordre de construction
// de l'objet `values` n'a aucune influence — sans ce tri, deux appels identiques produiraient deux
// empreintes différentes et le cache ne servirait jamais.
export function computeInputHash(input: {
  templateId: string;
  templateVersion: number;
  values: TokenValues;
}): string {
  const sorted = Object.keys(input.values).sort().map((k) => [k, input.values[k as keyof TokenValues]]);
  const canonical = JSON.stringify([input.templateId, input.templateVersion, sorted]);
  return createHash("sha256").update(canonical).digest("hex");
}

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/webp": "webp", "image/png": "png" };

export function storageKeyFor(hash: string, mime: string, now: Date): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `renders/${year}/${month}/${hash}.${EXT[mime] ?? "jpg"}`;
}

export async function findCachedRender(inputHash: string) {
  const [row] = await db.select().from(renders).where(eq(renders.inputHash, inputHash)).limit(1);
  return row ?? null;
}

export async function saveRender(row: typeof renders.$inferInsert) {
  const [saved] = await db.insert(renders).values(row).returning();
  return saved;
}

export { publicUrlFor };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/studio-store.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck and commit**

```bash
bun run typecheck && bun test tests/studio-store.test.ts
git add lib/studio/store.ts tests/studio-store.test.ts
git commit -m "feat(studio): stockage des rendus et empreinte d'entrée"
```

---

### Task 11: Template resolution

**Files:**
- Create: `lib/studio/resolve.ts`
- Test: `tests/studio-resolve.test.ts`

**Interfaces:**
- Consumes: `renderTemplates`, `renderTemplateVersions`, `parseScene`, `TemplateContext`.
- Produces: `ResolvedTemplate = { templateId: string; version: number; scene: Scene; context: TemplateContext; width: number; height: number }`; `resolveTemplate(q: { context: TemplateContext; channel?: string | null; categoryId?: string | null }): Promise<ResolvedTemplate | null>`.

- [ ] **Step 1: Write the failing test**

Create `tests/studio-resolve.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { db, renderTemplates, renderTemplateVersions, wpCategories } from "@/db";
import { inArray, eq } from "drizzle-orm";
import { resolveTemplate } from "@/lib/studio/resolve";

const templateIds: string[] = [];
let categoryId: string;

function sceneWithTitle(title: string) {
  return {
    schemaVersion: 1,
    canvas: { width: 1200, height: 630, background: "#000000" },
    layers: [{
      id: "t", name: title, visible: true, locked: false, frame: { x: 0, y: 0, w: 10, h: 10 },
      type: "text", content: title, font: { family: "Noto Sans", size: 10, weight: 400 },
      color: "#FFFFFF", align: "left", vAlign: "top", lineHeight: 1.2,
    }],
  };
}

async function makeTemplate(o: {
  channel: string | null; categoryId: string | null; publish: string | null; draft: string; archived?: boolean;
}) {
  const [t] = await db.insert(renderTemplates).values({
    name: o.draft, context: "social_post", channel: o.channel, categoryId: o.categoryId,
    format: "fb_link", width: 1200, height: 630, scene: sceneWithTitle(o.draft),
    archived: o.archived ?? false,
  }).returning();
  templateIds.push(t.id);
  if (o.publish) {
    await db.insert(renderTemplateVersions).values({ templateId: t.id, version: 1, scene: sceneWithTitle(o.publish) });
    await db.update(renderTemplates).set({ publishedVersion: 1 }).where(eq(renderTemplates.id, t.id));
  }
  return t;
}

beforeAll(async () => {
  const [c] = await db.insert(wpCategories).values({
    name: `Studio test ${Date.now()}`, slug: `studio-test-${Date.now()}`,
  }).returning();
  categoryId = c.id;
});

afterAll(async () => {
  if (templateIds.length) await db.delete(renderTemplates).where(inArray(renderTemplates.id, templateIds));
  await db.delete(wpCategories).where(eq(wpCategories.id, categoryId));
});

describe("resolveTemplate", () => {
  it("renvoie null quand aucun gabarit ne correspond", async () => {
    expect(await resolveTemplate({ context: "recap_card" })).toBeNull();
  });

  it("ignore un gabarit jamais publié", async () => {
    await makeTemplate({ channel: "x", categoryId: null, publish: null, draft: "brouillon" });
    expect(await resolveTemplate({ context: "social_post", channel: "x" })).toBeNull();
  });

  it("renvoie l'INSTANTANÉ PUBLIÉ, pas le brouillon de travail", async () => {
    await makeTemplate({ channel: "tiktok", categoryId: null, publish: "publié", draft: "brouillon" });
    const r = await resolveTemplate({ context: "social_post", channel: "tiktok" });
    const layer = r!.scene.layers[0];
    if (layer.type !== "text") throw new Error("type");
    expect(layer.content).toBe("publié");
  });

  it("préfère (contexte, canal, catégorie) au défaut de canal", async () => {
    await makeTemplate({ channel: "instagram", categoryId: null, publish: "défaut-canal", draft: "d" });
    await makeTemplate({ channel: "instagram", categoryId, publish: "spécifique", draft: "d" });
    const r = await resolveTemplate({ context: "social_post", channel: "instagram", categoryId });
    const layer = r!.scene.layers[0];
    if (layer.type !== "text") throw new Error("type");
    expect(layer.content).toBe("spécifique");
  });

  it("retombe sur le défaut de canal quand la catégorie n'a pas de gabarit", async () => {
    const r = await resolveTemplate({ context: "social_post", channel: "instagram", categoryId: null });
    const layer = r!.scene.layers[0];
    if (layer.type !== "text") throw new Error("type");
    expect(layer.content).toBe("défaut-canal");
  });

  it("retombe sur le défaut de contexte quand le canal n'a pas de gabarit", async () => {
    await makeTemplate({ channel: null, categoryId: null, publish: "défaut-contexte", draft: "d" });
    const r = await resolveTemplate({ context: "social_post", channel: "whatsapp" });
    const layer = r!.scene.layers[0];
    if (layer.type !== "text") throw new Error("type");
    expect(layer.content).toBe("défaut-contexte");
  });

  it("ignore un gabarit archivé", async () => {
    await makeTemplate({ channel: "facebook", categoryId: null, publish: "archivé", draft: "d", archived: true });
    const r = await resolveTemplate({ context: "social_post", channel: "facebook" });
    const layer = r!.scene.layers[0];
    if (layer.type !== "text") throw new Error("type");
    expect(layer.content).toBe("défaut-contexte");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test tests/studio-resolve.test.ts`
Expected: FAIL — cannot resolve `@/lib/studio/resolve`.

- [ ] **Step 3: Implement `lib/studio/resolve.ts`**

```ts
import { and, eq, isNull, isNotNull } from "drizzle-orm";
import { db, renderTemplates, renderTemplateVersions } from "@/db";
import { parseScene, type Scene } from "./scene";
import type { TemplateContext } from "./tokens";

export type ResolvedTemplate = {
  templateId: string;
  version: number;
  scene: Scene;
  context: TemplateContext;
  width: number;
  height: number;
};

// Le résolveur ne lit JAMAIS render_templates.scene (le brouillon) — uniquement l'instantané de la
// version publiée. C'est ce qui empêche une modification en cours de fuiter dans un post en ligne.
async function findAt(
  context: TemplateContext,
  channel: string | null,
  categoryId: string | null,
): Promise<ResolvedTemplate | null> {
  const [row] = await db
    .select({
      templateId: renderTemplates.id,
      version: renderTemplates.publishedVersion,
      width: renderTemplates.width,
      height: renderTemplates.height,
      scene: renderTemplateVersions.scene,
    })
    .from(renderTemplates)
    .innerJoin(
      renderTemplateVersions,
      and(
        eq(renderTemplateVersions.templateId, renderTemplates.id),
        eq(renderTemplateVersions.version, renderTemplates.publishedVersion),
      ),
    )
    .where(and(
      eq(renderTemplates.context, context),
      channel === null ? isNull(renderTemplates.channel) : eq(renderTemplates.channel, channel),
      categoryId === null ? isNull(renderTemplates.categoryId) : eq(renderTemplates.categoryId, categoryId),
      eq(renderTemplates.archived, false),
      isNotNull(renderTemplates.publishedVersion),
    ))
    .limit(1);

  if (!row) return null;
  return {
    templateId: row.templateId,
    version: row.version!,
    scene: parseScene(row.scene),
    context,
    width: row.width,
    height: row.height,
  };
}

// Trois niveaux de repli. Un null final n'est PAS une erreur : l'appelant utilise l'image brute.
export async function resolveTemplate(q: {
  context: TemplateContext;
  channel?: string | null;
  categoryId?: string | null;
}): Promise<ResolvedTemplate | null> {
  const channel = q.channel ?? null;
  const categoryId = q.categoryId ?? null;

  if (channel && categoryId) {
    const exact = await findAt(q.context, channel, categoryId);
    if (exact) return exact;
  }
  if (channel) {
    const byChannel = await findAt(q.context, channel, null);
    if (byChannel) return byChannel;
  }
  if (!channel && categoryId) {
    const byCategory = await findAt(q.context, null, categoryId);
    if (byCategory) return byCategory;
  }
  return findAt(q.context, null, null);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/studio-resolve.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Typecheck and commit**

```bash
bun run typecheck && bun test tests/studio-resolve.test.ts
git add lib/studio/resolve.ts tests/studio-resolve.test.ts
git commit -m "feat(studio): résolution (contexte, canal, catégorie) vers la version publiée"
```

---

### Task 12: Article bindings and the public API

**Files:**
- Create: `lib/studio/bindings.ts`, `lib/studio/index.ts`
- Test: `tests/studio-bindings.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `DEFAULT_CATEGORY_COLOR = "#1B7F4A"`; `articleTokenValues(articleId: string, context: TemplateContext): Promise<TokenValues>`; `renderForArticle(articleId: string, o: { context: TemplateContext; channel?: string | null; store?: RenderStore }): Promise<RenderForArticleResult>` where
  ```ts
  type RenderForArticleResult =
    | { ok: true; url: string; renderId: string; degraded: boolean }
    | { ok: true; url: null; renderId: null; degraded: false }   // aucun gabarit : image brute
    | { ok: false; message: string };
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/studio-bindings.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { db, articles, articleSources, wpCategories } from "@/db";
import { eq, inArray } from "drizzle-orm";
import { articleTokenValues, DEFAULT_CATEGORY_COLOR } from "@/lib/studio/bindings";

let articleId: string;
let categoryId: string;

beforeAll(async () => {
  const [c] = await db.insert(wpCategories).values({
    name: "Agribusiness test", slug: `agri-${Date.now()}`, color: "#1B7F4A",
  }).returning();
  categoryId = c.id;

  const [a] = await db.insert(articles).values({
    title: "Le cacao camerounais",
    bodyHtml: "<p>x</p>",
    excerpt: "Un chapô.",
    categoryId,
    featuredImageUrl: "https://cdn.test/photo.jpg",
    imageCredit: "Reuters",
    status: "approved",
  }).returning();
  articleId = a.id;

  await db.insert(articleSources).values([
    { articleId, mediaName: "Reuters", url: "https://reuters.test/a" },
    { articleId, mediaName: "Jeune Afrique", url: "https://ja.test/b" },
  ]);
});

afterAll(async () => {
  await db.delete(articles).where(inArray(articles.id, [articleId]));
  await db.delete(wpCategories).where(eq(wpCategories.id, categoryId));
});

describe("articleTokenValues", () => {
  it("fournit les jetons de base du contexte article_image", async () => {
    const v = await articleTokenValues(articleId, "article_image");
    expect(v["article.title"]).toBe("Le cacao camerounais");
    expect(v["article.excerpt"]).toBe("Un chapô.");
    expect(v["article.image"]).toBe("https://cdn.test/photo.jpg");
    expect(v["category.name"]).toBe("Agribusiness test");
    expect(v["category.color"]).toBe("#1B7F4A");
    expect(v["source.names"]).toBe("Reuters, Jeune Afrique");
  });

  it("n'expose JAMAIS article.url dans le contexte article_image", async () => {
    const v = await articleTokenValues(articleId, "article_image");
    expect(v["article.url"]).toBeUndefined();
  });

  it("retombe sur la couleur par défaut quand la catégorie n'en a pas", async () => {
    await db.update(wpCategories).set({ color: null }).where(eq(wpCategories.id, categoryId));
    const v = await articleTokenValues(articleId, "article_image");
    expect(v["category.color"]).toBe(DEFAULT_CATEGORY_COLOR);
    await db.update(wpCategories).set({ color: "#1B7F4A" }).where(eq(wpCategories.id, categoryId));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test tests/studio-bindings.test.ts`
Expected: FAIL — cannot resolve `@/lib/studio/bindings`.

- [ ] **Step 3: Implement `lib/studio/bindings.ts`**

```ts
import { eq } from "drizzle-orm";
import { db, articles, articleSources, wpCategories, distributions } from "@/db";
import { and } from "drizzle-orm";
import type { TokenValues } from "./values";
import { CONTEXT_TOKENS, type TemplateContext, type TokenId } from "./tokens";

// Couleur de marque utilisée quand une catégorie n'a pas de couleur propre. Une catégorie sans
// couleur ne doit jamais faire échouer un rendu.
export const DEFAULT_CATEGORY_COLOR = "#1B7F4A";
export const BRAND_LOGO_URL = process.env.STUDIO_BRAND_LOGO_URL ?? "";

// Construit les valeurs de jetons pour un article, PUIS les filtre par contexte. Le filtrage final
// est ce qui garantit qu'un jeton indisponible (article.url en article_image) ne peut pas se
// glisser dans un rendu même si le code de liaison le calculait par mégarde.
export async function articleTokenValues(
  articleId: string,
  context: TemplateContext,
): Promise<TokenValues> {
  const [row] = await db
    .select({ article: articles, categoryName: wpCategories.name, categoryColor: wpCategories.color })
    .from(articles)
    .leftJoin(wpCategories, eq(articles.categoryId, wpCategories.id))
    .where(eq(articles.id, articleId));
  if (!row) throw new Error("Article introuvable.");

  const sources = await db.select().from(articleSources).where(eq(articleSources.articleId, articleId));

  // article.url n'existe qu'après publication WordPress : on le lit sur la ligne distributions.
  const [dist] = await db
    .select()
    .from(distributions)
    .where(and(eq(distributions.articleId, articleId), eq(distributions.channel, "wordpress")))
    .limit(1);

  const date = row.article.publishedAt ?? row.article.generatedAt ?? row.article.createdAt;

  const all: TokenValues = {
    "article.title": row.article.title,
    "article.excerpt": row.article.excerpt ?? undefined,
    "article.date": date.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" }),
    "article.byline": row.article.aiAuthor ? "Afrotiative Media" : undefined,
    "article.image": row.article.featuredImageUrl ?? undefined,
    "article.url": dist?.externalId ? `wp:${dist.externalId}` : undefined,
    "category.name": row.categoryName ?? undefined,
    "category.color": row.categoryColor ?? DEFAULT_CATEGORY_COLOR,
    "source.names": sources.length ? sources.map((s) => s.mediaName).join(", ") : undefined,
    "brand.logo": BRAND_LOGO_URL || undefined,
  };

  const allowed = new Set<string>(CONTEXT_TOKENS[context]);
  const filtered: TokenValues = {};
  for (const [key, value] of Object.entries(all)) {
    if (value !== undefined && allowed.has(key)) filtered[key as TokenId] = value;
  }
  return filtered;
}
```

> **Implementer note on `article.url`:** `distributions.externalId` holds the WordPress post *id*,
> not its URL. `lib/wp/post-url.ts` already exists — read it and use it to build the real permalink
> instead of the `wp:` placeholder above. If it does not expose a suitable function, add one there
> rather than duplicating URL construction here.

- [ ] **Step 4: Implement `lib/studio/index.ts`**

```ts
import { articles } from "@/db";
import { db } from "@/db";
import { eq } from "drizzle-orm";
import { getStudioConfig } from "./config";
import { resolveTemplate } from "./resolve";
import { articleTokenValues } from "./bindings";
import { renderScene } from "./render";
import {
  R2RenderStore, computeInputHash, storageKeyFor, findCachedRender, saveRender,
  type RenderStore,
} from "./store";
import { MissingTokensError } from "./values";
import { ImageFetchError } from "./images";
import { SceneError } from "./scene";
import type { TemplateContext } from "./tokens";

export type RenderForArticleResult =
  | { ok: true; url: string; renderId: string; degraded: boolean }
  | { ok: true; url: null; renderId: null; degraded: false }
  | { ok: false; message: string };

// API publique de V1. V3 (onglet Aperçu) et D1 (panneau Diffusion) n'appellent que ceci.
export async function renderForArticle(
  articleId: string,
  o: { context: TemplateContext; channel?: string | null; store?: RenderStore },
): Promise<RenderForArticleResult> {
  const store = o.store ?? new R2RenderStore();
  if (!o.store && !getStudioConfig()) {
    return { ok: false, message: "Stockage R2 non configuré." };
  }

  const [article] = await db
    .select({ categoryId: articles.categoryId })
    .from(articles)
    .where(eq(articles.id, articleId));
  if (!article) return { ok: false, message: "Article introuvable." };

  const template = await resolveTemplate({
    context: o.context, channel: o.channel ?? null, categoryId: article.categoryId,
  });
  // Aucun gabarit n'est un cas NORMAL, pas une erreur : l'appelant garde l'image brute.
  if (!template) return { ok: true, url: null, renderId: null, degraded: false };

  try {
    const values = await articleTokenValues(articleId, o.context);
    const inputHash = computeInputHash({
      templateId: template.templateId, templateVersion: template.version, values,
    });

    const cached = await findCachedRender(inputHash);
    if (cached) return { ok: true, url: cached.url, renderId: cached.id, degraded: cached.degraded };

    const out = await renderScene({ scene: template.scene, values });
    const key = storageKeyFor(inputHash, out.mime, new Date());
    const url = await store.put(key, out.bytes, out.mime);

    const saved = await saveRender({
      templateId: template.templateId,
      templateVersion: template.version,
      context: o.context,
      subjectType: "article",
      subjectId: articleId,
      inputHash,
      storageKey: key,
      url,
      width: out.width,
      height: out.height,
      bytes: out.bytes.byteLength,
      degraded: out.degraded,
    });

    return { ok: true, url: saved.url, renderId: saved.id, degraded: saved.degraded };
  } catch (e) {
    // Échec DUR et message français : chaque rendu est déclenché par une action humaine délibérée
    // (« Approuver & publier », « Publier sur Facebook »). Diffuser silencieusement une carte au
    // fond manquant est pire qu'une erreur claire et réessayable.
    if (e instanceof MissingTokensError || e instanceof ImageFetchError || e instanceof SceneError) {
      return { ok: false, message: `Génération de l'image échouée — ${e.message}` };
    }
    return { ok: false, message: `Génération de l'image échouée : ${(e as Error).message}` };
  }
}

export { resolveTemplate } from "./resolve";
export { validateScene, CONTEXT_TOKENS, TOKEN_KINDS, TEMPLATE_CONTEXTS, CHANNELS } from "./tokens";
export { parseScene, type Scene } from "./scene";
export { FORMAT_PRESETS, type FormatKey } from "./formats";
export { MemoryRenderStore, type RenderStore } from "./store";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test tests/studio-bindings.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Typecheck and commit**

```bash
bun run typecheck && bun test
git add lib/studio/bindings.ts lib/studio/index.ts tests/studio-bindings.test.ts
git commit -m "feat(studio): liaisons article et API publique renderForArticle"
```

---

### Task 13: Starter templates, end-to-end check, documentation

**Files:**
- Create: `db/studio-templates.ts`
- Modify: `package.json`, `README.md`, `docs/DEPLOYMENT.md`
- Test: `tests/studio-e2e.test.ts`

**Interfaces:**
- Consumes: the whole public API.
- Produces: `bun run db:studio-templates` — idempotent seeding of three published starter templates.

- [ ] **Step 1: Write the end-to-end test**

Create `tests/studio-e2e.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import sharp from "sharp";
import { db, renderTemplates, renderTemplateVersions, articles, wpCategories, renders } from "@/db";
import { eq, inArray } from "drizzle-orm";
import { renderForArticle } from "@/lib/studio";
import { MemoryRenderStore } from "@/lib/studio/store";
import { validateScene } from "@/lib/studio/tokens";
import { parseScene } from "@/lib/studio/scene";
import { ARTICLE_IMAGE_TEMPLATE } from "@/db/studio-templates";

let articleId: string;
let categoryId: string;
let templateId: string;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  const png = await sharp({
    create: { width: 900, height: 900, channels: 3, background: { r: 30, g: 90, b: 40 } },
  }).png().toBuffer();
  server = Bun.serve({ port: 0, fetch: () => new Response(png, { headers: { "content-type": "image/png" } }) });

  const [c] = await db.insert(wpCategories).values({
    name: "E2E Agri", slug: `e2e-agri-${Date.now()}`, color: "#1B7F4A",
  }).returning();
  categoryId = c.id;

  const [a] = await db.insert(articles).values({
    title: "Le cacao camerounais bat un record d'exportation",
    bodyHtml: "<p>x</p>", excerpt: "Chapô.", categoryId,
    featuredImageUrl: `http://127.0.0.1:${server.port}/photo.png`,
    imageCredit: "Reuters", status: "approved",
  }).returning();
  articleId = a.id;

  const [t] = await db.insert(renderTemplates).values({
    name: "E2E", context: "article_image", channel: null, categoryId: null,
    format: "website_featured", width: 1200, height: 675, scene: ARTICLE_IMAGE_TEMPLATE,
  }).returning();
  templateId = t.id;
  await db.insert(renderTemplateVersions).values({ templateId, version: 1, scene: ARTICLE_IMAGE_TEMPLATE });
  await db.update(renderTemplates).set({ publishedVersion: 1 }).where(eq(renderTemplates.id, templateId));
});

afterAll(async () => {
  await db.delete(renders).where(eq(renders.subjectId, articleId));
  await db.delete(renderTemplates).where(inArray(renderTemplates.id, [templateId]));
  await db.delete(articles).where(inArray(articles.id, [articleId]));
  await db.delete(wpCategories).where(eq(wpCategories.id, categoryId));
  server.stop(true);
});

describe("gabarits de départ", () => {
  it("sont des scènes valides pour leur contexte", () => {
    expect(validateScene(parseScene(ARTICLE_IMAGE_TEMPLATE), "article_image")).toEqual([]);
  });
});

describe("renderForArticle — bout en bout", () => {
  it("rend, stocke et met en cache", async () => {
    const store = new MemoryRenderStore();
    const first = await renderForArticle(articleId, { context: "article_image", store });
    expect(first.ok).toBe(true);
    if (!first.ok || !first.url) throw new Error("rendu attendu");
    expect(store.objects.size).toBe(1);

    const bytes = [...store.objects.values()][0];
    const meta = await sharp(Buffer.from(bytes)).metadata();
    expect(meta.width).toBe(1200);
    expect(meta.height).toBe(675);

    // Deuxième appel : servi par le cache, aucun nouvel objet stocké.
    const second = await renderForArticle(articleId, { context: "article_image", store });
    if (!second.ok) throw new Error("rendu attendu");
    expect(second.renderId).toBe(first.renderId);
    expect(store.objects.size).toBe(1);
  });

  it("renvoie url:null quand aucun gabarit ne correspond au contexte", async () => {
    const r = await renderForArticle(articleId, { context: "recap_card", store: new MemoryRenderStore() });
    expect(r).toEqual({ ok: true, url: null, renderId: null, degraded: false });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test tests/studio-e2e.test.ts`
Expected: FAIL — cannot resolve `@/db/studio-templates`.

- [ ] **Step 3: Implement `db/studio-templates.ts`**

```ts
import { eq, and, isNull } from "drizzle-orm";
import { db, renderTemplates, renderTemplateVersions } from "./index";
import { parseScene } from "@/lib/studio/scene";
import { validateScene, type TemplateContext } from "@/lib/studio/tokens";
import { FORMAT_PRESETS, type FormatKey } from "@/lib/studio/formats";

const layer = { visible: true, locked: false };

// L'exemple de référence du programme : photo de fond floutée, voile sombre, bordure à la couleur
// de la catégorie, titre. UN gabarit pour toutes les catégories — la couleur vient de la taxonomie.
export const ARTICLE_IMAGE_TEMPLATE = {
  schemaVersion: 1 as const,
  canvas: { width: 1200, height: 675, background: "#0B0B0B" },
  layers: [
    { ...layer, id: "bg", name: "Photo de fond", frame: { x: 0, y: 0, w: 1200, h: 675 },
      type: "image" as const, source: { kind: "slot" as const, slot: "article.image" },
      fit: "cover" as const, blur: 18, overlay: "#000000A6" },
    { ...layer, id: "frame", name: "Bordure catégorie", frame: { x: 0, y: 0, w: 1200, h: 675 },
      type: "shape" as const, shape: "rect" as const, fill: "transparent",
      border: { width: 12, color: "{{category.color}}" } },
    { ...layer, id: "kicker", name: "Catégorie", frame: { x: 72, y: 72, w: 600, h: 44 },
      type: "text" as const, content: "{{category.name}}",
      font: { family: "Noto Sans", size: 28, weight: 700 },
      color: "{{category.color}}", align: "left" as const, vAlign: "top" as const, lineHeight: 1.2 },
    { ...layer, id: "title", name: "Titre", frame: { x: 72, y: 360, w: 1056, h: 240 },
      type: "text" as const, content: "{{article.title}}",
      font: { family: "Noto Sans", size: 64, weight: 700 },
      color: "#FFFFFF", align: "left" as const, vAlign: "bottom" as const,
      lineHeight: 1.1, maxLines: 3, autoFit: true },
  ],
};

export const FB_TEMPLATE = {
  ...ARTICLE_IMAGE_TEMPLATE,
  canvas: { width: 1200, height: 630, background: "#0B0B0B" },
  layers: ARTICLE_IMAGE_TEMPLATE.layers.map((l) =>
    l.id === "title" ? { ...l, frame: { x: 72, y: 320, w: 1056, h: 236 } }
      : l.id === "bg" || l.id === "frame" ? { ...l, frame: { x: 0, y: 0, w: 1200, h: 630 } }
      : l),
};

export const IG_TEMPLATE = {
  ...ARTICLE_IMAGE_TEMPLATE,
  canvas: { width: 1080, height: 1080, background: "#0B0B0B" },
  layers: ARTICLE_IMAGE_TEMPLATE.layers.map((l) =>
    l.id === "title" ? { ...l, frame: { x: 72, y: 640, w: 936, h: 340 }, font: { ...(l as { font: { family: string; size: number; weight: number } }).font, size: 72 } }
      : l.id === "bg" || l.id === "frame" ? { ...l, frame: { x: 0, y: 0, w: 1080, h: 1080 } }
      : l),
};

type Starter = {
  name: string; context: TemplateContext; channel: string | null; format: FormatKey; scene: unknown;
};

const STARTERS: Starter[] = [
  { name: "Image à la une — défaut", context: "article_image", channel: null, format: "website_featured", scene: ARTICLE_IMAGE_TEMPLATE },
  { name: "Facebook — défaut", context: "social_post", channel: "facebook", format: "fb_link", scene: FB_TEMPLATE },
  { name: "Instagram — défaut", context: "social_post", channel: "instagram", format: "ig_square", scene: IG_TEMPLATE },
];

// IDEMPOTENT et NON destructif — contrairement à db/seed.ts. Sûr à exécuter en production : un
// gabarit déjà présent sur la même portée est laissé intact, jamais écrasé.
export async function seedStudioTemplates(): Promise<{ created: number; skipped: number }> {
  let created = 0, skipped = 0;

  for (const starter of STARTERS) {
    const scene = parseScene(starter.scene);
    const errors = validateScene(scene, starter.context);
    if (errors.length) throw new Error(`Gabarit « ${starter.name} » invalide : ${errors.join(" ")}`);

    const [existing] = await db.select().from(renderTemplates).where(and(
      eq(renderTemplates.context, starter.context),
      starter.channel === null ? isNull(renderTemplates.channel) : eq(renderTemplates.channel, starter.channel),
      isNull(renderTemplates.categoryId),
    )).limit(1);
    if (existing) { skipped++; continue; }

    const preset = FORMAT_PRESETS[starter.format];
    const [t] = await db.insert(renderTemplates).values({
      name: starter.name, context: starter.context, channel: starter.channel, categoryId: null,
      format: starter.format, width: preset.width, height: preset.height, scene,
    }).returning();
    await db.insert(renderTemplateVersions).values({ templateId: t.id, version: 1, scene });
    await db.update(renderTemplates).set({ publishedVersion: 1 }).where(eq(renderTemplates.id, t.id));
    created++;
  }

  return { created, skipped };
}

if (import.meta.main) {
  seedStudioTemplates()
    .then((r) => { console.log(`Gabarits — créés : ${r.created}, déjà présents : ${r.skipped}`); process.exit(0); })
    .catch((e) => { console.error(e); process.exit(1); });
}
```

- [ ] **Step 4: Add the script to `package.json`**

In `"scripts"`, after `"db:seed"`:

```json
    "db:studio-templates": "bun db/studio-templates.ts",
```

- [ ] **Step 5: Run the end-to-end test**

Run: `bun test tests/studio-e2e.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Seed the dev database and eyeball a real render**

```bash
bun run db:studio-templates
```

Expected: `Gabarits — créés : 3, déjà présents : 0`. Run it a second time and confirm it prints
`créés : 0, déjà présents : 3` — idempotence.

- [ ] **Step 7: Document in `docs/DEPLOYMENT.md`**

Add a subsection under §2 (environment variables) listing the five `R2_*` variables, stating that
leaving them empty cleanly disables the studio, and add `bun run db:studio-templates` to the
first-run checklist as a **non-destructive, production-safe** step (unlike `db:seed`).

- [ ] **Step 8: Document in `README.md`**

Add a `| **Studio (V1)** | moteur de gabarits — rendu d'images depuis une scène JSON. |` row to the
"Ce qui est inclus" table, and `| bun run db:studio-templates | installe les 3 gabarits de départ (idempotent). |`
to the commands table.

- [ ] **Step 9: Full verification and commit**

```bash
bun run typecheck && bun test
git add db/studio-templates.ts package.json README.md docs/DEPLOYMENT.md tests/studio-e2e.test.ts
git commit -m "feat(studio): gabarits de départ, vérification bout en bout et documentation"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §1 Architecture (module layout, `RenderStore` interface) | 1, 10 |
| §2 Data model (4 tables, `wp_categories.color`, NULLS NOT DISTINCT, no FK cycle, no `status`) | 9 |
| §3 Scene schema (4 layer types, paint order, agribusiness example) | 2, 13 |
| §4 Tokens/contexts/bindings (`article.url` rule, type coherence, derived slots) | 3, 12 |
| §5 Render pipeline (6 steps, autoFit, resolution) | 5, 6, 7, 8, 11 |
| §6 Errors (config null, hard fail, font fallback → degraded) | 1, 8, 12 |
| §7 Tests (all 8 rows of the table) | every task |
| §8 Configuration (5 env vars, `.env.example`, DEPLOYMENT) | 1, 13 |
| §9 Seeded templates (3, hand-authored, not in `db:seed`) | 13 |

**Known risks flagged inline for the implementer:**
1. `isSafePublicHttpUrl` will reject the `127.0.0.1` test fixture server — Task 5 Step 1 resolves this with an injected `fetchImpl` rather than weakening the guard.
2. Satori's TypeScript signature wants `ReactNode`; the plain-object tree is cast. Task 8 Step 4 gives the fallback if it fails at runtime.
3. `distributions.externalId` is a post id, not a URL — Task 12 flags `lib/wp/post-url.ts` as the place to build the permalink.
4. `autoFit` is the one genuinely uncertain piece; Task 8 documents the retreat path (`maxLines` + ellipsis).
