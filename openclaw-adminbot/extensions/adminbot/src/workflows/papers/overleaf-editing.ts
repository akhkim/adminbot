import type { AdminBotLabMember, AdminBotPaperRecord } from "../../contracts/actions.js";

export type AdminBotOverleafEditMode = "manual" | "affiliation_check";

export type AdminBotOverleafAffiliationIssue = {
  author: string;
  status: "ok" | "confirm" | "missing";
  message: string;
  expectedAffiliation?: string;
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
        `Use exactly "${JINESIS_AFFILIATION}" for members whose main affiliation is Jinesis.`,
        `Use exactly "${ZHIJING_MPI_AFFILIATION}" for Zhijing's German-side affiliation.`,
        'Never use "Jinesis AI Lab".',
        "Do not infer EuroSafeAI eligibility or company-sponsored affiliation without explicit evidence.",
        "Preserve exact current institutional wording for collaborators paid by another professor or institute.",
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
  if (!payload.requestedEdits.trim()) {
    throw new Error("requested Overleaf edits are required");
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
  return authors.map((author) => {
    const member = findMember(author, members);
    if (!member) {
      return {
        author,
        status: "missing",
        message: "Author is not present in the AdminBot member list; ask for exact affiliation.",
      };
    }
    const notes = member.notes ?? "";
    const explicitAffiliation = readNoteValue(notes, "Affiliation");
    if (explicitAffiliation) {
      return {
        author: member.name,
        status: "ok",
        message: `Use recorded affiliation: ${explicitAffiliation}`,
        expectedAffiliation: explicitAffiliation,
      };
    }
    if (member.id.toLowerCase() === "zhijing" || member.name.toLowerCase().includes("zhijing")) {
      return {
        author: member.name,
        status: "confirm",
        message:
          "Zhijing requires exact German-side affiliation and any paper-specific additional affiliations.",
        expectedAffiliation: ZHIJING_MPI_AFFILIATION,
      };
    }
    if (/main affiliation:\s*jinesis/i.test(notes) || /\bjinesis\b/i.test(notes)) {
      return {
        author: member.name,
        status: "ok",
        message: `Use Jinesis main affiliation: ${JINESIS_AFFILIATION}`,
        expectedAffiliation: JINESIS_AFFILIATION,
      };
    }
    return {
      author: member.name,
      status: "confirm",
      message:
        "No exact affiliation is recorded in member notes; ask the user/student before editing.",
    };
  });
}

function findMember(author: string, members: AdminBotLabMember[]): AdminBotLabMember | undefined {
  const normalized = normalize(author);
  return members.find((member) => member.id === author || normalize(member.name) === normalized);
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
