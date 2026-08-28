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

// Everything in the copy that should reach the recipient as a link, in one alternation so a single
// pass can escape and linkify together (see escapeAndLinkify).
//
// Three shapes, in precedence order:
//
//   1. `[label](https://…)` or `[label](mailto:…)` -- anchor text. The lab's template document
//      hyperlinks words rather than printing URLs ("LinkedIn: Zhijing-Jin, Jinesis-Lab"), and
//      without this those words shipped as dead text with the URL nowhere in the mail at all.
//   2. A bare URL. Stops at whitespace and at the characters that would break the attribute it
//      lands in; trailing sentence punctuation is trimmed afterwards, so "…at
//      https://example.com/x." does not linkify the full stop.
//   3. A bare email address, which becomes a mailto: link. Clients differ on whether they
//      autolink one themselves, and the newsletter address is an instruction to write to it.
//
// The URL branch precedes the address branch so the "@" inside a URL never starts an address.
const LINK_PATTERN = new RegExp(
  [
    String.raw`\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)`,
    String.raw`https?:\/\/[^\s<>"']+`,
    String.raw`[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}`,
  ].join("|"),
  "gu",
);
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
 * Escapes `text` and turns links into anchors.
 *
 * Escaping and linkifying have to happen in one pass: escaping first would rewrite `&` inside a
 * query string into `&amp;` before the URL is recognised, and linkifying first would then escape
 * the markup it just produced. Both the label and the href are escaped, so a `"` inside either can
 * never close the attribute it sits in.
 */
function escapeAndLinkify(text: string): string {
  let result = "";
  let cursor = 0;
  for (const match of text.matchAll(LINK_PATTERN)) {
    const start = match.index;
    const [whole = "", label, target] = match;
    result += escapeHtml(text.slice(cursor, start));
    if (label !== undefined && target !== undefined) {
      result += `<a href="${escapeHtml(target)}">${escapeHtml(label)}</a>`;
      cursor = start + whole.length;
      continue;
    }
    const trimmed = whole.replace(TRAILING_PUNCTUATION, "");
    // An address is shown as itself and linked as a mailto:; a URL is both.
    const isAddress = !trimmed.startsWith("http");
    const href = escapeHtml(isAddress ? `mailto:${trimmed}` : trimmed);
    result += `<a href="${href}">${escapeHtml(trimmed)}</a>`;
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
// Anchor-text links, for the text/plain part. Same pattern as the first branch of LINK_PATTERN.
const MARKDOWN_LINK = /\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)/gu;

/**
 * The body as a text-only client should read it: anchor text followed by its destination, rather
 * than the `[label](url)` source.
 *
 * The copy carries links in one notation and the two parts of the mail render it differently --
 * the html alternative as an anchor, this as "label (url)". Without it a text-only reader saw the
 * markdown itself, which reads as a templating bug rather than as a link. A bare `mailto:` prefix
 * is dropped here because an address on its own is what a person would type.
 */
export function renderEmailBodyText(body: string): string {
  return body.replaceAll(MARKDOWN_LINK, (_whole, label: string, target: string) => {
    const shown = target.startsWith("mailto:") ? target.slice("mailto:".length) : target;
    // "[Ada](mailto:ada@x.com)" is one thing said twice; print it once.
    return shown === label ? label : `${label} (${shown})`;
  });
}

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
