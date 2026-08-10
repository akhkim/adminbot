// Renders the canonical plain-text body of a lab email into a minimal HTML alternative.
//
// Why this exists: the copy in `workflows/onboarding/emails.ts` carries no hard wrapping (rule 3
// there), and neither does the compose path -- but the operator still received these mails with
// ~70-character breaks mid-paragraph. The breaks are introduced at delivery, by sending a
// `text/plain` part: a long logical line is quoted-printable soft-wrapped on the way out and then
// re-wrapped again by the reading client, and neither of those is something the sender controls.
// A `text/html` alternative is, so every send path renders one from the same string it already has.
//
// This is deliberately not a Markdown renderer. It understands exactly what the copy uses --
// paragraphs, "- " bullets nested by two-space indent, and bare URLs -- and escapes everything
// else. No styling: the point is to stop the wrapping, not to restyle the lab's mail. It is pure,
// so the HTML for a given body is identical on every run and can be asserted in a test.
//
// It lives beside the gog connector rather than beside the copy because it is a property of
// *delivery*, and because every caller that sends already imports from this directory.

/** Two spaces per nesting level, matching how the templates indent a sub-bullet. */
const INDENT_WIDTH = 2;

// Bare URLs in the copy. Deliberately narrow: it stops at whitespace and at the characters that
// would break the attribute it lands in, and trailing sentence punctuation is trimmed afterwards
// so "…at https://example.com/x." does not linkify the full stop.
const URL_PATTERN = /https?:\/\/[^\s<>"']+/gu;
const TRAILING_PUNCTUATION = /[.,;:!?)\]]+$/u;

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Escapes `text` and turns bare URLs into links.
 *
 * Escaping and linkifying have to happen in one pass: escaping first would rewrite `&` inside a
 * query string into `&amp;` before the URL is recognised, and linkifying first would then escape
 * the markup it just produced.
 */
function escapeAndLinkify(text: string): string {
  let result = "";
  let cursor = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index;
    const raw = match[0];
    const trimmed = raw.replace(TRAILING_PUNCTUATION, "");
    result += escapeHtml(text.slice(cursor, start));
    const href = escapeHtml(trimmed);
    result += `<a href="${href}">${href}</a>`;
    cursor = start + trimmed.length;
  }
  return result + escapeHtml(text.slice(cursor));
}

type Bullet = { depth: number; text: string };

function bulletOf(line: string): Bullet | undefined {
  const match = /^( *)- (.*)$/u.exec(line);
  if (!match) {
    return undefined;
  }
  const [, indent = "", text = ""] = match;
  return { depth: Math.floor(indent.length / INDENT_WIDTH), text: text.trim() };
}

/**
 * Renders one run of bullets as nested lists.
 *
 * A sub-bullet belongs *inside* its parent's `<li>`, so the parent stays open until the run drops
 * back to its own depth. A run that starts indented, or that skips a level, is clamped to the depth
 * above it rather than emitting an orphan list -- malformed copy should still deliver.
 */
function renderBullets(bullets: readonly Bullet[]): string {
  let html = "";
  let depth = -1;
  for (const bullet of bullets) {
    const target = Math.min(bullet.depth, depth + 1);
    if (target > depth) {
      html += "<ul>";
    }
    for (let level = depth; level > target; level -= 1) {
      html += "</li></ul>";
    }
    if (target <= depth) {
      html += "</li>";
    }
    html += `<li>${escapeAndLinkify(bullet.text)}`;
    depth = target;
  }
  for (let level = depth; level >= 0; level -= 1) {
    html += "</li></ul>";
  }
  return html;
}

function renderParagraph(lines: readonly string[]): string {
  return `<p>${lines.map((line) => escapeAndLinkify(line)).join("<br />")}</p>`;
}

/**
 * The HTML alternative for a plain-text email body.
 *
 * Blank lines separate blocks; inside a block, a run of "- " lines becomes a (possibly nested)
 * list and everything else becomes a paragraph whose own newlines become `<br />`. An empty body
 * renders as an empty string, which callers treat as "send text only".
 */
export function renderEmailBodyHtml(body: string): string {
  const lines = body.replaceAll("\r\n", "\n").split("\n");
  let html = "";
  let paragraph: string[] = [];
  let bullets: Bullet[] = [];

  const flush = (): void => {
    if (paragraph.length > 0) {
      html += renderParagraph(paragraph);
      paragraph = [];
    }
    if (bullets.length > 0) {
      html += renderBullets(bullets);
      bullets = [];
    }
  };

  for (const line of lines) {
    if (!line.trim()) {
      flush();
      continue;
    }
    const bullet = bulletOf(line);
    if (bullet) {
      if (paragraph.length > 0) {
        flush();
      }
      bullets.push(bullet);
      continue;
    }
    if (bullets.length > 0) {
      flush();
    }
    paragraph.push(line);
  }
  flush();
  return html;
}
