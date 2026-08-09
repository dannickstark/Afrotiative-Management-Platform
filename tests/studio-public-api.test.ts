import { describe, it, expect } from "bun:test";
import {
  renderScene, RenderError, MissingTokensError, ImageFetchError, SceneError,
  sceneSchema, parseScene, extractTokens, TOKEN_IDS, FORMAT_KEYS,
  CONTEXT_TOKENS, TOKEN_KINDS, TEMPLATE_CONTEXTS, CHANNELS, validateScene,
  MemoryRenderStore, resolveTemplate,
  type Scene, type Layer, type ImageLayer, type TextLayer, type ShapeLayer, type QrLayer,
  type Frame, type Gradient, type ImageSource,
  type TokenId, type TemplateContext, type Channel,
  type AssetLoader, type LoadedFont, type RenderStore, type FormatKey,
} from "@/lib/studio";

// Important 6 (revue de branche) : la surface publique de lib/studio/index.ts est le contrat que V2
// (éditeur visuel), V3 (aperçu article) et D1 (diffusion multicanale) consomment. Ce fichier ne
// teste AUCUNE logique métier (déjà couverte ailleurs) — il verrouille juste que ces exports
// EXISTENT et ont la forme attendue, pour qu'une régression future (un export retiré ou renommé par
// mégarde) casse `bun test`/`bun run typecheck` ici plutôt que silencieusement dans un sous-projet
// consommateur qui n'existe pas encore. Réseau et DB non requis.
describe("lib/studio — surface publique", () => {
  it("expose renderScene et les erreurs typées comme des valeurs appelables/instanciables", () => {
    expect(typeof renderScene).toBe("function");
    expect(typeof resolveTemplate).toBe("function");
    expect(typeof validateScene).toBe("function");
    expect(typeof extractTokens).toBe("function");
    expect(typeof parseScene).toBe("function");

    expect(new RenderError("x")).toBeInstanceOf(Error);
    expect(new MissingTokensError(["a.b"])).toBeInstanceOf(Error);
    expect(new ImageFetchError("x")).toBeInstanceOf(Error);
    expect(new SceneError("x")).toBeInstanceOf(Error);
  });

  it("expose sceneSchema (zod) utilisable directement", () => {
    expect(typeof sceneSchema.safeParse).toBe("function");
    const result = sceneSchema.safeParse({
      schemaVersion: 1, canvas: { width: 10, height: 10, background: "#000000" }, layers: [],
    });
    expect(result.success).toBe(true);
  });

  it("expose les catalogues de jetons et de formats attendus par un sélecteur V2", () => {
    expect(TOKEN_IDS).toContain("article.title");
    expect(TOKEN_IDS).toContain("brand.logo");
    expect(FORMAT_KEYS).toContain("website_featured");
    expect(TEMPLATE_CONTEXTS).toContain("article_image");
    expect(CHANNELS).toContain("facebook");
    expect(CONTEXT_TOKENS.quote_card).toContain("quote.text");
    expect(TOKEN_KINDS["article.image"]).toBe("image");
  });

  it("MemoryRenderStore reste exporté (utilisé par les tests des sous-projets consommateurs)", () => {
    const store = new MemoryRenderStore();
    expect(store.objects).toBeInstanceOf(Map);
  });

  // Les alias de type ci-dessous n'ont pas de trace à l'exécution (effacés à la compilation) : leur
  // seule vérification possible est que ce fichier COMPILE — c'est `bun run typecheck` qui les
  // couvre, pas une assertion `expect`. Cette fonction jamais appelée force le compilateur à
  // résoudre chacun d'eux depuis "@/lib/studio" plutôt que depuis leur module d'origine.
  function _typeSurface(
    scene: Scene, layer: Layer, image: ImageLayer, text: TextLayer, shape: ShapeLayer, qr: QrLayer,
    frame: Frame, gradient: Gradient, source: ImageSource,
    tokenId: TokenId, context: TemplateContext, channel: Channel,
    assets: AssetLoader, font: LoadedFont, store: RenderStore, format: FormatKey,
  ): void {
    void scene; void layer; void image; void text; void shape; void qr; void frame; void gradient;
    void source; void tokenId; void context; void channel; void assets; void font; void store;
    void format;
  }
  void _typeSurface;

  it("(placeholder) — la vérification des types ci-dessus est faite par bun run typecheck", () => {
    expect(true).toBe(true);
  });
});
