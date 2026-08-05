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
});
