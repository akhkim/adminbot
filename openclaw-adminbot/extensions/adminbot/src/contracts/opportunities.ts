// Member-contributed opportunities: the half of the Opportunities board that does not ship in the
// bundle.
//
// The curated list still lives in the Control UI's own `opportunities-data.ts` and is edited by an
// admin in the repo -- those entries are lab-vetted and change a few times a year. What this adds
// is the entry a member found and wants the rest of the lab to hear about, which arrives far more
// often than a release does and has nobody reviewing it on the way in.
//
// So a submission is `pending` until an admin decides on it. The board is served to signed-out
// visitors as well as members, and an unreviewed free-text entry with a link in it is not something
// to render on a public page on the strength of one member's say-so. The submitter still sees their
// own pending entry, so the tab does not look like it swallowed their contribution.

export const ADMINBOT_OPPORTUNITY_NAME_MAX = 200;
export const ADMINBOT_OPPORTUNITY_ORG_MAX = 200;
export const ADMINBOT_OPPORTUNITY_TEXT_MAX = 2000;
export const ADMINBOT_OPPORTUNITY_WINDOW_MAX = 120;

/** Mirrors OPPORTUNITY_CATEGORIES in the Control UI's opportunities-data.ts. */
export const adminBotOpportunityCategories = [
  "phd",
  "internship",
  "grants_awards",
  "rising_stars",
  "faculty",
] as const;

export type AdminBotOpportunityCategory = (typeof adminBotOpportunityCategories)[number];

export const adminBotOpportunityStatuses = ["pending", "approved", "rejected"] as const;

export type AdminBotOpportunityStatus = (typeof adminBotOpportunityStatuses)[number];

export type AdminBotOpportunityInput = {
  name: string;
  category: AdminBotOpportunityCategory;
  org?: string;
  /** AoE wall clock, "YYYY-MM-DD HH:MM:SS". Empty means the date is not yet announced. */
  deadline_aoe?: string;
  link?: string;
  eligibility?: string;
  note?: string;
  application_window?: string;
};

export type AdminBotOpportunity = {
  id: string;
  name: string;
  category: AdminBotOpportunityCategory;
  org?: string;
  deadline_aoe: string;
  link?: string;
  eligibility?: string;
  note?: string;
  application_window?: string;
  status: AdminBotOpportunityStatus;
  /**
   * Absent once the submitter has been purged from the roster.
   *
   * An approved entry is on the board for the whole lab and outlives whoever suggested it, so the
   * purge clears the name rather than deleting the row -- the same split `MEMBER_ATTRIBUTION_COLUMNS`
   * already makes for paper slots. Anything still pending or rejected was never published and goes.
   */
  submitted_by_member_id?: string;
  created_at: string;
  updated_at: string;
  decided_at?: string;
  decided_by?: string;
  /**
   * A date the refresh sweep read off this entry's own page, waiting for a human to accept it.
   *
   * Never applied on its own. These programs are annual and their pages are edited in place, so a
   * page carrying last year's date is indistinguishable from one carrying next year's until
   * somebody looks -- and the board's whole rule is that "an unannounced deadline must never
   * render as if it were a real one, because members plan around this tab". A proposal is the
   * sweep saying what it saw and where; accepting it is a person saying it is this cycle's date.
   */
  proposed_deadline?: AdminBotOpportunityDeadlineProposal;
  /**
   * Where this entry came from, when a sweep found it rather than a member submitting it.
   *
   * Kept on the record rather than inferred from `submitted_by_member_id` being absent: an admin
   * reviewing a queue needs to know which page or which message put a thing in front of them, and
   * `source_url` is also what makes a rejection stick -- see `submitDiscoveredOpportunity`.
   */
  discovered?: AdminBotOpportunityDiscovery;
};

export type AdminBotOpportunityDiscovery = {
  /** Which sweep found it. Open enough for a third feed without a migration. */
  feed: string;
  /** The page or message it was read from. The identity a repeat sweep dedupes on. */
  source_url: string;
  /** The line it was read out of, so a reviewer can judge without opening the page. */
  evidence: string;
  found_at: string;
};

