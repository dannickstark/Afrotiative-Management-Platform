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

  // Une image à contour net (moitié noire, moitié blanche) : sert à prouver que le flou lisse
  // réellement des pixels, ce qu'une image de couleur unie ne peut pas démontrer.
  const edge = await sharp({
    create: { width: 400, height: 400, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .composite([
      {
        input: await sharp({
          create: { width: 200, height: 400, channels: 3, background: { r: 0, g: 0, b: 0 } },
        }).png().toBuffer(),
        left: 0,
        top: 0,
      },
    ])
    .png()
    .toBuffer();

  server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/ok.png") return new Response(png, { headers: { "content-type": "image/png" } });
      if (path === "/edge.png") return new Response(edge, { headers: { "content-type": "image/png" } });
      // Réponse 200 mais pas une image du tout — reproduit le cas d'une page d'erreur HTML servie
      // par un serveur/CDN mal configuré à la place de l'image attendue.
      if (path === "/not-an-image.html") {
        return new Response("<html><body>pas une image</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      return new Response("nope", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => server.stop(true));

describe("prepareImage", () => {
  // La garde SSRF partagée (lib/url-guard.ts) refuse 127.0.0.1 — c'est précisément son rôle.
  // Le serveur fixture ci-dessus tourne en local : ces tests injectent donc fetchImpl pour
  // contourner UNIQUEMENT ici le garde, sans jamais toucher lib/url-guard.ts. Le test de garde
  // plus bas, lui, n'injecte pas fetchImpl : il exerce le vrai garde.
  it("recadre en cover aux dimensions exactes du calque", async () => {
    const uri = await prepareImage({ url: `${base}/ok.png`, width: 1200, height: 675, fit: "cover", fetchImpl: fetch });
    expect(uri.startsWith("data:image/png;base64,")).toBe(true);
    const meta = await sharp(Buffer.from(uri.split(",")[1], "base64")).metadata();
    expect(meta.width).toBe(1200);
    expect(meta.height).toBe(675);
  });

  it("applique le flou sans changer les dimensions", async () => {
    const uri = await prepareImage({ url: `${base}/ok.png`, width: 600, height: 600, fit: "cover", blur: 24, fetchImpl: fetch });
    const meta = await sharp(Buffer.from(uri.split(",")[1], "base64")).metadata();
    expect(meta.width).toBe(600);
    expect(meta.height).toBe(600);
  });

  it("le flou lisse réellement les hautes fréquences (écart-type réduit sur un contour net)", async () => {
    // Sur l'image rouge unie du fixture ci-dessus, un flou ne changerait quasiment rien de
    // mesurable (couleur déjà uniforme) — ça ne prouverait pas que le flou a eu un effet. On sert
    // ici une image à fort contraste (moitié noire, moitié blanche) : un flou gaussien doit
    // adoucir la transition et donc réduire l'écart-type des valeurs de pixels.
    const net = await prepareImage({ url: `${base}/edge.png`, width: 200, height: 200, fit: "cover", fetchImpl: fetch });
    const flou = await prepareImage({ url: `${base}/edge.png`, width: 200, height: 200, fit: "cover", blur: 60, fetchImpl: fetch });
    const stdevOf = async (uri: string) =>
      (await sharp(Buffer.from(uri.split(",")[1], "base64")).stats()).channels[0].stdev;
    expect(await stdevOf(flou)).toBeLessThan(await stdevOf(net));
  });

  it("assombrit l'image selon l'opacité EXACTE de la teinte, pas juste « plus sombre »", async () => {
    // Une simple comparaison "plus sombre" ne distinguerait pas un mélange alpha correct d'un bug
    // qui composite la teinte à pleine opacité (l'image deviendrait alors entièrement noire — mean
    // ≈ 0 — ce qui est aussi "plus sombre" que l'original et passerait donc un test trop faible).
    // On compare ici au résultat attendu ANALYTIQUEMENT pour un mélange alpha standard :
    // résultat = base * (1 - alpha) + teinte * alpha, avec teinte noire (0) et alpha = 0xCC/255.
    const plain = await prepareImage({ url: `${base}/ok.png`, width: 100, height: 100, fit: "cover", fetchImpl: fetch });
    const tinted = await prepareImage({ url: `${base}/ok.png`, width: 100, height: 100, fit: "cover", overlay: "#000000CC", fetchImpl: fetch });
    const meanOf = async (uri: string) =>
      (await sharp(Buffer.from(uri.split(",")[1], "base64")).stats()).channels[0].mean;
    const plainMean = await meanOf(plain);
    const tintedMean = await meanOf(tinted);
    const alpha = 0xcc / 255; // ≈ 0.8 — clairement ni 0 ni 1, pour que le calcul pèse vraiment
    const expected = plainMean * (1 - alpha);
    // Tolérance de quelques unités pour l'arrondi PNG/8-bit (mesuré : ~39 pour un attendu de 40).
    expect(tintedMean).toBeGreaterThan(expected - 5);
    expect(tintedMean).toBeLessThan(expected + 5);
  });

  it("refuse une URL non publique (garde SSRF partagé)", async () => {
    await expect(prepareImage({ url: "http://169.254.169.254/latest/meta-data/", width: 10, height: 10, fit: "cover" }))
      .rejects.toBeInstanceOf(ImageFetchError);
  });

  it("échoue clairement sur une 404", async () => {
    await expect(prepareImage({ url: `${base}/missing.png`, width: 10, height: 10, fit: "cover", fetchImpl: fetch }))
      .rejects.toBeInstanceOf(ImageFetchError);
  });

  it("échoue proprement (ImageFetchError, français) quand la réponse 200 n'est pas une image exploitable", async () => {
    // Un serveur/CDN mal configuré peut répondre 200 avec une page d'erreur HTML à la place de
    // l'image — sharp échoue alors au décodage. Sans filet, cette erreur sharp brute (anglaise,
    // pas une ImageFetchError) s'échapperait telle quelle vers l'appelant.
    try {
      await prepareImage({ url: `${base}/not-an-image.html`, width: 10, height: 10, fit: "cover", fetchImpl: fetch });
      throw new Error("prepareImage aurait dû rejeter");
    } catch (e) {
      expect(e).toBeInstanceOf(ImageFetchError);
      expect((e as Error).message).toContain("n'est pas une image exploitable");
      // Message autonome en français : ne doit pas contenir le texte brut de l'erreur sharp sous-
      // jacente (typiquement en anglais, ex. "unsupported image format").
      expect((e as Error).message.toLowerCase()).not.toContain("unsupported");
      // Important 3 (revue de branche) : le message affiché reste français et sans détail natif,
      // mais l'erreur sharp d'origine doit rester accessible via `.cause` — c'est la SEULE trace qui
      // survit en production, un `console.error` ne pouvant pas être vérifié depuis un test.
      expect((e as Error).cause).toBeDefined();
    }
  });

  it("le contournement du garde via fetchImpl ne s'applique qu'en environnement de test", async () => {
    // fetchImpl seul ne suffit pas à lever la garde SSRF : il faut aussi NODE_ENV === "test". On
    // force ici une valeur différente pour simuler un appel de production, et on vérifie que la
    // garde reste active même avec fetchImpl fourni et une URL de boucle locale.
    // (Le typage global de Next.js déclare NODE_ENV en lecture seule ; process.env reste un objet
    // mutable à l'exécution, on passe donc par un alias non « readonly » pour la réassignation.)
    const env = process.env as { NODE_ENV?: string };
    const original = env.NODE_ENV;
    env.NODE_ENV = "production";
    try {
      await expect(
        prepareImage({ url: `${base}/ok.png`, width: 10, height: 10, fit: "cover", fetchImpl: fetch }),
      ).rejects.toBeInstanceOf(ImageFetchError);
    } finally {
      env.NODE_ENV = original;
    }
  });
});
