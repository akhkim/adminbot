import { html } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import { directive } from "lit/directive.js";
import { ref } from "lit/directives/ref.js";

/** Suppress punctuation when the adjacent metadata wraps onto different lines. */
class WrapSeparator extends AsyncDirective {
  private element?: HTMLElement;
  private observer?: ResizeObserver;
  private frame = 0;
  private width = -1;

  private measure = () => {
    const element = this.element;
    if (!element?.isConnected) {
      return;
    }
    element.hidden = false;
    const siblingRect = (direction: "previousSibling" | "nextSibling") => {
      let node = element[direction];
      while (node && (!node.textContent?.trim() || node.nodeType === Node.COMMENT_NODE)) {
        node = node[direction];
      }
      if (!node) {
        return undefined;
      }
      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = Array.from(range.getClientRects());
      return direction === "previousSibling" ? rects.at(-1) : rects[0];
    };
    const before = siblingRect("previousSibling");
    const after = siblingRect("nextSibling");
    if (before && after) {
      element.hidden = after.top >= before.bottom - 1;
    }
  };

  private attach = (element?: Element) => {
    this.observer?.disconnect();
    this.element = element as HTMLElement | undefined;
    if (!element || typeof ResizeObserver === "undefined") {
      return;
    }
    this.observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width === this.width) {
        return;
      }
      this.width = entry.contentRect.width;
      cancelAnimationFrame(this.frame);
      this.frame = requestAnimationFrame(this.measure);
    });
    if (element.parentElement) {
      this.observer.observe(element.parentElement);
    }
    this.frame = requestAnimationFrame(this.measure);
  };

  render() {
    this.width = -1;
    if (typeof ResizeObserver !== "undefined") {
      cancelAnimationFrame(this.frame);
      this.frame = requestAnimationFrame(this.measure);
    }
    return html`<span class="deadline-meta-separator" aria-hidden="true" ${ref(this.attach)}>
      ·
    </span>`;
  }

  protected override disconnected() {
    this.observer?.disconnect();
    cancelAnimationFrame(this.frame);
  }

  protected override reconnected() {
    this.attach(this.element);
  }
}
export const wrapSeparator = directive(WrapSeparator);
