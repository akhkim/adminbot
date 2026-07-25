export type AdminBotApplicantRow = {
  name: string;
  email: string;
  cv_link: string;
  submitted_at: string;
};

// Google Forms writes its own Timestamp column first; the rest are the live mentee-application
// question labels. Matching is normalized so a reworded or reordered question degrades to an
// empty field instead of dropping the whole applicant.
const COLUMN_ALIASES = {
  submitted_at: ["timestamp", "submitted at", "submission time"],
  name: ["full name", "name", "preferred name to be called", "preferred name"],
  email: ["email", "email address"],
  cv_link: ["link to your cv", "cv link", "cv", "resume link", "link to your resume"],
} satisfies Record<keyof AdminBotApplicantRow, string[]>;

export function selectUnreviewedApplicants(
  rows: readonly (readonly string[])[],
  since?: string,
): AdminBotApplicantRow[] {
  const [header, ...body] = rows;
  if (!header) {
    return [];
  }
  const columns = resolveColumns(header);
  const cutoff = since ? Date.parse(since) : Number.NaN;
  const applicants = body
    .filter((row) => row.some((cell) => cell.trim()))
    .map((row) => ({
      name: cell(row, columns.name),
      email: cell(row, columns.email),
      cv_link: cell(row, columns.cv_link),
      submitted_at: cell(row, columns.submitted_at),
    }));
  if (Number.isNaN(cutoff)) {
    return applicants;
  }
  return applicants.filter((applicant) => {
    const submitted = Date.parse(applicant.submitted_at);
    // Unparseable timestamps stay in the review set; silently dropping an applicant is worse
    // than showing one that may already have been reviewed.
    return Number.isNaN(submitted) || submitted > cutoff;
  });
}

function resolveColumns(header: readonly string[]): Record<keyof AdminBotApplicantRow, number> {
  const normalized = header.map((label) => normalizeLabel(label));
  const indexFor = (aliases: readonly string[]): number => {
    for (const alias of aliases) {
      const exact = normalized.indexOf(alias);
      if (exact !== -1) return exact;
    }
    return normalized.findIndex((label) => aliases.some((alias) => label.startsWith(alias)));
  };
  return {
    submitted_at: indexFor(COLUMN_ALIASES.submitted_at),
    name: indexFor(COLUMN_ALIASES.name),
    email: indexFor(COLUMN_ALIASES.email),
    cv_link: indexFor(COLUMN_ALIASES.cv_link),
  };
}

function normalizeLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

function cell(row: readonly string[], index: number): string {
  return index >= 0 ? (row[index]?.trim() ?? "") : "";
}
