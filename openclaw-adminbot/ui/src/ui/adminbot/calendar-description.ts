// Google Calendar descriptions are HTML, so the card has to render them as HTML.
//
// They arrive as things like `<p>Zoom link: <a href="...">...</a></p>Docs: <a ...>...</a><br>`, and
// printing that as text put the raw tags on screen. It cannot go through the markdown pipeline
// either: that one deliberately escapes embedded HTML (see the html_block/html_inline overrides in
// markdown.ts), so the tags would still show — and running markdown over text nobody wrote as
// markdown mangles it in other ways, underscores inside a URL being the obvious one.
//
// This is untrusted input. Anyone who can put an event on the lab calendar — including an outside
// guest whose invitation lands there — controls this string, so it is sanitized before it is
// rendered, not merely trusted because Google sent it.
//
// DOMPurify's global hooks are deliberately not used. markdown.ts installs its own
// `afterSanitizeAttributes` hook lazily, and hooks are process-wide: adding another would make each
// module's rules silently apply to the other's content. Anchors are fixed up here on the returned
// fragment instead.
import DOMPurify from "dompurify";

// What a calendar description legitimately contains. No images, no styles, no ids — a description
// is a few lines and some links, and everything outside that list is either decoration Google adds
// or something nobody should be injecting into an admin page.
const ALLOWED_TAGS = [
  "a",
  "b",
  "br",
  "code",
  "em",
  "i",
  "li",
  "ol",
  "p",
  "pre",
  "span",
  "strong",
  "u",
  "ul",
];
const ALLOWED_ATTR = ["href", "title"];
const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
// Long enough for a real agenda, short enough that a pathological description cannot lock the tab.
const MAX_DESCRIPTION_CHARS = 20_000;

/** True when the string carries markup rather than being plain text with newlines. */
export function looksLikeHtml(value: string): boolean {
  return /<[a-z][\s\S]*>/iu.test(value);
}

/**
 * Sanitized HTML for an event description, ready for `unsafeHTML`.
 *
 * Returns an empty string for empty input, so the caller can decide whether to render the block at
 * all.
 */
export function sanitizeEventDescription(value: string | undefined): string {
  const input = (value ?? "").trim();
  if (!input) {
    return "";
  }
  const truncated =
    input.length > MAX_DESCRIPTION_CHARS ? `${input.slice(0, MAX_DESCRIPTION_CHARS)}…` : input;
  const fragment = DOMPurify.sanitize(truncated, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    RETURN_DOM_FRAGMENT: true,
  });
  hardenLinks(fragment);
  const container = document.createElement("div");
  container.append(fragment);
  const html = container.innerHTML;
  // A plain-text description keeps its line breaks. Doing this after sanitizing rather than before
  // means the newlines *inside* real markup — the ones between Google's own block tags — are not
  // turned into visible blank lines.
  return looksLikeHtml(truncated) ? html : html.replace(/\r?\n/gu, "<br>");
}

/** A malformed URL is not a safe one: unparseable means the scheme cannot be vouched for. */
function hasSafeProtocol(href: string): boolean {
  try {
    return SAFE_PROTOCOLS.has(new URL(href, window.location.href).protocol);
  } catch {
    return false;
  }
}

/**
 * Makes every surviving link safe to click.
 *
 * DOMPurify already drops `javascript:` and friends, but a description is full of links the reader
 * will click, so the scheme is checked explicitly and anything that is not a web or mail address
 * loses its href rather than staying a live but unexplained link. Every link opens in a new tab —
 * this is an admin page, and losing it to a navigation costs the operator their place.
 */
function hardenLinks(fragment: DocumentFragment): void {
  for (const anchor of fragment.querySelectorAll("a")) {
    const href = anchor.getAttribute("href");
    if (!href) {
      continue;
    }
    if (!hasSafeProtocol(href)) {
      anchor.removeAttribute("href");
      continue;
    }
    anchor.setAttribute("target", "_blank");
    anchor.setAttribute("rel", "noreferrer noopener");
  }
}
