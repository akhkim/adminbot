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
// paragraphs, "- " bullets and "1. " numbered steps nested by two-space indent, bare URLs, and
// bare email addresses -- and escapes everything else. No styling: the point is to stop the
// wrapping and to keep the onboarding steps reading as steps, not to restyle the lab's mail. It is
// pure, so the HTML for a given body is identical on every run and can be asserted in a test.
//
// It lives beside the gog connector rather than beside the copy because it is a property of
// *delivery*, and because every caller that sends already imports from this directory.

/** Two spaces per nesting level, matching how the templates indent a sub-bullet. */
const INDENT_WIDTH = 2;

// Anchor text: `[label](https://…)` or `[label](mailto:…)`.
//
// The lab's template document hyperlinks words rather than printing URLs -- "LinkedIn: Zhijing-Jin,
// Jinesis-Lab, EuroSafeAI" is three destinations behind three names. Without a notation for that,
// those words shipped as dead text with the URL nowhere in the mail at all.
const MARKDOWN_LINK = /\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)/gu;

// Bare URLs in the copy. Deliberately narrow: it stops at whitespace and at the characters that
// would break the attribute it lands in, and trailing sentence punctuation is trimmed afterwards
// so "…at https://example.com/x." does not linkify the full stop.
const URL_PATTERN = /https?:\/\/[^\s<>"']+/gu;
const TRAILING_PUNCTUATION = /[.,;:!?)\]]+$/u;

