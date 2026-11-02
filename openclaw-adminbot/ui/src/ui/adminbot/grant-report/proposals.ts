// The proposals the Grant Report tab can report against.
//
// Each is a section tree plus the document it came from. Papers carry section ids from every
// proposal at once (see papers.ts), so switching proposals changes which ids count, not which
// papers exist.

import { SOURCE } from "./areas.ts";
import { CANADIAN_SECTIONS } from "./sections-canadian.ts";
import { GRANT_SECTIONS, type GrantSection } from "./sections.ts";

export type ProposalId = "eurosafe" | "canadian";

export type GrantProposal = {
  id: ProposalId;
  /** The switcher's label. */
  label: string;
  title: string;
  /** Absent when the document has not been shared with AdminBot yet. */
  url?: string;
  /** One line under the switcher on how the sections relate to the document. */
  note: string;
  /**
   * Whether a section shows its spread over the six safety areas. Useful when the proposal is a
   * safety proposal; noise when it is about training, where most of its work has no area.
   */
  areaMix: boolean;
  sections: readonly GrantSection[];
};

export const PROPOSALS: readonly GrantProposal[] = [
  {
    id: "eurosafe",
    label: "EuroSafeAI",
    title: SOURCE.proposal.title,
    url: SOURCE.proposal.url,
    note: "Sections follow the proposal's Part 1 headings.",
    areaMix: true,
    sections: GRANT_SECTIONS,
  },
  {
    id: "canadian",
    label: "Canadian AI",
    title: "Canadian AI proposal",
    note: "Grouped into six themes on model training until the proposal's own headings arrive.",
    areaMix: false,
    sections: CANADIAN_SECTIONS,
  },
];

export const PROPOSAL_BY_ID: Readonly<Record<ProposalId, GrantProposal>> = Object.fromEntries(
  PROPOSALS.map((proposal) => [proposal.id, proposal]),
) as Record<ProposalId, GrantProposal>;

export const DEFAULT_PROPOSAL = PROPOSAL_BY_ID.eurosafe;

/** Every section of every proposal, for resolving any id a paper carries. */
export const ALL_SECTION_BY_ID: Readonly<Record<string, GrantSection>> = Object.fromEntries(
  PROPOSALS.flatMap((proposal) => proposal.sections).map((section) => [section.id, section]),
);
