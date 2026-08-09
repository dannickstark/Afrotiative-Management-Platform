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

  it("assombrit l'image quand une teinte est fournie", async () => {
    const plain = await prepareImage({ url: `${base}/ok.png`, width: 100, height: 100, fit: "cover", fetchImpl: fetch });
    const tinted = await prepareImage({ url: `${base}/ok.png`, width: 100, height: 100, fit: "cover", overlay: "#000000CC", fetchImpl: fetch });
    const meanOf = async (uri: string) =>
      (await sharp(Buffer.from(uri.split(",")[1], "base64")).stats()).channels[0].mean;
    expect(await meanOf(tinted)).toBeLessThan(await meanOf(plain));
  });

  it("refuse une URL non publique (garde SSRF partagé)", async () => {
    await expect(prepareImage({ url: "http://169.254.169.254/latest/meta-data/", width: 10, height: 10, fit: "cover" }))
      .rejects.toBeInstanceOf(ImageFetchError);
  });

  it("échoue clairement sur une 404", async () => {
    await expect(prepareImage({ url: `${base}/missing.png`, width: 10, height: 10, fit: "cover", fetchImpl: fetch }))
      .rejects.toBeInstanceOf(ImageFetchError);
  });
});
