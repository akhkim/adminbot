// "You are here" on the PaperFlow chart.
//
// A shopping-mall map rather than a picture of one: it opens centred on the step the paper is
// actually at, marks it, and lets you zoom and drag around the rest. A flat image would show the
// same shape but leave the reader to find themselves in it, which on a 33-node graph is the whole
// difficulty.
//
// Built imperatively instead of as a Lit view on purpose. It owns a <dialog>, a wheel listener and
// a drag loop -- state that belongs to the overlay and dies with it, so routing it through the app
// view state would add a lifecycle for no gain.

import { paperflow } from "@openclaw/nudge-engine";
import { nextStepFor, paperToState } from "./next-step.ts";
import type { AdminBotPaperRecord } from "./controllers/admin.ts";

const SVG_URL = "paperflow.svg";
const MIN_SCALE = 0.2;
const MAX_SCALE = 4;

/** The chart is exported by mermaid, whose node ids look like `export-svg-flowchart-GT-21`. */
function findNode(root: ParentNode, nodeId: string): SVGGraphicsElement | null {
  return root.querySelector<SVGGraphicsElement>(`[id*="flowchart-${nodeId}-"]`);
}

/** Cached so reopening the map does not refetch 80KB every time. */
let svgTextPromise: Promise<string> | undefined;

function loadSvg(): Promise<string> {
  svgTextPromise ??= fetch(SVG_URL).then((response) => {
    if (!response.ok) {
      throw new Error(`paperflow.svg ${response.status}`);
    }
    return response.text();
  });
  return svgTextPromise;
}

export function openPaperFlowMap(paper: AdminBotPaperRecord): void {
  const dialog = document.createElement("dialog");
  dialog.className = "flowmap";
  dialog.innerHTML = `
    <div class="flowmap__bar">
      <div class="flowmap__title">
        <strong>PaperFlow</strong>
        <span class="flowmap__subtitle"></span>
      </div>
      <div class="flowmap__tools">
        <button type="button" class="btn btn--sm" data-act="out" title="Zoom out">−</button>
        <button type="button" class="btn btn--sm" data-act="in" title="Zoom in">+</button>
        <button type="button" class="btn btn--sm" data-act="fit" title="Back to you">You are here</button>
        <button type="button" class="btn btn--sm" data-act="close" title="Close">Close</button>
      </div>
    </div>
    <div class="flowmap__canvas"><div class="flowmap__stage">Loading…</div></div>
    <p class="flowmap__hint">Drag to pan · scroll to zoom · red pin is where this paper is</p>
  `;
  document.body.appendChild(dialog);
  dialog.showModal();

  const canvas = dialog.querySelector<HTMLElement>(".flowmap__canvas");
  const stage = dialog.querySelector<HTMLElement>(".flowmap__stage");
  const subtitle = dialog.querySelector<HTMLElement>(".flowmap__subtitle");
  if (!canvas || !stage) {
    return;
  }

  let scale = 1;
  let x = 0;
  let y = 0;

  const apply = () => {
    stage.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
  };

  const close = () => {
    dialog.close();
    dialog.remove();
  };

  // Centre the viewport on one node. This is what makes it a map you can read rather than a
  // drawing you have to search.
  // Measure where the node currently is on screen and shift by the difference.
  //
  // getBBox() was the wrong tool: mermaid translates every node group, and getBBox reports
  // coordinates in the group's own space, so those numbers are not canvas coordinates. Working
  // from client rects sidesteps the whole nesting question and stays correct at any zoom.
  const centreOn = (target: SVGGraphicsElement) => {
    const node = target.getBoundingClientRect();
    const view = canvas.getBoundingClientRect();
    x += view.left + view.width / 2 - (node.left + node.width / 2);
    y += view.top + view.height / 2 - (node.top + node.height / 2);
    apply();
  };

  loadSvg()
    .then((markup) => {
      stage.innerHTML = markup;
      const svg = stage.querySelector("svg");
      if (!svg) {
        stage.textContent = "Could not read the diagram.";
        return;
      }
      svg.removeAttribute("style");
      svg.classList.add("flowmap__svg");
      // Pin to the viewBox so user units == pixels; everything below depends on that.
      const viewBox = svg.viewBox.baseVal;
      svg.setAttribute("width", String(viewBox.width));
      svg.setAttribute("height", String(viewBox.height));

      // Shade what is already done, so the pin reads as a position in a journey rather than a
      // lone dot on a static chart.
      const state = paperToState(paper);
      for (const node of paperflow.nodes) {
        if (state.status[node.id] !== "complete") {
          continue;
        }
        findNode(svg, node.id)?.classList.add("flowmap__node--done");
      }

      const next = nextStepFor(paper);
      const targetId =
        paperflow.nodes.find((node) => node.label === next?.headline)?.id ?? paperflow.root;
      if (subtitle) {
        subtitle.textContent = next?.done
          ? "Everything on this paper is finished"
          : next
            ? `You are here: ${next.headline}`
            : paper.title;
      }

      const target = findNode(svg, targetId);
      if (target) {
        target.classList.add("flowmap__node--here");
        // One frame so layout has run and getBoundingClientRect is real.
        requestAnimationFrame(() => centreOn(target));
        dialog.querySelector('[data-act="fit"]')?.addEventListener("click", () => {
          scale = 1;
          apply();
          // Re-measure after the scale lands, or the offset is computed against the old zoom.
          requestAnimationFrame(() => centreOn(target));
        });
      }
    })
    .catch(() => {
      stage.textContent = "Could not load the diagram.";
    });

  const zoom = (factor: number) => {
    scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * factor));
    apply();
  };

  dialog.addEventListener("click", (event) => {
    const act = (event.target as HTMLElement).closest("[data-act]")?.getAttribute("data-act");
    if (act === "in") zoom(1.25);
    if (act === "out") zoom(0.8);
    if (act === "close") close();
  });

  // Escape already closes a modal dialog; make the backdrop do it too.
  dialog.addEventListener("cancel", close);
  dialog.addEventListener("mousedown", (event) => {
    if (event.target === dialog) {
      close();
    }
  });

  canvas.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      zoom(event.deltaY < 0 ? 1.1 : 0.9);
    },
    { passive: false },
  );

  let dragging = false;
  let originX = 0;
  let originY = 0;
  canvas.addEventListener("pointerdown", (event) => {
    dragging = true;
    originX = event.clientX - x;
    originY = event.clientY - y;
    canvas.setPointerCapture(event.pointerId);
    canvas.classList.add("is-dragging");
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!dragging) {
      return;
    }
    x = event.clientX - originX;
    y = event.clientY - originY;
    apply();
  });
  const endDrag = () => {
    dragging = false;
    canvas.classList.remove("is-dragging");
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
}
