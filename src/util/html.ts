/**
 * Small dependency-free HTML -> plain text / markdown-ish converter for work item
 * rich-text fields (Description, Repro Steps, Acceptance Criteria) and comments.
 * It is intentionally approximate: good enough for an LLM to read.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  laquo: "«",
  raquo: "»",
  copy: "©",
  reg: "®",
  trade: "™",
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, ent: string) => {
    if (ent[0] === "#") {
      const code =
        ent[1]?.toLowerCase() === "x" ? Number.parseInt(ent.slice(2), 16) : Number.parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[ent.toLowerCase()] ?? match;
  });
}

export function isProbablyHtml(value: string): boolean {
  return /<\/?[a-z][\s\S]*>/i.test(value);
}

/**
 * Convert HTML to readable plain text (light markdown: headings, lists, links, code).
 */
export function htmlToText(html: string | undefined | null): string {
  if (!html) return "";
  if (!isProbablyHtml(html)) return decodeEntities(html).trim();

  let s = html;
  // drop non-content
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<(script|style|head)[^>]*>[\s\S]*?<\/\1>/gi, "");

  // code blocks: extract verbatim so later whitespace normalisation leaves indentation intact
  const codeBlocks: string[] = [];
  s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_m, inner: string) => {
    const code = decodeEntities(inner.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")).replace(/\n$/, "");
    codeBlocks.push("```\n" + code + "\n```");
    return `\n\u0000${codeBlocks.length - 1}\u0000\n`;
  });
  s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_m, inner: string) => "`" + inner.replace(/<[^>]+>/g, "") + "`");

  // links & images
  s = s.replace(/<a\b[^>]*href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, text: string) => {
    const label = text.replace(/<[^>]+>/g, "").trim();
    if (!label || label === href) return href;
    return `[${label}](${href})`;
  });
  s = s.replace(/<img\b[^>]*alt\s*=\s*["']([^"']*)["'][^>]*>/gi, (_m, alt: string) => (alt ? `[image: ${alt}]` : "[image]"));
  s = s.replace(/<img\b[^>]*>/gi, "[image]");

  // headings
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level: string, inner: string) => {
    return "\n" + "#".repeat(Number(level)) + " " + inner.replace(/<[^>]+>/g, "").trim() + "\n";
  });

  // emphasis
  s = s.replace(/<(b|strong)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t: string, inner: string) => `**${inner}**`);
  s = s.replace(/<(i|em)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t: string, inner: string) => `_${inner}_`);

  // lists
  s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner: string) => "\n- " + inner.trim());
  s = s.replace(/<\/?(ul|ol)[^>]*>/gi, "\n");

  // tables: cells separated by " | ", rows by newlines
  s = s.replace(/<\/t[dh]>\s*<t[dh][^>]*>/gi, " | ");
  s = s.replace(/<\/tr>/gi, "\n");
  s = s.replace(/<t[dh][^>]*>/gi, "");

  // block boundaries
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|blockquote|section|article|table|tr|h[1-6])>/gi, "\n");
  s = s.replace(/<(p|div|blockquote|section|article|table)\b[^>]*>/gi, "\n");

  // remaining tags
  s = s.replace(/<[^>]+>/g, "");

  s = decodeEntities(s);
  // collapse whitespace
  s = s.replace(/\r\n?/g, "\n");
  s = s.replace(/[ \t\u00a0]+\n/g, "\n");
  s = s.replace(/\n[ \t]+/g, "\n");
  s = s.replace(/[ \t]{2,}/g, " ");
  s = s.replace(/\n{3,}/g, "\n\n");
  s = s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codeBlocks[Number(i)] ?? "");
  return s.trim();
}

/** Convert plain text (with newlines) into simple HTML suitable for TFS rich-text fields. */
export function textToHtml(text: string): string {
  if (isProbablyHtml(text)) return text;
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return escaped
    .split(/\n{2,}/)
    .map((para) => `<div>${para.replace(/\n/g, "<br>")}</div>`)
    .join("");
}
