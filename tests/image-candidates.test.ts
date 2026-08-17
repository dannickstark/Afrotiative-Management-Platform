import { describe, it, expect } from "bun:test";
import { filterImageCandidates } from "@/lib/pipeline/image-candidates";
import type { ImageCandidate } from "@/db";

// Fabrique un candidat minimal — la provenance (sourceUrl/mediaName) n'est jamais le sujet du
// test, seule url compte pour les règles de filtrage.
function c(url: string, sourceUrl = "https://source.test/article", mediaName = "Source Test"): ImageCandidate {
  return { url, sourceUrl, mediaName };
}

describe("filterImageCandidates", () => {
  it("écarte les URIs data:, et les extensions non photographiques (.svg, .ico, .gif)", () => {
    const out = filterImageCandidates([
      c("https://x.test/photo.jpg"),
      c("data:image/png;base64,AAAA"),
      c("https://x.test/logo-brand.svg"),
      c("https://x.test/favicon.ico"),
      c("https://x.test/animation.gif"),
    ]);
    expect(out.map((i) => i.url)).toEqual(["https://x.test/photo.jpg"]);
  });

  it("écarte le chrome évident (logo, favicon, avatar, sprite, bannière, pixel de suivi, réseaux sociaux…) par segment de chemin", () => {
    const out = filterImageCandidates([
      c("https://x.test/photo-legitime.jpg"),
      c("https://x.test/assets/logo/main.png"),
      c("https://x.test/img/favicon-32.png"),
      c("https://x.test/users/avatar-123.jpg"),
      c("https://x.test/css/sprite-icons.png"),
      c("https://x.test/banners/top-banniere.jpg"),
      c("https://x.test/track/pixel.png"),
      c("https://x.test/img/spacer.gif".replace(".gif", ".png")),
      c("https://x.test/img/blank.png"),
      c("https://x.test/img/placeholder-default.png"),
      c("https://x.test/emoji/smile.png"),
    ]);
    expect(out.map((i) => i.url)).toEqual(["https://x.test/photo-legitime.jpg"]);
  });

  it("ne filtre PLUS 'share' et 'social' — vocabulaire éditorial courant sur une publication économique/financière (safaricom-share-price, rse-social-corporate)", () => {
    const out = filterImageCandidates([
      c("https://x.test/wp-content/uploads/2024/05/safaricom-share-price.jpg"),
      c("https://x.test/wp-content/uploads/2024/05/rse-social-corporate.jpg"),
    ]);
    expect(out.map((i) => i.url)).toEqual([
      "https://x.test/wp-content/uploads/2024/05/safaricom-share-price.jpg",
      "https://x.test/wp-content/uploads/2024/05/rse-social-corporate.jpg",
    ]);
  });

  it("borne le mot de chrome sur `_` ET sur les chiffres (site_logo_2024.png et logo2.png sont écartés — `\\b` seul échouait sur les deux)", () => {
    const out = filterImageCandidates([
      c("https://x.test/photo-legitime.jpg"),
      c("https://x.test/assets/site_logo_2024.png"),
      c("https://x.test/assets/logo2.png"),
      c("https://x.test/assets/banner3.png"),
    ]);
    // Seule la photo survit : un suffixe numérique est une numérotation de fichier, pas un mot
    // différent — `logo2` reste du chrome.
    expect(out.map((i) => i.url)).toEqual(["https://x.test/photo-legitime.jpg"]);
  });

  it("ne se laisse pas piéger par des segments légitimes contenant 'icon' ou 'social' en sous-chaîne (ex: iconic, socialite)", () => {
    const out = filterImageCandidates([
      c("https://ecofin.test/wp-content/uploads/2024/05/reportage-iconic-tower.jpg"),
      c("https://revue.test/img/socialite-du-mois.jpg"),
    ]);
    expect(out.map((i) => i.url)).toEqual([
      "https://ecofin.test/wp-content/uploads/2024/05/reportage-iconic-tower.jpg",
      "https://revue.test/img/socialite-du-mois.jpg",
    ]);
  });

  it("écarte les images déclarées minuscules — suffixe -WxH avec les deux dimensions ≤ 200, ou ?w=/?width= ≤ 200", () => {
    const out = filterImageCandidates([
      c("https://x.test/photo-1024x576.jpg"),
      c("https://x.test/thumb-150x150.jpg"),
      c("https://x.test/thumb-200x150.jpg"),
      c("https://x.test/thumb-320x150.jpg"), // une dimension > 200 → pas minuscule
      c("https://x.test/thumb.jpg?w=100"),
      c("https://x.test/photo2.jpg?width=800"),
    ]);
    const urls = out.map((i) => i.url);
    expect(urls).not.toContain("https://x.test/thumb-150x150.jpg");
    expect(urls).not.toContain("https://x.test/thumb-200x150.jpg");
    expect(urls).not.toContain("https://x.test/thumb.jpg?w=100");
    expect(urls).toContain("https://x.test/thumb-320x150.jpg");
    expect(urls).toContain("https://x.test/photo2.jpg?width=800");
  });

  it("regroupe les variantes de redimensionnement (-WxH) sous une même base et garde l'ORIGINAL nu (convention WordPress : le nu est l'upload d'origine, souvent plus grand que tout resize déclaré)", () => {
    const out = filterImageCandidates([
      c("https://www.ecofin.com/wp-content/uploads/2024/05/safaricom-cloudflare-150x150.jpg"),
      c("https://www.ecofin.com/wp-content/uploads/2024/05/safaricom-cloudflare-768x432.jpg"),
      c("https://www.ecofin.com/wp-content/uploads/2024/05/safaricom-cloudflare-1024x576.jpg"),
      c("https://www.ecofin.com/wp-content/uploads/2024/05/safaricom-cloudflare.jpg"),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].url).toBe("https://www.ecofin.com/wp-content/uploads/2024/05/safaricom-cloudflare.jpg");
  });

  it("sans URL nue dans le groupe, garde la plus grande variante dimensionnée (repli inchangé)", () => {
    const out = filterImageCandidates([
      c("https://www.ecofin.com/wp-content/uploads/2024/05/safaricom-cloudflare-150x150.jpg"),
      c("https://www.ecofin.com/wp-content/uploads/2024/05/safaricom-cloudflare-768x432.jpg"),
      c("https://www.ecofin.com/wp-content/uploads/2024/05/safaricom-cloudflare-1024x576.jpg"),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].url).toBe("https://www.ecofin.com/wp-content/uploads/2024/05/safaricom-cloudflare-1024x576.jpg");
  });

  it("sans aucune variante dimensionnée dans le groupe, garde celle sans suffixe", () => {
    const out = filterImageCandidates([
      c("https://x.test/reportage-thumb.jpg"), // pas de suffixe -WxH → pas de collapse possible ici
      c("https://x.test/reportage.jpg"),
    ]);
    // Les deux bases diffèrent (thumb vs rien), donc pas de regroupement : les deux survivent.
    expect(out.map((i) => i.url)).toEqual([
      "https://x.test/reportage-thumb.jpg",
      "https://x.test/reportage.jpg",
    ]);
  });

  it("préserve la provenance de l'entrée conservée lors du regroupement", () => {
    const out = filterImageCandidates([
      c("https://x.test/p-150x150.jpg", "https://source-a.test", "Media A"),
      c("https://x.test/p-1024x576.jpg", "https://source-b.test", "Media B"),
    ]);
    expect(out).toEqual([{ url: "https://x.test/p-1024x576.jpg", sourceUrl: "https://source-b.test", mediaName: "Media B" }]);
  });

  it("plafonne à max (défaut 12) en préservant l'ordre", () => {
    const many = Array.from({ length: 20 }, (_, i) => c(`https://x.test/photo-${i}.jpg`));
    const out = filterImageCandidates(many);
    expect(out).toHaveLength(12);
    expect(out.map((i) => i.url)).toEqual(many.slice(0, 12).map((i) => i.url));
  });

  it("respecte un max personnalisé", () => {
    const many = Array.from({ length: 5 }, (_, i) => c(`https://x.test/photo-${i}.jpg`));
    const out = filterImageCandidates(many, 3);
    expect(out).toHaveLength(3);
  });

  it("règle de sécurité : si le filtrage viderait une liste non vide, renvoie la liste ORIGINALE plafonnée plutôt que rien", () => {
    const onlyChrome = [c("https://x.test/logo.svg"), c("https://x.test/favicon.ico")];
    const out = filterImageCandidates(onlyChrome);
    // Le filtrage aurait tout éliminé (svg + ico) : on retombe sur la liste d'origine plafonnée,
    // jamais sur une liste vide qui ferait avorter planRegeneration.
    expect(out).toEqual(onlyChrome);
  });

  it("liste vide en entrée reste vide en sortie (la règle de sécurité ne s'applique qu'au non-vide)", () => {
    expect(filterImageCandidates([])).toEqual([]);
  });
});
