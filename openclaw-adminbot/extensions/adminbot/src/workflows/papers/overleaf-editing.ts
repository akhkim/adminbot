import type { AdminBotLabMember, AdminBotPaperRecord } from "../../contracts/actions.js";
import { adminBotOverleafHosts, adminBotOverleafProjectRef } from "../../contracts/overleaf.js";

export type AdminBotOverleafEditMode = "manual" | "affiliation_check";

export type AdminBotOverleafAffiliationIssue = {
  author: string;
  /** Original immutable author entry; display names may differ from input member IDs. */
  authorReference?: { index: number; value: string };
  status: "ok" | "confirm" | "missing";
  message: string;
  expectedAffiliation?: string;
  /** Explicit paper-specific evidence retained in the immutable payload reviewed by approvers. */
  confirmation?: { source: string; workPeriod: string };
};

export type AdminBotOverleafEditPayload = {
  action: "apply_overleaf_project_edits";
  mode: AdminBotOverleafEditMode;
  paper: {
    id?: string;
    title: string;
    authors: string[];
    overleafEditUrl: string;
  };
  requestedEdits: string;
  targetFiles: string[];
  affiliationPolicy?: {
    source: string;
    rules: string[];
    issues: AdminBotOverleafAffiliationIssue[];
  };
};

export type BuildOverleafEditPayloadInput = {
  paper?: AdminBotPaperRecord;
  paperId?: string;
  title?: string;
  authors?: string[];
  overleafEditUrl?: string;
  requestedEdits: string;
  targetFiles?: string[];
  mode?: AdminBotOverleafEditMode;
  members: AdminBotLabMember[];
  policySource?: string;
};

const DEFAULT_TARGET_FILES = ["main.tex"];
const JINESIS_AFFILIATION = "Jinesis Lab, University of Toronto & Vector Institute";
const ZHIJING_MPI_AFFILIATION = "Max Planck Institute for Intelligent Systems, Tübingen, Germany";

export function buildOverleafEditPayload(
  input: BuildOverleafEditPayloadInput,
): AdminBotOverleafEditPayload {
  const title = input.title ?? input.paper?.title;
  if (!title) {
    throw new Error("paper title is required for Overleaf edits");
  }
  const authors = input.authors ?? input.paper?.authors ?? [];
  const overleafEditUrl = input.overleafEditUrl ?? input.paper?.artifacts?.overleaf_edit_url;
  if (!overleafEditUrl) {
    throw new Error("Overleaf edit URL is required; add it to the paper project links first");
  }
  const mode = input.mode ?? "manual";
  const payload: AdminBotOverleafEditPayload = {
    action: "apply_overleaf_project_edits",
    mode,
    paper: {
      ...((input.paperId ?? input.paper?.id) ? { id: input.paperId ?? input.paper?.id } : {}),
      title,
      authors,
      overleafEditUrl,
    },
    requestedEdits: input.requestedEdits,
    targetFiles: input.targetFiles?.length ? input.targetFiles : DEFAULT_TARGET_FILES,
  };
  if (mode === "affiliation_check") {
    payload.affiliationPolicy = {
      source: input.policySource ?? "affiliation-policy.md",
      rules: [
        `The combined display wording "${JINESIS_AFFILIATION}" is conditional on main Jinesis affiliation AND explicit paper-specific confirmation of every listed institution; it is not evidence of individual eligibility.`,
        `Only after explicit confirmation for this paper, use "${ZHIJING_MPI_AFFILIATION}" for Zhijing's German-side affiliation.`,
        'Never use "Jinesis AI Lab".',
        "Do not infer EuroSafeAI eligibility or company-sponsored affiliation without explicit evidence.",
        "Preserve exact current institutional wording for collaborators paid by another professor or institute.",
        "Jinesis, University of Toronto and Vector are independent associations; membership, access and email are not affiliation evidence.",
        "Recorded affiliations and historical notes require confirmation for this paper and its work period before editing; do not add institutions from display wording.",
      ],
      issues: auditAffiliations(authors, input.members),
    };
  }
  return payload;
}

