import DOMPurify from "isomorphic-dompurify";
import { JSDOM } from "jsdom";

// Server-side sanitizer for HUMAN-AUTHORED article bodies (the TipTap editor's saved bodyHtml —
// see saveDraft() in lib/actions/article-actions.ts). Deliberately narrower than
// lib/extract/readability.ts's DOMPurify.sanitize() call, which cleans raw scraped HTML with
// DOMPurify's full default allow-list (images, spans, etc.) — this allow-list only needs the tags
// the article editor can actually produce, so anything else (script/style/iframe/img/on*/data
// attrs) is dropped outright rather than merely defanged.
const ALLOWED_TAGS = ["p", "h2", "h3", "h4", "ul", "ol", "li", "a", "strong", "em", "blockquote", "br"];
// `rel` is intentionally excluded here — DOMPurify would otherwise pass through whatever rel the
// editor's HTML happened to contain, and we want a single enforced value (see below), never an
// author-controlled one that could drop noopener/noreferrer and enable tab-nabbing.
const ALLOWED_ATTR = ["href", "target"];

/**
 * Sanitizes an editorial article body to the allow-list above. `javascript:`/`data:` hrefs and
 * any attribute/tag not on the allow-list (script, style, iframe, img, onclick, …) are stripped by
 * DOMPurify's default URI scheme + attribute filtering. Every surviving `<a>` gets
 * `rel="noopener noreferrer"` forced on — via a scoped JSDOM pass on the sanitized output rather
 * than a global DOMPurify.addHook(), which would mutate the shared isomorphic-dompurify singleton
 * also used by lib/extract/readability.ts.
 *
 * NOTE: applied on BOTH write paths — the human-edit save (saveDraft, below) and the pipeline's
 * AI-generated bodyHtml (lib/pipeline/stages.ts + lib/pipeline/regenerate.ts sanitize at write
 * time).
 */
export function sanitizeArticleHtml(html: string): string {
  // ALLOW_DATA_ATTR defaults to true in DOMPurify — it lets data-* attributes through regardless
  // of ALLOWED_ATTR, so it must be turned off explicitly to keep this allow-list closed.
  const clean = DOMPurify.sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR, ALLOW_DATA_ATTR: false });
  const dom = new JSDOM(`<body>${clean}</body>`);
  try {
    dom.window.document.querySelectorAll("a").forEach((a) => {
      a.setAttribute("rel", "noopener noreferrer");
    });
    return dom.window.document.body.innerHTML;
  } finally {
    dom.window.close();
  }
}