// Bare email addresses, which the copy uses for the newsletter and for the lab admin. The lookbehind
// is the whole point: the same templates also print *example* addresses -- `"firstname@…"` and
// `{full_last_name}@…` -- and an address that is quoted or built out of a placeholder is copy about
// an address rather than one to write to, so only an address standing on its own is linked.
const EMAIL_PATTERN = /(?<=^|[\s(<])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/gu;

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

type Link = { start: number; end: number; href: string; label: string };

/** Every anchor, URL and email address in `text`, in source order and never overlapping. */
function linksIn(text: string): Link[] {
  const links: Link[] = [];
  const covers = (start: number, end: number): boolean =>
    links.some((link) => start < link.end && end > link.start);

  // Anchors first, so the URL and address passes both see their target as already claimed and do
  // not linkify the inside of a `[label](url)` a second time.
  for (const match of text.matchAll(MARKDOWN_LINK)) {
    const [whole = "", label = "", href = ""] = match;
    links.push({ start: match.index, end: match.index + whole.length, href, label });
  }
  for (const match of text.matchAll(URL_PATTERN)) {
    const raw = match[0].replace(TRAILING_PUNCTUATION, "");
    const start = match.index;
    if (covers(start, start + raw.length)) {
      continue;
    }
    links.push({ start, end: start + raw.length, href: raw, label: raw });
  }
  for (const match of text.matchAll(EMAIL_PATTERN)) {
    const raw = match[0].replace(TRAILING_PUNCTUATION, "");
    const start = match.index;
    // An address inside a URL -- a mailto: or a userinfo host -- is already covered by that link.
    if (covers(start, start + raw.length)) {
      continue;
    }
    links.push({ start, end: start + raw.length, href: `mailto:${raw}`, label: raw });
  }
  return links.toSorted((left, right) => left.start - right.start);
}

/**
 * The body as a text-only client should read it: anchor text followed by its destination.
 *
 * The copy carries links in one notation and the two parts of the mail render it differently -- the
 * html alternative as an anchor, this as "label (url)". Without it a text-only reader saw the
 * `[label](url)` source, which reads as a templating bug rather than as a link. A `mailto:` prefix
 * is dropped here because an address on its own is what a person would type.
 *
 * A label that already *is* its destination -- the newsletter address, hyperlinked to itself --
 * renders once rather than as "x (x)".
 */
export function renderEmailBodyText(body: string): string {
  return body.replace(MARKDOWN_LINK, (_whole, label: string, href: string) => {
    const destination = href.replace(/^mailto:/u, "");
    return label === destination ? label : `${label} (${destination})`;
  });
}

/**
 * Escapes `text` and turns bare URLs and email addresses into links.
 *
 * Escaping and linkifying have to happen in one pass: escaping first would rewrite `&` inside a
 * query string into `&amp;` before the URL is recognised, and linkifying first would then escape
 * the markup it just produced.
 */
function escapeAndLinkify(text: string): string {
  let result = "";
  let cursor = 0;
  for (const link of linksIn(text)) {
    if (link.start < cursor) {
      continue;
    }
    result += escapeHtml(text.slice(cursor, link.start));
    result += `<a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>`;
    cursor = link.end;
  }
  return result + escapeHtml(text.slice(cursor));
}

type ListKind = "ul" | "ol";
type Item = { kind: ListKind; depth: number; number?: number; text: string };

/**
 * The list item a line is, if it is one.
 *
 * `depth` is the source indent, not the eventual nesting level -- the copy nests a run of "- "
 * bullets *under* the numbered step that introduces them without indenting them, so the renderer
 * works the level out from the markers rather than from the whitespace alone.
 */
function itemOf(line: string): Item | undefined {
  const bullet = /^( *)- (.*)$/u.exec(line);
  if (bullet) {
    const [, indent = "", text = ""] = bullet;
    return { kind: "ul", depth: Math.floor(indent.length / INDENT_WIDTH), text: text.trim() };
  }
  const numbered = /^( *)(\d{1,3})\. (.*)$/u.exec(line);
  if (numbered) {
    const [, indent = "", number = "1", text = ""] = numbered;
    return {
      kind: "ol",
      depth: Math.floor(indent.length / INDENT_WIDTH),
      number: Number(number),
      text: text.trim(),
    };
  }
  return undefined;
}

/**
 * Renders one run of list items as nested `<ul>`/`<ol>`.
 *
 * An item joins the innermost open list that was started at its own indent *with its own marker*;
 * anything else opens a new list one level in, which is what makes a run of "- " bullets land
 * inside the numbered step above it rather than terminating the numbered list. A sub-list belongs
 * inside its parent's `<li>`, so the parent stays open until the run comes back out to its level.
 * Malformed copy -- a run that starts indented, or that skips a level -- still delivers, one level
 * shallower than it asked for.
 */
function renderList(items: readonly Item[]): string {
  let html = "";
  const open: Array<{ kind: ListKind; depth: number }> = [];
  const close = (): string => `</li></${open.pop()?.kind ?? "ul"}>`;

  for (const item of items) {
    let level = open.findLastIndex((list) => list.depth === item.depth && list.kind === item.kind);
    if (level < 0) {
      // Not a sibling of anything open: drop any list indented deeper than this item, then nest.
      while (open.length > 0 && (open.at(-1)?.depth ?? 0) > item.depth) {
        html += close();
      }
      level = open.length;
    }
    while (open.length > level + 1) {
      html += close();
    }
    if (open.length === level + 1) {
      html += "</li>";
    } else {
      // `start` keeps a step list that the copy numbers from something other than 1 honest.
      html +=
        item.kind === "ol" && item.number !== undefined && item.number !== 1
          ? `<ol start="${item.number}">`
          : `<${item.kind}>`;
      open.push({ kind: item.kind, depth: item.depth });
    }
    html += `<li>${escapeAndLinkify(item.text)}`;
  }
  while (open.length > 0) {
    html += close();
  }
  return html;
}

function renderParagraph(lines: readonly string[]): string {
  return `<p>${lines.map((line) => escapeAndLinkify(line)).join("<br />")}</p>`;
}

/**
 * The HTML alternative for a plain-text email body.
 *
 * Blank lines separate paragraphs, and a run of "- " or "1. " lines becomes a (possibly nested)
 * list. A blank line does *not* end a list: the onboarding copy puts one between every numbered
 * step for readability in the plain-text part, and those steps are one list all the same. Only a
 * line of prose (or the end of the body) closes a list. An empty body renders as an empty string,
 * which callers treat as "send text only".
 */
export function renderEmailBodyHtml(body: string): string {
  const lines = body.replaceAll("\r\n", "\n").split("\n");
  let html = "";
  let paragraph: string[] = [];
  let items: Item[] = [];

  const flush = (): void => {
    if (paragraph.length > 0) {
      html += renderParagraph(paragraph);
      paragraph = [];
    }
    if (items.length > 0) {
      html += renderList(items);
      items = [];
    }
  };

  for (const line of lines) {
    if (!line.trim()) {
      // A blank line ends a paragraph but only pauses a list, which the next line resumes.
      if (paragraph.length > 0) {
        flush();
      }
      continue;
    }
    const item = itemOf(line);
    if (item) {
      if (paragraph.length > 0) {
        flush();
      }
      items.push(item);
      continue;
    }
    if (items.length > 0) {
      flush();
    }
    paragraph.push(line);
  }
  flush();
  return html;
}