/**
 * What the sweep found, and enough to check it without opening the page.
 *
 * `evidence` is the line the date was read out of, quoted. Without it a proposal is a bare
 * assertion and the reviewer has to go and read the page anyway, which is the work the sweep was
 * supposed to remove.
 */
export type AdminBotOpportunityDeadlineProposal = {
  /** AoE wall clock, same shape as the field it would replace. */
  deadline_aoe: string;
  source_url: string;
  evidence: string;
  found_at: string;
};

/** What the board renders: the record plus the submitter's name, for the attribution line. */
export type AdminBotOpportunityView = AdminBotOpportunity & {
  submitted_by_name?: string;
};

export function isAdminBotOpportunityCategory(
  value: unknown,
): value is AdminBotOpportunityCategory {
  return (
    typeof value === "string" &&
    (adminBotOpportunityCategories as readonly string[]).includes(value)
  );
}

// The board sorts and labels on this, and `Date` would happily read "2026-13-45" as something.
// Empty is allowed and means "not announced yet" -- that is a first-class state here, not a gap.
const AOE_WALL_CLOCK = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u;

export function isAdminBotOpportunityDeadline(value: string): boolean {
  if (value === "") {
    return true;
  }
  if (!AOE_WALL_CLOCK.test(value)) {
    return false;
  }
  const asIso = `${value.replace(" ", "T")}Z`;
  return Number.isFinite(Date.parse(asIso));
}

/**
 * Validates and trims a submission, or says what is wrong with it.
 *
 * Shared by the member submit route and the admin edit route so the two cannot drift into
 * accepting different things -- the reason the roster's email rule ended up in one place too.
 */
export function validateAdminBotOpportunity(
  input: Partial<AdminBotOpportunityInput>,
): { ok: true; value: AdminBotOpportunityInput } | { ok: false; error: string } {
  const name = (input.name ?? "").trim();
  if (!name) {
    return { ok: false, error: "name is required" };
  }
  if (name.length > ADMINBOT_OPPORTUNITY_NAME_MAX) {
    return { ok: false, error: `name must be at most ${ADMINBOT_OPPORTUNITY_NAME_MAX} characters` };
  }
  if (!isAdminBotOpportunityCategory(input.category)) {
    return {
      ok: false,
      error: `category must be one of ${adminBotOpportunityCategories.join(", ")}`,
    };
  }
  const deadline = (input.deadline_aoe ?? "").trim();
  if (!isAdminBotOpportunityDeadline(deadline)) {
    return { ok: false, error: 'deadline_aoe must be "YYYY-MM-DD HH:MM:SS" or empty' };
  }
  const link = (input.link ?? "").trim();
  if (link && !/^https?:\/\//iu.test(link)) {
    return { ok: false, error: "link must be an http(s) URL" };
  }
  const org = (input.org ?? "").trim();
  if (org.length > ADMINBOT_OPPORTUNITY_ORG_MAX) {
    return { ok: false, error: `org must be at most ${ADMINBOT_OPPORTUNITY_ORG_MAX} characters` };
  }
  const applicationWindow = (input.application_window ?? "").trim();
  if (applicationWindow.length > ADMINBOT_OPPORTUNITY_WINDOW_MAX) {
    return {
      ok: false,
      error: `application_window must be at most ${ADMINBOT_OPPORTUNITY_WINDOW_MAX} characters`,
    };
  }
  const eligibility = (input.eligibility ?? "").trim();
  const note = (input.note ?? "").trim();
  for (const [label, value] of [
    ["eligibility", eligibility],
    ["note", note],
  ] as const) {
    if (value.length > ADMINBOT_OPPORTUNITY_TEXT_MAX) {
      return {
        ok: false,
        error: `${label} must be at most ${ADMINBOT_OPPORTUNITY_TEXT_MAX} characters`,
      };
    }
  }
  return {
    ok: true,
    value: {
      name,
      category: input.category,
      deadline_aoe: deadline,
      ...(org ? { org } : {}),
      ...(link ? { link } : {}),
      ...(eligibility ? { eligibility } : {}),
      ...(note ? { note } : {}),
      ...(applicationWindow ? { application_window: applicationWindow } : {}),
    },
  };
}
