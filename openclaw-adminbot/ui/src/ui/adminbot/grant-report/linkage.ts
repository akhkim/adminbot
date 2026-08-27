// Everything derived from the three data modules, plus the markdown the tab exports.
//
// The export matters as much as the screen does: the point of the tab is to get text into the
// proposal document, and a block that is retyped by hand is a block that stops matching the sheet.
// The markdown here reproduces the shape Part 2.3 of the proposal already uses -- a bolded lead-in,
// a parenthesised link, then the claim -- so a section pastes in without reformatting.

import { SAFETY_AREAS, SAFETY_AREA_BY_ID, SOURCE, type SafetyAreaId } from "./areas.ts";
import { GRANT_PAPERS, type GrantPaper } from "./papers.ts";
import { GRANT_SECTIONS, type GrantSection, type TrackRecord } from "./sections.ts";

/** Papers in the current submission cycle -- everything except the already-published prior work. */
export function pipelinePapers(): readonly GrantPaper[] {
  return GRANT_PAPERS.filter((paper) => !paper.published);
}

export function papersForArea(area: SafetyAreaId): readonly GrantPaper[] {
  return GRANT_PAPERS.filter((paper) => paper.areas.includes(area));
}

/**
 * Papers assigned to a section, including those assigned only to its children.
 *
 * A reader on Part 1.1.1 wants the three hacking interfaces' papers counted there too -- the parent
 * is the thing the proposal asks money for, and its children are how it spends it.
 */
export function papersForSection(sectionId: string): readonly GrantPaper[] {
  const ids = new Set([sectionId, ...descendantIds(sectionId)]);
  return GRANT_PAPERS.filter((paper) => paper.sections.some((id) => ids.has(id)));
}

export function descendantIds(sectionId: string): readonly string[] {
  const found: string[] = [];
  for (const section of GRANT_SECTIONS) {
    if (section.parent === sectionId) {
      found.push(section.id, ...descendantIds(section.id));
    }
  }
  return found;
}

/** Lab output that no part of the technical agenda claims. Counted, not hidden. */
export function unmappedPapers(): readonly GrantPaper[] {
  return GRANT_PAPERS.filter((paper) => !paper.published && paper.sections.length === 0);
}

/** Papers the six-area taxonomy has no home for -- technical AGI safety is not all the lab does. */
export function unclassifiedPapers(): readonly GrantPaper[] {
  return GRANT_PAPERS.filter((paper) => !paper.published && paper.areas.length === 0);
}

export type AreaCount = { area: SafetyAreaId; name: string; count: number };

/**
 * Papers per area, largest first.
 *
 * A paper sits in every area it belongs to rather than being forced into one, so these sum to more
 * than the paper count. That is the honest shape of the data: "systematic misalignment benchmarks,
 * read with interpretability" is two areas, and picking one of them would lose the claim.
 */
export function areaCounts(): readonly AreaCount[] {
  return SAFETY_AREAS.map((area) => ({
    area: area.id,
    name: area.name,
    count: papersForArea(area.id).length,
  })).toSorted((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export function sectionCount(sectionId: string): number {
  return papersForSection(sectionId).length;
}

/** How the papers of one section spread across the six areas, largest first. */
export function areaMixForSection(sectionId: string): readonly AreaCount[] {
  const papers = papersForSection(sectionId);
  return SAFETY_AREAS.map((area) => ({
    area: area.id,
    name: area.name,
    count: papers.filter((paper) => paper.areas.includes(area.id)).length,
  }))
    .filter((row) => row.count > 0)
    .toSorted((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

// --- Markdown export ------------------------------------------------------------------------

function bulletLine(
  label: string,
  detail: string,
  links?: readonly { text: string; href: string }[],
) {
  const linkText = links?.length
    ? ` (${links.map((link) => `[${link.text}](${link.href})`).join(", ")})`
    : "";
  return `  - **${label}**${linkText}: ${detail}`;
}

export function trackRecordMarkdown(record: TrackRecord): string {
  return [
    record.lede,
    "",
    ...record.bullets.map((b) => bulletLine(b.label, b.detail, b.links)),
  ].join("\n");
}

/** One section as a document-ready block: heading, the "Track record" label, then the bullets. */
export function sectionMarkdown(section: GrantSection): string {
  const heading = `${"#".repeat(section.depth)} ${section.number}${
    section.depth === 4 ? ":" : ":"
  } ${section.title}`;
  return [heading, "", "**Track record**", "", trackRecordMarkdown(section.trackRecord), ""].join(
    "\n",
  );
}

/** Every section's track record, in document order. This is what Task 2 hands back. */
export function allTrackRecordsMarkdown(): string {
  return GRANT_SECTIONS.map(sectionMarkdown).join("\n");
}

/** The area map as a markdown table: one row per paper, with the areas it was placed in. */
export function areaMapMarkdown(): string {
  const header = ["| Paper | Venue | Areas | Proposal sections |", "| --- | --- | --- | --- |"];
  const rows = GRANT_PAPERS.map((paper) => {
    const areas = paper.areas.map((id) => SAFETY_AREA_BY_ID[id].name).join(", ") || "—";
    const sections = paper.sections.join(", ") || "—";
    // Pipes inside a title would break the table; the sheet has none today, but a paper renamed
    // tomorrow should not silently produce a broken export.
    const title = paper.title.replaceAll("|", "\\|");
    return `| ${title} | ${paper.venue || "—"} | ${areas} | ${sections} |`;
  });
  return [...header, ...rows].join("\n");
}

/** Both halves of the report, with the provenance header a grant reader needs. */
export function fullReportMarkdown(): string {
  return [
    "# Grant report — paper coverage and track record",
    "",
    `Compiled ${SOURCE.compiledOn} from the \`${SOURCE.sheet.tab}\` tab of [${SOURCE.sheet.title}](${SOURCE.sheet.url}),`,
    `against [${SOURCE.proposal.title}](${SOURCE.proposal.url}).`,
    `Area taxonomy: ${SOURCE.taxonomy.title} (${SOURCE.taxonomy.attribution}), ${SOURCE.taxonomy.url}.`,
    "",
    "## Task 1 — Papers mapped to the six areas",
    "",
    areaMapMarkdown(),
    "",
    "## Task 2 — Track record by proposal section",
    "",
    allTrackRecordsMarkdown(),
  ].join("\n");
}
