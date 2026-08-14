/**
 * Estimate the plain-text length of an HTML string.
 *
 * Rule: replace each tag with a single space, collapse all whitespace runs
 * to one space, trim, then return the resulting string's length.
 */
export function plainTextLen(html: string): number {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim().length;
}
