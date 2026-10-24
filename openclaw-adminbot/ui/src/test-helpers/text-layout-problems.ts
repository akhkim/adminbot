// In-page checks for text that collides with other text, is cut off by an `overflow: hidden`
// ancestor, or runs out of the visible box (border or background) it sits in.
//
// `collectTextLayoutProblems` is passed to Playwright's `page.evaluate`, so it must stay
// self-contained: no imports and no references to anything outside its own body.

export type TextLayoutProblems = {
  overlaps: string[];
  clipped: string[];
  escaped: string[];
};

export function collectTextLayoutProblems(ignoreSelectors: string[]): TextLayoutProblems {
  const out: TextLayoutProblems = { overlaps: [], clipped: [], escaped: [] };
  const ignore = ignoreSelectors.join(",");
  const viewportWidth = innerWidth;
  const viewportHeight = innerHeight;
  type Box = { left: number; right: number; top: number; bottom: number };
  type Text = { el: HTMLElement; rects: Box[]; visible: Box[]; label: string };

  const describe = (el: Element) => {
    const name = (node: Element) =>
      node.tagName.toLowerCase() +
      [...node.classList]
        .slice(0, 2)
        .map((c) => `.${c}`)
        .join("");
    return el.parentElement ? `${name(el.parentElement)} > ${name(el)}` : name(el);
  };
  const isShown = (el: HTMLElement) => {
    if (ignore && el.closest(ignore)) {
      return false;
    }
    // The body of a closed <details> keeps its layout boxes but is hidden by content-visibility.
    if (!el.checkVisibility({ contentVisibilityAuto: true, opacityProperty: true })) {
      return false;
    }
    for (let node: HTMLElement | null = el; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
        return false;
      }
      // Visually-hidden (screen-reader only) text is meant to sit in a 1px clipped box.
      const box = node.getBoundingClientRect();
      if (box.width <= 1.5 && box.height <= 1.5 && style.overflow !== "visible") {
        return false;
      }
    }
    return true;
  };

  const texts: Text[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const el = node.parentElement;
    if (!el || !node.textContent?.trim() || ["SCRIPT", "STYLE", "OPTION"].includes(el.tagName)) {
      continue;
    }
    const range = document.createRange();
    range.selectNodeContents(node);
    const rects = [...range.getClientRects()]
      .filter((r) => r.width > 1 && r.height > 1)
      .map((r) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom }));
    if (!rects.length || !isShown(el)) {
      continue;
    }
    // What the reader can actually see: each line box cut down by every clipping ancestor.
    let visible = rects;
    for (let a: HTMLElement | null = el; a && a !== document.documentElement; a = a.parentElement) {
      const style = getComputedStyle(a);
      if (style.overflowX === "visible" && style.overflowY === "visible") {
        continue;
      }
      const box = a.getBoundingClientRect();
      visible = visible.map((r) => ({
        left: Math.max(r.left, box.left),
        right: Math.min(r.right, box.right),
        top: Math.max(r.top, box.top),
        bottom: Math.min(r.bottom, box.bottom),
      }));
    }
    visible = visible.filter((r) => r.right - r.left > 1 && r.bottom - r.top > 1);
    if (visible.length) {
      texts.push({ el, rects, visible, label: node.textContent.trim().slice(0, 40) });
    }
  }

  // Clipped: per axis only the nearest ancestor that does not overflow visibly matters. A scroller
  // keeps the text reachable; `hidden`/`clip` cuts it off unless the element asks for an ellipsis.
  for (const text of texts) {
    const style = getComputedStyle(text.el);
    const ellipsis = style.textOverflow === "ellipsis" || style.webkitLineClamp !== "none";
    let problem = "";
    for (const axis of ["x", "y"] as const) {
      for (let a: HTMLElement | null = text.el; a && a !== document.body; a = a.parentElement) {
        const ancestor = getComputedStyle(a);
        const overflow = axis === "x" ? ancestor.overflowX : ancestor.overflowY;
        if (overflow === "visible") {
          continue;
        }
        if (overflow === "hidden" || overflow === "clip") {
          const box = a.getBoundingClientRect();
          const cut = text.rects.some((r) =>
            axis === "x"
              ? !ellipsis &&
                (r.right > box.right + 2 || r.left < box.left - 2) &&
                r.top < box.bottom &&
                r.bottom > box.top
              : (r.bottom > box.bottom + 2 || r.top < box.top - 2) &&
                r.left < box.right &&
                r.right > box.left &&
                !(ellipsis && r.bottom - r.top <= box.height + 4),
          );
          if (cut && box.bottom > 0 && box.top < viewportHeight) {
            problem ||= `"${text.label}" (${describe(text.el)}) cut off in ${axis} by ${describe(a)}`;
          }
        }
        break;
      }
    }
    if (problem) {
      out.clipped.push(problem);
    }
  }

  // Escaped: text running past the nearest visibly drawn box (border or background) around it.
  const drawn = (el: HTMLElement) => {
    const style = getComputedStyle(el);
    if (parseFloat(style.borderLeftWidth) > 0 && parseFloat(style.borderRightWidth) > 0) {
      return style.borderLeftStyle !== "none";
    }
    const parts = style.backgroundColor.match(/[\d.]+/g)?.map(Number) ?? [];
    return parts.length === 3 || (parts.length === 4 && parts[3] > 0.05);
  };
  for (const text of texts) {
    let box: HTMLElement | null = text.el;
    while (box && box !== document.body && !(box !== text.el && drawn(box))) {
      box = box.parentElement;
    }
    if (!box || box === document.body || getComputedStyle(box).overflowX !== "visible") {
      continue;
    }
    const bounds = box.getBoundingClientRect();
    const by = Math.max(...text.visible.map((r) => Math.max(r.right - bounds.right, bounds.left - r.left)));
    if (bounds.width >= 8 && by > 2) {
      out.escaped.push(`"${text.label}" (${describe(text.el)}) runs ${Math.round(by)}px out of ${describe(box)}`);
    }
  }

  // Overlap: two different text nodes whose visible line boxes really intersect, and both are
  // painted at that point (text under an opaque dialog or menu is not a collision).
  const related = (a: Element, b: Element) => a.contains(b) || b.contains(a);
  const opaque = (el: Element) => {
    const parts = getComputedStyle(el).backgroundColor.match(/[\d.]+/g)?.map(Number) ?? [];
    return ["IMG", "svg", "CANVAS"].includes(el.tagName) || parts.length === 3 || parts[3] > 0.5;
  };
  const hidden = (el: Element, x: number, y: number) => {
    for (const top of document.elementsFromPoint(x, y)) {
      if (related(top, el)) {
        return false;
      }
      if (opaque(top)) {
        return true;
      }
    }
    return false;
  };
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i];
      const b = texts[j];
      if (a.el === b.el) {
        continue;
      }
      const hit = a.visible.some((p) =>
        b.visible.some((q) => {
          const dx = Math.min(p.right, q.right) - Math.max(p.left, q.left);
          const dy = Math.min(p.bottom, q.bottom) - Math.max(p.top, q.top);
          // Adjacent lines may touch; a real collision shares a good part of a line's height.
          if (dx <= 3 || dy <= Math.min(p.bottom - p.top, q.bottom - q.top) * 0.35) {
            return false;
          }
          const x = (Math.max(p.left, q.left) + Math.min(p.right, q.right)) / 2;
          const y = (Math.max(p.top, q.top) + Math.min(p.bottom, q.bottom)) / 2;
          if (x < 0 || y < 0 || x > viewportWidth || y > viewportHeight) {
            return false;
          }
          return !hidden(a.el, x, y) && !hidden(b.el, x, y);
        }),
      );
      if (hit) {
        out.overlaps.push(`"${a.label}" (${describe(a.el)}) overlaps "${b.label}" (${describe(b.el)})`);
      }
    }
  }
  return out;
}