export function assertOverleafPayloadReady(payload: AdminBotOverleafEditPayload): void {
  if (payload.action !== "apply_overleaf_project_edits") {
    throw new Error("unsupported Overleaf edit payload action");
  }
  if (!payload.paper.overleafEditUrl.trim()) {
    throw new Error("Overleaf edit URL is required");
  }
  // Fail closed on the destination, not just on its presence. This is the last check before the
  // connector posts the edit to the configured bridge, and a paper record carrying a link to
  // somewhere that is not an Overleaf we know is the one way an approved edit could be aimed at a
  // host nobody chose. Checked as a project reference rather than as a string so the same rule --
  // an https project link on a known instance -- covers the action and the evidence slot.
  if (!adminBotOverleafProjectRef(payload.paper.overleafEditUrl)) {
    throw new Error(
      `Overleaf edit URL must be an https project link on ${adminBotOverleafHosts().join(" or ")}`,
    );
  }
  if (!payload.requestedEdits.trim()) {
    throw new Error("requested Overleaf edits are required");
  }
  if (payload.mode === "affiliation_check") {
    const issues = payload.affiliationPolicy?.issues;
    if (!issues?.length || issues.length !== payload.paper.authors.length) {
      throw new Error("Overleaf affiliation check requires confirmation for every author.");
    }
    const seen = new Set<number>();
    for (const issue of issues) {
      const reference = issue.authorReference;
      if (
        !reference ||
        !Number.isInteger(reference.index) ||
        reference.index < 0 ||
        reference.index >= payload.paper.authors.length ||
        seen.has(reference.index) ||
        reference.value !== payload.paper.authors[reference.index]
      ) {
        throw new Error(
          "Overleaf affiliation check requires confirmation with one-to-one original author references; refresh legacy approvals.",
        );
      }
      seen.add(reference.index);
      if (
        issue.status === "ok" &&
        (!issue.expectedAffiliation?.trim() ||
          typeof issue.confirmation?.source !== "string" ||
          !issue.confirmation.source.trim() ||
          typeof issue.confirmation?.workPeriod !== "string" ||
          !issue.confirmation.workPeriod.trim())
      ) {
        throw new Error(
          "Overleaf affiliation check requires confirmation evidence and paper work period; refresh legacy approvals.",
        );
      }
    }
  }
  const blockingIssues =
    payload.affiliationPolicy?.issues.filter((issue) => issue.status !== "ok") ?? [];
  if (blockingIssues.length) {
    throw new Error(
      `Overleaf affiliation check requires confirmation: ${blockingIssues
        .map((issue) => `${issue.author}: ${issue.message}`)
        .join("; ")}`,
    );
  }
}

function auditAffiliations(
  authors: string[],
  members: AdminBotLabMember[],
): AdminBotOverleafAffiliationIssue[] {
  return authors.map((author, index) => {
    const authorReference = { index, value: author };
    const member = findMember(author, members);
    if (!member) {
      return {
        authorReference,
        author,
        status: "missing",
        message:
          "Author cannot be uniquely matched in the AdminBot member list; confirm identity and exact affiliation.",
      };
    }
    const structured = member.affiliation?.trim();
    const legacy = readNoteValue(member.notes ?? "", "Affiliation");
    const mainAffiliation = readNoteValue(member.notes ?? "", "Main affiliation");
    const normalized = (value: string) => value.toLowerCase().replace(/\s+/gu, " ").trim();
    const conflictingNote = [legacy, mainAffiliation].find(
      (value) => value && structured && normalized(structured) !== normalized(value),
    );
    if (structured && conflictingNote) {
      return {
        authorReference,
        author: member.name,
        status: "confirm",
        message: `Conflicting records: structured affiliation is "${structured}"; legacy affiliation note is "${conflictingNote}". Confirm exact institutions for this paper and work period; do not merge or choose silently.`,
        expectedAffiliation: structured,
      };
    }
    // The roster records a present association, not where this particular work was done.
    // Even matching old notes cannot establish paper-time eligibility or additional institutions.
    const recorded = structured || legacy || mainAffiliation;
    if (recorded) {
      return {
        authorReference,
        author: member.name,
        status: "confirm",
        message: `${structured ? "Structured affiliation" : "Unverified legacy affiliation note"}: ${recorded}. Confirm that these exact independent institutions apply to this paper's work period before editing. No additional Jinesis, UofT or Vector association is inferred.`,
        expectedAffiliation: recorded,
      };
    }
    return {
      authorReference,
      author: member.name,
      status: "confirm",
      message:
        "No explicit institution association is recorded. Incidental lab mentions, membership, access and email do not establish affiliation; ask the author for exact institutions and paper-work-period confirmation.",
    };
  });
}

function findMember(author: string, members: AdminBotLabMember[]): AdminBotLabMember | undefined {
  const normalized = normalize(author);
  const exact = members.find((member) => member.id === author);
  if (exact) {
    return exact;
  }
  const matches = members.filter((member) => normalize(member.name) === normalized);
  return matches.length === 1 ? matches[0] : undefined;
}

function readNoteValue(notes: string, label: string): string | undefined {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = notes.match(new RegExp(`^${escaped}:\\s*(.+)$`, "im"));
  return match?.[1]?.trim();
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
