import { describe, it, expect } from "bun:test";
import { sanitizeArticleHtml } from "@/lib/sanitize";

// Pure function, no DB — SP4 Task 2.
describe("sanitizeArticleHtml", () => {
  it("strips <script> tags entirely (tag + content)", () => {
    const out = sanitizeArticleHtml("<p>Bonjour</p><script>alert('xss')</script>");
    expect(out).not.toContain("<script");
    expect(out).not.toContain("alert(");
    expect(out).toContain("Bonjour");
  });

  it("strips onclick= and other on* event-handler attributes", () => {
    const out = sanitizeArticleHtml('<p onclick="alert(1)">Texte</p>');
    expect(out).not.toContain("onclick");
    expect(out).toContain("Texte");
  });

  it("drops javascript: hrefs", () => {
    const out = sanitizeArticleHtml('<a href="javascript:alert(1)">Lien</a>');
    expect(out).not.toContain("javascript:");
  });

  it("drops data:, vbscript:, and obfuscated (mixed-case / whitespace) javascript: hrefs", () => {
    const dataOut = sanitizeArticleHtml('<a href="data:text/html,<script>alert(1)</script>">Lien</a>');
    expect(dataOut.toLowerCase()).not.toContain("data:");

    const vbOut = sanitizeArticleHtml('<a href="vbscript:msgbox(1)">Lien</a>');
    expect(vbOut.toLowerCase()).not.toContain("vbscript:");

    const mixedCaseOut = sanitizeArticleHtml('<a href="JaVaScRiPt:alert(1)">Lien</a>');
    expect(mixedCaseOut.toLowerCase()).not.toContain("javascript:");
    expect(mixedCaseOut.toLowerCase()).not.toContain("javascript");

    const whitespaceOut = sanitizeArticleHtml('<a href="java\tscript:alert(1)">Lien</a>');
    // Neither the (whitespace-split) scheme nor a href pointing at it survives.
    expect(whitespaceOut).not.toContain("alert(");
  });

  it("strips a bare style=\"...\" attribute (not just the <style> tag)", () => {
    const out = sanitizeArticleHtml('<p style="position:absolute;left:-9999px">Texte</p>');
    expect(out).not.toContain("style=");
    expect(out).not.toContain("position:absolute");
    expect(out).toContain("Texte");
  });

  it("preserves target=\"_blank\" AND forces rel=\"noopener noreferrer\" on it", () => {
    const out = sanitizeArticleHtml('<a href="https://example.com" target="_blank">Lien</a>');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain('href="https://example.com"');
  });

  it("preserves h2/h3 subheadings", () => {
    const out = sanitizeArticleHtml("<h2>Contexte</h2><h3>Détails</h3><p>Corps</p>");
    expect(out).toContain("<h2>Contexte</h2>");
    expect(out).toContain("<h3>Détails</h3>");
  });

  it("preserves ul/ol/li lists", () => {
    const out = sanitizeArticleHtml("<ul><li>Un</li><li>Deux</li></ul><ol><li>Trois</li></ol>");
    expect(out).toContain("<ul>");
    expect(out).toContain("<li>Un</li>");
    expect(out).toContain("<ol>");
    expect(out).toContain("<li>Trois</li>");
  });

  it("preserves a references list (<ul><li><a href>) and forces rel on its links", () => {
    const out = sanitizeArticleHtml(
      '<ul><li><a href="https://example.com/source">Le Monde</a></li></ul>'
    );
    expect(out).toContain("<ul>");
    expect(out).toContain('href="https://example.com/source"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain(">Le Monde</a>");
  });

  it("forces rel=\"noopener noreferrer\" on links regardless of author-supplied rel", () => {
    const out = sanitizeArticleHtml('<a href="https://example.com" rel="opener">Lien</a>');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).not.toContain('rel="opener"');
  });

  it("strips disallowed tags (style, iframe, img) while keeping their safe text content where applicable", () => {
    const out = sanitizeArticleHtml(
      '<style>body{color:red}</style><iframe src="https://evil.example"></iframe><img src="x.png" onerror="alert(1)">'
    );
    expect(out).not.toContain("<style");
    expect(out).not.toContain("<iframe");
    expect(out).not.toContain("<img");
    expect(out).not.toContain("onerror");
  });

  it("keeps strong/em/blockquote/br and drops disallowed attributes like data-*", () => {
    const out = sanitizeArticleHtml(
      '<p data-evil="x"><strong>Fort</strong> <em>italique</em></p><blockquote>Citation</blockquote><br>'
    );
    expect(out).not.toContain("data-evil");
    expect(out).toContain("<strong>Fort</strong>");
    expect(out).toContain("<em>italique</em>");
    expect(out).toContain("<blockquote>Citation</blockquote>");
  });

  it("garde un <mark class=hl-jaune> valide", () => {
    const out = sanitizeArticleHtml('<p><mark class="hl-jaune">climat</mark></p>');
    expect(out).toContain('<mark class="hl-jaune">climat</mark>');
  });
  it("dénoue un <mark> sans classe valide", () => {
    const out = sanitizeArticleHtml("<p><mark>x</mark></p>");
    expect(out).not.toContain("<mark");
    expect(out).toContain("x");
  });
  it("classe invalide sur <mark> → dénoué, rien de l'injection ne survit", () => {
    const out = sanitizeArticleHtml('<p><mark class="hl-x evilclass">x</mark></p>');
    expect(out).not.toContain("<mark");
    expect(out).not.toContain("evilclass");
  });
  it("class retirée sur un élément non-mark", () => {
    expect(sanitizeArticleHtml('<p class="evilclass">x</p>')).toBe("<p>x</p>");
  });
  it("style sur mark supprimé ; span non autorisé", () => {
    expect(sanitizeArticleHtml('<p><mark style="background:red">x</mark></p>')).not.toContain("style");
    expect(sanitizeArticleHtml('<p><span class="hl-jaune">x</span></p>')).not.toContain("hl-jaune");
  });
});
