import type { Rect } from "./face-layout-measure.js";
import type { GroupPlan, WorkingGroupsPlan } from "./face-layout-plan.js";

// The preview an approver looks at before signing a write to the deck. Round faces with initials
// rather than photos, ringed the way the slide's faces are: the preview must not fetch anybody's
// avatar, and initials are enough to see who is added where.

const PANEL_PX = 640;
const LEGEND_X = [0, 260, 360, 500, 680];
const COLORS = {
  keep: "#94a3b8",
  create: "#16a34a",
  remove: "#dc2626",
  wouldRemove: "#f59e0b",
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

type Ring = { color: string; width: number } | null;

function ringOf(group: GroupPlan, scale: number): Ring {
  const ring = group.metrics?.ring;
  if (!ring) {
    return null;
  }
  const hex = (value: number) =>
    Math.round(Math.min(1, Math.max(0, value)) * 255)
      .toString(16)
      .padStart(2, "0");
  return { color: `#${hex(ring.red)}${hex(ring.green)}${hex(ring.blue)}`, width: Math.max(0.75, ring.weight * scale) };
}

function face(
  rect: Rect,
  scale: number,
  color: string,
  name: string,
  ring: Ring,
  dashed = false,
): string {
  const r = (Math.min(rect.w, rect.h) / 2) * scale;
  const cx = (rect.x + rect.w / 2) * scale;
  const cy = (rect.y + rect.h / 2) * scale;
  const dash = dashed ? ' stroke-dasharray="3 2"' : "";
  // The slide's own ring, drawn inside the circle the way a ring baked into a photo sits.
  const inner = ring
    ? `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${Math.max(0, r - ring.width / 2).toFixed(1)}" fill="none" stroke="${ring.color}" stroke-width="${ring.width.toFixed(2)}"/>`
    : "";
  return (
    `<g><title>${escapeXml(name)}</title>` +
    `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" fill="${color}" fill-opacity="0.25" stroke="${color}" stroke-width="1.5"${dash}/>` +
    inner +
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

function note(group: GroupPlan, scale: number): string {
  if (!group.box || !group.noRoom.length) {
    return "";
  }
  const { x, y, w, h } = group.box;
  // A full box gets a red dashed outline and "+N" in its corner: N people belong but did not fit.
  // The names are in the JSON preview's no_room.
  return (
    `<rect x="${(x * scale + 2).toFixed(1)}" y="${(y * scale + 2).toFixed(1)}" width="${(w * scale - 4).toFixed(1)}" height="${(h * scale - 4).toFixed(1)}" rx="7" fill="none" stroke="${COLORS.remove}" stroke-dasharray="4 3"/>` +
    `<text x="${((x + w) * scale - 6).toFixed(1)}" y="${(y * scale + 13).toFixed(1)}" font-size="10" font-weight="700" text-anchor="end" fill="${COLORS.remove}"><title>${escapeXml(group.noRoom.join(", "))}</title>+${group.noRoom.length}</text>`
  );
}

function panel(plan: WorkingGroupsPlan, scale: number, after: boolean): string {
  return plan.groups
    .map((group) => {
      const ring = ringOf(group, scale);
      // Images nobody can be tied to stay on the slide and take up room, so both panels show them.
      const strangers = group.unidentified.map((entry) => face(entry.rect, scale, COLORS.keep, "?", ring));
      const removing = group.status === "update" ? group.removed : [];
      const faces = after
        ? [
            ...(group.status === "update" ? group.faces : group.faces.filter((entry) => entry.action === "keep")).map(
              (entry) => face(entry.rect, scale, COLORS[entry.action], entry.name, ring),
            ),
            ...group.wouldRemove.map((entry) => face(entry.rect, scale, COLORS.wouldRemove, entry.name, ring, true)),
          ]
        : [
            ...group.faces
              .filter((entry) => entry.action === "keep")
              .map((entry) => face(entry.rect, scale, COLORS.keep, entry.name, ring)),
            ...removing.map((entry) => face(entry.rect, scale, COLORS.remove, entry.name, ring, true)),
          ];
      return boxOutline(group, scale) + strangers.join("") + faces.join("") + (after ? note(group, scale) : "");
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
      ["keep", "already there (? = not tied to a member)"],
      ["create", "added"],
      ["remove", "removed (opt-in)"],
      ["wouldRemove", "would remove (opt-in off)"],
      ["remove", "dashed box, +N: full, N not added"],
    ] as const
  )
    .map(
      ([key, label], index) =>
        `<circle cx="${12 + LEGEND_X[index]!}" cy="${height - 9}" r="5" fill="${COLORS[key]}"/><text x="${22 + LEGEND_X[index]!}" y="${height - 5}" font-size="11" fill="#334155">${label}</text>`,
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
