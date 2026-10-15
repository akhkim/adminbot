import type { Rect } from "./face-layout-measure.js";
import type { GroupPlan, WorkingGroupsPlan } from "./face-layout-plan.js";

// The preview an approver looks at before signing a write to the deck. Circles with initials
// rather than photos: the preview must not fetch anybody's avatar, and initials are enough to see
// who moved where.

const PANEL_PX = 640;
const COLORS = {
  keep: "#94a3b8",
  move: "#2563eb",
  create: "#16a34a",
  remove: "#dc2626",
  unknown: "#f59e0b",
  box: "#475569",
};

function escapeXml(value: string): string {
  return value.replace(
    /[<>&"']/gu,
    (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[char]!,
  );
}

function initials(name: string): string {
  return name
    .split(/\s+/u)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase())
    .slice(0, 2)
    .join("");
}

function face(rect: Rect, scale: number, color: string, name: string, dashed = false): string {
  const r = (Math.min(rect.w, rect.h) / 2) * scale;
  const cx = (rect.x + rect.w / 2) * scale;
  const cy = (rect.y + rect.h / 2) * scale;
  const dash = dashed ? ' stroke-dasharray="3 2"' : "";
  return (
    `<g><title>${escapeXml(name)}</title>` +
    `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" fill="${color}" fill-opacity="0.25" stroke="${color}" stroke-width="1.5"${dash}/>` +
    `<text x="${cx.toFixed(1)}" y="${(cy + r * 0.3).toFixed(1)}" font-size="${(r * 0.8).toFixed(1)}" text-anchor="middle" fill="#0f172a">${escapeXml(initials(name))}</text></g>`
  );
}

function boxOutline(group: GroupPlan, scale: number): string {
  if (!group.box) {
    return "";
  }
  const { x, y, w, h } = group.box;
  return (
    `<rect x="${(x * scale).toFixed(1)}" y="${(y * scale).toFixed(1)}" width="${(w * scale).toFixed(1)}" height="${(h * scale).toFixed(1)}" rx="8" fill="none" stroke="${COLORS.box}"/>` +
    `<text x="${((x + w / 2) * scale).toFixed(1)}" y="${(y * scale + 13).toFixed(1)}" font-size="11" font-weight="600" text-anchor="middle" fill="${COLORS.box}">${escapeXml(group.title)}</text>`
  );
}

function panel(plan: WorkingGroupsPlan, scale: number, after: boolean): string {
  return plan.groups
    .map((group) => {
      const shown = after && group.status === "update";
      const faces = shown
        ? group.faces.map((entry) => face(entry.rect, scale, COLORS[entry.action], entry.name))
        : [
            ...group.faces
              .filter((entry) => entry.action !== "create")
              .map((entry) => face(entry.from ?? entry.rect, scale, COLORS.keep, entry.name)),
            ...(group.status === "update"
              ? group.removed.map((entry) => face(entry.rect, scale, COLORS.remove, entry.name, true))
              : []),
          ];
      return boxOutline(group, scale) + faces.join("");
    })
    .join("");
}

/** Before and after, side by side, for the preview route and the PR evidence. */
export function renderWorkingGroupsPlanSvg(
  plan: WorkingGroupsPlan,
  page: { width: number; height: number },
): string {
  const scale = PANEL_PX / page.width;
  const panelHeight = page.height * scale;
  const gap = 24;
  const header = 22;
  const width = PANEL_PX * 2 + gap;
  const height = panelHeight + header + 26;
  const legend = (
    [
      ["keep", "unchanged"],
      ["move", "moved / resized"],
      ["create", "added"],
      ["remove", "removed"],
    ] as const
  )
    .map(
      ([key, label], index) =>
        `<circle cx="${12 + index * 150}" cy="${height - 9}" r="5" fill="${COLORS[key]}"/><text x="${22 + index * 150}" y="${height - 5}" font-size="11" fill="#334155">${label}</text>`,
    )
    .join("");
  const frame = (x: number) =>
    `<rect x="${x}" y="${header}" width="${PANEL_PX}" height="${panelHeight.toFixed(1)}" fill="#ffffff" stroke="#cbd5e1"/>`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height.toFixed(0)}" viewBox="0 0 ${width} ${height.toFixed(0)}" font-family="Helvetica, Arial, sans-serif">`,
    `<rect width="100%" height="100%" fill="#f8fafc"/>`,
    `<text x="4" y="15" font-size="13" font-weight="700" fill="#0f172a">Before</text>`,
    `<text x="${PANEL_PX + gap + 4}" y="15" font-size="13" font-weight="700" fill="#0f172a">After</text>`,
    // Clipped to the page, as Slides shows it: a face that overflowed past the slide's edge is
    // cut off there in the "before" panel rather than drawn over the legend.
    `<defs><clipPath id="page"><rect width="${PANEL_PX}" height="${panelHeight.toFixed(1)}"/></clipPath></defs>`,
    frame(0),
    frame(PANEL_PX + gap),
    `<g transform="translate(0 ${header})"><g clip-path="url(#page)">${panel(plan, scale, false)}</g></g>`,
    `<g transform="translate(${PANEL_PX + gap} ${header})"><g clip-path="url(#page)">${panel(plan, scale, true)}</g></g>`,
    legend,
    `</svg>`,
  ].join("");
}
